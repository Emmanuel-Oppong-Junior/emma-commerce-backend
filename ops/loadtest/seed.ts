// Load-test data (P9-L): a realistic catalogue, customers with verified phones, staff report readers, a year of order
// history and analytics rollups. Every row has a deterministic id and is inserted with skipDuplicates, so a re-run
// adds only what is missing. Never point it at a database holding real data.
// Usage: DATABASE_URL=... LOAD_USER_PASSWORD=... npx ts-node --transpile-only ops/loadtest/seed.ts
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GhanaRegion, Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { optionsKey } from '../../src/product-types/domain/attribute-validation';

// Shared with the k6 scenarios, which derive slugs, emails and counts from the same file.
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8')) as {
  productCount: number;
  apparelEvery: number;
  sizes: string[];
  categoryCount: number;
  brandCount: number;
  customerCount: number;
  staffCount: number;
  historyOrders: number;
  historyDays: number;
  productSlug: string;
  customerEmail: string;
  staffEmail: string;
};
const PRODUCT_COUNT = fixtures.productCount;
const CATEGORY_COUNT = fixtures.categoryCount;
const BRAND_COUNT = fixtures.brandCount;
const CUSTOMER_COUNT = fixtures.customerCount;
const STAFF_COUNT = fixtures.staffCount;
const HISTORY_ORDERS = fixtures.historyOrders;
const HISTORY_DAYS = fixtures.historyDays;
const SIZES = fixtures.sizes;
const fill = (template: string, n: number) => template.replace('{n}', String(n));
const productSlug = (n: number) => fill(fixtures.productSlug, n);
const customerEmail = (n: number) => fill(fixtures.customerEmail, n);
const staffEmail = (n: number) => fill(fixtures.staffEmail, n);
const isApparel = (n: number) => n % fixtures.apparelEvery !== 0;

