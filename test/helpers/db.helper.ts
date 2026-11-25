import { PaymentProvider, PaymentStatus, Role } from '../../src/generated/prisma/client';
import { genSalt, hash } from 'bcrypt';
import { PrismaService } from '../../src/prisma/prisma.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMfaKey, sealSecret } from '../../src/iam/mfa/mfa-crypto';
import { TEST_TOTP_SEED } from './staff.helper';
import { ALL_VELOCITY_RULES } from '../../src/fraud/velocity-rules';

const STAFF_ROLES_MIGRATION = join(__dirname, '../../prisma/migrations/20261120100000_staff_roles/migration.sql');

/** The staff_roles migration's backfill statement (SUPER_ADMIN -> Owner, ADMIN -> Manager), exactly as deployed. */
export function staffMembershipBackfillSql(): string {
  const sql = readFileSync(STAFF_ROLES_MIGRATION, 'utf8');
  const start = sql.indexOf('-- Backfill');
  if (start < 0) throw new Error(`No "-- Backfill" section in ${STAFF_ROLES_MIGRATION}`);
  return sql.slice(start);
}

/**
 * Makes ADMIN / SUPER_ADMIN users created directly in the database usable as staff, as they would be in production:
 * the migration backfill gives them their membership (permissions come from memberships, not User.role), and those
 * whose role requires two-factor authentication are enrolled with TEST_TOTP_SEED (see signInWithPassword).
 */
export async function prepareStaffAccounts(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(staffMembershipBackfillSql());
  const key = parseMfaKey(process.env.MFA_ENCRYPTION_KEY ?? '');
  const unenrolled = await prisma.user.findMany({
    where: { mfaEnabledAt: null, storeMemberships: { some: { role: { mfaRequired: true } } } },
    select: { id: true },
  });
  for (const { id } of unenrolled) {
    await prisma.user.update({
      where: { id },
      data: { mfaSecret: sealSecret(key, TEST_TOTP_SEED, id), mfaEnabledAt: new Date(), mfaLastUsedStep: null },
    });
  }
}

/**
 * Deletes all rows from every table in dependency order (children first, parents last).
 * Safe to call before each test suite to guarantee a clean database state.
 *
 * @param prisma - The PrismaService instance from the test module.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  // Leaf-level usage tables (stock levels, reservations and movements go with their variants and orders)
  await prisma.redemption.deleteMany();

  // Serial units hold their order lines (their append-only history goes with them through the cascade)
  await prisma.serialUnit.deleteMany();

  // Payment and order hierarchy (refunds reference return requests)
  await clearPaymentLedger(prisma);
  await prisma.returnRequest.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();

  // Cart hierarchy
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();

  // User-owned collections
  await prisma.wishList.deleteMany();
  await prisma.review.deleteMany();

  // Stock-takes hold their location; their lines go with them
  await prisma.stockTake.deleteMany();

  // Product hierarchy (variants before products; implicit join-table rows cascade)
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();
  // Custom product types a test created (their attributes cascade); the seeded system types stay
  await prisma.productType.deleteMany({ where: { isSystem: false } });
  await prisma.productType.updateMany({ data: { returnable: true, returnWindowDays: null } });

  // Catalogue
  await prisma.priceList.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.subCategory.deleteMany();
  await prisma.category.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.searchSynonym.deleteMany();

  // User-adjacent tables (must precede user deletion due to Restrict FK on order→user)
  await prisma.address.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.authProvider.deleteMany();
  await prisma.refreshToken.deleteMany();

  // Store payment settings back to their defaults: no stored provider keys, every method on through Paystack
  await prisma.paymentProviderConfig.deleteMany();
  await prisma.store.updateMany({
    data: {
      cardPaymentsEnabled: true,
      mobileMoneyPaymentsEnabled: true,
      cashOnDeliveryEnabled: true,
      cardPaymentProvider: 'PAYSTACK',
      mobileMoneyPaymentProvider: 'PAYSTACK',
      returnWindowDays: 14,
      abandonedCartReminderDelayHours: 4,
      loyaltyEnabled: true,
      loyaltyEarnPointsPerCedi: 1,
      loyaltyRedeemPointsPerCedi: 100,
      loyaltyMinRedeemPoints: 500,
      loyaltyMaxRedeemPercent: 50,
      loyaltyPointsExpiryMonths: 12,
      referralReferrerPoints: 500,
      referralNewCustomerPoints: 500,
    },
  });
  await relaxVelocityLimits(prisma);
  await relaxCodRiskLimits(prisma);
  await prisma.codBlacklistEntry.deleteMany();

  // Independent reference data
  await prisma.tax.deleteMany();
  await prisma.deliverySlotBooking.deleteMany();
  await prisma.shippingZone.deleteMany();
  await prisma.pickupLocation.deleteMany();
  // Stock locations a test added (their levels, movements and reservations went with the variants and orders above)
  await prisma.stockTransfer.deleteMany();
  // Purchase orders hold their supplier and location (lines and receipts cascade)
  await prisma.purchaseOrder.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.stockLocation.deleteMany({ where: { isDefault: false } });

  // Users last (referenced by many tables above); their staff memberships cascade
  await prisma.user.deleteMany();
  // Custom staff roles a test created; the seeded system roles stay
  await prisma.staffRole.deleteMany({ where: { isSystem: false } });
}

/**
 * Empties the payment ledger. A database trigger forbids deleting ledger rows, and TRUNCATE does not fire
 * row-level delete triggers, so tests clear these tables with TRUNCATE.
 */
