// Electronics demo store for manual testing: a realistic catalogue, stock received on purchase orders, delivery
// zones, pickup points, promotions, staff for every role, customers and orders in every state. Rows are written
// directly (not through the API), so the helpers below keep the stock, serial, payment and loyalty invariants by
// construction; scripts/dr/verify.sql checks them. Runs only on an empty, migrated database:
//   npx prisma migrate reset --force && npm run seed:demo
// Demo sign-in details (one password for every account, the staff TOTP secret) go to tmp/demo-accounts.md, never
// to the console.
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeliveryServiceLevel,
  GhanaRegion,
  PaymentMethod,
  Prisma,
  PrismaClient,
  RefundReason,
  ReturnReason,
  ShipmentStatus,
  Weekday,
} from '../../src/generated/prisma/client';
import { AnalyticsRollupRepository } from '../../src/analytics/rollup/analytics-rollup.repository';
import { toAddressSnapshot } from '../../src/addresses/address-snapshot';
import { parseMfaKey, sealSecret } from '../../src/iam/mfa/mfa-crypto';
import { base32Encode } from '../../src/iam/mfa/totp';
import { addMonths, drawPoints, earnedPoints, orderSettlement, paidGoods } from '../../src/loyalty/loyalty-rules';
import { formatOpeningHours } from '../../src/pickup-locations/opening-hours';
import { ANONYMOUS_CUSTOMER, PRICING_VERSION, price, PricingLine, Quote } from '../../src/pricing/price';
import {
  AttributeRule,
  checkOptionValues,
  checkProductAttributes,
  describeProblems,
} from '../../src/product-types/domain/attribute-validation';
import { deliveryFee, DeliveryRate } from '../../src/shipping-zones/delivery-fee';
import { matchKey } from '../../src/shipping-zones/zone-matching';
import { taxInclusivePrice } from '../../src/tax/tax-inclusive-price';
import { roundHalfUp } from '../../src/commons/money/money';
import {
  BRANDS,
  CATEGORIES,
  CUSTOMERS,
  DemoCustomer,
  DemoProduct,
  PRODUCT_TYPES,
  PRODUCTS,
  STAFF,
  SUPPLIERS,
  SupplierKey,
} from './demo-electronics.data';

if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data with NODE_ENV=production');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const D = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value);
const DAY_MS = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number, hour = 10, minute = 0) => {
  const at = new Date(NOW.getTime() - days * DAY_MS);
  at.setUTCHours(hour, minute, 0, 0);
  return at.getTime() > NOW.getTime() ? new Date(NOW.getTime() - 60_000) : at;
};
const plusMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

// Deterministic randomness, so re-seeding gives the same serials, history and reviews.
let state = 20261126;
const random = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

type Db = PrismaClient;

// ---------------------------------------------------------------------------------------------------------------
// Context filled while seeding
interface SeedVariant {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  options: Record<string, string>;
  price: Prisma.Decimal;
  basePrice: Prisma.Decimal;
  categoryId: string;
  brandId: string;
  weightGrams: number;
  serial: boolean;
  lots: boolean;
  product: DemoProduct;
}
interface SeedCustomer extends DemoCustomer {
  id: string;
  addressId: string;
  address: DemoCustomer['address'];
}
interface Zone {
  id: string;
  name: string;
  rules: DeliveryRate[];
  locations: string[];
}

const ctx = {
  storeId: '',
  main: '',
  branch: '',
  taxRates: [] as { id: string; name: string; rate: Prisma.Decimal }[],
  totalRate: D(0),
  categories: new Map<string, string>(),
  subcategories: new Map<string, string>(),
  brands: new Map<string, string>(),
  variants: [] as SeedVariant[],
  byKey: new Map<string, SeedVariant[]>(),
  staff: new Map<string, string>(),
  customers: new Map<string, SeedCustomer>(),
  zones: new Map<GhanaRegion, Zone>(),
  pickups: new Map<string, { id: string; locations: string[]; snapshot: Record<string, unknown> }>(),
  promotions: new Map<string, string>(),
  collections: new Map<string, string>(),
  loyaltyLots: new Map<string, { id: string; remaining: number; expiresAt: Date; createdAt: Date }[]>(),
};
const variant = (key: string, index = 0) => {
  const found = ctx.byKey.get(key)?.[index];
  if (!found) throw new Error(`No demo variant ${key}[${index}]`);
  return found;
};
const staffId = (key: string) => {
  const id = ctx.staff.get(key);
  if (!id) throw new Error(`No demo staff member ${key}`);
  return id;
};
const customerOf = (key: string) => {
  const found = ctx.customers.get(key);
  if (!found) throw new Error(`No demo customer ${key}`);
  return found;
};

// ---------------------------------------------------------------------------------------------------------------
// Stock ledger: every change is one append-only movement plus the same delta on the level (and lot)
interface Move {
  variantId: string;
  locationId: string;
  onHand?: number;
  reserved?: number;
  reason: 'RECEIPT' | 'RESERVE' | 'RELEASE' | 'SALE' | 'RETURN_RESTOCK';
  refType?: string;
  refId?: string;
  lotId?: string;
  unitCost?: Prisma.Decimal;
  at: Date;
  note?: string;
}
async function move(db: Db, m: Move): Promise<string> {
  const onHand = m.onHand ?? 0;
  const reserved = m.reserved ?? 0;
  const movement = await db.stockMovement.create({
    data: {
      variantId: m.variantId,
      locationId: m.locationId,
      onHandDelta: onHand,
      reservedDelta: reserved,
      reason: m.reason,
      refType: m.refType,
      refId: m.refId,
      lotId: m.lotId,
      unitCost: m.unitCost,
      note: m.note,
      createdAt: m.at,
    },
  });
  const updated = await db.stockLevel.updateMany({
    where: { variantId: m.variantId, locationId: m.locationId },
    data: { onHand: { increment: onHand }, reserved: { increment: reserved } },
  });
  if (updated.count === 0) {
    await db.stockLevel.create({ data: { variantId: m.variantId, locationId: m.locationId, onHand, reserved } });
  }
  if (m.lotId) {
    const lot = await db.lotStock.updateMany({
      where: { lotId: m.lotId, locationId: m.locationId },
      data: { onHand: { increment: onHand } },
    });
    if (lot.count === 0) await db.lotStock.create({ data: { lotId: m.lotId, locationId: m.locationId, onHand } });
  }
  return movement.id;
}