const databaseUrl = process.env.DATABASE_URL;
const password = process.env.LOAD_USER_PASSWORD;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
if (!password || password.length < 12) throw new Error('LOAD_USER_PASSWORD must be set (12+ characters)');
if (!/load/i.test(new URL(databaseUrl).pathname)) {
  throw new Error(`Refusing to seed "${new URL(databaseUrl).pathname}": the database name must contain "load"`);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const CHUNK = 2000;
const SECOND_LOCATION_ID = 'load_location_kumasi';
const REPORT_ROLE_ID = 'load_role_report_reader';
const TAG_COUNT = 30;
const SUBCATEGORIES_PER_CATEGORY = 3;
const REVIEWED_PRODUCTS = 1000;
const ROLLUP_VARIANTS_PER_DAY = 120;
const DAY_MS = 86_400_000;

// A small deterministic generator, so a re-run produces the same names, prices and stock.
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const random = seeded(20261220);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

const CATEGORY_NAMES = [
  'Phones',
  'Computers',
  'Television',
  'Audio',
  'Home Appliances',
  'Kitchen',
  'Fashion',
  'Shoes',
  'Beauty',
  'Groceries',
  'Baby',
  'Sports',
];
const NOUNS = ['Speaker', 'Kettle', 'Shirt', 'Sneaker', 'Blender', 'Phone', 'Laptop', 'Dress', 'Lotion', 'Ball'];
const ADJECTIVES = ['Classic', 'Smart', 'Premium', 'Compact', 'Kente', 'Urban', 'Solar', 'Deluxe', 'Everyday', 'Pro'];

async function inChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

async function seedTaxonomy() {
  await prisma.category.createMany({
    data: CATEGORY_NAMES.slice(0, CATEGORY_COUNT).map((name, i) => ({
      id: `load_cat_${i}`,
      name: `${name} (load)`,
      slug: `load-${name.toLowerCase().replace(/ /g, '-')}`,
    })),
    skipDuplicates: true,
  });
  const subcategories: Prisma.SubCategoryCreateManyInput[] = [];
  for (let c = 0; c < CATEGORY_COUNT; c++) {
    for (let s = 0; s < SUBCATEGORIES_PER_CATEGORY; s++) {
      subcategories.push({
        id: `load_sub_${c}_${s}`,
        name: `${CATEGORY_NAMES[c]} ${s + 1} (load)`,
        categoryId: `load_cat_${c}`,
      });
    }
  }
  await prisma.subCategory.createMany({ data: subcategories, skipDuplicates: true });
  await prisma.brand.createMany({
    data: Array.from({ length: BRAND_COUNT }, (_, i) => ({ id: `load_brand_${i}`, name: `Load Brand ${i}` })),
    skipDuplicates: true,
  });
  await prisma.tag.createMany({
    data: Array.from({ length: TAG_COUNT }, (_, i) => ({ id: `load_tag_${i}`, name: `load-tag-${i}` })),
    skipDuplicates: true,
  });
}

async function seedLocationsAndZones() {
  const store = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });
  const { id: defaultLocationId } = await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } });
  await prisma.stockLocation.createMany({
    data: [{ id: SECOND_LOCATION_ID, storeId: store.id, name: 'Kumasi warehouse (load)' }],
    skipDuplicates: true,
  });
  await prisma.shippingZone.createMany({
    data: [
      { id: 'load_zone_accra', name: 'Greater Accra (load)' },
      { id: 'load_zone_ashanti', name: 'Ashanti (load)' },
    ],
    skipDuplicates: true,
  });
  await prisma.zoneArea.createMany({
    data: [
      {
        id: 'load_area_accra',
        zoneId: 'load_zone_accra',
        level: 'REGION',
        region: 'GREATER_ACCRA',
        matchKey: 'REGION:GREATER_ACCRA',
      },
      {
        id: 'load_area_ashanti',
        zoneId: 'load_zone_ashanti',
        level: 'REGION',
        region: 'ASHANTI',
        matchKey: 'REGION:ASHANTI',
      },
    ],
    skipDuplicates: true,
  });
  await prisma.rateRule.createMany({
    data: [
      { id: 'load_rate_accra_std', zoneId: 'load_zone_accra', serviceLevel: 'STANDARD', baseFee: 20, freeAbove: 1500 },
      { id: 'load_rate_accra_exp', zoneId: 'load_zone_accra', serviceLevel: 'EXPRESS', baseFee: 45 },
      { id: 'load_rate_ashanti_std', zoneId: 'load_zone_ashanti', serviceLevel: 'STANDARD', baseFee: 35 },
    ],
    skipDuplicates: true,
  });
  await prisma.shippingZoneStockLocation.createMany({
    data: [
      { shippingZoneId: 'load_zone_accra', locationId: defaultLocationId, priority: 1 },
      { shippingZoneId: 'load_zone_ashanti', locationId: SECOND_LOCATION_ID, priority: 1 },
      { shippingZoneId: 'load_zone_ashanti', locationId: defaultLocationId, priority: 2 },
    ],
    skipDuplicates: true,
  });
  return { defaultLocationId, currency: store.currency };
}

interface SeededVariant {
  id: string;
  productId: string;
  name: string;
  price: Prisma.Decimal;
}

