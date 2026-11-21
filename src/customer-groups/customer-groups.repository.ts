import { Injectable } from '@nestjs/common';
import { CustomerGroup, CustomerGroupMember, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CustomerGroupWithCount = CustomerGroup & { _count: { members: number } };

const WITH_COUNT = { _count: { select: { members: true } } } satisfies Prisma.CustomerGroupInclude;

@Injectable()
export class CustomerGroupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<CustomerGroupWithCount[]> {
    return this.prisma.customerGroup.findMany({ include: WITH_COUNT, orderBy: { name: 'asc' } });
  }

  async findById(id: string): Promise<CustomerGroupWithCount | null> {
    return this.prisma.customerGroup.findUnique({ where: { id }, include: WITH_COUNT });
  }

  async create(data: Prisma.CustomerGroupCreateInput, tx: Prisma.TransactionClient): Promise<CustomerGroupWithCount> {
    return tx.customerGroup.create({ data, include: WITH_COUNT });
  }

  async update(
    id: string,
    data: Prisma.CustomerGroupUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CustomerGroupWithCount> {
    return tx.customerGroup.update({ where: { id }, data, include: WITH_COUNT });
  }

  async delete(id: string, tx: Prisma.TransactionClient): Promise<CustomerGroupWithCount> {
    return tx.customerGroup.delete({ where: { id }, include: WITH_COUNT });
  }

  async countPromotions(groupId: string): Promise<number> {
    return this.prisma.promotion.count({ where: { customerGroups: { some: { id: groupId } } } });
  }

  async missingUsers(userIds: readonly string[]): Promise<string[]> {
    const found = await this.prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true } });
    const existing = new Set(found.map((user) => user.id));
    return userIds.filter((id) => !existing.has(id));
  }

  /** Adds the users not yet in the group; returns how many were added. */
  async addMembers(groupId: string, userIds: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.customerGroupMember.createMany({
      data: userIds.map((userId) => ({ groupId, userId })),
      skipDuplicates: true,
    });
    return count;
  }

  async removeMembers(groupId: string, userIds: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.customerGroupMember.deleteMany({ where: { groupId, userId: { in: [...userIds] } } });
    return count;
  }

  async findMemberPage(
    groupId: string,
    page: { take: number; after?: string },
  ): Promise<[CustomerGroupMember[], number]> {
    return Promise.all([
      this.prisma.customerGroupMember.findMany({
        where: { groupId },
        orderBy: { userId: 'asc' },
        take: page.take,
        ...(page.after && { cursor: { groupId_userId: { groupId, userId: page.after } }, skip: 1 }),
      }),
      this.prisma.customerGroupMember.count({ where: { groupId } }),
    ]);
  }
}
