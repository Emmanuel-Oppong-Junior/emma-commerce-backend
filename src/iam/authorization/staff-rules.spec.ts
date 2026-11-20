import { ForbiddenException } from '@nestjs/common';
import { Role } from '../../generated/prisma/client';
import { assertHoldsPermissions, assertMayGrantRole, assertMayManageStaff, legacyRoleFor } from './staff-rules';
import { ALL_PERMISSIONS } from './permissions';
import { effectivePermissions, staffAccessFor, unknownPermissions } from './staff-access';
import { accessWith, MANAGER_ACCESS, MANAGER_ROLE, OWNER_ACCESS, OWNER_ROLE } from '../../../test/helpers/staff.helper';

const CASHIER_ROLE = { key: 'CASHIER', permissions: ['order.view', 'payment.record'] };
const STAFF_ADMIN = accessWith('staff.manage', 'order.view', 'payment.record', 'catalog.product.write');

describe('permission resolution', () => {
  it('gives the Owner every permission in the catalogue whatever its stored list says', () => {
    expect(effectivePermissions({ key: 'OWNER', permissions: [] })).toEqual(ALL_PERMISSIONS);
    expect(OWNER_ACCESS.permissions.size).toBe(ALL_PERMISSIONS.length);
  });

  it('keeps only catalogue permissions of any other role', () => {
    expect(effectivePermissions({ key: 'X', permissions: ['order.view', 'retired.permission'] })).toEqual([
      'order.view',
    ]);
  });

  it('gives a customer no role and no permissions', () => {
    expect(staffAccessFor(null)).toEqual({ roleKey: null, permissions: new Set(), mfaRequired: false });
  });

  it('carries the role key and MFA requirement', () => {
    expect(MANAGER_ACCESS).toMatchObject({ roleKey: 'MANAGER', mfaRequired: true });
    expect(MANAGER_ACCESS.permissions.has('staff.manage')).toBe(false);
  });

  it('lists permission strings that are not in the catalogue', () => {
    expect(unknownPermissions(['order.view', 'order.steal'])).toEqual(['order.steal']);
  });
});

describe('assertMayGrantRole (no privilege escalation)', () => {
  it('needs staff.manage', () => {
    expect(() => assertMayGrantRole(MANAGER_ACCESS, CASHIER_ROLE)).toThrow(ForbiddenException);
  });

  it('lets an actor grant a role whose permissions they all hold', () => {
    expect(() => assertMayGrantRole(STAFF_ADMIN, CASHIER_ROLE)).not.toThrow();
  });

  it('refuses a role with a permission the actor lacks', () => {
    expect(() => assertMayGrantRole(STAFF_ADMIN, MANAGER_ROLE)).toThrow(/you do not hold/);
  });

  it('lets only an Owner grant the Owner role', () => {
    const everythingButOwner = staffAccessFor({ key: 'ALMOST', permissions: ALL_PERMISSIONS, mfaRequired: true });

    expect(() => assertMayGrantRole(everythingButOwner, OWNER_ROLE)).toThrow('Only an Owner can assign the Owner role');
    expect(() => assertMayGrantRole(OWNER_ACCESS, OWNER_ROLE)).not.toThrow();
  });
});

describe('assertMayManageStaff', () => {
  it('lets anyone through for a customer target (the guard already checked user.manage)', () => {
    expect(() => assertMayManageStaff(MANAGER_ACCESS, null, 'updated')).not.toThrow();
  });

  it('needs staff.manage for a staff target', () => {
    expect(() => assertMayManageStaff(MANAGER_ACCESS, CASHIER_ROLE, 'updated')).toThrow(
      'Staff accounts can only be updated by someone with the staff.manage permission',
    );
  });

  it('lets only an Owner act on an Owner', () => {
    expect(() => assertMayManageStaff(STAFF_ADMIN, OWNER_ROLE, 'removed')).toThrow(
      'Owner accounts can only be removed by an Owner',
    );
    expect(() => assertMayManageStaff(OWNER_ACCESS, OWNER_ROLE, 'removed')).not.toThrow();
  });

  it('refuses a target holding permissions the actor lacks', () => {
    expect(() => assertMayManageStaff(STAFF_ADMIN, MANAGER_ROLE, 'archived')).toThrow(ForbiddenException);
    expect(() => assertMayManageStaff(STAFF_ADMIN, CASHIER_ROLE, 'archived')).not.toThrow();
  });
});

describe('assertHoldsPermissions', () => {
  it('names the permissions the actor lacks', () => {
    expect(() => assertHoldsPermissions(STAFF_ADMIN, ['order.view', 'order.refund'], 'create this role')).toThrow(
      'You cannot create this role: you do not hold order.refund',
    );
  });
});

describe('legacyRoleFor', () => {
  it.each([
    ['OWNER', Role.SUPER_ADMIN],
    ['MANAGER', Role.ADMIN],
    ['CASHIER', Role.ADMIN],
    [null, Role.USER],
  ])('maps %s to %s', (key, legacy) => {
    expect(legacyRoleFor(key)).toBe(legacy);
  });
});
