import { ALL_PERMISSIONS, isPermission, OWNER_ROLE_KEY, Permission } from './permissions';

export interface StaffRoleGrant {
  key: string;
  permissions: readonly string[];
  mfaRequired: boolean;
}

/** What the signed-in user may do, resolved once per request from their staff membership. */
export interface StaffAccess {
  roleKey: string | null;
  permissions: ReadonlySet<Permission>;
  mfaRequired: boolean;
}

export const CUSTOMER_ACCESS: StaffAccess = { roleKey: null, permissions: new Set(), mfaRequired: false };

/** The Owner holds every permission in the catalogue, including ones added after its row was seeded. */
export function effectivePermissions(role: Pick<StaffRoleGrant, 'key' | 'permissions'>): Permission[] {
  if (role.key === OWNER_ROLE_KEY) return [...ALL_PERMISSIONS];
  return ALL_PERMISSIONS.filter((permission) => role.permissions.includes(permission));
}

export function staffAccessFor(role: StaffRoleGrant | null | undefined): StaffAccess {
  if (!role) return CUSTOMER_ACCESS;
  return { roleKey: role.key, permissions: new Set(effectivePermissions(role)), mfaRequired: role.mfaRequired };
}

export function hasPermission(access: StaffAccess | undefined, permission: Permission): boolean {
  return !!access?.permissions.has(permission);
}

/** Permission strings that are not in the catalogue, for validating custom role input. */
export function unknownPermissions(values: readonly string[]): string[] {
  return values.filter((value) => !isPermission(value));
}
