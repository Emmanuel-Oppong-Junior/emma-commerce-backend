import { PaymentProvider, PaymentStatus, Role } from '../../src/generated/prisma/client';
import { genSalt, hash } from 'bcrypt';
import { PrismaService } from '../../src/prisma/prisma.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STAFF_ROLES_MIGRATION = join(__dirname, '../../prisma/migrations/20261120100000_staff_roles/migration.sql');

/** The staff_roles migration's backfill statement (SUPER_ADMIN -> Owner, ADMIN -> Manager), exactly as deployed. */
export function staffMembershipBackfillSql(): string {
  const sql = readFileSync(STAFF_ROLES_MIGRATION, 'utf8');
  const start = sql.indexOf('-- Backfill');
  if (start < 0) throw new Error(`No "-- Backfill" section in ${STAFF_ROLES_MIGRATION}`);
  return sql.slice(start);
}

/**
 * Gives every ADMIN / SUPER_ADMIN user created directly in the database the staff membership the migration backfill
 * gives existing staff, since permissions now come from memberships, not User.role.
 */
export async function grantStaffMemberships(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(staffMembershipBackfillSql());
}

/**
 * Deletes all rows from every table in dependency order (children first, parents last).
 * Safe to call before each test suite to guarantee a clean database state.
 *
 * @param prisma - The PrismaService instance from the test module.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  // Leaf-level audit / usage tables
  await prisma.inventoryLog.deleteMany();
  await prisma.couponUsage.deleteMany();

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

  // Product hierarchy (variants before products; implicit join-table rows cascade)
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();

  // Catalogue
  await prisma.discount.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.subCategory.deleteMany();
  await prisma.category.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.tag.deleteMany();

  // User-adjacent tables (must precede user deletion due to Restrict FK on order→user)
  await prisma.address.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.authProvider.deleteMany();
  await prisma.refreshToken.deleteMany();

  // Independent reference data
  await prisma.tax.deleteMany();
  await prisma.shippingZone.deleteMany();
  await prisma.pickupLocation.deleteMany();

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
    'TRUNCATE "Refund", "CashCollection", "PaymentAttempt", "PaymentIntent", "WebhookEvent"',
  );
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
      status: attempt.status === PaymentStatus.COMPLETED ? 'PAID' : 'PENDING',
    },
    update: attempt.status === PaymentStatus.COMPLETED ? { status: 'PAID' } : {},
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
}

/**
 * Seeds the minimum set of records required across all e2e test suites:
 * three users (super admin, admin, regular user), one brand, one category,
 * two published products, one DRAFT product, one inactive product and shipping zones
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

  await grantStaffMemberships(prisma);

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
        price: 999.99,
        sku: 'SEED-LAP-001',
        quantity: 50,
        images: ['laptop.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod2',
        name: 'Phone',
        price: 499.99,
        sku: 'SEED-PHN-001',
        quantity: 100,
        images: ['phone.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod_draft',
        name: 'Unreleased Tablet',
        price: 299.99,
        sku: 'SEED-TAB-DRAFT',
        quantity: 10,
        images: [],
        isActive: true,
        status: 'DRAFT',
        categoryId: category.id,
        brandId: brand.id,
      },
      {
        id: 'seed_prod_inactive',
        name: 'Discontinued Watch',
        price: 199.99,
        sku: 'SEED-WAT-OFF',
        quantity: 5,
        images: [],
        isActive: false,
        status: 'PUBLISHED',
        categoryId: category.id,
        brandId: brand.id,
      },
    ],
  });

  // Shipping zones covering the cities the e2e suites deliver to
  await prisma.shippingZone.createMany({
    data: [
      { id: 'seed_zone_accra', name: 'Greater Accra', cities: ['accra', 'tema'], fee: 15 },
      { id: 'seed_zone_ashanti', name: 'Ashanti', cities: ['kumasi'], fee: 30 },
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
  };
}
