import { Injectable } from '@nestjs/common';
import { Prisma, Role, StaffRole } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OWNER_ROLE_KEY } from '../../iam/authorization/permissions';

// Every change that can drop an Owner takes this lock first, so two such changes never both pass the last-Owner check.
const OWNERS_LOCK = 'store.owners';

@Injectable()
export class StaffRepository {
  constructor(private readonly prisma: PrismaService) {}

  findRoles(): Promise<StaffRole[]> {
    return this.prisma.staffRole.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
  }

  findRoleByKey(key: string, db: Prisma.TransactionClient = this.prisma): Promise<StaffRole | null> {
    return db.staffRole.findUnique({ where: { key } });
  }

  findMembers() {
    return this.prisma.storeMembership.findMany({
      include: { role: true, user: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  findMembership(userId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.storeMembership.findFirst({ where: { userId }, include: { role: true } });
  }

  findRolesOfUsers(userIds: readonly string[]) {
    return this.prisma.storeMembership.findMany({
      where: { userId: { in: [...userIds] } },
      include: { role: true },
    });
  }

  /** Locks Owner changes for the rest of the transaction and counts the active Owners other than `userId`. */
  async lockOwnersAndCountOthers(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${OWNERS_LOCK}))`;
    return tx.storeMembership.count({
      where: { userId: { not: userId }, role: { key: OWNER_ROLE_KEY }, user: { isActive: true } },
    });
  }

  /** Gives the user `role` in the store (replacing any other) and keeps the legacy User.role in step. */
  async assignRole(tx: Prisma.TransactionClient, userId: string, role: StaffRole, legacyRole: Role) {
    const store = await tx.store.findUniqueOrThrow({ where: { singleton: true }, select: { id: true } });
    await tx.user.update({ where: { id: userId }, data: { role: legacyRole } });
    return tx.storeMembership.upsert({
      where: { userId_storeId: { userId, storeId: store.id } },
      create: { userId, storeId: store.id, roleId: role.id },
      update: { roleId: role.id },
      include: { role: true, user: true },
    });
  }

  async removeRole(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.storeMembership.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { role: Role.USER } });
  }

  createRole(tx: Prisma.TransactionClient, data: Prisma.StaffRoleCreateInput): Promise<StaffRole> {
    return tx.staffRole.create({ data });
  }

  updateRole(tx: Prisma.TransactionClient, id: string, data: Prisma.StaffRoleUpdateInput): Promise<StaffRole> {
    return tx.staffRole.update({ where: { id }, data });
  }
}