async function available(db: Db, variantId: string, locationId: string): Promise<number> {
  const level = await db.stockLevel.findFirst({ where: { variantId, locationId } });
  if (!level) return 0;
  const expired = await db.lotStock.aggregate({
    _sum: { onHand: true },
    where: { locationId, lot: { variantId, expiresAt: { lte: NOW } } },
  });
  return level.onHand - level.reserved - (expired._sum.onHand ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Serial numbers
function luhnDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let digit = Number(body[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}
let serialCounter = 0;
function nextSerial(product: DemoProduct): string {
  serialCounter++;
  if (product.serial === 'IMEI') {
    const tac = String(35000000 + ((product.key.length * 7919 + product.key.charCodeAt(0) * 31) % 999999)).padStart(
      8,
      '0',
    );
    const body = tac + String(100000 + serialCounter).slice(-6);
    return body + luhnDigit(body);
  }
  const prefix = product.brand
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 3)
    .toUpperCase();
  return `${prefix}${String(serialCounter).padStart(4, '0')}${randomBytes(3).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------------------------
async function assertEmptyDatabase() {
  const [products, orders, users] = await Promise.all([
    prisma.product.count(),
    prisma.order.count(),
    prisma.user.count(),
  ]);
  if (products + orders + users > 0) {
    throw new Error(
      `The demo seed needs an empty, migrated database (found ${products} products, ${orders} orders, ${users} users). ` +
        'Run `npx prisma migrate reset --force` first (it deletes everything in DATABASE_URL).',
    );
  }
}

async function seedStore() {
  const store = await prisma.store.update({
    where: { singleton: true },
    data: {
      legalName: 'Emma Electronics Ghana Ltd',
      tradingName: 'Emma Electronics',
      tin: 'C0012345678',
      vatRegistered: true,
      pricesIncludeTax: true,
      supportEmail: 'help@example.com',
      supportPhone: '+233302000200',
      codMaxOrderTotal: 10000,
      codMaxOpenOrdersPerPhone: 2,
    },
  });
  ctx.storeId = store.id;
  const main = await prisma.stockLocation.update({
    where: { id: (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id },
    data: { name: 'Accra Warehouse (Spintex)' },
  });
  ctx.main = main.id;
  ctx.branch = (
    await prisma.stockLocation.create({ data: { storeId: store.id, name: 'Kumasi Branch (Adum)', type: 'BRANCH' } })
  ).id;
  // Demo values: Ghana's VAT and levies as separate rates added to the price (verify current rates with a tax adviser).
  for (const [name, rate] of [
    ['VAT', '0.15'],
    ['NHIL', '0.025'],
    ['GETFund Levy', '0.025'],
  ] as const) {
    const tax = await prisma.tax.create({ data: { name, rate: D(rate) } });
    ctx.taxRates.push({ id: tax.id, name: tax.name, rate: tax.rate });
    ctx.totalRate = ctx.totalRate.add(tax.rate);
  }
}

async function seedPeople(passwordHash: string, totpSecret: string, mfaKey: Buffer) {
  const roles = new Map((await prisma.staffRole.findMany()).map((role) => [role.key, role]));
  for (const member of STAFF) {
    const role = roles.get(member.role);
    if (!role) throw new Error(`Staff role ${member.role} is missing; run the migrations first`);
    const user = await prisma.user.create({
      data: {
        name: member.name,
        email: member.email,
        password: passwordHash,
        role: member.legacyRole,
        emailVerifiedAt: daysAgo(120),
        phoneNumber: `+23320000${String(STAFF.indexOf(member) + 1).padStart(4, '0')}`,
        createdAt: daysAgo(120),
      },
    });
    if (role.mfaRequired) {
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaSecret: sealSecret(mfaKey, totpSecret, user.id), mfaEnabledAt: daysAgo(120) },
      });
    }
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: ctx.storeId, roleId: role.id } });
    ctx.staff.set(member.key, user.id);
  }

  for (const [index, c] of CUSTOMERS.entries()) {
    const joined = daysAgo(110 - index * 6);
    const user = await prisma.user.create({
      data: {
        name: c.name,
        email: c.email,
        password: passwordHash,
        phoneNumber: c.phone,
        phoneVerifiedAt: c.phoneVerified ? joined : null,
        phoneVerifiedNumber: c.phoneVerified ? c.phone : null,
        emailVerifiedAt: joined,
        createdAt: joined,
      },
    });
    const address = await prisma.address.create({
      data: {
        userId: user.id,
        recipientName: c.name,
        phone: c.phone,
        region: c.address.region,
        city: c.address.city,
        area: c.address.area,
        street: c.address.street,
        landmark: c.address.landmark,
        ghanaPostGps: c.address.gps,
        country: 'Ghana',
      },
    });
    for (const [channel, enabled] of [
      ['EMAIL', c.marketingEmail],
      ['SMS', c.marketingSms],
    ] as const) {
      if (!enabled) continue;
      await prisma.notificationPreference.create({
        data: { userId: user.id, category: 'MARKETING', channel, enabled: true },
      });
      await prisma.consentEvent.create({
        data: {
          userId: user.id,
          category: 'MARKETING',
          channel,
          action: 'GRANTED',
          source: 'ACCOUNT_SETTINGS',
          createdAt: joined,
        },
      });
    }
    ctx.customers.set(c.key, { ...c, id: user.id, addressId: address.id });
  }

  const students = await prisma.customerGroup.create({
    data: { name: 'Students', description: 'Verified university and SHS students' },
  });
  const corporate = await prisma.customerGroup.create({
    data: { name: 'Corporate buyers', description: 'Businesses buying laptops and accessories in volume' },
  });
  await prisma.customerGroupMember.createMany({
    data: [
      { groupId: students.id, userId: customerOf('abena').id },
      { groupId: students.id, userId: customerOf('amaserwaa').id },
      { groupId: corporate.id, userId: customerOf('nanayaw').id },
    ],
  });
  return { students: students.id, corporate: corporate.id };
}

async function seedTaxonomy() {
  for (const [name, category] of Object.entries(CATEGORIES)) {
    const row = await prisma.category.create({
      data: {
        name,
        description: category.description,
        image: placeholder(name),
        metaDescription: category.description,
      },
    });
    ctx.categories.set(name, row.id);
    for (const sub of category.subcategories) {
      const subRow = await prisma.subCategory.create({
        data: { name: sub, categoryId: row.id, image: placeholder(sub) },
      });
      ctx.subcategories.set(`${name}/${sub}`, subRow.id);
    }
  }
  for (const [name, description] of Object.entries(BRANDS)) {
    const row = await prisma.brand.create({ data: { name, description, logo: placeholder(name, 400) } });
    ctx.brands.set(name, row.id);
  }
  const tags = [...new Set(PRODUCTS.flatMap((product) => product.tags))];
  await prisma.tag.createMany({ data: tags.map((name) => ({ name })) });
}

function placeholder(text: string, size = 800) {
  return `https://placehold.co/${size}x${size}/png?text=${encodeURIComponent(text).replace(/%20/g, '+')}`;
}

async function seedProductTypes(): Promise<Map<string, { id: string; rules: AttributeRule[] }>> {
  const types = new Map<string, { id: string; rules: AttributeRule[] }>();
  types.set('general', { id: 'product_type_general', rules: [] });
  for (const [key, definition] of Object.entries(PRODUCT_TYPES)) {
    const row = await prisma.productType.create({
      data: {
        id: `product_type_${key}`,
        key,
        name: definition.name,
        returnable: true,
        returnWindowDays: key === 'smartphone' || key === 'laptop' ? 7 : null,
        attributes: {
          create: definition.attributes.map((attribute, position) => ({
            key: attribute.key,
            label: attribute.label,
            dataType: attribute.dataType,
            unit: attribute.unit,
            allowedValues: attribute.allowedValues ?? [],
            isVariantAxis: attribute.isVariantAxis ?? false,
            isFilterable: attribute.isFilterable ?? false,
            position,
          })),
        },
      },
      include: { attributes: true },
    });
    types.set(key, { id: row.id, rules: row.attributes });
  }
  return types;
}

async function seedCatalogue() {
  const types = await seedProductTypes();
  const tagIds = new Map((await prisma.tag.findMany()).map((tag) => [tag.name, tag.id]));
  for (const [index, product] of PRODUCTS.entries()) {
    const type = types.get(product.type);
    if (!type) throw new Error(`Unknown product type ${product.type}`);
    const attributes = checkProductAttributes(type.rules, product.attributes);
    if (!attributes.ok) throw new Error(`${product.key}: ${describeProblems(attributes.problems)}`);
    const categoryId = ctx.categories.get(product.category);
    const subcategoryId = ctx.subcategories.get(`${product.category}/${product.subcategory}`);
    const brandId = ctx.brands.get(product.brand);
    if (!categoryId || !subcategoryId || !brandId) throw new Error(`${product.key}: unknown category or brand`);
    const publishedAt = daysAgo(100 - index);
    const row = await prisma.product.create({
      data: {
        name: product.name,
        shortDescription: product.short,
        description: product.description,
        metaDescription: product.short,
        isTaxable: true,
        status: 'PUBLISHED',
        publishedAt,
        createdAt: publishedAt,
        images: [placeholder(product.name), placeholder(`${product.name} side`)],
        categoryId,
        subcategoryId,
        brandId,
        productTypeId: type.id,
        attributes: attributes.value,
        trackSerials: product.serial !== undefined,
        serialFormat: product.serial ?? 'FREE_TEXT',
        warrantyMonths: product.warrantyMonths,
        trackLots: product.lots ?? false,
        tags: { connect: product.tags.map((name) => ({ id: tagIds.get(name) as string })) },
      },
    });
    const seeded: SeedVariant[] = [];
    for (const [v, spec] of product.variants.entries()) {
      const options = checkOptionValues(type.rules, spec.options);
      if (!options.ok) throw new Error(`${product.key}[${v}]: ${describeProblems(options.problems)}`);
      const basePrice = roundHalfUp(D(spec.retail).div(ctx.totalRate.add(1)));
      const sellingPrice = taxInclusivePrice(basePrice, ctx.totalRate);
      const sku = `EE-${product.key.toUpperCase()}-${v + 1}`;
      const created = await prisma.variant.create({
        data: {
          productId: row.id,
          sku,
          barcode: spec.barcode,
          price: sellingPrice,
          basePrice,
          optionValues: options.value.values,
          optionsKey: options.value.optionsKey,
          weightGrams: product.weightGrams,
          lowStockThreshold: product.category === 'Accessories' || product.subcategory === 'Batteries' ? 10 : 3,
          createdAt: publishedAt,
        },
      });
      await prisma.priceChange.createMany({
        data: (['BASE_PRICE', 'PRICE'] as const).map((field) => ({
          variantId: created.id,
          field,
          newValue: field === 'PRICE' ? sellingPrice : basePrice,
          currency: 'GHS' as const,
          source: 'VARIANT_CREATED' as const,
          createdAt: publishedAt,
        })),
      });
      const seededVariant: SeedVariant = {
        id: created.id,
        productId: row.id,
        productName: product.name,
        sku,
        options: spec.options,
        price: sellingPrice,
        basePrice,
        categoryId,
        brandId,
        weightGrams: product.weightGrams,
        serial: product.serial !== undefined,
        lots: product.lots ?? false,
        product,
      };
      seeded.push(seededVariant);
      ctx.variants.push(seededVariant);
    }
    ctx.byKey.set(product.key, seeded);
  }
}

// Opening stock arrives on received purchase orders, which also sets each variant's weighted-average cost.
const COST_RATIO: Record<string, number> = {
  'Phones & Tablets': 0.82,
  Computers: 0.84,
  'TV & Video': 0.78,
  Gaming: 0.85,
};
const unitCostOf = (v: SeedVariant) =>
  roundHalfUp(v.basePrice.mul(COST_RATIO[v.product.category] ?? 0.68)).toDecimalPlaces(4);

const LOTS: Record<string, { lotNumber: string; expiresInDays: number; stock: [number, number] }[]> = {
  'duracell-aa-4': [
    { lotNumber: 'DUR-2311X', expiresInDays: -5, stock: [6, 0] },
    { lotNumber: 'DUR-2405A', expiresInDays: 20, stock: [30, 10] },
    { lotNumber: 'DUR-2511C', expiresInDays: 730, stock: [120, 40] },
  ],
  'energizer-aaa-4': [{ lotNumber: 'EN-2509B', expiresInDays: 400, stock: [100, 30] }],
};

async function seedPurchasing() {
  const owner = staffId('owner');
  const inventory = staffId('inventory');
  const suppliers = new Map<SupplierKey, string>();
  for (const s of SUPPLIERS) {
    const row = await prisma.supplier.create({
      data: {
        storeId: ctx.storeId,
        name: s.name,
        nameKey: s.name.toLowerCase(),
        contactName: s.contactName,
        phone: s.phone,
        email: `orders.${s.key}@example.com`,
        address: s.address,
        currency: 'GHS',
      },
    });
    suppliers.set(s.key, row.id);
  }
  const costed = new Set<string>();
  for (const [locationIndex, locationId] of [ctx.main, ctx.branch].entries()) {
    for (const s of SUPPLIERS) {
      const variants = ctx.variants.filter((v) => {
        if (v.product.supplier !== s.key) return false;
        const lots = LOTS[v.product.key];
        return lots
          ? lots.some((lot) => lot.stock[locationIndex] > 0)
          : v.product.variants[0] && stockOf(v)[locationIndex] > 0;
      });
      if (variants.length === 0) continue;
      const sentAt = daysAgo(45 - locationIndex * 3, 9);
      const receivedAt = daysAgo(42 - locationIndex * 3, 11);
      const quantities = variants.map((v) =>
        LOTS[v.product.key]
          ? LOTS[v.product.key].reduce((sum, lot) => sum + lot.stock[locationIndex], 0)
          : stockOf(v)[locationIndex],
      );
      const po = await prisma.purchaseOrder.create({
        data: {
          supplierId: suppliers.get(s.key) as string,
          locationId,
          status: 'RECEIVED',
          currency: 'GHS',
          createdById: owner,
          sentById: owner,
          sentAt,
          expectedAt: receivedAt,
          note: 'Opening stock',
          createdAt: sentAt,
          updatedAt: receivedAt,
          lines: {
            create: variants.map((v, i) => ({
              variantId: v.id,
              quantityOrdered: quantities[i],
              quantityReceived: quantities[i],
              unitCost: unitCostOf(v),
            })),
          },
        },
        include: { lines: true },
      });
      const receipt = await prisma.purchaseOrderReceipt.create({
        data: { purchaseOrderId: po.id, receivedById: inventory, receivedAt },
      });
      // A receipt has one line per order line, so each further lot of a line arrives on its own receipt.
      const lotReceipts = [receipt.id];
      const receiptForLot = async (index: number) => {
        while (lotReceipts.length <= index) {
          const extra = await prisma.purchaseOrderReceipt.create({
            data: {
              purchaseOrderId: po.id,
              receivedById: inventory,
              receivedAt: plusMinutes(receivedAt, lotReceipts.length * 5),
            },
          });
          lotReceipts.push(extra.id);
        }
        return lotReceipts[index];
      };
      for (const [i, v] of variants.entries()) {
        const line = po.lines.find((l) => l.variantId === v.id) as (typeof po.lines)[number];
        const unitCost = unitCostOf(v);
        const lotSpecs = LOTS[v.product.key];
        if (lotSpecs) {
          let lotIndex = 0;
          for (const spec of lotSpecs) {
            const quantity = spec.stock[locationIndex];
            if (quantity === 0) continue;
            const lotReceiptId = await receiptForLot(lotIndex++);
            const lot = await prisma.lot.upsert({
              where: { variantId_lotNumber: { variantId: v.id, lotNumber: spec.lotNumber } },
              create: {
                variantId: v.id,
                lotNumber: spec.lotNumber,
                expiresAt: new Date(NOW.getTime() + spec.expiresInDays * DAY_MS),
                manufacturedAt: daysAgo(400),
              },
              update: {},
            });
            const movementId = await move(prisma, {
              variantId: v.id,
              locationId,
              onHand: quantity,
              reason: 'RECEIPT',
              refType: 'PurchaseOrder',
              refId: po.id,
              lotId: lot.id,
              unitCost,
              at: receivedAt,
            });
            await prisma.purchaseOrderReceiptLine.create({
              data: { receiptId: lotReceiptId, lineId: line.id, quantity, unitCost, lotId: lot.id, movementId },
            });
          }
        } else {
          const movementId = await move(prisma, {
            variantId: v.id,
            locationId,
            onHand: quantities[i],
            reason: 'RECEIPT',
            refType: 'PurchaseOrder',
            refId: po.id,
            unitCost,
            at: receivedAt,
          });
          await prisma.purchaseOrderReceiptLine.create({
            data: { receiptId: receipt.id, lineId: line.id, quantity: quantities[i], unitCost, movementId },
          });
          if (v.serial) {
            for (let n = 0; n < quantities[i]; n++) {
              const unit = await prisma.serialUnit.create({
                data: { variantId: v.id, serial: nextSerial(v.product), locationId, receivedAt },
              });
              await prisma.serialUnitEvent.create({
                data: {
                  serialUnitId: unit.id,
                  to: 'IN_STOCK',
                  locationId,
                  movementId,
                  refType: 'PurchaseOrder',
                  refId: po.id,
                  actorId: inventory,
                  createdAt: receivedAt,
                },
              });
            }
          }
        }
        if (!costed.has(v.id)) {
          costed.add(v.id);
          await prisma.variant.update({ where: { id: v.id }, data: { costPrice: unitCost } });
          await prisma.costChange.create({
            data: {
              variantId: v.id,
              newValue: unitCost,
              currency: 'GHS',
              source: 'PURCHASE_ORDER',
              refType: 'PurchaseOrderReceipt',
              refId: receipt.id,
              actorId: inventory,
              createdAt: receivedAt,
            },
          });
        }
      }
    }
  }
  // An order sent and awaiting delivery (to test receiving, including IMEIs), and a draft.
  await prisma.purchaseOrder.create({
    data: {
      supplierId: suppliers.get('mobile') as string,
      locationId: ctx.main,
      status: 'SENT',
      currency: 'GHS',
      createdById: owner,
      sentById: owner,
      sentAt: daysAgo(2),
      expectedAt: new Date(NOW.getTime() + 3 * DAY_MS),
      note: 'Restock for December',
      lines: {
        create: [
          { variantId: variant('iphone-13').id, quantityOrdered: 6, unitCost: unitCostOf(variant('iphone-13')) },
          { variantId: variant('galaxy-a15').id, quantityOrdered: 10, unitCost: unitCostOf(variant('galaxy-a15')) },
          {
            variantId: variant('samsung-25w-charger').id,
            quantityOrdered: 30,
            unitCost: unitCostOf(variant('samsung-25w-charger')),
          },
        ],
      },
    },
  });
  await prisma.purchaseOrder.create({
    data: {
      supplierId: suppliers.get('appliances') as string,
      locationId: ctx.branch,
      status: 'DRAFT',
      currency: 'GHS',
      createdById: staffId('manager'),
      note: 'Air conditioners for the dry season',
      lines: {
        create: [
          {
            variantId: variant('nasco-split-ac-15').id,
            quantityOrdered: 8,
            unitCost: unitCostOf(variant('nasco-split-ac-15')),
          },
          {
            variantId: variant('midea-split-ac-10').id,
            quantityOrdered: 8,
            unitCost: unitCostOf(variant('midea-split-ac-10')),
          },
        ],
      },
    },
  });
}
function stockOf(v: SeedVariant): [number, number] {
  const spec = v.product.variants.find((candidate) => JSON.stringify(candidate.options) === JSON.stringify(v.options));
  return spec?.stock ?? [0, 0];
}

async function seedDelivery() {
  const weekdays: Weekday[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const zones: {
    name: string;
    regions: GhanaRegion[];
    codEnabled: boolean;
    locations: string[];
    rules: { level: DeliveryServiceLevel; base: number; freeAbove?: number; bands: [number, number][] }[];
    slots: boolean;
  }[] = [
    {
      name: 'Greater Accra',
      regions: [GhanaRegion.GREATER_ACCRA],
      codEnabled: true,
      locations: [ctx.main],
      rules: [
        {
          level: 'STANDARD',
          base: 30,
          freeAbove: 3000,
          bands: [
            [5000, 50],
            [20000, 120],
            [40000, 200],
          ],
        },
        {
          level: 'EXPRESS',
          base: 60,
          bands: [
            [5000, 90],
            [20000, 180],
          ],
        },
      ],
      slots: true,
    },
    {
      name: 'Ashanti',
      regions: [GhanaRegion.ASHANTI],
      codEnabled: true,
      locations: [ctx.branch, ctx.main],
      rules: [
        {
          level: 'STANDARD',
          base: 45,
          freeAbove: 5000,
          bands: [
            [5000, 70],
            [20000, 150],
            [40000, 250],
          ],
        },
      ],
      slots: false,
    },
    {
      name: 'Rest of Ghana',
      regions: [
        GhanaRegion.CENTRAL,
        GhanaRegion.WESTERN,
        GhanaRegion.VOLTA,
        GhanaRegion.EASTERN,
        GhanaRegion.BONO,
        GhanaRegion.NORTHERN,
      ],
      codEnabled: false,
      locations: [ctx.main],
      rules: [
        {
          level: 'STANDARD',
          base: 80,
          bands: [
            [5000, 120],
            [20000, 250],
            [40000, 400],
          ],
        },
      ],
      slots: false,
    },
  ];
  for (const spec of zones) {
    const zone = await prisma.shippingZone.create({ data: { name: spec.name, codEnabled: spec.codEnabled } });
    await prisma.zoneArea.createMany({
      data: spec.regions.map((region) => ({
        zoneId: zone.id,
        level: 'REGION' as const,
        region,
        matchKey: matchKey({ level: 'REGION', region, town: null, area: null }),
      })),
    });
    const rules: DeliveryRate[] = [];
    for (const rule of spec.rules) {
      const row = await prisma.rateRule.create({
        data: {
          zoneId: zone.id,
          serviceLevel: rule.level,
          baseFee: rule.base,
          freeAbove: rule.freeAbove,
          weightBands: { create: rule.bands.map(([fromGrams, fee]) => ({ fromGrams, fee })) },
        },
        include: { weightBands: true },
      });
      rules.push({
        ...row,
        weightBands: row.weightBands.map((band) => ({ fromGrams: band.fromGrams, fee: band.fee })),
      });
    }
    await prisma.shippingZoneStockLocation.createMany({
      data: spec.locations.map((locationId, i) => ({ shippingZoneId: zone.id, locationId, priority: i + 1 })),
    });
    if (spec.slots) {
      await prisma.deliverySlot.createMany({
        data: weekdays.flatMap((weekday) => [
          { zoneId: zone.id, weekday, startMinute: 9 * 60, endMinute: 13 * 60, capacity: 15, cutoffHours: 12 },
          { zoneId: zone.id, weekday, startMinute: 14 * 60, endMinute: 18 * 60, capacity: 15, cutoffHours: 4 },
        ]),
      });
      // A public holiday: no deliveries.
      const holiday = new Date(Date.UTC(NOW.getUTCFullYear(), 11, 25));
      await prisma.deliveryClosure.create({ data: { zoneId: zone.id, date: holiday, reason: 'Christmas Day' } });
    }
    const z: Zone = { id: zone.id, name: zone.name, rules, locations: spec.locations };
    for (const region of spec.regions) ctx.zones.set(region, z);
  }

  const pickups = [
    {
      key: 'osu',
      name: 'Emma Electronics Osu Shop',
      address: '31 Oxford Street, Osu',
      city: 'Accra',
      region: GhanaRegion.GREATER_ACCRA,
      gps: 'GA-018-1150',
      phone: '+233302000201',
      locations: [ctx.main],
    },
    {
      key: 'adum',
      name: 'Emma Electronics Kumasi Shop',
      address: 'Prempeh II Street, Adum',
      city: 'Kumasi',
      region: GhanaRegion.ASHANTI,
      gps: 'AK-001-0042',
      phone: '+233322000202',
      locations: [ctx.branch, ctx.main],
    },
  ];
  for (const p of pickups) {
    const hours = [
      ...weekdays.slice(0, 5).map((weekday) => ({ weekday, opensMinute: 8 * 60, closesMinute: 19 * 60 })),
      { weekday: 'SATURDAY' as Weekday, opensMinute: 9 * 60, closesMinute: 18 * 60 },
    ];
    const row = await prisma.pickupLocation.create({
      data: {
        name: p.name,
        address: p.address,
        city: p.city,
        region: p.region,
        country: 'Ghana',
        contactPhone: p.phone,
        instructions: 'Bring your order number and a photo ID. Free parking at the back.',
        ghanaPostGps: p.gps,
        openingHours: { create: hours },
        fulfilmentLocations: { create: p.locations.map((locationId, i) => ({ locationId, priority: i + 1 })) },
      },
      include: { openingHours: true },
    });
    ctx.pickups.set(p.key, {
      id: row.id,
      locations: p.locations,
      snapshot: {
        name: row.name,
        address: row.address,
        city: row.city,
        region: row.region,
        country: row.country,
        contactPhone: row.contactPhone,
        instructions: row.instructions,
        openingHours: formatOpeningHours(row.openingHours),
      },
    });
  }
}

async function seedPromotions(groups: { students: string; corporate: string }) {
  const startsAt = daysAgo(10, 0);
  const endsAt = new Date(NOW.getTime() + 30 * DAY_MS);
  const accra = ctx.zones.get(GhanaRegion.GREATER_ACCRA) as Zone;
  const create = async (key: string, data: Omit<Prisma.PromotionCreateInput, 'startsAt'> & { startsAt?: Date }) => {
    const row = await prisma.promotion.create({ data: { isActive: true, startsAt, endsAt, ...data } });
    ctx.promotions.set(key, row.id);
    return row;
  };
  await create('black-friday-phones', {
    name: 'Black Friday: 10% off phones and tablets',
    description: 'Every phone and tablet, while stocks last.',
    scope: 'CATEGORY',
    type: 'PERCENT',
    value: 10,
    priority: 10,
    categories: { connect: [{ id: ctx.categories.get('Phones & Tablets') as string }] },
  });
  await create('tv-200-off', {
    name: 'GHS 200 off Samsung and LG 55" TVs',
    scope: 'SKU',
    type: 'AMOUNT_OFF',
    value: 200,
    variants: { connect: [{ id: variant('samsung-cu7000', 1).id }, { id: variant('lg-ur80', 1).id }] },
  });
  await create('freepods-flash', {
    name: 'Flash sale: Oraimo FreePods 4 for GHS 299',
    description: 'First 20 units only.',
    scope: 'PRODUCT',
    type: 'FIXED_PRICE',
    value: 299,
    unitCap: 20,
    endsAt: new Date(NOW.getTime() + 2 * DAY_MS),
    products: { connect: [{ id: variant('oraimo-freepods-4').productId }] },
  });
  await create('cables-bxgy', {
    name: 'Buy 2 chargers or cables, get 1 free',
    scope: 'CATEGORY',
    type: 'BXGY',
    value: 100,
    buyQuantity: 2,
    getQuantity: 1,
    maxApplications: 2,
    categories: { connect: [{ id: ctx.categories.get('Accessories') as string }] },
  });
  await create('powerbank-tiers', {
    name: 'Power banks: 5% off 2+, 10% off 4+',
    scope: 'PRODUCT',
    type: 'TIERED',
    tierValueType: 'PERCENT',
    products: { connect: [{ id: variant('oraimo-traveler-20k').productId }] },
    tiers: {
      create: [
        { minimumQuantity: 2, value: 5 },
        { minimumQuantity: 4, value: 10 },
      ],
    },
  });
  await create('cart-5-over-10k', {
    name: '5% off orders over GHS 10,000',
    scope: 'CART',
    type: 'PERCENT',
    value: 5,
    minimumSpend: 10000,
    stackingGroup: 'cart',
  });
  await create('free-delivery-accra', {
    name: 'Free delivery in Greater Accra over GHS 1,500',
    scope: 'CART',
    type: 'FREE_SHIPPING',
    minimumSpend: 1500,
    stackingGroup: 'shipping',
    shippingZones: { connect: [{ id: accra.id }] },
  });
  await create('welcome10', {
    name: 'WELCOME10: 10% off your first order',
    scope: 'CART',
    type: 'PERCENT',
    value: 10,
    requiresCoupon: true,
    firstOrderOnly: true,
    perCustomerLimit: 1,
    stackingGroup: 'coupon',
    endsAt: null,
    couponCodes: { create: [{ code: 'WELCOME10' }] },
  });
  await create('student15', {
    name: 'STUDENT15: 15% off laptops for students',
    scope: 'CATEGORY',
    type: 'PERCENT',
    value: 15,
    requiresCoupon: true,
    perCustomerLimit: 2,
    stackingGroup: 'coupon',
    categories: { connect: [{ id: ctx.categories.get('Computers') as string }] },
    customerGroups: { connect: [{ id: groups.students }] },
    couponCodes: { create: [{ code: 'STUDENT15', usageLimit: 100 }] },
  });
  await create('save50', {
    name: 'SAVE50: GHS 50 off orders over GHS 1,000',
    scope: 'CART',
    type: 'AMOUNT_OFF',
    value: 50,
    minimumSpend: 1000,
    requiresCoupon: true,
    usageLimit: 3,
    stackingGroup: 'coupon',
    couponCodes: { create: [{ code: 'SAVE50' }] },
  });
  await create('xmas-expired', {
    name: 'XMAS2025 (expired)',
    scope: 'CART',
    type: 'PERCENT',
    value: 12,
    requiresCoupon: true,
    startsAt: new Date(Date.UTC(NOW.getUTCFullYear() - 1, 11, 1)),
    endsAt: new Date(Date.UTC(NOW.getUTCFullYear() - 1, 11, 31)),
    couponCodes: { create: [{ code: 'XMAS2025' }] },
  });

  // B2B: corporate buyers pay less for business laptops from 3 units, less again from 10.
  const list = await prisma.priceList.create({
    data: {
      name: 'Corporate volume pricing',
      description: 'Laptop prices for registered businesses',
      isActive: true,
      priority: 1,
      customerGroups: { connect: [{ id: groups.corporate }] },
    },
  });
  for (const key of ['hp-250-g9', 'thinkpad-e14', 'dell-inspiron-3520']) {
    const v = variant(key);
    const entry = await prisma.priceListEntry.create({
      data: { priceListId: list.id, variantId: v.id, price: roundHalfUp(v.price.mul(0.93)), minQuantity: 3 },
    });
    await prisma.priceListTier.create({
      data: { entryId: entry.id, minQuantity: 10, price: roundHalfUp(v.price.mul(0.88)) },
    });
  }
}

async function seedContent() {
  const productId = (key: string) => variant(key).productId;
  const collection = async (key: string, data: Prisma.CollectionCreateInput) => {
    const row = await prisma.collection.create({ data });
    ctx.collections.set(key, row.id);
    return row;
  };
  await collection('deals', {
    name: 'Black Friday deals',
    description: 'Everything on sale this week.',
    type: 'RULE',
    rules: { onSale: true, inStock: true },
    imageUrl: placeholder('Black Friday'),
  });
  await collection('new', {
    name: 'New arrivals',
    type: 'MANUAL',
    products: {
      create: [
        'galaxy-s24',
        'iphone-15',
        'camon-30',
        'note-40-pro',
        'tcl-c645',
        'ps5-slim',
        'galaxy-watch6',
        'oraimo-freepods-4',
      ].map((key, position) => ({ productId: productId(key), position })),
    },
  });
  await collection('school', {
    name: 'Back to school',
    description: 'Laptops, tablets and the accessories students need.',
    type: 'MANUAL',
    products: {
      create: [
        'hp-250-g9',
        'ideapad-slim-3',
        'dell-inspiron-3520',
        'galaxy-tab-a9',
        'ipad-10',
        'logitech-m185',
        'sandisk-ultra-128',
      ].map((key, position) => ({ productId: productId(key), position })),
    },
  });
  await collection('phones', {
    name: 'Phones under GHS 3,000',
    type: 'RULE',
    rules: { categoryId: ctx.categories.get('Phones & Tablets'), priceMax: '3000.00', inStock: true },
  });

  await prisma.banner.createMany({
    data: [
      {
        title: 'Black Friday is here',
        subtitle: 'Up to 10% off phones, GHS 200 off TVs',
        imageUrl: placeholder('Black Friday', 1600),
        altText: 'Black Friday sale',
        placement: 'HOME_HERO',
        position: 0,
        linkCollectionId: ctx.collections.get('deals'),
        endsAt: new Date(NOW.getTime() + 7 * DAY_MS),
      },
      {
        title: 'Galaxy S24',
        subtitle: 'Galaxy AI is here',
        imageUrl: placeholder('Galaxy S24', 1600),
        placement: 'HOME_HERO',
        position: 1,
        linkProductId: productId('galaxy-s24'),
      },
      {
        title: 'Beat dumsor',
        subtitle: 'Generators, inverters and power banks',
        imageUrl: placeholder('Power and Solar', 1200),
        placement: 'HOME_STRIP',
        position: 0,
        linkCategoryId: ctx.categories.get('Power & Solar'),
      },
      {
        title: 'Free delivery in Accra over GHS 1,500',
        imageUrl: placeholder('Free delivery', 1200),
        placement: 'HOME_STRIP',
        position: 1,
        linkPath: '/delivery',
      },
    ],
  });
  const featuredCategories = [
    'Phones & Tablets',
    'Computers',
    'TV & Video',
    'Audio',
    'Home Appliances',
    'Power & Solar',
  ];
  await prisma.homepageSection.createMany({
    data: [
      {
        type: 'PRODUCT_CAROUSEL',
        title: 'Black Friday deals',
        position: 0,
        config: { collectionId: ctx.collections.get('deals'), productLimit: 12 },
      },
      {
        type: 'CATEGORY_GRID',
        title: 'Shop by category',
        position: 1,
        config: { categoryIds: featuredCategories.map((name) => ctx.categories.get(name) as string) },
      },
      {
        type: 'PRODUCT_CAROUSEL',
        title: 'New arrivals',
        position: 2,
        config: { collectionId: ctx.collections.get('new'), productLimit: 8 },
      },
      { type: 'BANNER_STRIP', title: null, position: 3, config: { bannerPlacement: 'HOME_STRIP', bannerLimit: 2 } },
      {
        type: 'BRAND_STRIP',
        title: 'Top brands',
        position: 4,
        config: {
          brandIds: ['Samsung', 'Apple', 'Tecno', 'Infinix', 'HP', 'LG', 'Sony', 'Oraimo'].map(
            (name) => ctx.brands.get(name) as string,
          ),
        },
      },
      {
        type: 'PRODUCT_CAROUSEL',
        title: 'Back to school',
        position: 5,
        config: { collectionId: ctx.collections.get('school'), productLimit: 8 },
      },
      {
        type: 'RICH_TEXT',
        title: 'Why shop with us',
        position: 6,
        config: {
          text: '**Genuine products** with full warranty. Pay with **Mobile Money**, card or cash on delivery in Accra and Kumasi. Next-day delivery in Greater Accra, or pick up at our [Osu shop](/stores).',
        },
      },
    ],
  });
  await prisma.searchSynonym.createMany({
    data: [
      { kind: 'TWO_WAY', synonyms: ['tv', 'television'] },
      { kind: 'TWO_WAY', synonyms: ['phone', 'mobile', 'smartphone'] },
      { kind: 'TWO_WAY', synonyms: ['earbuds', 'earphones', 'airpods'] },
      { kind: 'ONE_WAY', term: 'fridge', synonyms: ['refrigerator'] },
      { kind: 'ONE_WAY', term: 'ac', synonyms: ['air conditioner'] },
      { kind: 'ONE_WAY', term: 'gen', synonyms: ['generator'] },
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Orders
interface OrderLineSpec {
  variant: SeedVariant;
  quantity: number;
}
interface OrderSpec {
  customer: string;
  lines: OrderLineSpec[];
  method?: PaymentMethod;
  channel?: 'card' | 'mobile_money';
  pickup?: string;
  express?: boolean;
  at: Date;
}
interface PlacedOrder {
  id: string;
  number: number;
  customer: SeedCustomer;
  quote: Quote;
  method: PaymentMethod;
  locationId: string;
  at: Date;
  items: {
    id: string;
    variant: SeedVariant;
    quantity: number;
    lineTotal: Prisma.Decimal;
    unitNet: Prisma.Decimal;
    unitTax: Prisma.Decimal;
  }[];
  intentId: string;
  attemptId: string;
}

function quoteFor(
  lines: OrderLineSpec[],
  fee: Prisma.Decimal,
  zoneId: string | null,
  delivery: Quote['delivery'],
  at: Date,
): Quote {
  const pricingLines: PricingLine[] = lines.map((line) => ({
    variantId: line.variant.id,
    productId: line.variant.productId,
    categoryId: line.variant.categoryId,
    brandId: line.variant.brandId,
    quantity: line.quantity,
    unitListPrice: line.variant.price,
    taxable: true,
  }));
  return price(
    { lines: pricingLines, shippingFee: fee, shippingZoneId: zoneId, delivery },
    { currency: 'GHS', now: at, promotions: [], taxRates: ctx.taxRates, customer: ANONYMOUS_CUSTOMER, priceLists: [] },
  );
}

async function chooseLocation(candidates: string[], lines: OrderLineSpec[]): Promise<string> {
  for (const locationId of candidates) {
    let fits = true;
    for (const line of lines) {
      if ((await available(prisma, line.variant.id, locationId)) < line.quantity) fits = false;
    }
    if (fits) return locationId;
  }
  throw new Error(`No location holds ${lines.map((l) => `${l.quantity} × ${l.variant.sku}`).join(', ')}`);
}

// Orders priced by the real engine (no promotions), reserved at the first serving location that holds every line.
async function placeOrder(spec: OrderSpec): Promise<PlacedOrder> {
  const customer = customerOf(spec.customer);
  const method = spec.method ?? 'ONLINE';
  const at = spec.at;
  let quote: Quote;
  let candidates: string[];
  let fulfilment: Partial<Prisma.OrderUncheckedCreateInput>;
  if (spec.pickup) {
    const pickup = ctx.pickups.get(spec.pickup);
    if (!pickup) throw new Error(`No pickup point ${spec.pickup}`);
    quote = quoteFor(spec.lines, D(0), null, null, at);
    candidates = pickup.locations;
    fulfilment = {
      fulfillmentType: 'PICKUP',
      pickupLocationId: pickup.id,
      pickupLocationSnapshot: pickup.snapshot as Prisma.InputJsonObject,
    };
  } else {
    const zone = ctx.zones.get(customer.address.region);
    if (!zone) throw new Error(`No delivery zone for ${customer.address.region}`);
    const level: DeliveryServiceLevel = spec.express ? 'EXPRESS' : 'STANDARD';
    const merchandise = quoteFor(spec.lines, D(0), zone.id, null, at).grandTotal;
    const weight = spec.lines.reduce((sum, line) => sum + line.variant.weightGrams * line.quantity, 0);
    const fee = deliveryFee(zone.rules, level, weight, merchandise);
    if (!fee) throw new Error(`${zone.name} has no ${level} delivery`);
    quote = quoteFor(spec.lines, fee.fee, zone.id, { rateRuleId: fee.rateRuleId, serviceLevel: level, slot: null }, at);
    candidates = zone.locations;
    const address = await prisma.address.findUniqueOrThrow({ where: { id: customer.addressId } });
    fulfilment = {
      fulfillmentType: 'DELIVERY',
      shippingAddressId: address.id,
      shippingAddressSnapshot: toAddressSnapshot(address) as Prisma.InputJsonObject,
      shippingZoneId: zone.id,
      shippingZoneName: zone.name,
      rateRuleId: fee.rateRuleId,
      serviceLevel: level,
      shippingFee: fee.fee,
    };
  }
  const locationId = await chooseLocation(candidates, spec.lines);
  const store = await prisma.store.update({ where: { singleton: true }, data: { nextOrderNumber: { increment: 1 } } });
  const number = store.nextOrderNumber - 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: number,
      userId: customer.id,
      currency: 'GHS',
      pricingVersion: PRICING_VERSION,
      subtotal: quote.subtotal,
      discountTotal: quote.discountTotal,
      taxTotal: quote.taxTotal,
      shippingTotal: quote.shippingTotal,
      grandTotal: quote.grandTotal,
      paymentMethod: method,
      contactEmail: customer.email,
      contactPhone: customer.phone,
      codPhone: method === 'CASH_ON_DELIVERY' ? customer.phone : null,
      stockLocationId: locationId,
      createdAt: at,
      updatedAt: at,
      ...fulfilment,
    },
  });
  const items: PlacedOrder['items'] = [];
  for (const line of quote.lines) {
    const seeded = spec.lines[line.cartLineIndex].variant;
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: seeded.productId,
        variantId: seeded.id,
        productName: seeded.productName,
        sku: seeded.sku,
        optionValues: seeded.options,
        quantity: line.quantity,
        unitListPrice: line.unitListPrice,
        unitDiscount: line.unitDiscount,
        unitNet: line.unitNet,
        unitTax: line.unitTax,
        lineTotal: line.lineTotal,
        createdAt: at,
        taxLines: {
          create: line.taxLines.map((tax) => ({
            taxId: tax.taxId,
            name: tax.name,
            rate: tax.rate,
            base: tax.base,
            amount: tax.amount,
          })),
        },
      },
    });
    await prisma.stockReservation.create({
      data: {
        variantId: seeded.id,
        locationId,
        orderId: order.id,
        orderItemId: item.id,
        quantity: line.quantity,
        createdAt: at,
      },
    });
    await move(prisma, {
      variantId: seeded.id,
      locationId,
      reserved: line.quantity,
      reason: 'RESERVE',
      refType: 'Order',
      refId: order.id,
      at,
    });
    items.push({
      id: item.id,
      variant: seeded,
      quantity: line.quantity,
      lineTotal: line.lineTotal,
      unitNet: line.unitNet,
      unitTax: line.unitTax,
    });
  }
  await prisma.orderStatusEvent.create({
    data: { orderId: order.id, to: 'PLACED', actorId: customer.id, createdAt: at },
  });
  const intent = await prisma.paymentIntent.create({
    data: { orderId: order.id, amount: quote.grandTotal, createdAt: at, updatedAt: at },
  });
  const online = method === 'ONLINE';
  const attempt = await prisma.paymentAttempt.create({
    data: {
      intentId: intent.id,
      provider: online ? 'PAYSTACK' : 'CASH_ON_DELIVERY',
      reference: online ? `DEMO-${number}` : null,
      amount: quote.grandTotal,
      channel: online ? (spec.channel ?? 'mobile_money') : 'cash',
      createdAt: at,
      updatedAt: at,
    },
  });
  return {
    id: order.id,
    number,
    customer,
    quote,
    method,
    locationId,
    at,
    items,
    intentId: intent.id,
    attemptId: attempt.id,
  };
}

async function orderEvent(order: PlacedOrder, from: string, to: string, at: Date, actorId?: string) {
  await prisma.orderStatusEvent.create({
    data: { orderId: order.id, from: from as never, to: to as never, actorId, createdAt: at },
  });
  await prisma.order.update({ where: { id: order.id }, data: { status: to as never, updatedAt: at } });
}

async function capture(order: PlacedOrder, at: Date) {
  await prisma.paymentAttempt.update({
    where: { id: order.attemptId },
    data: { status: 'CAPTURED', rawStatus: order.method === 'ONLINE' ? 'success' : null, updatedAt: at },
  });
  await prisma.paymentIntent.update({ where: { id: order.intentId }, data: { status: 'CAPTURED', updatedAt: at } });
}

// Reserved units leave the shelf; lot-tracked lines draw the unexpired lot that expires first (FEFO).
async function consume(order: PlacedOrder, at: Date) {
  const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id, status: 'ACTIVE' } });
  for (const r of reservations) {
    await prisma.stockReservation.update({ where: { id: r.id }, data: { status: 'CONSUMED', updatedAt: at } });
    const item = order.items.find((i) => i.id === r.orderItemId) as PlacedOrder['items'][number];
    if (item.variant.lots) {
      let left = r.quantity;
      const lots = await prisma.lotStock.findMany({
        where: { locationId: r.locationId, onHand: { gt: 0 }, lot: { variantId: r.variantId, expiresAt: { gt: NOW } } },
        include: { lot: true },
        orderBy: { lot: { expiresAt: 'asc' } },
      });
      for (const lot of lots) {
        if (left === 0) break;
        const take = Math.min(left, lot.onHand);
        left -= take;
        await move(prisma, {
          variantId: r.variantId,
          locationId: r.locationId,
          onHand: -take,
          reserved: left === 0 ? -r.quantity : 0,
          reason: 'SALE',
          refType: 'Order',
          refId: order.id,
          lotId: lot.lotId,
          at,
        });
      }
      if (left > 0) throw new Error(`Not enough unexpired lots for ${item.variant.sku}`);
    } else {
      await move(prisma, {
        variantId: r.variantId,
        locationId: r.locationId,
        onHand: -r.quantity,
        reserved: -r.quantity,
        reason: 'SALE',
        refType: 'Order',
        refId: order.id,
        at,
      });
    }
    const cost = await prisma.variant.findUniqueOrThrow({ where: { id: r.variantId }, select: { costPrice: true } });
    await prisma.orderItem.update({
      where: { id: r.orderItemId },
      data: { unitCost: cost.costPrice, costRecordedAt: at },
    });
  }
}