export async function clearPaymentLedger(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "DisputeNote", "DisputeEvent", "Dispute", "RefundLine", "Refund", "CashCollection", "CashRemittance", "PaymentAttempt", "PaymentIntent", "WebhookEvent"',
  );
}

/**
 * Puts the cash-on-delivery open-order and order-total caps out of reach: suites place many COD orders from one account.
 * cod-risk.e2e-spec sets the limits it tests.
 */
export async function relaxCodRiskLimits(prisma: PrismaService): Promise<void> {
  await prisma.store.updateMany({ data: { codMaxOpenOrdersPerPhone: 100, codMaxOrderTotal: 999_999_999 } });
}

/** Gives the user a verified phone number (P3-B.1), which cash-on-delivery checkouts require. */
export async function verifyPhoneForCod(
  prisma: PrismaService,
  userId = 'seed_user',
  phone = '+233244000000',
): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { phoneNumber: phone } });
  await prisma.user.update({
    where: { id: userId },
    data: { phoneVerifiedAt: new Date(), phoneVerifiedNumber: phone },
  });
}

/**
 * Puts every velocity limit out of reach. Suites place many orders and payments from one account and one IP within the
 * hour, and the counters in Redis outlive each file, so the defaults would refuse them; velocity.e2e-spec sets the
 * limits it tests.
 */
export async function relaxVelocityLimits(prisma: PrismaService): Promise<void> {
  const store = await prisma.store.findFirstOrThrow({ where: { singleton: true }, select: { id: true } });
  await prisma.velocityLimit.deleteMany();
  await prisma.velocityLimit.createMany({
    data: ALL_VELOCITY_RULES.map((rule) => ({ storeId: store.id, rule, softLimit: 1_000_000, hardLimit: 1_000_000 })),
  });
}

/** Inserts an active user with the system Rider staff role (P5-C.1), who can take cash for deliveries. */
export async function createRider(prisma: PrismaService, id: string, phoneNumber?: string): Promise<void> {
  const store = await prisma.store.findFirstOrThrow({ where: { singleton: true }, select: { id: true } });
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      name: `Rider ${id}`,
      phoneNumber,
      storeMemberships: { create: { storeId: store.id, roleId: 'staff_role_rider' } },
    },
  });
}

/** Takes the store's next order number the way OrdersRepository does, for orders inserted directly by a test. */
export async function takeOrderNumber(prisma: PrismaService): Promise<number> {
  const [{ orderNumber }] = await prisma.$queryRaw<{ orderNumber: number }[]>`
    UPDATE "Store" SET "nextOrderNumber" = "nextOrderNumber" + 1 WHERE "singleton"
    RETURNING "nextOrderNumber" - 1 AS "orderNumber"`;
  return orderNumber;
}

