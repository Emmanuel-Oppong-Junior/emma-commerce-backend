import { Role } from '@prisma/client';
import { genSalt, hash } from 'bcrypt';
import { PrismaService } from '../../src/prisma/prisma.service';

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
  await prisma.returnRequest.deleteMany();

  // Payment and order hierarchy
  await prisma.payment.deleteMany();
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
  await prisma.authProvider.deleteMany();
  await prisma.refreshToken.deleteMany();

  // Independent reference data
  await prisma.tax.deleteMany();

  // Users last (referenced by many tables above)
  await prisma.user.deleteMany();
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
  };
}

/**
 * Seeds the minimum set of records required across all e2e test suites:
 * three users (super admin, admin, regular user), one brand, one category,
 * and two products.
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
        categoryId: category.id,
        brandId: brand.id,
      },
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
    productIds: { prod1: 'seed_prod1', prod2: 'seed_prod2' },
  };
}
