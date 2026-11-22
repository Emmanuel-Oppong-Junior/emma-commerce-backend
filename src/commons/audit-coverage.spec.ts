import { RESOLVER_NAME_METADATA, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS_KEY } from '../iam/authorization/policy.decorators';

const SRC_DIR = join(__dirname, '..');

// Each entry names the unit spec that proves the mutation writes its audit row in the same transaction.
const AUDITED: Record<string, string> = {
  createUser: 'users.service.spec (audit trail)',
  updateUser: 'users.service.spec (audit trail)',
  removeUser: 'users.service.spec (audit trail)',
  archiveUser: 'users.service.spec (audit trail)',
  deArchiveUser: 'users.service.spec (audit trail)',
  approveReturn: 'returns.service.spec',
  rejectReturn: 'returns.service.spec',
  processRefund: 'refunds.service.spec (claim, outcome and return audit rows)',
  processPendingRefund: 'refunds.service.spec',
  refundOrder: 'refunds.service.spec (CREATE, or REFUND for cash, then the send audit rows)',
  createProduct: 'products.service.spec (audit trail)',
  updateProduct: 'products.service.spec (audit trail)',
  permanentlyDeleteProduct: 'products.service.spec (audit trail)',
  archiveProduct: 'products.service.spec (audit trail)',
  restoreProduct: 'products.service.spec (audit trail)',
  addTagToProduct: 'products.service.spec (audit trail)',
  removeTagFromProduct: 'products.service.spec (audit trail)',
  createVariant: 'variant.service.spec (audit trail)',
  updateVariant: 'variant.service.spec (audit trail)',
  deleteVariant: 'variant.service.spec (audit trail)',
  createProductType: 'product-types.service.spec (audit trail)',
  updateProductType: 'product-types.service.spec (audit trail)',
  deleteProductType: 'product-types.service.spec (audit trail)',
  addAttributeDefinition: 'product-types.service.spec (audit trail)',
  updateAttributeDefinition: 'product-types.service.spec (audit trail)',
  removeAttributeDefinition: 'product-types.service.spec (audit trail)',
  createPromotion: 'promotions.service.spec (audit trail)',
  updatePromotion: 'promotions.service.spec (audit trail)',
  deletePromotion: 'promotions.service.spec (audit trail)',
  createCouponCode: 'promotions.service.spec (audit trail)',
  updateCouponCode: 'promotions.service.spec (audit trail)',
  deleteCouponCode: 'promotions.service.spec (audit trail)',
  createCustomerGroup: 'customer-groups.service.spec (audit trail)',
  updateCustomerGroup: 'customer-groups.service.spec (audit trail)',
  deleteCustomerGroup: 'customer-groups.service.spec (audit trail)',
  addCustomerGroupMembers: 'customer-groups.service.spec (audit trail)',
  removeCustomerGroupMembers: 'customer-groups.service.spec (audit trail)',
  createPriceList: 'price-lists.e2e-spec (audit trail)',
  updatePriceList: 'price-lists.e2e-spec (audit trail)',
  deletePriceList: 'price-lists.e2e-spec (audit trail)',
  setPriceListEntries: 'price-lists.e2e-spec (audit trail)',
  removePriceListEntries: 'price-lists.e2e-spec (audit trail)',
  createTax: 'tax.service.spec',
  updateTax: 'tax.service.spec',
  deleteTax: 'tax.service.spec',
  createShippingZone: 'shipping-zones.service.spec (audit trail)',
  updateShippingZone: 'shipping-zones.service.spec (audit trail)',
  deleteShippingZone: 'shipping-zones.service.spec (audit trail)',
  createPickupLocation: 'pickup-locations.service.spec (audit trail)',
  updatePickupLocation: 'pickup-locations.service.spec (audit trail)',
  deletePickupLocation: 'pickup-locations.service.spec (audit trail)',
  restockVariant: 'inventory.service.spec (audit trail)',
  adjustVariantStock: 'inventory.service.spec (audit trail)',
  updateShipmentStatus: 'order.service.spec (updateShipmentStatus)',
  adminCancelOrder: 'order.service.spec',
  deleteOrder: 'order.service.spec',
  updateShipping: 'order.service.spec',
  recordCodPayment: 'payment.service.spec (recordCodPayment)',
  updateStoreSettings: 'store.service.spec',
  // Not transactional (the job lives in Redis): the audit row is written right after the retry succeeds.
  retryFailedJob: 'failed-jobs.service.spec',
  setPaystackConfig: 'payment-settings.service.spec (audited without the secret)',
  removePaystackConfig: 'payment-settings.service.spec',
  updatePaymentMethods: 'payment-settings.service.spec',
  updateVelocityLimits: 'velocity.service.spec (updateLimits)',
  clearOrderReviewFlags: 'velocity.service.spec (clears flags with an audit row)',
  updateCodRiskSettings: 'cod-risk.service.spec (audits the changed limits); cod-risk.e2e-spec',
  setShippingZoneCashOnDelivery: 'cod-risk.e2e-spec (zone gate)',
  addCodBlacklistEntry: 'cod-risk.e2e-spec (blacklist management)',
  removeCodBlacklistEntry: 'cod-risk.e2e-spec (blacklist management)',
  recordDispute: 'disputes.service.spec (staff changes)',
  updateDisputeStatus: 'disputes.service.spec (staff changes)',
  addDisputeNote: 'disputes.service.spec (staff changes)',
  assignStaffRole: 'staff.service.spec (audit trail)',
  removeStaffRole: 'staff.service.spec (audit trail)',
  createStaffRole: 'staff.service.spec (audit trail)',
  updateStaffRole: 'staff.service.spec (audit trail)',
};