/** Inserts a payment attempt (and the order's payment intent if it has none) directly into the database. */
export async function seedPaymentAttempt(
  prisma: PrismaService,
  attempt: { orderId: string; status: PaymentStatus; reference?: string; amount?: number; updatedAt?: Date },
): Promise<{ paymentId: string; reference: string }> {
  const amount = attempt.amount ?? 100;
  const reference = attempt.reference ?? `ref-${attempt.orderId}-${Date.now()}`;
  const intent = await prisma.paymentIntent.upsert({
    where: { orderId: attempt.orderId },
    create: {
      orderId: attempt.orderId,
      amount,
      status: attempt.status === PaymentStatus.CAPTURED ? 'CAPTURED' : 'PENDING',
    },
    update: attempt.status === PaymentStatus.CAPTURED ? { status: 'CAPTURED' } : {},
  });
  const created = await prisma.paymentAttempt.create({
    data: {
      intentId: intent.id,
      provider: PaymentProvider.PAYSTACK,
      reference,
      amount,
      currency: 'GHS',
      channel: 'card',
      status: attempt.status,
      providerDetails: { reference },
      updatedAt: attempt.updatedAt,
    },
  });
  return { paymentId: created.id, reference };
}

/** Shape returned by `seedMinimal`, exposing the IDs of all seeded records. */
export interface SeedResult {
  userIds: {
    superAdminId: string;
    adminId: string;
    userId: string;
  };
  categoryId: string;
  brandId: string;
  productIds: {
    prod1: string;
    prod2: string;
    draft: string;
    inactive: string;
  };
  /** The default variant (SKU) of each seeded product: what carts and orders reference. */
  variantIds: {
    prod1: string;
    prod2: string;
    draft: string;
    inactive: string;
  };
}

/**
 * Seeds the minimum set of records required across all e2e test suites:
 * three users (super admin, admin, regular user), one brand, one category,
 * two published products, one DRAFT product, one inactive product (each with one default variant
 * seed_var1, seed_var2, seed_var_draft, seed_var_inactive) and shipping zones
 * covering Accra, Tema and Kumasi.
 *
 * Credentials used here mirror the constants in `auth.helper.ts`.
 *
 * @param prisma - The PrismaService instance from the test module.
 * @returns The IDs of every created record so tests can reference them directly.
 */
