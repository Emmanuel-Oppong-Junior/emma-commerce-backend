export const PERMISSION_CATALOGUE = {
  'catalog.product.read': 'See products in every status (drafts, archived) in the admin catalogue',
  'catalog.product.write': 'Create, edit, archive and delete products and variants, and tag products',
  'catalog.taxonomy.write': 'Create, edit and delete brands, categories, sub-categories, tags and product types',
  'catalog.media.upload': 'Upload catalogue images',
  'inventory.view': 'Read stock levels and the stock ledger',
  'inventory.adjust': 'Restock and adjust product and variant stock',
  'inventory.location.manage': 'Manage stock locations and which of them fulfil each shipping zone and pickup point',
  'inventory.transfer': 'Create, dispatch, receive and cancel stock transfers between locations',
  'order.view': 'Read every order',
  'order.manage': 'Cancel and delete orders',
  'order.fulfil': 'Move shipments through picking, packing, dispatch and delivery, and set carrier and tracking',
  'order.refund': 'Approve returns with a refund amount and send refunds',
  'return.manage': 'Read and reject return requests',
  'payment.view': 'Read payments and refunds of every customer',
  'payment.record': 'Record cash collected for cash-on-delivery orders',
  'payment.manage': 'Soft-delete and restore payment records',
  'payment.dispute.manage': 'Record chargebacks and disputes, add evidence notes and change their status',
  'cod.cash.manage': 'Record cash riders hand to the store (remittances) and read the cash-on-delivery cash report',
  'payment.settings.manage': 'Set the payment provider keys and switch payment methods on or off (Owner only)',
  'promotion.manage': 'Manage promotions, coupon codes and their redemptions',
  'customer.group.manage': 'Manage customer groups and their members',
  'pricelist.manage': 'Manage B2B price lists and their entries (what members of customer groups pay)',
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
