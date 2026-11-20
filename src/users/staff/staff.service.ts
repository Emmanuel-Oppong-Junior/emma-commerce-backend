import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StaffRole } from '../../generated/prisma/client';
import { AuditService } from '../../commons/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OWNER_ROLE_KEY, PERMISSION_CATALOGUE } from '../../iam/authorization/permissions';
import { effectivePermissions, StaffAccess, unknownPermissions } from '../../iam/authorization/staff-access';
import {
  assertHoldsPermissions,
  assertMayGrantRole,
  assertMayManageStaff,
  legacyRoleFor,
} from '../../iam/authorization/staff-rules';
import { StaffRepository } from './staff.repository';
import { CreateStaffRoleInput, UpdateStaffRoleInput } from './dto/staff-role.input';
import { StaffPermissionEntity, StaffRoleEntity } from './entities/staff-role.entity';

export interface StaffActor {
  id: string;
  access: StaffAccess;
}

export const LAST_OWNER_MESSAGE = 'The store must keep at least one active Owner';

/** The role as the API shows it: the Owner's permissions are always the whole catalogue. */
export function toStaffRoleEntity(role: StaffRole): StaffRoleEntity {
  return { ...role, permissions: effectivePermissions(role) };
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staffRepository: StaffRepository,
    private readonly auditService: AuditService,
  ) {}

  permissions(): StaffPermissionEntity[] {
    return Object.entries(PERMISSION_CATALOGUE).map(([key, description]) => ({ key, description }));
  }

  async roles(): Promise<StaffRoleEntity[]> {
    return (await this.staffRepository.findRoles()).map(toStaffRoleEntity);
  }

  async members() {
    const members = await this.staffRepository.findMembers();
    return members.map((member) => ({ ...member, role: toStaffRoleEntity(member.role) }));
  }

  /** Gives a user a staff role (replacing their current one), subject to the escalation rules. Audited. */
  async assignRole(actor: StaffActor, userId: string, roleKey: string) {
    const member = await this.prisma.$transaction(async (tx) => {
      const role = await this.findRoleOrThrow(roleKey, tx);
      await this.findUserOrThrow(userId, tx);
      const current = await this.staffRepository.findMembership(userId, tx);
      assertMayManageStaff(actor.access, current?.role, 'changed');
      assertMayGrantRole(actor.access, role);
      if (current?.role.key === OWNER_ROLE_KEY && role.key !== OWNER_ROLE_KEY) {
        await this.assertAnotherOwnerRemains(tx, userId);
      }
      const assigned = await this.staffRepository.assignRole(tx, userId, role, legacyRoleFor(role.key));
      await this.auditService.log(
        {
          entity: 'StoreMembership',
          entityId: userId,
          action: 'ROLE_ASSIGN',
          userId: actor.id,
          details: { from: current?.role.key ?? null, to: role.key },
        },
        tx,
      );
      return assigned;
    });
    return { ...member, role: toStaffRoleEntity(member.role) };
  }

  /** Takes a user's staff role away, making them a customer. Audited; the last Owner cannot be removed. */
  async removeRole(actor: StaffActor, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.staffRepository.findMembership(userId, tx);
      if (!current) throw new NotFoundException('This user has no staff role');
      assertMayManageStaff(actor.access, current.role, 'removed');
      if (current.role.key === OWNER_ROLE_KEY) await this.assertAnotherOwnerRemains(tx, userId);
      await this.staffRepository.removeRole(tx, userId);
      await this.auditService.log(
        {
          entity: 'StoreMembership',
          entityId: userId,
          action: 'ROLE_REMOVE',
          userId: actor.id,
          details: { from: current.role.key },
        },
        tx,
      );
      return this.findUserOrThrow(userId, tx);
    });
  }

  async createRole(actor: StaffActor, input: CreateStaffRoleInput): Promise<StaffRoleEntity> {
    this.assertKnownPermissions(input.permissions);
    assertHoldsPermissions(actor.access, input.permissions, 'create this role');
    const role = await this.auditService.record(
      async (tx) => {
        if (await this.staffRepository.findRoleByKey(input.key, tx)) {
          throw new ConflictException(`A role with key ${input.key} already exists`);
        }
        return this.staffRepository.createRole(tx, {
          key: input.key,
          name: input.name,
          permissions: input.permissions,
          mfaRequired: input.mfaRequired ?? false,
        });
      },
      (created) => ({
        entity: 'StaffRole',
        entityId: created.id,
        action: 'CREATE',
        userId: actor.id,
        details: { key: created.key, permissions: created.permissions, mfaRequired: created.mfaRequired },
      }),
    );
    return toStaffRoleEntity(role);
  }

  /** Changes a custom role; the change applies to its holders on their next request. System roles are immutable. */
  async updateRole(actor: StaffActor, key: string, input: UpdateStaffRoleInput): Promise<StaffRoleEntity> {
    if (input.permissions) this.assertKnownPermissions(input.permissions);
    const { after } = await this.auditService.record(
      async (tx) => {
        const before = await this.findRoleOrThrow(key, tx);
        if (before.isSystem) throw new ForbiddenException('System roles cannot be changed');
        assertHoldsPermissions(actor.access, [...before.permissions, ...(input.permissions ?? [])], 'change this role');
        const data: Prisma.StaffRoleUpdateInput = {
          name: input.name ?? undefined,
          permissions: input.permissions ?? undefined,
          mfaRequired: input.mfaRequired ?? undefined,
        };
        return { before, after: await this.staffRepository.updateRole(tx, before.id, data) };
      },
      ({ before, after }) => ({
        entity: 'StaffRole',
        entityId: after.id,
        action: 'UPDATE',
        userId: actor.id,
        details: {
          key: after.key,
          before: { name: before.name, permissions: before.permissions, mfaRequired: before.mfaRequired },
          after: { name: after.name, permissions: after.permissions, mfaRequired: after.mfaRequired },
        },
      }),
    );
    return toStaffRoleEntity(after);
  }

  /** Call inside the transaction that would drop `userId` as an Owner (role change, removal, archive, delete). */
  async assertAnotherOwnerRemains(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    if ((await this.staffRepository.lockOwnersAndCountOthers(tx, userId)) === 0) {
      throw new ForbiddenException(LAST_OWNER_MESSAGE);
    }
  }

  private assertKnownPermissions(permissions: readonly string[]): void {
    const unknown = unknownPermissions(permissions);
    if (unknown.length > 0) throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);
  }

  private async findRoleOrThrow(key: string, tx: Prisma.TransactionClient): Promise<StaffRole> {
    const role = await this.staffRepository.findRoleByKey(key, tx);
    if (!role) throw new NotFoundException(`Staff role ${key} not found`);
    return role;
  }

  private async findUserOrThrow(userId: string, tx: Prisma.TransactionClient) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
