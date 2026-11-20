import { Permission } from '../../src/iam/authorization/permissions';
import { StaffAccess, staffAccessFor } from '../../src/iam/authorization/staff-access';

/** The Manager role as the staff_roles migration seeds it: exactly what the legacy ADMIN role could do. */
export const MANAGER_PERMISSIONS: Permission[] = [
  'catalog.product.read',
  'catalog.product.write',
  'catalog.taxonomy.write',
  'catalog.media.upload',
  'inventory.view',
  'inventory.adjust',
  'order.view',
  'order.manage',
  'order.refund',
  'return.manage',
  'payment.view',
  'payment.record',
  'payment.manage',
  'promotion.manage',
  'tax.manage',
  'shipping.manage',
  'review.moderate',
  'user.view',
  'user.manage',
  'staff.view',
  'report.view',
];

/** Base32 TOTP seed of staff enrolled by prepareStaffAccounts; signInWithPassword computes codes from it. */
export const TEST_TOTP_SEED = 'JBSWY3DPEHPK3PXP';

export const OWNER_ROLE = { key: 'OWNER', permissions: [] as string[], mfaRequired: true };
export const MANAGER_ROLE = { key: 'MANAGER', permissions: MANAGER_PERMISSIONS, mfaRequired: true };

export const OWNER_ACCESS: StaffAccess = staffAccessFor(OWNER_ROLE);
export const MANAGER_ACCESS: StaffAccess = staffAccessFor(MANAGER_ROLE);

export function accessWith(...permissions: Permission[]): StaffAccess {
  return staffAccessFor({ key: 'CUSTOM', permissions, mfaRequired: false });
}