async function payOnline(order: PlacedOrder, at: Date) {
  await capture(order, at);
  await consume(order, at);
  await orderEvent(order, 'PLACED', 'CONFIRMED', at);
}

async function closeUnpaid(order: PlacedOrder, to: 'CANCELLED' | 'EXPIRED', at: Date, actorId?: string) {
  const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id, status: 'ACTIVE' } });
  for (const r of reservations) {
    await prisma.stockReservation.update({ where: { id: r.id }, data: { status: 'RELEASED', updatedAt: at } });
    await move(prisma, {
      variantId: r.variantId,
      locationId: r.locationId,
      reserved: -r.quantity,
      reason: 'RELEASE',
      refType: 'Order',
      refId: order.id,
      at,
    });
  }
  await prisma.paymentAttempt.update({ where: { id: order.attemptId }, data: { status: 'CANCELLED', updatedAt: at } });
  await prisma.paymentIntent.update({ where: { id: order.intentId }, data: { status: 'CANCELLED', updatedAt: at } });
  await orderEvent(order, 'PLACED', to, at, actorId);
}

const SHIPMENT_PATH: Record<string, ShipmentStatus[]> = {
  PICKING: ['PICKING'],
  PACKED: ['PICKING', 'PACKED'],
  OUT_FOR_DELIVERY: ['PICKING', 'PACKED', 'OUT_FOR_DELIVERY'],
  DELIVERED: ['PICKING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'],
  READY_FOR_PICKUP: ['PICKING', 'PACKED', 'READY_FOR_PICKUP'],
  PICKED_UP: ['PICKING', 'PACKED', 'READY_FOR_PICKUP', 'DELIVERED'],
};

