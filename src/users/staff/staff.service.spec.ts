import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../generated/prisma/client';
import { LAST_OWNER_MESSAGE, StaffService } from './staff.service';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../../test/helpers/audit.helper';
import { accessWith, MANAGER_ACCESS, MANAGER_PERMISSIONS, OWNER_ACCESS } from '../../../test/helpers/staff.helper';
import { ALL_PERMISSIONS } from '../../iam/authorization/permissions';

const role = (key: string, permissions: string[], extra: object = {}) => ({
  id: `role_${key}`,
  key,
  name: key,
  permissions,
  isSystem: true,
  mfaRequired: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const OWNER = role('OWNER', ALL_PERMISSIONS);
const MANAGER = role('MANAGER', MANAGER_PERMISSIONS);
const CASHIER = role('CASHIER', ['order.view', 'payment.record']);
const CUSTOM = role('STOCK_TAKER', ['inventory.view'], { isSystem: false });
const user = { id: 'u1', role: Role.USER, isActive: true };

describe('StaffService', () => {
  const tx = { user: { findUnique: jest.fn() }, isTx: true };
  const prisma = { $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)) };
  const repository = {
    findRoles: jest.fn(),
    findRoleByKey: jest.fn(),
    findMembers: jest.fn(),
    findMembership: jest.fn(),
    lockOwnersAndCountOthers: jest.fn(),
    assignRole: jest.fn(),
    removeRole: jest.fn(),
    createRole: jest.fn(),
    updateRole: jest.fn(),
  };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: StaffService;

  const roles: Record<string, ReturnType<typeof role>> = { OWNER, MANAGER, CASHIER, STOCK_TAKER: CUSTOM };

  beforeEach(() => {
    jest.clearAllMocks();
    audit = createAuditServiceMock();
    service = new StaffService(prisma as never, repository as never, audit as never);
    tx.user.findUnique.mockResolvedValue(user);
    repository.findRoleByKey.mockImplementation(async (key: string) => roles[key] ?? null);
    repository.findMembership.mockResolvedValue(null);
    repository.lockOwnersAndCountOthers.mockResolvedValue(1);
    repository.assignRole.mockImplementation(async (_tx, userId: string, assigned) => ({
      userId,
      role: assigned,
      user,
      updatedAt: new Date(),
    }));
  });

  describe('assignRole', () => {
    it('lets an Owner assign the Owner role and audits it in the same transaction', async () => {
      const result = await service.assignRole({ id: 'owner1', access: OWNER_ACCESS }, 'u1', 'OWNER');

      expect(repository.assignRole).toHaveBeenCalledWith(tx, 'u1', OWNER, Role.SUPER_ADMIN);
      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'StoreMembership',
          entityId: 'u1',
          action: 'ROLE_ASSIGN',
          userId: 'owner1',
          details: { from: null, to: 'OWNER' },
        },
        tx,
      );
      expect(result.role.permissions).toEqual(ALL_PERMISSIONS);
    });

    it('keeps the legacy role in step: any role but Owner is ADMIN', async () => {
      await service.assignRole({ id: 'owner1', access: OWNER_ACCESS }, 'u1', 'CASHIER');

      expect(repository.assignRole).toHaveBeenCalledWith(tx, 'u1', CASHIER, Role.ADMIN);
    });

    it('refuses a Manager (no staff.manage)', async () => {
      await expect(service.assignRole({ id: 'm1', access: MANAGER_ACCESS }, 'u1', 'CASHIER')).rejects.toThrow(
        ForbiddenException,
      );
      expect(repository.assignRole).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses to grant a role with permissions the actor lacks, or the Owner role', async () => {
      const staffAdmin = { id: 's1', access: accessWith('staff.manage', 'order.view', 'payment.record') };

      await expect(service.assignRole(staffAdmin, 'u1', 'MANAGER')).rejects.toThrow(/you do not hold/);
      await expect(service.assignRole(staffAdmin, 'u1', 'OWNER')).rejects.toThrow(
        'Only an Owner can assign the Owner role',
      );
      await expect(service.assignRole(staffAdmin, 'u1', 'CASHIER')).resolves.toBeDefined();
    });

    it('refuses to change the role of staff holding permissions the actor lacks', async () => {
      repository.findMembership.mockResolvedValue({ userId: 'u1', role: MANAGER });
      const staffAdmin = { id: 's1', access: accessWith('staff.manage', 'order.view', 'payment.record') };

      await expect(service.assignRole(staffAdmin, 'u1', 'CASHIER')).rejects.toThrow(ForbiddenException);
    });

    it('refuses to demote the last Owner', async () => {
      repository.findMembership.mockResolvedValue({ userId: 'u1', role: OWNER });
      repository.lockOwnersAndCountOthers.mockResolvedValue(0);

      await expect(service.assignRole({ id: 'u1', access: OWNER_ACCESS }, 'u1', 'MANAGER')).rejects.toThrow(
        LAST_OWNER_MESSAGE,
      );
      expect(repository.lockOwnersAndCountOthers).toHaveBeenCalledWith(tx, 'u1');
      expect(repository.assignRole).not.toHaveBeenCalled();
    });

    it('reports an unknown role or user', async () => {
      await expect(service.assignRole({ id: 'o', access: OWNER_ACCESS }, 'u1', 'NOPE')).rejects.toThrow(
        NotFoundException,
      );
      tx.user.findUnique.mockResolvedValue(null);
      await expect(service.assignRole({ id: 'o', access: OWNER_ACCESS }, 'ghost', 'CASHIER')).rejects.toThrow(
        'User not found',
      );
    });
  });

  describe('removeRole', () => {
    it('makes the user a customer and audits it in the same transaction', async () => {
      repository.findMembership.mockResolvedValue({ userId: 'u1', role: CASHIER });

      await service.removeRole({ id: 'owner1', access: OWNER_ACCESS }, 'u1');

      expect(repository.removeRole).toHaveBeenCalledWith(tx, 'u1');
      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'StoreMembership',
          entityId: 'u1',
          action: 'ROLE_REMOVE',
          userId: 'owner1',
          details: { from: 'CASHIER' },
        },
        tx,
      );
    });

    it('refuses to remove the last Owner', async () => {
      repository.findMembership.mockResolvedValue({ userId: 'u1', role: OWNER });
      repository.lockOwnersAndCountOthers.mockResolvedValue(0);

      await expect(service.removeRole({ id: 'u1', access: OWNER_ACCESS }, 'u1')).rejects.toThrow(LAST_OWNER_MESSAGE);
      expect(repository.removeRole).not.toHaveBeenCalled();
    });

    it('lets an Owner remove another Owner while one remains', async () => {
      repository.findMembership.mockResolvedValue({ userId: 'u2', role: OWNER });

      await service.removeRole({ id: 'u1', access: OWNER_ACCESS }, 'u2');

      expect(repository.removeRole).toHaveBeenCalledWith(tx, 'u2');
    });

    it('reports a user without a staff role', async () => {
      await expect(service.removeRole({ id: 'o', access: OWNER_ACCESS }, 'u1')).rejects.toThrow(
        'This user has no staff role',
      );
    });
  });

  describe('createRole', () => {
    it('creates a custom role from permissions the actor holds, audited', async () => {
      repository.findRoleByKey.mockResolvedValue(null);
      repository.createRole.mockImplementation(async (_tx, data) => ({ ...CUSTOM, ...data }));

      await service.createRole(
        { id: 'owner1', access: OWNER_ACCESS },
        { key: 'STOCK_TAKER', name: 'Stock taker', permissions: ['inventory.view'] },
      );

      expect(repository.createRole).toHaveBeenCalledWith(AUDIT_TX, {
        key: 'STOCK_TAKER',
        name: 'Stock taker',
        permissions: ['inventory.view'],
        mfaRequired: false,
      });
      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'StaffRole',
          entityId: CUSTOM.id,
          action: 'CREATE',
          userId: 'owner1',
          details: { key: 'STOCK_TAKER', permissions: ['inventory.view'], mfaRequired: false },
        },
        AUDIT_TX,
      );
    });

    it('rejects unknown permissions and permissions the actor lacks', async () => {
      const input = { key: 'X_ROLE', name: 'X', permissions: ['order.steal'] };
      await expect(service.createRole({ id: 'o', access: OWNER_ACCESS }, input)).rejects.toThrow(BadRequestException);
      await expect(
        service.createRole({ id: 'm', access: MANAGER_ACCESS }, { ...input, permissions: ['jobs.manage'] }),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.createRole).not.toHaveBeenCalled();
    });

    it('rejects a duplicate key', async () => {
      await expect(
        service.createRole(
          { id: 'o', access: OWNER_ACCESS },
          { key: 'CASHIER', name: 'C', permissions: ['order.view'] },
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateRole', () => {
    it('changes a custom role and audits before and after', async () => {
      repository.updateRole.mockImplementation(async (_tx, _id, data) => ({ ...CUSTOM, ...withoutUndefined(data) }));

      await service.updateRole({ id: 'owner1', access: OWNER_ACCESS }, 'STOCK_TAKER', {
        permissions: ['inventory.view', 'inventory.adjust'],
      });

      expect(repository.updateRole).toHaveBeenCalledWith(AUDIT_TX, CUSTOM.id, {
        name: undefined,
        permissions: ['inventory.view', 'inventory.adjust'],
        mfaRequired: undefined,
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'StaffRole',
          action: 'UPDATE',
          userId: 'owner1',
          details: {
            key: 'STOCK_TAKER',
            before: { name: 'STOCK_TAKER', permissions: ['inventory.view'], mfaRequired: false },
            after: { name: 'STOCK_TAKER', permissions: ['inventory.view', 'inventory.adjust'], mfaRequired: false },
          },
        }),
        AUDIT_TX,
      );
    });

    it('refuses to change a system role', async () => {
      await expect(service.updateRole({ id: 'o', access: OWNER_ACCESS }, 'MANAGER', { name: 'Boss' })).rejects.toThrow(
        'System roles cannot be changed',
      );
    });

    it('refuses to add a permission the actor lacks', async () => {
      const actor = { id: 's', access: accessWith('staff.manage', 'inventory.view') };

      await expect(
        service.updateRole(actor, 'STOCK_TAKER', { permissions: ['inventory.view', 'order.refund'] }),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.updateRole).not.toHaveBeenCalled();
    });
  });

  describe('assertAnotherOwnerRemains', () => {
    it('passes while another active Owner exists and fails otherwise', async () => {
      await expect(service.assertAnotherOwnerRemains(tx as never, 'u1')).resolves.toBeUndefined();
      repository.lockOwnersAndCountOthers.mockResolvedValue(0);
      await expect(service.assertAnotherOwnerRemains(tx as never, 'u1')).rejects.toThrow(LAST_OWNER_MESSAGE);
    });
  });
});