// Privileged mutations deliberately left unaudited, with the reason. Adding to this list is a reviewed decision.
const PAYMENT_FOLLOW_UP = 'payment module is reworked separately; soft delete and restore are not yet audited';
const CATALOGUE_FOLLOW_UP = 'catalogue taxonomy or moderation, no price, stock or access impact; not in P0-D.1 scope';
const NOT_AUDITED: Record<string, string> = {
  softDeletePayment: PAYMENT_FOLLOW_UP,
  restorePayment: PAYMENT_FOLLOW_UP,
  createBrand: CATALOGUE_FOLLOW_UP,
  updateBrand: CATALOGUE_FOLLOW_UP,
  deleteBrand: CATALOGUE_FOLLOW_UP,
  createCategory: CATALOGUE_FOLLOW_UP,
  updateCategory: CATALOGUE_FOLLOW_UP,
  removeCategory: CATALOGUE_FOLLOW_UP,
  createSubCategory: CATALOGUE_FOLLOW_UP,
  updateSubCategory: CATALOGUE_FOLLOW_UP,
  removeSubCategory: CATALOGUE_FOLLOW_UP,
  createTag: CATALOGUE_FOLLOW_UP,
  updateTag: CATALOGUE_FOLLOW_UP,
  deleteTag: CATALOGUE_FOLLOW_UP,
  addProductsToTag: CATALOGUE_FOLLOW_UP,
  removeProductsFromTag: CATALOGUE_FOLLOW_UP,
  adminDeleteReview: CATALOGUE_FOLLOW_UP,
};

type ClassRef = { prototype: object; name: string };

async function loadResolverClasses(): Promise<ClassRef[]> {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.resolver.ts'));
  const modules: Record<string, unknown>[] = await Promise.all(files.map((file) => import(join(SRC_DIR, file))));
  return modules.flatMap((exports) =>
    Object.values(exports).filter(
      (value): value is ClassRef => typeof value === 'function' && value.name.endsWith('Resolver'),
    ),
  );
}

function privilegedMutations(resolvers: ClassRef[]): string[] {
  return resolvers.flatMap((cls) => {
    const classPermissions: string[] | undefined = Reflect.getMetadata(PERMISSIONS_KEY, cls);
    return Object.getOwnPropertyNames(cls.prototype).flatMap((key) => {
      const method = (cls.prototype as Record<string, unknown>)[key];
      if (typeof method !== 'function' || Reflect.getMetadata(RESOLVER_TYPE_METADATA, method) !== 'Mutation') return [];
      const permissions: string[] | undefined = Reflect.getMetadata(PERMISSIONS_KEY, method) ?? classPermissions;
      if (!permissions?.length) return [];
      return [Reflect.getMetadata(RESOLVER_NAME_METADATA, method) ?? key];
    });
  });
}

describe('Audit coverage of privileged mutations', () => {
  let mutations: string[];

  beforeAll(async () => {
    mutations = privilegedMutations(await loadResolverClasses());
  });

  it('finds the admin-only mutations it is meant to check', () => {
    expect(mutations).toEqual(expect.arrayContaining(['processRefund', 'updateUser', 'adjustVariantStock']));
  });

  it('classifies every admin-only mutation as audited or as a reviewed exemption', () => {
    const unclassified = mutations.filter((name) => !(name in AUDITED) && !(name in NOT_AUDITED));

    expect(unclassified).toEqual([]);
  });

  it('lists no audited mutation that no longer exists', () => {
    const stale = [...Object.keys(AUDITED), ...Object.keys(NOT_AUDITED)].filter((name) => !mutations.includes(name));

    expect(stale).toEqual([]);
  });
});