// One shipment carrying the whole order, walked through its statuses an hour apart; serial units are picked at
// PACKED and sold at dispatch.
async function ship(order: PlacedOrder, final: keyof typeof SHIPMENT_PATH, at: Date, rider?: string) {
  const path = SHIPMENT_PATH[final];
  const fulfiller = staffId('inventory');
  const dispatchIndex = path.findIndex((s) => s === 'OUT_FOR_DELIVERY' || s === 'READY_FOR_PICKUP');
  const deliveredIndex = path.indexOf('DELIVERED');
  const stepAt = (i: number) => plusMinutes(at, 60 * (i + 1));
  const finalStatus = path[path.length - 1];
  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      status: finalStatus,
      carrier: final === 'READY_FOR_PICKUP' || final === 'PICKED_UP' ? null : 'Emma Electronics riders',
      dispatchedAt: dispatchIndex >= 0 ? stepAt(dispatchIndex) : null,
      deliveredAt: deliveredIndex >= 0 ? stepAt(deliveredIndex) : null,
      riderId: rider,
      assignedAt: rider ? stepAt(0) : null,
      createdAt: at,
      updatedAt: stepAt(path.length - 1),
      items: { create: order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity, createdAt: at })) },
    },
    include: { items: true },
  });
  let previous: ShipmentStatus = 'PENDING';
  await prisma.shipmentStatusEvent.create({
    data: { shipmentId: shipment.id, to: 'PENDING', actorId: fulfiller, createdAt: at },
  });
  for (const [i, status] of path.entries()) {
    const actor = rider && (status === 'OUT_FOR_DELIVERY' || status === 'DELIVERED') ? rider : fulfiller;
    await prisma.shipmentStatusEvent.create({
      data: { shipmentId: shipment.id, from: previous, to: status, actorId: actor, createdAt: stepAt(i) },
    });
    previous = status;
  }
  if (order.method === 'CASH_ON_DELIVERY' && dispatchIndex >= 0) await consume(order, stepAt(dispatchIndex));

  const packed = path.includes('PACKED');
  for (const item of order.items.filter((i) => i.variant.serial)) {
    if (!packed) continue;
    const shipmentItem = shipment.items.find((s) => s.orderItemId === item.id) as (typeof shipment.items)[number];
    const units = await prisma.serialUnit.findMany({
      where: { variantId: item.variant.id, locationId: order.locationId, status: 'IN_STOCK' },
      orderBy: { serial: 'asc' },
      take: item.quantity,
    });
    if (units.length < item.quantity) throw new Error(`Not enough serial units of ${item.variant.sku}`);
    const packedAt = stepAt(path.indexOf('PACKED'));
    for (const unit of units) {
      const dispatched = dispatchIndex >= 0;
      const delivered = deliveredIndex >= 0;
      const warrantyStartsAt = delivered ? stepAt(deliveredIndex) : null;
      await prisma.serialUnit.update({
        where: { id: unit.id },
        data: {
          status: dispatched ? 'SOLD' : 'ASSIGNED',
          locationId: dispatched ? null : unit.locationId,
          orderItemId: item.id,
          shipmentItemId: shipmentItem.id,
          soldAt: dispatched ? stepAt(dispatchIndex) : null,
          warrantyStartsAt,
          warrantyEndsAt:
            warrantyStartsAt && item.variant.product.warrantyMonths
              ? addMonths(warrantyStartsAt, item.variant.product.warrantyMonths)
              : null,
          updatedAt: packedAt,
        },
      });
      await prisma.serialUnitEvent.create({
        data: {
          serialUnitId: unit.id,
          from: 'IN_STOCK',
          to: 'ASSIGNED',
          locationId: order.locationId,
          orderItemId: item.id,
          refType: 'Order',
          refId: order.id,
          actorId: fulfiller,
          createdAt: packedAt,
        },
      });
      if (dispatched) {
        await prisma.serialUnitEvent.create({
          data: {
            serialUnitId: unit.id,
            from: 'ASSIGNED',
            to: 'SOLD',
            orderItemId: item.id,
            refType: 'Order',
            refId: order.id,
            actorId: fulfiller,
            createdAt: stepAt(dispatchIndex),
          },
        });
      }
    }
  }
  return {
    id: shipment.id,
    finishedAt: stepAt(path.length - 1),
    deliveredAt: deliveredIndex >= 0 ? stepAt(deliveredIndex) : null,
  };
}

