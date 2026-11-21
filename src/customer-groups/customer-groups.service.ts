import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { CustomerGroupsRepository, CustomerGroupWithCount } from './customer-groups.repository';
import { CreateCustomerGroupInput, UpdateCustomerGroupInput } from './dto/customer-group.input';
import { CustomerGroup, CustomerGroupMemberPage } from './entities/customer-group.entity';

const AUDITED_FIELDS = ['name', 'description'] as const satisfies readonly (keyof CustomerGroupWithCount)[];

function toEntity({ _count, ...group }: CustomerGroupWithCount): CustomerGroup {
  return { ...group, memberCount: _count.members };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CustomerGroupsService {
  constructor(
    private readonly repository: CustomerGroupsRepository,
    private readonly auditService: AuditService,
  ) {}

  async findAll(): Promise<CustomerGroup[]> {
    return (await this.repository.findAll()).map(toEntity);
  }

  async findOne(id: string): Promise<CustomerGroup> {
    return toEntity(await this.findOrThrow(id));
  }

  async getMembers(groupId: string, first: number, after?: string): Promise<CustomerGroupMemberPage> {
    await this.findOrThrow(groupId);
    const [rows, totalCount] = await this.repository.findMemberPage(groupId, { take: first + 1, after });
    return {
      nodes: rows.slice(0, first).map(({ userId, createdAt }) => ({ userId, createdAt })),
      totalCount,
      hasNextPage: rows.length > first,
    };
  }

  async create(input: CreateCustomerGroupInput, actorId: string): Promise<CustomerGroup> {
    const created = await this.nameMustBeFree(input.name, () =>
      this.auditService.record(
        (tx) => this.repository.create({ name: input.name, description: input.description }, tx),
        (group) => ({
          entity: 'CustomerGroup',
          entityId: group.id,
          action: 'CREATE',
          userId: actorId,
          details: { after: fieldValues(group, AUDITED_FIELDS) },
        }),
      ),
    );
    return toEntity(created);
  }

  async update(id: string, input: UpdateCustomerGroupInput, actorId: string): Promise<CustomerGroup> {
    const existing = await this.findOrThrow(id);
    if (input.name === null) throw new BadRequestException('name cannot be null');
    const updated = await this.nameMustBeFree(input.name ?? existing.name, () =>
      this.auditService.record(
        (tx) => this.repository.update(id, { name: input.name, description: input.description }, tx),
        (after) => ({
          entity: 'CustomerGroup',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: { changes: fieldChanges(existing, after, AUDITED_FIELDS) },
        }),
      ),
    );
    return toEntity(updated);
  }

  /**
   * Deletes a group and its memberships. A group a promotion is limited to cannot be deleted: dropping it would open
   * that promotion to everyone.
   */
  async delete(id: string, actorId: string): Promise<CustomerGroup> {
    await this.findOrThrow(id);
    if ((await this.repository.countPromotions(id)) > 0) {
      throw new ConflictException(`Customer group "${id}" limits promotions; take it off them before deleting it`);
    }
    const deleted = await this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (before) => ({
        entity: 'CustomerGroup',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: { ...fieldValues(before, AUDITED_FIELDS), memberCount: before._count.members } },
      }),
    );
    return toEntity(deleted);
  }

  /** Adds customers to the group (already members are left alone); audited with the user ids, no personal data. */
  async addMembers(groupId: string, userIds: string[], actorId: string): Promise<CustomerGroup> {
    await this.findOrThrow(groupId);
    const unique = [...new Set(userIds)];
    const missing = await this.repository.missingUsers(unique);
    if (missing.length > 0) throw new BadRequestException(`Unknown user ids: ${missing.join(', ')}`);
    await this.auditService.record(
      (tx) => this.repository.addMembers(groupId, unique, tx),
      (added) => ({
        entity: 'CustomerGroup',
        entityId: groupId,
        action: 'UPDATE',
        userId: actorId,
        details: { addMembers: unique, added },
      }),
    );
    return this.findOne(groupId);
  }

  async removeMembers(groupId: string, userIds: string[], actorId: string): Promise<CustomerGroup> {
    await this.findOrThrow(groupId);
    const unique = [...new Set(userIds)];
    await this.auditService.record(
      (tx) => this.repository.removeMembers(groupId, unique, tx),
      (removed) => ({
        entity: 'CustomerGroup',
        entityId: groupId,
        action: 'UPDATE',
        userId: actorId,
        details: { removeMembers: unique, removed },
      }),
    );
    return this.findOne(groupId);
  }

  private async findOrThrow(id: string): Promise<CustomerGroupWithCount> {
    const group = await this.repository.findById(id);
    if (!group) throw new NotFoundException(`Customer group "${id}" not found`);
    return group;
  }

  private async nameMustBeFree<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`A customer group named "${name}" already exists`);
      throw error;
    }
  }
}