export async function seedMinimal(prisma: PrismaService): Promise<SeedResult> {
  const salt = await genSalt(10);

  const [superAdminHash, adminHash, userHash] = await Promise.all([
    hash('SuperAdmin@123', salt),
    hash('Admin@123', salt),
    hash('User@123', salt),
  ]);

  // Users
  await prisma.user.createMany({
    data: [
      {
        id: 'seed_super_admin',
        email: 'super_admin@example.com',
        password: superAdminHash,
        name: 'Super Admin',
        role: Role.SUPER_ADMIN,
      },
      {
        id: 'seed_admin',
        email: 'admin@example.com',
        password: adminHash,
        name: 'Admin User',
        role: Role.ADMIN,
      },
      {
        id: 'seed_user',
        email: 'user@example.com',
        password: userHash,
        name: 'Regular User',
        role: Role.USER,
      },
    ],
  });

  await prepareStaffAccounts(prisma);

  // Brand
  const brand = await prisma.brand.create({
    data: { id: 'seed_brand', name: 'Test Brand' },
  });

  // Category
  const category = await prisma.category.create({
    data: { id: 'seed_cat', name: 'Electronics' },
  });

  // Products
  await prisma.product.createMany({
    data: [
      {
        id: 'seed_prod1',
        name: 'Laptop',
        images: ['laptop.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod2',
        name: 'Phone',
        images: ['phone.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod_draft',
        name: 'Unreleased Tablet',
        images: [],
        isActive: true,
        status: 'DRAFT',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod_inactive',
        name: 'Discontinued Watch',
        images: [],
        isActive: false,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
    ],
  });

  // Every product sells through a variant: each seeded product has one default variant (no options) holding its price,
  // stocked at the default location with a RECEIPT movement each.
  await prisma.variant.createMany({
    data: [
      { id: 'seed_var1', productId: 'seed_prod1', sku: 'SEED-LAP-001', price: 999.99, basePrice: 999.99 },
      { id: 'seed_var2', productId: 'seed_prod2', sku: 'SEED-PHN-001', price: 499.99, basePrice: 499.99 },
      { id: 'seed_var_draft', productId: 'seed_prod_draft', sku: 'SEED-TAB-DRAFT', price: 299.99, basePrice: 299.99 },
      {
        id: 'seed_var_inactive',
        productId: 'seed_prod_inactive',
        sku: 'SEED-WAT-OFF',
        price: 199.99,
        basePrice: 199.99,
      },
    ],
  });
  await setStock(prisma, 'seed_var1', 50);
  await setStock(prisma, 'seed_var2', 100);
  await setStock(prisma, 'seed_var_draft', 10);
  await setStock(prisma, 'seed_var_inactive', 5);

  // Shipping zones covering the towns the e2e suites deliver to, each with a STANDARD rate
  await prisma.shippingZone.createMany({
    data: [
      { id: 'seed_zone_accra', name: 'Greater Accra' },
      { id: 'seed_zone_ashanti', name: 'Ashanti' },
    ],
  });
  await prisma.zoneArea.createMany({
    data: [
      { zoneId: 'seed_zone_accra', level: 'TOWN', town: 'accra', matchKey: 'TOWN:accra' },
      { zoneId: 'seed_zone_accra', level: 'TOWN', town: 'tema', matchKey: 'TOWN:tema' },
      { zoneId: 'seed_zone_ashanti', level: 'TOWN', town: 'kumasi', matchKey: 'TOWN:kumasi' },
    ],
  });
  await prisma.rateRule.createMany({
    data: [
      { id: 'seed_rate_accra', zoneId: 'seed_zone_accra', serviceLevel: 'STANDARD', baseFee: 15 },
      { id: 'seed_rate_ashanti', zoneId: 'seed_zone_ashanti', serviceLevel: 'STANDARD', baseFee: 30 },
    ],
  });

  return {
    userIds: {
      superAdminId: 'seed_super_admin',
      adminId: 'seed_admin',
      userId: 'seed_user',
    },
    categoryId: category.id,
    brandId: brand.id,
    productIds: { prod1: 'seed_prod1', prod2: 'seed_prod2', draft: 'seed_prod_draft', inactive: 'seed_prod_inactive' },
    variantIds: { prod1: 'seed_var1', prod2: 'seed_var2', draft: 'seed_var_draft', inactive: 'seed_var_inactive' },
  };
}

/** A variant's stock at every location, summed: what the ledger (ADR-0008) holds for it. */
export async function stockOf(
  prisma: PrismaService,
  variantId: string,
): Promise<{ onHand: number; reserved: number; available: number }> {
  const { _sum } = await prisma.stockLevel.aggregate({ where: { variantId }, _sum: { onHand: true, reserved: true } });
  const onHand = _sum.onHand ?? 0;
  const reserved = _sum.reserved ?? 0;
  return { onHand, reserved, available: onHand - reserved };
}

/**
 * Sets a variant's stock at the default location to `onHand` with nothing reserved, for fixtures (call it after the
 * orders holding reservations are gone). The level moves by the difference and a matching movement (RECEIPT up,
 * ADJUSTMENT otherwise) keeps the ledger reconciled.
 */
export async function setStock(prisma: PrismaService, variantId: string, onHand: number): Promise<void> {
  const { id: locationId } = await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } });
  await prisma.$transaction(async (tx) => {
    const level = await tx.stockLevel.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId },
      update: {},
    });
    const onHandDelta = onHand - level.onHand;
    const reservedDelta = -level.reserved;
    if (onHandDelta === 0 && reservedDelta === 0) return;
    await tx.stockLevel.update({ where: { id: level.id }, data: { onHand, reserved: 0, version: { increment: 1 } } });
    await tx.stockMovement.create({
      data: {
        variantId,
        locationId,
        onHandDelta,
        reservedDelta,
        reason: onHandDelta > 0 && reservedDelta === 0 ? 'RECEIPT' : 'ADJUSTMENT',
        note: 'Test fixture',
      },
    });
  });
}

/** Movements that gave an order's stock back (cancel or expiry): RELEASE of a hold, RETURN_RESTOCK of a sale. */
export function stockReturnsFor(prisma: PrismaService, orderId: string): Promise<number> {
  return prisma.stockMovement.count({
    where: { refType: 'Order', refId: orderId, reason: { in: ['RELEASE', 'RETURN_RESTOCK'] } },
  });
}