async function earnPoints(order: PlacedOrder, at: Date) {
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  const points = earnedPoints(paidGoods(items), 1);
  if (points === 0) return;
  const expiresAt = addMonths(at, 12);
  await prisma.loyaltyAccount.upsert({
    where: { userId: order.customer.id },
    create: { userId: order.customer.id, balance: points, createdAt: at },
    update: { balance: { increment: points } },
  });
  const tx = await prisma.loyaltyTransaction.create({
    data: { userId: order.customer.id, type: 'EARN', points, orderId: order.id, createdAt: at },
  });
  const lot = await prisma.loyaltyLot.create({
    data: { userId: order.customer.id, transactionId: tx.id, points, remaining: points, expiresAt, createdAt: at },
  });
  const lots = ctx.loyaltyLots.get(order.customer.id) ?? [];
  lots.push({ id: lot.id, remaining: points, expiresAt, createdAt: at });
  ctx.loyaltyLots.set(order.customer.id, lots);
}

// A delivered online order: paid, shipped by a rider with a delivery code, completed, points earned.
async function deliverOnline(order: PlacedOrder, at: Date, rider = staffId('rider1')) {
  await payOnline(order, at);
  const shipped = await ship(order, 'DELIVERED', plusMinutes(at, 120), rider);
  await prisma.proofOfDelivery.create({
    data: {
      shipmentId: shipped.id,
      method: 'CODE',
      deliveredById: rider,
      deliveredAt: shipped.deliveredAt as Date,
      recipientName: order.customer.name,
    },
  });
  await orderEvent(order, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(at, 180));
  await orderEvent(order, 'IN_FULFILMENT', 'COMPLETED', shipped.finishedAt);
  await earnPoints(order, shipped.finishedAt);
  return shipped;
}