async function seedCatalogue(defaultLocationId: string, currency: Prisma.PriceChangeCreateManyInput['currency']) {
  const products: Prisma.ProductCreateManyInput[] = [];
  const variants: Prisma.VariantCreateManyInput[] = [];
  const levels: Prisma.StockLevelCreateManyInput[] = [];
  const movements: Prisma.StockMovementCreateManyInput[] = [];
  const priceChanges: Prisma.PriceChangeCreateManyInput[] = [];
  const productTags: Prisma.Sql[] = [];
  const seededVariants: SeededVariant[] = [];

  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const id = `load_prod_${i}`;
    const category = i % CATEGORY_COUNT;
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${i}`;
    const apparel = isApparel(i);
    products.push({
      id,
      name,
      slug: productSlug(i),
      description: `${name}: a load-test product in ${CATEGORY_NAMES[category]}. Durable, affordable and sold across Ghana.`,
      shortDescription: `${name} for everyday use`,
      isActive: true,
      status: 'PUBLISHED',
      publishedAt: new Date(Date.now() - between(1, 365) * DAY_MS),
      categoryId: `load_cat_${category}`,
      subcategoryId: `load_sub_${category}_${i % SUBCATEGORIES_PER_CATEGORY}`,
      brandId: `load_brand_${i % BRAND_COUNT}`,
      productTypeId: apparel ? 'product_type_apparel' : 'product_type_general',
      images: [`https://res.cloudinary.com/demo/image/upload/load/${i}.jpg`],
    });
    productTags.push(Prisma.sql`(${id}, ${`load_tag_${i % TAG_COUNT}`})`);

    const options = apparel ? SIZES.map((size) => ({ size })) : [{}];
    const basePrice = between(10, 900);
    options.forEach((optionValues, v) => {
      const variantId = `load_var_${i}_${v}`;
      const price = new Prisma.Decimal(basePrice + v * 5);
      variants.push({
        id: variantId,
        productId: id,
        sku: `LOAD-${i}-${v}`,
        price,
        basePrice: price,
        optionValues,
        optionsKey: optionsKey(optionValues),
        weightGrams: between(100, 5000),
      });
      seededVariants.push({ id: variantId, productId: id, name, price });
      for (const locationId of [defaultLocationId, SECOND_LOCATION_ID]) {
        const onHand = between(300, 1000);
        levels.push({ variantId, locationId, onHand });
        movements.push({
          id: `load_mv_${variantId}_${locationId}`,
          variantId,
          locationId,
          onHandDelta: onHand,
          reason: 'RECEIPT',
          note: 'Load-test seed stock',
        });
      }
      for (const field of ['BASE_PRICE', 'PRICE'] as const) {
        priceChanges.push({
          id: `load_pc_${variantId}_${field}`,
          variantId,
          field,
          newValue: price,
          currency,
          source: 'VARIANT_CREATED',
        });
      }
    });
  }

  await inChunks(products, (data) => prisma.product.createMany({ data, skipDuplicates: true }));
  await inChunks(variants, (data) => prisma.variant.createMany({ data, skipDuplicates: true }));
  await inChunks(levels, (data) => prisma.stockLevel.createMany({ data, skipDuplicates: true }));
  await inChunks(movements, (data) => prisma.stockMovement.createMany({ data, skipDuplicates: true }));
  await inChunks(priceChanges, (data) => prisma.priceChange.createMany({ data, skipDuplicates: true }));
  await inChunks(
    productTags,
    (rows) =>
      prisma.$executeRaw`INSERT INTO "_ProductToTag" ("A", "B") VALUES ${Prisma.join(rows)} ON CONFLICT DO NOTHING`,
  );
  return seededVariants;
}

async function seedPromotions() {
  const startsAt = new Date(Date.now() - 30 * DAY_MS);
  const endsAt = new Date(Date.now() + 365 * DAY_MS);
  const promotions: Prisma.PromotionCreateInput[] = [
    {
      id: 'load_promo_phones',
      name: '10% off phones (load)',
      scope: 'CATEGORY',
      type: 'PERCENT',
      value: 10,
      startsAt,
      endsAt,
      isActive: true,
      categories: { connect: [{ id: 'load_cat_0' }] },
    },
    {
      id: 'load_promo_brand',
      name: 'GHS 15 off Load Brand 3 (load)',
      scope: 'BRAND',
      type: 'AMOUNT_OFF',
      value: 15,
      startsAt,
      endsAt,
      isActive: true,
      brands: { connect: [{ id: 'load_brand_3' }] },
    },
    {
      id: 'load_promo_bxgy',
      name: 'Buy 2 shoes get 1 half price (load)',
      scope: 'CATEGORY',
      type: 'BXGY',
      value: 50,
      buyQuantity: 2,
      getQuantity: 1,
      startsAt,
      endsAt,
      isActive: true,
      categories: { connect: [{ id: 'load_cat_7' }] },
    },
    {
      id: 'load_promo_cart',
      name: '5% off orders over GHS 500 (load)',
      scope: 'CART',
      type: 'PERCENT',
      value: 5,
      minimumSpend: 500,
      startsAt,
      endsAt,
      isActive: true,
      stackingGroup: 'cart',
    },
  ];
  for (const promotion of promotions) {
    await prisma.promotion.upsert({ where: { id: promotion.id as string }, create: promotion, update: {} });
  }
}

