import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { CustomerGroupsService } from './customer-groups.service';

const CREATED = new Date('2026-11-01T00:00:00.000Z');
const vip = (overrides: Record<string, unknown> = {}) => ({
  id: 'group1',
  name: 'VIP',
  description: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  _count: { members: 2 },
  ...overrides,
});

describe('CustomerGroupsService', () => {
  let repository: Record<string, jest.Mock>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: CustomerGroupsService;

  beforeEach(() => {
    repository = {
      findAll: jest.fn().mockResolvedValue([vip()]),
      findById: jest.fn().mockResolvedValue(vip()),
      create: jest.fn().mockImplementation(async (data) => vip({ ...data, _count: { members: 0 } })),
      update: jest.fn().mockImplementation(async (_id, data) => vip({ ...data, name: data.name ?? 'VIP' })),
      delete: jest.fn().mockResolvedValue(vip()),
      countPromotions: jest.fn().mockResolvedValue(0),
      missingUsers: jest.fn().mockResolvedValue([]),
      addMembers: jest.fn().mockResolvedValue(1),
      removeMembers: jest.fn().mockResolvedValue(1),
      findMemberPage: jest.fn().mockResolvedValue([[], 0]),
    };
    audit = createAuditServiceMock();
    service = new CustomerGroupsService(repository as never, audit as never);
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createCustomerGroup',
        () => service.create({ name: 'VIP' }, 'admin1'),
        { action: 'CREATE', details: { after: { name: 'VIP', description: null } } },
      ],
      [
        'updateCustomerGroup',
        () => service.update('group1', { name: 'Gold' }, 'admin1'),
        { action: 'UPDATE', details: { changes: { name: { from: 'VIP', to: 'Gold' } } } },
      ],
      [
        'deleteCustomerGroup',
        () => service.delete('group1', 'admin1'),
        { action: 'DELETE', details: { before: { name: 'VIP', description: null, memberCount: 2 } } },
      ],
      [
        'addCustomerGroupMembers',
        () => service.addMembers('group1', ['u1', 'u1', 'u2'], 'admin1'),
        { action: 'UPDATE', details: { addMembers: ['u1', 'u2'], added: 1 } },
      ],
      [
        'removeCustomerGroupMembers',
        () => service.removeMembers('group1', ['u1'], 'admin1'),
        { action: 'UPDATE', details: { removeMembers: ['u1'], removed: 1 } },
      ],
    ])('%s writes one audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        { entity: 'CustomerGroup', entityId: 'group1', userId: 'admin1', ...expected },
        AUDIT_TX,
      );
    });
  });

  it('returns groups with their member count', async () => {
    expect(await service.findAll()).toEqual([
      { id: 'group1', name: 'VIP', description: null, createdAt: CREATED, updatedAt: CREATED, memberCount: 2 },
    ]);
  });

  it('refuses to delete a group a promotion is limited to, which would open the promotion to everyone', async () => {
    repository.countPromotions.mockResolvedValue(1);

    await expect(service.delete('group1', 'admin1')).rejects.toThrow(ConflictException);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('refuses unknown users and an unknown group', async () => {
    repository.missingUsers.mockResolvedValue(['ghost']);
    await expect(service.addMembers('group1', ['ghost'], 'admin1')).rejects.toThrow(
      new BadRequestException('Unknown user ids: ghost'),
    );

    repository.findById.mockResolvedValue(null);
    await expect(service.removeMembers('nope', ['u1'], 'admin1')).rejects.toThrow(NotFoundException);
  });

  it('reports a taken name as CONFLICT', async () => {
    const { Prisma } = jest.requireActual('../generated/prisma/client');
    repository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(service.create({ name: 'VIP' }, 'admin1')).rejects.toThrow(
      new ConflictException('A customer group named "VIP" already exists'),
    );
  });

  it('pages the members by user id', async () => {
    repository.findMemberPage.mockResolvedValue([
      [
        { groupId: 'group1', userId: 'u1', createdAt: CREATED },
        { groupId: 'group1', userId: 'u2', createdAt: CREATED },
      ],
      3,
    ]);

    const page = await service.getMembers('group1', 1, 'u0');

    expect(repository.findMemberPage).toHaveBeenCalledWith('group1', { take: 2, after: 'u0' });
    expect(page).toEqual({ nodes: [{ userId: 'u1', createdAt: CREATED }], totalCount: 3, hasNextPage: true });
  });
});