// Cash on delivery: confirmed at placement, stock consumed at dispatch, cash taken by the rider at the door.
async function deliverCod(order: PlacedOrder, at: Date, rider = staffId('rider1')) {
  await orderEvent(order, 'PLACED', 'CONFIRMED', at);
  const shipped = await ship(order, 'DELIVERED', plusMinutes(at, 120), rider);
  await orderEvent(order, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(at, 180));
  const deliveredAt = shipped.deliveredAt as Date;
  await prisma.proofOfDelivery.create({
    data: {
      shipmentId: shipped.id,
      method: 'CODE',
      deliveredById: rider,
      deliveredAt,
      recipientName: order.customer.name,
    },
  });
  await capture(order, deliveredAt);
  await prisma.cashCollection.create({
    data: {
      orderId: order.id,
      attemptId: order.attemptId,
      riderId: rider,
      recordedById: rider,
      amount: order.quote.grandTotal,
      collectedAt: deliveredAt,
      createdAt: deliveredAt,
    },
  });
  await orderEvent(order, 'IN_FULFILMENT', 'COMPLETED', deliveredAt);
  await earnPoints(order, deliveredAt);
  return shipped;
}

// A processed refund of some units of the first line (by the stored snapshot), with the loyalty settlement.
async function refund(order: PlacedOrder, quantity: number, reason: RefundReason, at: Date, returnRequestId?: string) {
  const item = order.items[0];
  const amount = item.unitNet.add(item.unitTax).mul(quantity);
  const taxAmount = item.unitTax.mul(quantity);
  const row = await prisma.refund.create({
    data: {
      attemptId: order.attemptId,
      returnRequestId,
      amount,
      taxAmount,
      status: 'PROCESSED',
      providerRef: `DEMO-RFD-${order.number}-${quantity}`,
      idempotencyKey: returnRequestId ? `return:${returnRequestId}` : `staff:demo-${order.number}`,
      reason,
      method: order.method === 'ONLINE' ? 'PROVIDER' : 'CASH',
      createdById: staffId('manager'),
      createdAt: at,
      updatedAt: at,
      lines: { create: [{ orderItemId: item.id, quantity, amount }] },
    },
  });
  const refunded = await prisma.refund.aggregate({
    _sum: { amount: true },
    where: { attemptId: order.attemptId, status: 'PROCESSED' },
  });
  const total = refunded._sum.amount ?? D(0);
  await prisma.paymentIntent.update({
    where: { id: order.intentId },
    data: { status: total.gte(order.quote.grandTotal) ? 'REFUNDED' : 'PARTIALLY_REFUNDED', updatedAt: at },
  });
  // Points follow the refunded share of the goods (LoyaltyLedger.settleOrder's rule).
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  const earned = await prisma.loyaltyTransaction.findFirst({ where: { orderId: order.id, type: 'EARN' } });
  if (earned) {
    const goods = paidGoods(items);
    const refundedGoods =
      (
        await prisma.refundLine.aggregate({
          _sum: { amount: true },
          where: { refund: { attemptId: order.attemptId, status: 'PROCESSED' } },
        })
      )._sum.amount ?? D(0);
    const { reverse } = orderSettlement(
      { earned: earned.points, reversed: 0, redeemed: 0, returned: 0 },
      { status: 'COMPLETED', paid: goods, refunded: refundedGoods },
    );
    if (reverse > 0) {
      const lots = ctx.loyaltyLots.get(order.customer.id) ?? [];
      const earnedLot = await prisma.loyaltyLot.findUnique({ where: { transactionId: earned.id } });
      const { draws } = drawPoints(
        lots.filter((lot) => lot.remaining > 0),
        reverse,
        earnedLot?.id,
      );
      for (const draw of draws) {
        await prisma.loyaltyLot.update({ where: { id: draw.lotId }, data: { remaining: { decrement: draw.points } } });
        const lot = lots.find((l) => l.id === draw.lotId);
        if (lot) lot.remaining -= draw.points;
      }
      await prisma.loyaltyAccount.update({
        where: { userId: order.customer.id },
        data: { balance: { decrement: reverse } },
      });
      await prisma.loyaltyTransaction.create({
        data: {
          userId: order.customer.id,
          type: 'REVERSE',
          points: -reverse,
          orderId: order.id,
          draws: draws as unknown as Prisma.InputJsonArray,
          createdAt: at,
        },
      });
    }
  }
  return row;
}

interface OrderNotes {
  label: string;
  number: number;
  customer: string;
}
const scenarioOrders: OrderNotes[] = [];
const note = (label: string, order: PlacedOrder) =>
  scenarioOrders.push({ label, number: order.number, customer: order.customer.email });