async function seedContent() {
  const manual = Array.from({ length: 2 }, (_, c) => ({
    id: `load_collection_manual_${c}`,
    name: `Featured ${c + 1} (load)`,
    slug: `load-featured-${c + 1}`,
    type: 'MANUAL' as const,
  }));
  await prisma.collection.createMany({
    data: [
      ...manual,
      {
        id: 'load_collection_rule_0',
        name: 'All phones (load)',
        slug: 'load-all-phones',
        type: 'RULE',
        rules: { categoryId: 'load_cat_0' },
      },
      {
        id: 'load_collection_rule_1',
        name: 'Load Brand 5 picks (load)',
        slug: 'load-brand-5-picks',
        type: 'RULE',
        rules: { brandId: 'load_brand_5', inStock: true },
      },
    ],
    skipDuplicates: true,
  });
  await prisma.collectionProduct.createMany({
    data: manual.flatMap((collection, c) =>
      Array.from({ length: 24 }, (_, position) => ({
        collectionId: collection.id,
        productId: `load_prod_${c * 100 + position * 3}`,
        position,
      })),
    ),
    skipDuplicates: true,
  });
  await prisma.homepageSection.createMany({
    data: [
      {
        id: 'load_home_0',
        type: 'PRODUCT_CAROUSEL',
        title: 'Featured',
        position: 0,
        config: { collectionId: 'load_collection_manual_0', productLimit: 12 },
      },
      {
        id: 'load_home_1',
        type: 'CATEGORY_GRID',
        title: 'Shop by category',
        position: 1,
        config: { categoryIds: Array.from({ length: 8 }, (_, i) => `load_cat_${i}`) },
      },
      {
        id: 'load_home_2',
        type: 'PRODUCT_CAROUSEL',
        title: 'Phones',
        position: 2,
        config: { collectionId: 'load_collection_rule_0', productLimit: 12 },
      },
      {
        id: 'load_home_3',
        type: 'BRAND_STRIP',
        title: 'Brands',
        position: 3,
        config: { brandIds: Array.from({ length: 10 }, (_, i) => `load_brand_${i}`) },
      },
      {
        id: 'load_home_4',
        type: 'PRODUCT_CAROUSEL',
        title: 'Picks',
        position: 4,
        config: { collectionId: 'load_collection_manual_1', productLimit: 12 },
      },
    ],
    skipDuplicates: true,
  });
}

async function seedPeople() {
  const passwordHash = await bcrypt.hash(password as string, 10);
  const verifiedAt = new Date(Date.now() - 30 * DAY_MS);
  const customers: Prisma.UserCreateManyInput[] = [];
  const addresses: Prisma.AddressCreateManyInput[] = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const phone = `+23324${String(1_000_000 + i)}`;
    const accra = i % 3 !== 0;
    customers.push({
      id: `load_customer_${i}`,
      email: customerEmail(i),
      name: `Load Customer ${i}`,
      password: passwordHash,
      phoneNumber: phone,
      phoneVerifiedAt: verifiedAt,
      phoneVerifiedNumber: phone,
      emailVerifiedAt: verifiedAt,
    });
    addresses.push({
      id: `load_address_${i}`,
      userId: `load_customer_${i}`,
      recipientName: `Load Customer ${i}`,
      phone,
      region: accra ? GhanaRegion.GREATER_ACCRA : GhanaRegion.ASHANTI,
      street: `${i} Independence Avenue`,
      city: accra ? 'Accra' : 'Kumasi',
      area: accra ? 'Osu' : 'Adum',
      country: 'Ghana',
    });
  }
  await inChunks(customers, (data) => prisma.user.createMany({ data, skipDuplicates: true }));
  await inChunks(addresses, (data) => prisma.address.createMany({ data, skipDuplicates: true }));

  // Reading orders and reports needs no two-factor sign-in, which a load script cannot complete.
  await prisma.staffRole.createMany({
    data: [
      {
        id: REPORT_ROLE_ID,
        key: 'LOAD_REPORT_READER',
        name: 'Report reader (load test)',
        permissions: ['order.view', 'report.view'],
        mfaRequired: false,
      },
    ],
    skipDuplicates: true,
  });
  const store = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });
  await prisma.user.createMany({
    data: Array.from({ length: STAFF_COUNT }, (_, i) => ({
      id: `load_staff_${i}`,
      email: staffEmail(i),
      name: `Load Staff ${i}`,
      password: passwordHash,
      role: 'ADMIN' as const,
    })),
    skipDuplicates: true,
  });
  await prisma.storeMembership.createMany({
    data: Array.from({ length: STAFF_COUNT }, (_, i) => ({
      id: `load_membership_${i}`,
      userId: `load_staff_${i}`,
      storeId: store.id,
      roleId: REPORT_ROLE_ID,
    })),
    skipDuplicates: true,
  });
}

