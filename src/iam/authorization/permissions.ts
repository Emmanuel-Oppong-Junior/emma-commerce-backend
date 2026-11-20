export const PERMISSION_CATALOGUE = {
  'catalog.product.read': 'See products in every status (drafts, archived) in the admin catalogue',
  'catalog.product.write': 'Create, edit, archive and delete products and variants, and tag products',
  'catalog.taxonomy.write': 'Create, edit and delete brands, categories, sub-categories, tags and product types',
  'catalog.media.upload': 'Upload catalogue images',
  'inventory.view': 'Read inventory logs',
  'inventory.adjust': 'Restock and adjust product and variant stock',
  'order.view': 'Read every order',
  'order.manage': 'Change order status and shipping, cancel and delete orders',
  'order.refund': 'Approve returns with a refund amount and send refunds',
  'return.manage': 'Read and reject return requests',
  'payment.view': 'Read payments and refunds of every customer',
  'payment.record': 'Record cash collected for cash-on-delivery orders',
  'payment.manage': 'Soft-delete and restore payment records',
  'promotion.manage': 'Manage discounts and coupons',
  'tax.manage': 'Manage tax rates',
  'shipping.manage': 'Manage shipping zones and pickup locations',
  'review.moderate': 'Delete any customer review',
  'user.view': 'Read customer accounts and their addresses',
  'user.manage': 'Edit, archive, restore and delete customer accounts',
  'customer.data.export': 'Export every customer address at once',
  'staff.view': 'Read staff roles, permissions and memberships',
  'staff.manage': 'Create accounts, assign and remove staff roles, manage custom roles and staff accounts',
  'report.view': 'Read sales reports and the dashboard',
  'store.settings.manage': 'Change the store settings',
  'jobs.manage': 'Read and retry failed background jobs',
} as const;

export type Permission = keyof typeof PERMISSION_CATALOGUE;

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOGUE) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSION_CATALOGUE, value);
}

export const OWNER_ROLE_KEY = 'OWNER';
export const MANAGER_ROLE_KEY = 'MANAGER';