async function seedScenarioOrders() {
  const manager = staffId('manager');
  const rider1 = staffId('rider1');
  const rider2 = staffId('rider2');

  // Order history over the last 90 days: delivered online and cash orders, for reports, reviews and loyalty.
  const historyCustomers = ['abena', 'kwabena', 'esi', 'nanayaw', 'adwoa', 'akua', 'yaw', 'efia', 'kweku', 'selorm'];
  const historyCatalogue = ctx.variants.filter((v) => !v.lots && v.price.lt(9000));
  const history: PlacedOrder[] = [];
  for (let n = 0; n < 45; n++) {
    const customerKey = pick(historyCustomers);
    const customer = customerOf(customerKey);
    const lines: OrderLineSpec[] = [{ variant: pick(historyCatalogue), quantity: 1 }];
    if (random() < 0.4) {
      const extra = pick(
        ctx.variants.filter((v) => v.product.category === 'Accessories' || v.product.subcategory === 'Power Banks'),
      );
      if (extra.id !== lines[0].variant.id) lines.push({ variant: extra, quantity: between(1, 2) });
    }
    const codAllowed = ctx.zones.get(customer.address.region)?.name !== 'Rest of Ghana' && customer.phoneVerified;
    const cod = codAllowed && random() < 0.3;
    const at = daysAgo(90 - n * 2 + between(0, 1), between(8, 20), between(0, 59));
    try {
      const order = await placeOrder({
        customer: customerKey,
        lines,
        method: cod ? 'CASH_ON_DELIVERY' : 'ONLINE',
        channel: random() < 0.6 ? 'mobile_money' : 'card',
        at,
      });
      if (cod) await deliverCod(order, plusMinutes(at, 30), random() < 0.5 ? rider1 : rider2);
      else await deliverOnline(order, plusMinutes(at, 5), random() < 0.5 ? rider1 : rider2);
      history.push(order);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('No location holds')) throw error;
    }
  }

  // Current orders, one per state, for walking every staff and customer flow.
  let o = await placeOrder({
    customer: 'efia',
    lines: [{ variant: variant('galaxy-a55'), quantity: 1 }],
    at: daysAgo(0, NOW.getUTCHours(), 0),
  });
  note('PLACED, online, awaiting payment (expires if unpaid)', o);

  o = await placeOrder({
    customer: 'abena',
    lines: [
      { variant: variant('hp-250-g9'), quantity: 1 },
      { variant: variant('logitech-m185'), quantity: 1 },
    ],
    channel: 'card',
    at: daysAgo(1, 9),
  });
  await payOnline(o, plusMinutes(o.at, 4));
  note('CONFIRMED, paid by card: create a shipment, pick the laptop serial, pack, assign a rider', o);

  o = await placeOrder({
    customer: 'kwabena',
    lines: [
      { variant: variant('camon-30'), quantity: 1 },
      { variant: variant('oraimo-usbc-cable'), quantity: 2 },
    ],
    at: daysAgo(1, 11),
  });
  await payOnline(o, plusMinutes(o.at, 3));
  await ship(o, 'PACKED', plusMinutes(o.at, 60));
  await orderEvent(o, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(o.at, 120));
  note('IN_FULFILMENT, packed at the Kumasi branch with its IMEI assigned: assign a rider and dispatch', o);

  o = await placeOrder({
    customer: 'adwoa',
    lines: [{ variant: variant('samsung-cu7000', 1), quantity: 1 }],
    at: daysAgo(0, 7),
  });
  await payOnline(o, plusMinutes(o.at, 2));
  await ship(o, 'OUT_FOR_DELIVERY', plusMinutes(o.at, 30), rider1);
  await orderEvent(o, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(o.at, 90));
  note(
    'OUT_FOR_DELIVERY with rider1 (online): complete with an override reason as Owner/Manager (the SMS code was never sent)',
    o,
  );

  o = await placeOrder({
    customer: 'nanayaw',
    lines: [
      { variant: variant('binatone-blender'), quantity: 1 },
      { variant: variant('binatone-kettle'), quantity: 1 },
    ],
    method: 'CASH_ON_DELIVERY',
    at: daysAgo(0, 6),
  });
  await orderEvent(o, 'PLACED', 'CONFIRMED', o.at);
  await ship(o, 'OUT_FOR_DELIVERY', plusMinutes(o.at, 30), rider2);
  await orderEvent(o, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(o.at, 90));
  note('OUT_FOR_DELIVERY, cash on delivery with rider2: collect cash on completion', o);

  o = await placeOrder({
    customer: 'akua',
    lines: [{ variant: variant('hot-40i'), quantity: 1 }],
    method: 'CASH_ON_DELIVERY',
    at: daysAgo(0, 8),
  });
  await orderEvent(o, 'PLACED', 'CONFIRMED', o.at);
  note('CONFIRMED, cash on delivery, not shipped yet (Kumasi): create the shipment', o);

  o = await placeOrder({
    customer: 'abena',
    lines: [{ variant: variant('jbl-flip-6', 1), quantity: 1 }],
    pickup: 'osu',
    at: daysAgo(0, 9),
  });
  await payOnline(o, plusMinutes(o.at, 2));
  await ship(o, 'READY_FOR_PICKUP', plusMinutes(o.at, 20));
  await orderEvent(o, 'CONFIRMED', 'IN_FULFILMENT', plusMinutes(o.at, 80));
  note('READY_FOR_PICKUP at the Osu shop: hand over (shipment DELIVERED)', o);

  o = await placeOrder({
    customer: 'selorm',
    lines: [
      { variant: variant('duracell-aa-4'), quantity: 4 },
      { variant: variant('energizer-aaa-4'), quantity: 2 },
    ],
    at: daysAgo(1, 15),
  });
  await payOnline(o, plusMinutes(o.at, 3));
  note('CONFIRMED, lot-tracked batteries (drawn FEFO from the lot expiring in 20 days)', o);

  o = await placeOrder({
    customer: 'yaw',
    lines: [{ variant: variant('nokia-105'), quantity: 2 }],
    at: daysAgo(2, 10),
  });
  await closeUnpaid(o, 'CANCELLED', plusMinutes(o.at, 25), o.customer.id);
  note('CANCELLED by the customer before paying', o);

  o = await placeOrder({
    customer: 'kweku',
    lines: [{ variant: variant('itel-a70'), quantity: 1 }],
    at: daysAgo(3, 10),
  });
  await closeUnpaid(o, 'EXPIRED', plusMinutes(o.at, 60));
  note('EXPIRED: never paid', o);

  // Delivered recently, inside the return window: return and refund flows.
  o = await placeOrder({
    customer: 'efia',
    lines: [{ variant: variant('sony-wh1000xm5'), quantity: 1 }],
    at: daysAgo(4, 10),
  });
  await deliverOnline(o, plusMinutes(o.at, 5), rider1);
  note('COMPLETED 4 days ago: request a return as the customer (within 14 days)', o);

  o = await placeOrder({
    customer: 'abena',
    lines: [{ variant: variant('galaxy-a15', 1), quantity: 1 }],
    at: daysAgo(3, 12),
  });
  await deliverOnline(o, plusMinutes(o.at, 5), rider2);
  const requested = await prisma.returnRequest.create({
    data: {
      orderId: o.id,
      userId: o.customer.id,
      status: 'REQUESTED',
      reason: 'Screen has a dead pixel in the top corner',
      createdAt: daysAgo(1, 14),
      lines: {
        create: [
          {
            orderItemId: o.items[0].id,
            quantity: 1,
            reason: ReturnReason.DEFECTIVE,
            note: 'Dead pixel near the camera',
          },
        ],
      },
    },
  });
  await prisma.returnStatusEvent.create({
    data: { returnRequestId: requested.id, to: 'REQUESTED', actorId: o.customer.id, createdAt: daysAgo(1, 14) },
  });
  note('COMPLETED with a return REQUESTED (defective phone): approve, receive, inspect, refund', o);

  o = await placeOrder({
    customer: 'nanayaw',
    lines: [{ variant: variant('spigen-s24-case'), quantity: 2 }],
    at: daysAgo(9, 10),
  });
  await deliverOnline(o, plusMinutes(o.at, 5), rider1);
  const done = await prisma.returnRequest.create({
    data: {
      orderId: o.id,
      userId: o.customer.id,
      status: 'REFUNDED',
      reason: 'Ordered the wrong colour',
      refundAmount: o.items[0].unitNet.add(o.items[0].unitTax),
      createdAt: daysAgo(7, 9),
      lines: {
        create: [
          {
            orderItemId: o.items[0].id,
            quantity: 1,
            reason: ReturnReason.CHANGED_MIND,
            receivedQuantity: 1,
            restockQuantity: 1,
            writeOffQuantity: 0,
          },
        ],
      },
    },
  });
  for (const [i, [from, to]] of (
    [
      [null, 'REQUESTED'],
      ['REQUESTED', 'APPROVED'],
      ['APPROVED', 'RECEIVED'],
      ['RECEIVED', 'INSPECTED'],
      ['INSPECTED', 'REFUND_PENDING'],
      ['REFUND_PENDING', 'REFUNDED'],
    ] as const
  ).entries()) {
    await prisma.returnStatusEvent.create({
      data: {
        returnRequestId: done.id,
        from,
        to,
        actorId: i === 0 ? o.customer.id : manager,
        createdAt: daysAgo(7 - Math.min(i, 5), 9 + i),
      },
    });
  }
  await move(prisma, {
    variantId: o.items[0].variant.id,
    locationId: o.locationId,
    onHand: 1,
    reason: 'RETURN_RESTOCK',
    refType: 'ReturnRequest',
    refId: done.id,
    at: daysAgo(5, 11),
  });
  await refund(o, 1, 'RETURN', daysAgo(2, 12), done.id);
  note('Return REFUNDED (1 of 2 cases restocked)', o);

  o = await placeOrder({
    customer: 'kwabena',
    lines: [{ variant: variant('binatone-kettle'), quantity: 2 }],
    at: daysAgo(12, 10),
  });
  await deliverOnline(o, plusMinutes(o.at, 5), rider1);
  await refund(o, 1, 'DAMAGED', daysAgo(10, 15));
  note('COMPLETED, PARTIALLY_REFUNDED (one kettle arrived dented)', o);

  return history;
}

// ---------------------------------------------------------------------------------------------------------------
const REVIEW_TEXT: [number, string, string][] = [
  [
    5,
    'Genuine product, fast delivery',
    'Delivered the next morning in Accra. Sealed box and the warranty card was inside.',
  ],
  [5, 'Very happy', 'Exactly as described. The rider called before arriving and was very polite.'],
  [4, 'Good value', 'Works well. Packaging could be better but no damage.'],
  [4, 'Solid', 'Does the job. Battery life is better than I expected.'],
  [5, 'Original!', 'I checked the IMEI with the manufacturer and it is original. Will buy again.'],
  [3, 'Okay', 'Product is fine but delivery took three days to Kumasi.'],
  [2, 'Not impressed', 'It works, but it heats up more than I expected.'],
  [5, 'Excellent', 'Paid with MoMo, no wahala. Recommended.'],
];