async function seedReviews() {
  const reviews: Prisma.ReviewCreateManyInput[] = [];
  for (let p = 0; p < REVIEWED_PRODUCTS; p++) {
    const count = 5 + (p % 16);
    for (let r = 0; r < count; r++) {
      reviews.push({
        id: `load_review_${p}_${r}`,
        productId: `load_prod_${p}`,
        userId: `load_customer_${(p * 7 + r) % CUSTOMER_COUNT}`,
        score: between(2, 5),
        title: 'Load-test review',
        comment: 'Arrived on time and works as described.',
        createdAt: new Date(Date.now() - between(1, 300) * DAY_MS),
      });
    }
  }
  await inChunks(reviews, (data) => prisma.review.createMany({ data, skipDuplicates: true }));
  // The rating summary columns are maintained by the review service; recompute them from the rows just written.
  await prisma.$executeRaw`
    UPDATE "Product" p SET
      "ratingCount" = s.n, "ratingAverage" = s.avg,
      "rating1Count" = s.c1, "rating2Count" = s.c2, "rating3Count" = s.c3, "rating4Count" = s.c4, "rating5Count" = s.c5
    FROM (
      SELECT "productId", count(*)::int AS n, round(avg(score)::numeric, 2) AS avg,
        count(*) FILTER (WHERE score = 1)::int AS c1, count(*) FILTER (WHERE score = 2)::int AS c2,
        count(*) FILTER (WHERE score = 3)::int AS c3, count(*) FILTER (WHERE score = 4)::int AS c4,
        count(*) FILTER (WHERE score = 5)::int AS c5
      FROM "Review" WHERE status = 'PUBLISHED' AND "productId" LIKE 'load_prod_%' GROUP BY "productId"
    ) s
    WHERE p.id = s."productId"`;
}

// Completed cash-on-delivery orders over the last year, recorded like legacy orders (pricingVersion 0, no tax lines),
// so order lists and per-customer history have realistic volume. They hold no stock reservations.
async function seedOrderHistory(variants: SeededVariant[]) {
  const store = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });
  const firstNumber = 1_000_000;
  const orders: Prisma.OrderCreateManyInput[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];
  for (let o = 0; o < HISTORY_ORDERS; o++) {
    const customer = o % CUSTOMER_COUNT;
    const lines = Array.from({ length: between(1, 3) }, () => pick(variants));
    let total = new Prisma.Decimal(0);
    lines.forEach((variant, l) => {
      const quantity = between(1, 2);
      const lineTotal = variant.price.mul(quantity);
      total = total.add(lineTotal);
      items.push({
        id: `load_hist_item_${o}_${l}`,
        orderId: `load_hist_order_${o}`,
        productId: variant.productId,
        variantId: variant.id,
        productName: variant.name,
        quantity,
        unitListPrice: variant.price,
        unitDiscount: 0,
        lineTotal,
      });
    });
    const createdAt = new Date(Date.now() - (1 + (o % HISTORY_DAYS)) * DAY_MS - between(0, DAY_MS / 1000) * 1000);
    orders.push({
      id: `load_hist_order_${o}`,
      orderNumber: firstNumber + o,
      userId: `load_customer_${customer}`,
      currency: store.currency,
      pricingVersion: 0,
      subtotal: total,
      discountTotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: total,
      status: 'COMPLETED',
      fulfillmentType: 'DELIVERY',
      shippingAddressId: `load_address_${customer}`,
      paymentMethod: 'CASH_ON_DELIVERY',
      contactEmail: customerEmail(customer),
      contactPhone: `+23324${String(1_000_000 + customer)}`,
      createdAt,
    });
  }
  await inChunks(orders, (data) => prisma.order.createMany({ data, skipDuplicates: true }));
  await inChunks(items, (data) => prisma.orderItem.createMany({ data, skipDuplicates: true }));
  await prisma.$executeRaw`
    UPDATE "Store" SET "nextOrderNumber" = ${firstNumber + HISTORY_ORDERS}
    WHERE singleton AND "nextOrderNumber" < ${firstNumber + HISTORY_ORDERS}`;
}

