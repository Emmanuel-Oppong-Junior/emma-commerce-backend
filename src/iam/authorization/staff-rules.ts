import { ForbiddenException } from '@nestjs/common';
import { Role } from '../../generated/prisma/client';
import { OWNER_ROLE_KEY } from './permissions';
import { effectivePermissions, StaffAccess, StaffRoleGrant } from './staff-access';

type RoleShape = Pick<StaffRoleGrant, 'key' | 'permissions'>;

function missingPermissions(actor: StaffAccess, permissions: readonly string[]): string[] {
  return permissions.filter((permission) => !actor.permissions.has(permission as never));
}

/**
 * Rules for touching a staff account (IAM-10/USR-03): staff.manage is needed, only an Owner may act on an Owner, and
 * nobody may act on staff holding a permission the actor lacks. Customers (no role) need nothing beyond the guard.
 */
export function assertMayManageStaff(actor: StaffAccess, target: RoleShape | null | undefined, action: string): void {
  if (!target) return;
  if (!actor.permissions.has('staff.manage')) {
    throw new ForbiddenException(`Staff accounts can only be ${action} by someone with the staff.manage permission`);
  }
  if (target.key === OWNER_ROLE_KEY && actor.roleKey !== OWNER_ROLE_KEY) {
    throw new ForbiddenException(`Owner accounts can only be ${action} by an Owner`);
  }
  const missing = missingPermissions(actor, effectivePermissions(target));
  if (missing.length > 0) {
    throw new ForbiddenException(
      `Staff with permissions you do not hold cannot be ${action} by you: ${missing.join(', ')}`,
    );
  }
}

/** No privilege escalation: the actor may only grant a role whose permissions they all hold, and only an Owner grants Owner. */
export function assertMayGrantRole(actor: StaffAccess, role: RoleShape): void {
  if (!actor.permissions.has('staff.manage')) {
    throw new ForbiddenException('Assigning staff roles needs the staff.manage permission');
  }
  if (role.key === OWNER_ROLE_KEY && actor.roleKey !== OWNER_ROLE_KEY) {
    throw new ForbiddenException('Only an Owner can assign the Owner role');
  }
  assertHoldsPermissions(actor, effectivePermissions(role), `assign the ${role.key} role`);
}

/** Custom roles may only contain permissions the actor holds, before and after the change. */
export function assertHoldsPermissions(actor: StaffAccess, permissions: readonly string[], action: string): void {
  const missing = missingPermissions(actor, permissions);
  if (missing.length > 0) {
    throw new ForbiddenException(`You cannot ${action}: you do not hold ${missing.join(', ')}`);
  }
}

/** The legacy User.role kept in step for old clients: Owner -> SUPER_ADMIN, any other staff role -> ADMIN, none -> USER. */
export function legacyRoleFor(roleKey: string | null | undefined): Role {
  if (!roleKey) return Role.USER;
  return roleKey === OWNER_ROLE_KEY ? Role.SUPER_ADMIN : Role.ADMIN;
}