async function seedReviewsAndQuestions(history: PlacedOrder[]) {
  const reviewed = new Set<string>();
  for (const order of history) {
    for (const item of order.items) {
      const key = `${order.customer.id}:${item.variant.productId}`;
      if (reviewed.has(key) || random() < 0.35) continue;
      reviewed.add(key);
      const [score, title, comment] = pick(REVIEW_TEXT);
      const at = plusMinutes(order.at, (between(3, 10) * 24 + between(0, 12)) * 60);
      await prisma.review.create({
        data: {
          productId: item.variant.productId,
          userId: order.customer.id,
          score,
          title,
          comment,
          verifiedPurchase: true,
          orderItemId: item.id,
          createdAt: at.getTime() > NOW.getTime() ? NOW : at,
          reply: score <= 3 ? 'Thank you for the feedback. Our support team will call you to make it right.' : null,
          repliedAt: score <= 3 ? NOW : null,
        },
      });
    }
  }
  // A reported review waiting for moderation.
  const reported = await prisma.review.findFirst({ where: { score: { lte: 3 } }, orderBy: { createdAt: 'desc' } });
  if (reported) {
    await prisma.reviewReport.create({
      data: {
        reviewId: reported.id,
        reporterId: customerOf('amaserwaa').id,
        reason: 'OFF_TOPIC',
        note: 'This is about delivery, not the product',
      },
    });
  }
  await prisma.$executeRaw`
    UPDATE "Product" p SET
      "ratingCount" = s.n, "ratingAverage" = s.avg,
      "rating1Count" = s.c1, "rating2Count" = s.c2, "rating3Count" = s.c3, "rating4Count" = s.c4, "rating5Count" = s.c5
    FROM (
      SELECT "productId", count(*)::int AS n, round(avg(score)::numeric, 2) AS avg,
        count(*) FILTER (WHERE score = 1)::int AS c1, count(*) FILTER (WHERE score = 2)::int AS c2,
        count(*) FILTER (WHERE score = 3)::int AS c3, count(*) FILTER (WHERE score = 4)::int AS c4,
        count(*) FILTER (WHERE score = 5)::int AS c5
      FROM "Review" WHERE status = 'PUBLISHED' GROUP BY "productId"
    ) s
    WHERE p.id = s."productId"`;

  const questions: [string, string, string, string | null][] = [
    [
      'galaxy-s24',
      'kofi',
      'Does this version support two physical SIM cards?',
      'Yes. The Ghana version takes two nano-SIMs plus eSIM.',
    ],
    [
      'nasco-split-ac-15',
      'adwoa',
      'Is installation included in the price?',
      'The installation kit is included. Installation in Accra and Kumasi is GHS 350, booked after delivery.',
    ],
    [
      'hp-250-g9',
      'amaserwaa',
      'Can I upgrade the RAM to 16GB later?',
      'Yes, it has two slots and supports up to 16 GB.',
    ],
    ['firman-spg3800', 'yaw', 'How many hours does it run on a full tank?', null],
  ];
  for (const [key, customerKey, body, answer] of questions) {
    await prisma.productQuestion.create({
      data: {
        productId: variant(key).productId,
        userId: customerOf(customerKey).id,
        body,
        answer,
        answeredAt: answer ? daysAgo(2) : null,
        createdAt: daysAgo(5),
      },
    });
  }
}

async function seedCustomerExtras() {
  // Efia gets a goodwill top-up so she has enough points to redeem at checkout (minimum 500).
  const efia = customerOf('efia');
  const adjust = await prisma.loyaltyTransaction.create({
    data: {
      userId: efia.id,
      type: 'ADJUST',
      points: 1500,
      reason: 'Goodwill: late delivery in October',
      actorId: staffId('manager'),
      createdAt: daysAgo(20),
    },
  });
  await prisma.loyaltyLot.create({
    data: {
      userId: efia.id,
      transactionId: adjust.id,
      points: 1500,
      remaining: 1500,
      expiresAt: addMonths(daysAgo(20), 12),
      createdAt: daysAgo(20),
    },
  });
  await prisma.loyaltyAccount.upsert({
    where: { userId: efia.id },
    create: { userId: efia.id, balance: 1500 },
    update: { balance: { increment: 1500 } },
  });
  // Ama Serwaa was referred by Abena and has not ordered yet (WELCOME10 and the referral reward on her first order).
  await prisma.referral.create({
    data: { referrerId: customerOf('abena').id, refereeId: customerOf('amaserwaa').id, createdAt: daysAgo(3) },
  });
  await prisma.user.update({ where: { id: customerOf('abena').id }, data: { referralCode: 'ABENA7KQ' } });
  // Selorm left items in the cart six hours ago (abandoned-cart reminder; marketing email consent given).
  const cart = await prisma.cart.create({
    data: { userId: customerOf('selorm').id, createdAt: plusMinutes(NOW, -400), updatedAt: plusMinutes(NOW, -360) },
  });
  for (const [key, quantity] of [
    ['galaxy-watch6', 1],
    ['anker-20w-usbc', 2],
  ] as const) {
    const v = variant(key);
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: v.productId,
        variantId: v.id,
        quantity,
        originalPrice: v.price,
        createdAt: plusMinutes(NOW, -380),
        updatedAt: plusMinutes(NOW, -360),
      },
    });
  }
}

// Rider 1 handed in the cash of all but the last two collections; their latest remittance was short by GHS 20.
async function seedCashRemittances() {
  const cashier = staffId('cashier');
  for (const rider of [staffId('rider1'), staffId('rider2')]) {
    const collections = await prisma.cashCollection.findMany({
      where: { riderId: rider },
      orderBy: [{ collectedAt: 'asc' }, { id: 'asc' }],
    });
    const remitted = collections.slice(0, Math.max(0, collections.length - 2));
    if (remitted.length === 0) continue;
    const expected = remitted.reduce((sum, c) => sum.add(c.amount), D(0));
    const short = rider === staffId('rider1') ? D(20) : D(0);
    const remittance = await prisma.cashRemittance.create({
      data: {
        riderId: rider,
        receivedById: cashier,
        amount: expected.sub(short),
        expectedAmount: expected,
        discrepancy: short.neg(),
        currency: 'GHS',
        note: short.gt(0) ? 'Rider says one customer paid GHS 20 short; follow up' : null,
        receivedAt: plusMinutes(remitted[remitted.length - 1].collectedAt, 240),
      },
    });
    await prisma.cashCollection.updateMany({
      where: { id: { in: remitted.map((c) => c.id) } },
      data: { remittanceId: remittance.id },
    });
  }
}

async function rebuildAnalytics() {
  const repository = new AnalyticsRollupRepository();
  const today = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
  for (let offset = -100; offset <= 0; offset += 31) {
    const from = new Date(today.getTime() + offset * DAY_MS);
    const to = new Date(Math.min(from.getTime() + 31 * DAY_MS, today.getTime() + DAY_MS));
    await prisma.$transaction((tx) => repository.rebuild(tx, { from, to }, NOW), { timeout: 120_000 });
  }
}

function writeAccounts(password: string, totpSecret: string) {
  const dir = join(process.cwd(), 'tmp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, 'demo-accounts.md');
  const lines = [
    '# Demo store accounts (local only, gitignored)',
    '',
    `Generated ${NOW.toISOString()} by \`npm run seed:demo\`. Every account below uses the same password:`,
    '',
    `    ${password}`,
    '',
    'Owner and Manager need a TOTP code (two-factor). Add this secret to an authenticator app (Google Authenticator,',
    'Authy, 1Password: "enter a setup key", time-based, 6 digits), one entry per account:',
    '',
    `    ${totpSecret}`,
    '',
    '## Staff',
    '',
    '| Role | Email |',
    '|---|---|',
    ...STAFF.map((s) => `| ${s.role} | ${s.email} |`),
    '',
    '## Customers',
    '',
    '| Customer | Email | Region | Notes |',
    '|---|---|---|---|',
    ...CUSTOMERS.map((c) => `| ${c.name} | ${c.email} | ${c.address.city} | ${customerNote(c)} |`),
    '',
    '## Orders to start from',
    '',
    '| Order | Customer | State |',
    '|---|---|---|',
    ...scenarioOrders.map((o) => `| ${o.number} | ${o.customer} | ${o.label} |`),
    '',
    '## Coupons',
    '',
    '- `WELCOME10`: 10% off a first order (try it as ama.serwaa@example.com).',
    '- `STUDENT15`: 15% off computers, Students group only (abena.owusu, ama.serwaa).',
    '- `SAVE50`: GHS 50 off orders over GHS 1,000, 3 uses in total.',
    '- `XMAS2025`: expired, should be refused.',
    '',
    'Automatic: 10% off phones and tablets, GHS 200 off the 55" Samsung CU7000 and LG UR80, FreePods 4 at GHS 299',
    '(first 20 units), buy 2 accessories get 1 free, power-bank tiers, 5% off over GHS 10,000, free Accra delivery over',
    'GHS 1,500. Corporate buyers (nana.yaw.appiah) get volume prices on three laptops from 3 units.',
    '',
    'Payments use Paystack test mode only if you configure test keys; seeded payment references (DEMO-…) do not exist',
    'at Paystack. SMS and email are skipped or logged unless Hubtel/Resend are configured.',
  ];
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}
function customerNote(c: DemoCustomer): string {
  const notes: string[] = [];
  if (!c.phoneVerified) notes.push('phone NOT verified (cash on delivery refused)');
  if (c.address.region !== GhanaRegion.GREATER_ACCRA && c.address.region !== GhanaRegion.ASHANTI)
    notes.push('Rest of Ghana zone (no COD)');
  if (c.key === 'amaserwaa') notes.push('no orders yet, referred by Abena, Students group');
  if (c.key === 'abena') notes.push('Students group, referral code ABENA7KQ');
  if (c.key === 'nanayaw') notes.push('Corporate buyers group');
  if (c.key === 'selorm') notes.push('abandoned cart');
  if (c.key === 'efia') notes.push('loyalty points to redeem');
  return notes.join('; ');
}

async function main() {
  const started = Date.now();
  // The staff TOTP secrets are sealed with the app's key, so a missing key must stop the seed before it writes anything.
  const mfaKey = parseMfaKey(process.env.MFA_ENCRYPTION_KEY ?? '');
  await assertEmptyDatabase();
  const password = process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(9).toString('base64url')}`;
  const totpSecret = base32Encode(randomBytes(20));
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    const result = await run();
    console.log(`seed:demo ${name} (${((Date.now() - at) / 1000).toFixed(1)} s)`);
    return result;
  };
  await step('store, taxes, locations', seedStore);
  const groups = await step('staff and customers', () => seedPeople(bcrypt.hashSync(password, 10), totpSecret, mfaKey));
  await step('categories and brands', seedTaxonomy);
  await step('catalogue', seedCatalogue);
  await step('purchase orders and opening stock', seedPurchasing);
  await step('delivery zones and pickup points', seedDelivery);
  await step('promotions and price lists', () => seedPromotions(groups));
  await step('storefront content', seedContent);
  const history = await step('orders', seedScenarioOrders);
  await step('reviews and questions', () => seedReviewsAndQuestions(history));
  await step('referral and cart', seedCustomerExtras);
  await step('cash remittances', seedCashRemittances);
  await step('analytics rollups', rebuildAnalytics);
  await step('analyze', () => prisma.$executeRawUnsafe('ANALYZE'));
  const file = writeAccounts(password, totpSecret);
  console.log(`seed:demo done in ${((Date.now() - started) / 1000).toFixed(1)} s; sign-in details in ${file}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