// Report queries read the daily rollups, not the orders; give them a year of rows to aggregate.
async function seedRollups(variants: SeededVariant[]) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const sales: Prisma.AnalyticsDailySalesCreateManyInput[] = [];
  const perVariant: Prisma.AnalyticsDailyVariantCreateManyInput[] = [];
  for (let d = 1; d <= HISTORY_DAYS; d++) {
    const day = new Date(today.getTime() - d * DAY_MS);
    let revenue = new Prisma.Decimal(0);
    let units = 0;
    for (let v = 0; v < ROLLUP_VARIANTS_PER_DAY; v++) {
      const variant = variants[(d * 37 + v * 53) % variants.length];
      const unitsSold = between(1, 6);
      const amount = variant.price.mul(unitsSold);
      revenue = revenue.add(amount);
      units += unitsSold;
      perVariant.push({
        day,
        variantId: variant.id,
        productId: variant.productId,
        unitsSold,
        sales: amount,
        unitsRefunded: 0,
        refunds: 0,
        unitsRestocked: 0,
        costedNetSales: 0,
        cogs: 0,
        unknownCostUnits: unitsSold,
        unknownCostNetSales: amount,
      });
    }
    sales.push({
      day,
      paidOrders: Math.round(units / 2),
      unitsSold: units,
      grossRevenue: revenue,
      itemSales: revenue,
      itemDiscounts: 0,
      orderDiscounts: 0,
      loyaltyDiscounts: 0,
      shipping: 0,
      shippingDiscounts: 0,
      tax: 0,
      refundCount: 0,
      refunds: 0,
      refundedShipping: 0,
      refundedTax: 0,
      unallocatedRefunds: 0,
      ordersPlaced: Math.round(units / 2),
      computedAt: new Date(),
    });
  }
  await inChunks(sales, (data) => prisma.analyticsDailySales.createMany({ data, skipDuplicates: true }));
  await inChunks(perVariant, (data) => prisma.analyticsDailyVariant.createMany({ data, skipDuplicates: true }));
}

async function main() {
  const started = Date.now();
  const step = async (name: string, run: () => Promise<unknown>) => {
    const at = Date.now();
    await run();
    console.log(`seed: ${name} (${((Date.now() - at) / 1000).toFixed(1)} s)`);
  };
  await step('taxonomy', seedTaxonomy);
  const { defaultLocationId, currency } = await seedLocationsAndZones();
  let variants: SeededVariant[] = [];
  await step('catalogue', async () => (variants = await seedCatalogue(defaultLocationId, currency)));
  await step('promotions', seedPromotions);
  await step('content', seedContent);
  await step('customers and staff', seedPeople);
  await step('reviews', seedReviews);
  await step('order history', () => seedOrderHistory(variants));
  await step('analytics rollups', () => seedRollups(variants));
  await step('analyze', () => prisma.$executeRawUnsafe('ANALYZE'));
  console.log(`seed: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
