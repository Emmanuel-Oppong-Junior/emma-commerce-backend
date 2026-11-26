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
  acceptReturnOutsidePolicy: 'returns.service.spec (CREATE audit row)',
  approveReturn: 'returns.service.spec',
  rejectReturn: 'returns.service.spec',
  receiveReturn: 'returns.service.spec',
  inspectReturn: 'returns.service.spec (with the restock movements)',
  exchangeReturn: 'returns.service.spec',
  refundReturn: 'refunds.service.spec (claim, outcome and return audit rows); returns.e2e-spec (item-level refund)',
  processPendingRefund: 'refunds.service.spec',
  refundOrder: 'refunds.service.spec (CREATE, or REFUND for cash, then the send audit rows)',
  createProduct: 'products.service.spec (audit trail)',
  createBanner: 'content.e2e-spec (Banner audit rows)',
  updateBanner: 'content.e2e-spec (Banner audit rows)',
  deleteBanner: 'content.e2e-spec (Banner audit rows)',
  createHomepageSection: 'content.e2e-spec (HomepageSection audit rows)',
  updateHomepageSection: 'content.e2e-spec (HomepageSection audit rows)',
  deleteHomepageSection: 'content.e2e-spec (HomepageSection audit rows)',
  createCollection: 'content.e2e-spec (Collection audit rows)',
  updateCollection: 'content.e2e-spec (Collection audit rows)',
  setCollectionProducts: 'content.e2e-spec (Collection audit rows)',
  deleteCollection: 'content.e2e-spec (Collection audit rows)',
  createPathRedirect: 'content.e2e-spec (PathRedirect audit rows)',
  deletePathRedirect: 'content.e2e-spec (PathRedirect audit rows)',
  createSearchSynonym: 'search-synonyms.service.spec, product-search.e2e-spec (CREATE, UPDATE, DELETE rows)',
  updateSearchSynonym: 'search-synonyms.service.spec (before and after)',
  deleteSearchSynonym: 'product-search.e2e-spec (synonym audit rows)',
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
  setProductTypeReturnPolicy: 'product-types.service.spec (audit trail)',
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
  openStockTake: 'stock-take.service.spec (audit trail)',
  recordStockTakeCounts: 'stock-take.service.spec (audit trail)',
  submitStockTake: 'stock-take.service.spec (audit trail)',
  approveStockTake: 'stock-take.service.spec (audit trail)',
  cancelStockTake: 'stock-take.service.spec (audit trail)',
  createTax: 'tax.service.spec',
  updateTax: 'tax.service.spec',
  deleteTax: 'tax.service.spec',
  createShippingZone: 'shipping-zones.service.spec (audit trail)',
  updateShippingZone: 'shipping-zones.service.spec (audit trail)',
  deleteShippingZone: 'shipping-zones.service.spec (audit trail)',
  createRateRule: 'shipping-zones.service.spec (audit trail)',
  updateRateRule: 'shipping-zones.service.spec (audit trail)',
  deleteRateRule: 'shipping-zones.service.spec (audit trail)',
  createDeliverySlot: 'delivery-slots.service.spec (audit trail)',
  updateDeliverySlot: 'delivery-slots.service.spec (audit trail)',
  deleteDeliverySlot: 'delivery-slots.service.spec (audit trail)',
  addDeliveryClosure: 'delivery-slots.service.spec (audit trail)',
  removeDeliveryClosure: 'delivery-slots.service.spec (audit trail)',
  createPickupLocation: 'pickup-locations.service.spec (audit trail)',
  updatePickupLocation: 'pickup-locations.service.spec (audit trail)',
  deletePickupLocation: 'pickup-locations.service.spec (audit trail)',
  restockVariant: 'inventory.service.spec (audit trail)',
  adjustVariantStock: 'inventory.service.spec (audit trail)',
  createStockLocation: 'fulfilment-locations.e2e-spec (CREATE audit row)',
  updateStockLocation: 'stock-locations.service.spec (update)',
  deleteStockLocation: 'stock-locations.service.spec (delete)',
  setShippingZoneFulfilmentLocations: 'stock-locations.service.spec (setFulfilmentLocations)',
  setPickupLocationFulfilmentLocations: 'stock-locations.service.spec (setFulfilmentLocations)',
  createStockTransfer: 'stock-transfers.service.spec (create)',
  dispatchStockTransfer: 'stock-transfers.service.spec (dispatch)',
  receiveStockTransfer: 'stock-transfers.service.spec (receive)',
  cancelStockTransfer: 'stock-transfers.service.spec (cancel)',
  createSupplier: 'purchasing.e2e-spec (supplier audit rows)',
  updateSupplier: 'purchasing.e2e-spec (supplier audit rows)',
  deleteSupplier: 'purchasing.e2e-spec (supplier audit rows)',
  createPurchaseOrder: 'purchasing.e2e-spec (purchase order audit rows)',
  updatePurchaseOrder: 'purchasing.e2e-spec (purchase order audit rows)',
  sendPurchaseOrder: 'purchasing.e2e-spec (purchase order audit rows)',
  receivePurchaseOrder: 'purchasing.e2e-spec (receipt audit row with lines)',
  cancelPurchaseOrder: 'purchasing.e2e-spec (purchase order audit rows)',
  closePurchaseOrder: 'purchasing.e2e-spec (purchase order audit rows)',
  setVariantCost: 'purchasing.e2e-spec (Variant UPDATE audit row)',
  updateShipmentStatus: 'shipments.service.spec (updateShipmentStatus)',
  createShipment: 'shipments.service.spec (createShipment), split-shipments.e2e-spec (audit rows)',
  cancelShipment: 'shipments.service.spec (cancelShipment), split-shipments.e2e-spec (audit rows)',
  assignShipmentItemSerials: 'serial-units.e2e-spec (SERIALS_ASSIGNED audit rows)',
  unassignShipmentItemSerials: 'serial-units.e2e-spec (SERIALS_UNASSIGNED audit row)',
  adminCancelOrder: 'order.service.spec',
  deleteOrder: 'order.service.spec',
  updateShipping: 'shipments.service.spec (updateShipping)',
  recordCodPayment: 'payment.service.spec (recordCodPayment)',
  assignShipmentRider: 'riders.service.spec (assign), riders.e2e-spec (audit rows)',
  unassignShipmentRider: 'riders.service.spec (unassign)',
  startMyDelivery: 'shipments.service.spec (moveAsRider)',
  failMyDelivery: 'shipments.service.spec (moveAsRider)',
  completeMyDelivery: 'proof-of-delivery.service.spec (PROOF_OF_DELIVERY audit row), proof-of-delivery.e2e-spec',
  completeDelivery: 'proof-of-delivery.service.spec (PROOF_OF_DELIVERY audit row), proof-of-delivery.e2e-spec',
  recordCashRemittance: 'cash.service.spec (recordRemittance)',
  updateStoreSettings: 'store.service.spec',
  applyProductImport: 'imports.service.spec (STATUS_CHANGE audit row), imports.e2e-spec',
  applyPriceImport: 'imports.service.spec (STATUS_CHANGE audit row), imports.e2e-spec',
  applyStockImport: 'imports.service.spec (STATUS_CHANGE audit row), imports.e2e-spec',
  cancelCatalogImport: 'imports.service.spec (STATUS_CHANGE audit row)',
  cancelStockImport: 'imports.service.spec (STATUS_CHANGE audit row)',
  setStoreFeature: 'store-features.service.spec (before and after on the change transaction); store-features.e2e-spec',
  // Not transactional (the job lives in Redis): the audit row is written right after the retry succeeds.
  retryFailedJob: 'failed-jobs.service.spec',
  // Not transactional either: the audit row is written right after the rebuild job is queued.
  rebuildAnalytics: 'analytics.service.spec (requestRebuild)',
  setPaystackConfig: 'payment-settings.service.spec (audited without the secret)',
  removePaystackConfig: 'payment-settings.service.spec',
  updatePaymentMethods: 'payment-settings.service.spec',
  updateVelocityLimits: 'velocity.service.spec (updateLimits)',
  clearOrderReviewFlags: 'velocity.service.spec (clears flags with an audit row)',
  adjustLoyaltyPoints: 'loyalty.service.spec (ledger change and audit row on one transaction)',
  updateLoyaltySettings: 'loyalty.service.spec (fields before and after)',
  hideReview: 'review.service.spec (moderation audit trail)',
  unhideReview: 'review.service.spec (moderation audit trail)',
  dismissReviewReports: 'review.service.spec (moderation audit trail)',
  replyToReview: 'review.service.spec (moderation audit trail)',
  answerProductQuestion: 'product-questions.service.spec (answers under the row lock with an audit row)',
  hideProductQuestion: 'product-questions.service.spec (hides and unhides with audit rows)',
  unhideProductQuestion: 'product-questions.service.spec (hides and unhides with audit rows)',
  dismissProductQuestionReports: 'product-questions.service.spec (dismisses reports with an audit row)',
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
  recordCustomerConsent:
    'Its own audit trail: the append-only consent ledger (ConsentEvent with source STAFF_REQUEST and the staff actorId), ' +
    'written in the same transaction (notification-preferences e2e)',
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
    expect(mutations).toEqual(expect.arrayContaining(['refundReturn', 'updateUser', 'adjustVariantStock']));
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
