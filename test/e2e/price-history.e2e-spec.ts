import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261124010000_order_state_machines_contract';
const PRICE_HISTORY = '20261125050000_price_history';

interface Row {
  variantId: string;
  field: string;
  oldValue: string | null;
  newValue: string;
  source: string;
  actorId: string | null;
  reason: string | null;
}

describe('Price history (P2-H.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const admin = async (query: string) => {
    const res = await gqlRequest(app, query, undefined, adminToken);
    expect(res.status === 200 ? res.body.errors : res.body).toBeUndefined();
    return res.body.data;
  };
  const rowsOf = async (variantId: string): Promise<Row[]> =>
    (await prisma.priceChange.findMany({ where: { variantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(
      (r) => ({
        variantId: r.variantId,
        field: r.field,
        oldValue: r.oldValue?.toFixed(2) ?? null,
        newValue: r.newValue.toFixed(2),
        source: r.source,
        actorId: r.actorId,
        reason: r.reason,
      }),
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('writes', () => {
    it('createProduct and createVariant record the first base price and selling price as VARIANT_CREATED', async () => {
      const { createProduct } = await admin(
        `mutation { createProduct(createProductInput: { name: "History Tee", productTypeId: "product_type_apparel", variants: [{ optionValues: { size: "M" }, basePrice: "25.00", quantity: 0 }] }) { id } }`,
      );
      const { createVariant } = await admin(
        `mutation { createVariant(input: { productId: "${createProduct.id}", optionValues: { size: "L" }, basePrice: "27.50", quantity: 0 }) { id } }`,
      );
      const firstVariant = await prisma.variant.findFirstOrThrow({
        where: { productId: createProduct.id, id: { not: createVariant.id } },
      });
      const created = (value: string) => [
        {
          field: 'BASE_PRICE',
          oldValue: null,
          newValue: value,
          source: 'VARIANT_CREATED',
          actorId: 'seed_admin',
          reason: null,
        },
        {
          field: 'PRICE',
          oldValue: null,
          newValue: value,
          source: 'VARIANT_CREATED',
          actorId: 'seed_admin',
          reason: null,
        },
      ];

      expect(await rowsOf(firstVariant.id)).toEqual(
        created('25.00').map((r) => ({ ...r, variantId: firstVariant.id })),
      );
      expect(await rowsOf(createVariant.id)).toEqual(
        created('27.50').map((r) => ({ ...r, variantId: createVariant.id })),
      );

      await admin(`mutation { permanentlyDeleteProduct(productId: "${createProduct.id}") { id } }`);

      expect(
        await prisma.priceChange.count({ where: { variantId: { in: [firstVariant.id, createVariant.id] } } }),
      ).toBe(0);
    });

    it('updateVariant records each changed price with the actor and reason, and nothing when unchanged', async () => {
      await admin(
        `mutation { updateVariant(input: { id: "seed_var2", basePrice: "450.00", priceChangeReason: "Supplier discount" }) { id } }`,
      );
      await admin(`mutation { updateVariant(input: { id: "seed_var2", basePrice: "450" }) { id } }`);
      await admin(
        `mutation { updateVariant(input: { id: "seed_var2", image: "https://img.test/phone-2.jpg" }) { id } }`,
      );

      const common = {
        variantId: 'seed_var2',
        source: 'ADMIN_EDIT',
        actorId: 'seed_admin',
        reason: 'Supplier discount',
      };
      expect(await rowsOf('seed_var2')).toEqual([
        { ...common, field: 'BASE_PRICE', oldValue: '499.99', newValue: '450.00' },
        { ...common, field: 'PRICE', oldValue: '499.99', newValue: '450.00' },
      ]);
    });

    it('turning tax on for a product records one PRICE change per repriced variant', async () => {
      await admin(`mutation { createTax(input: { name: "VAT", rate: "0.10", isActive: false }) { id } }`);
      expect(await prisma.priceChange.count({ where: { source: 'TAX_RATE_CHANGE' } })).toBe(0);
      await prisma.tax.updateMany({ where: { name: 'VAT' }, data: { isActive: true } });

      await admin(
        `mutation { updateProduct(productId: "seed_prod2", updateProductInput: { isTaxable: true, priceChangeReason: "VAT registered" }) { id } }`,
      );

      expect((await rowsOf('seed_var2')).slice(2)).toEqual([
        {
          variantId: 'seed_var2',
          field: 'PRICE',
          oldValue: '450.00',
          newValue: '495.00',
          source: 'ADMIN_EDIT',
          actorId: 'seed_admin',
          reason: 'VAT registered',
        },
      ]);
    });

    it('a tax rate change records a TAX_RATE_CHANGE row for each repriced variant only', async () => {
      const vat = await prisma.tax.findFirstOrThrow({ where: { name: 'VAT' } });
      const untouched = await prisma.priceChange.count({ where: { variantId: { not: 'seed_var2' } } });

      await admin(
        `mutation { updateTax(id: "${vat.id}", input: { rate: "0.2", priceChangeReason: "Budget" }) { id } }`,
      );

      expect((await rowsOf('seed_var2')).slice(3)).toEqual([
        {
          variantId: 'seed_var2',
          field: 'PRICE',
          oldValue: '495.00',
          newValue: '540.00',
          source: 'TAX_RATE_CHANGE',
          actorId: 'seed_admin',
          reason: 'Budget',
        },
      ]);
      expect(await prisma.priceChange.count({ where: { variantId: { not: 'seed_var2' } } })).toBe(untouched);

      await admin(`mutation { deleteTax(id: "${vat.id}", priceChangeReason: "Levy removed") { id } }`);

      expect((await rowsOf('seed_var2')).slice(4)).toEqual([
        expect.objectContaining({
          oldValue: '540.00',
          newValue: '450.00',
          source: 'TAX_RATE_CHANGE',
          reason: 'Levy removed',
        }),
      ]);
    });

    it('a failed price write rolls back its price history', async () => {
      // basePrice × 1.05 overflows the Decimal(14, 2) price column, so the reprice fails in Postgres.
      await prisma.product.create({
        data: {
          id: 'hist_overflow',
          name: 'Overflow',
          isTaxable: true,
          categoryId: 'seed_cat',
          variants: { create: { sku: 'HIST-OVERFLOW', basePrice: '999999999999.99', price: '999999999999.99' } },
        },
      });
      const before = await prisma.priceChange.count();

      const res = await gqlRequest(
        app,
        `mutation { createTax(input: { name: "GETFund", rate: "0.05" }) { id } }`,
        undefined,
        adminToken,
      ).expect(200);

      expect(res.body.errors).toBeDefined();
      expect(await prisma.tax.count({ where: { name: 'GETFund' } })).toBe(0);
      expect(await prisma.priceChange.count()).toBe(before);
      expect((await prisma.variant.findUniqueOrThrow({ where: { id: 'seed_var2' } })).price?.toFixed(2)).toBe('450.00');
      await prisma.product.delete({ where: { id: 'hist_overflow' } });
    });
  });

  describe('append-only', () => {
    it('refuses UPDATE and direct DELETE of a price change', async () => {
      const row = await prisma.priceChange.findFirstOrThrow({ where: { variantId: 'seed_var2' } });

      await expect(
        prisma.$executeRawUnsafe(`UPDATE "PriceChange" SET "reason" = 'edited' WHERE id = $1`, row.id),
      ).rejects.toThrow(/PriceChange is append-only: UPDATE refused/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "PriceChange" WHERE id = $1`, row.id)).rejects.toThrow(
        /PriceChange is append-only: DELETE refused/,
      );
      expect((await prisma.priceChange.findUniqueOrThrow({ where: { id: row.id } })).reason).toBe(row.reason);
    });
  });

  describe('admin view', () => {
    const PAGE = `nodes { id variantId field oldValue { amount currency } newValue { amount currency } source reason actorId createdAt } totalCount hasNextPage`;

    it('lists a variant’s history newest first, paginated', async () => {
      const first = await admin(`{ priceChanges(variantId: "seed_var2", first: 2) { ${PAGE} } }`);
      const all = await prisma.priceChange.count({ where: { variantId: 'seed_var2' } });

      expect(first.priceChanges.totalCount).toBe(all);
      expect(first.priceChanges.hasNextPage).toBe(true);
      expect(first.priceChanges.nodes[0]).toEqual(
        expect.objectContaining({
          field: 'PRICE',
          oldValue: { amount: '540.00', currency: 'GHS' },
          newValue: { amount: '450.00', currency: 'GHS' },
          source: 'TAX_RATE_CHANGE',
        }),
      );
      const last = first.priceChanges.nodes[1].id;

      const next = await admin(`{ priceChanges(variantId: "seed_var2", first: 20, after: "${last}") { ${PAGE} } }`);

      expect(next.priceChanges.nodes).toHaveLength(all - 2);
      expect(next.priceChanges.hasNextPage).toBe(false);
      expect(next.priceChanges.nodes.at(-1)).toEqual(
        expect.objectContaining({ field: 'BASE_PRICE', oldValue: { amount: '499.99', currency: 'GHS' } }),
      );
    });

    it('filters by product and by time window', async () => {
      const byProduct = await admin(`{ priceChanges(productId: "seed_prod1") { totalCount } }`);
      const future = await admin(`{ priceChanges(from: "2999-01-01T00:00:00.000Z") { totalCount } }`);
      const past = await admin(`{ priceChanges(to: "2000-01-01T00:00:00.000Z") { totalCount } }`);
      const now = await admin(
        `{ priceChanges(productId: "seed_prod2", from: "2000-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z") { totalCount } }`,
      );

      expect(byProduct.priceChanges.totalCount).toBe(0);
      expect(future.priceChanges.totalCount).toBe(0);
      expect(past.priceChanges.totalCount).toBe(0);
      expect(now.priceChanges.totalCount).toBe(
        await prisma.priceChange.count({ where: { variant: { productId: 'seed_prod2' } } }),
      );
    });

    it('serves Variant.priceHistory to staff', async () => {
      const data = await admin(`{ variant(variantId: "seed_var2") { priceHistory(first: 1) { ${PAGE} } } }`);

      expect(data.variant.priceHistory.nodes).toHaveLength(1);
      expect(data.variant.priceHistory.hasNextPage).toBe(true);
    });

    it('refuses guests and customers', async () => {
      const userToken = await signInUser(app);

      const guest = await gqlRequest(app, `{ priceChanges { totalCount } }`).expect(200);
      const customer = await gqlRequest(app, `{ priceChanges { totalCount } }`, undefined, userToken).expect(200);
      const nested = `{ product(productId: "seed_prod2") { variants { priceHistory { totalCount } } } }`;
      const guestField = await gqlRequest(app, nested).expect(200);
      const customerField = await gqlRequest(app, nested, undefined, userToken).expect(200);

      expect(guest.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(guestField.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(customerField.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('serves staff with catalog.product.read and refuses staff without it', async () => {
      const store = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });
      const tokens: Record<string, string> = {};
      for (const role of ['CASHIER', 'SUPPORT']) {
        const email = `price-history-${role.toLowerCase()}@test.local`;
        const { accessToken } = await signUpUser(app, { email, password: 'Staff@12345', name: role });
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        const staffRole = await prisma.staffRole.findUniqueOrThrow({ where: { key: role } });
        await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: staffRole.id } });
        tokens[role] = accessToken;
      }

      const cashier = await gqlRequest(app, `{ priceChanges { totalCount } }`, undefined, tokens.CASHIER).expect(200);
      const support = await gqlRequest(app, `{ priceChanges { totalCount } }`, undefined, tokens.SUPPORT).expect(200);

      expect(cashier.body.errors).toBeUndefined();
      expect(cashier.body.data.priceChanges.totalCount).toBe(await prisma.priceChange.count());
      expect(support.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });
  });

  describe('backfill on legacy data', () => {
    let legacy: ScratchSchema;
    const rows = () =>
      legacy.query<{
        id: string;
        variantId: string;
        field: string;
        oldValue: string | null;
        newValue: string;
        currency: string;
        source: string;
      }>(
        `SELECT id, "variantId", field::text, "oldValue"::text, "newValue"::text, currency::text, source::text
         FROM "PriceChange" ORDER BY id`,
      );

    beforeAll(async () => {
      legacy = new ScratchSchema(prisma, 'legacy_price_history');
      await legacy.recreate();
      await legacy.migrateTo(BEFORE);
      await legacy.exec(`
        INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
        INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "basePrice", "isActive", "updatedAt") VALUES
          ('v_priced', 'p1', 'PRICED', 'size=s', 11.50, 10.00, true, now()),
          ('v_legacy', 'p1', 'LEGACY', 'size=m', 9.99, NULL, true, now()),
          ('v_unpriced', 'p1', 'UNPRICED', 'size=l', NULL, NULL, false, now());
      `);
      await legacy.exec(migrationSql(PRICE_HISTORY));
    });

    afterAll(async () => {
      await legacy.drop();
    });

    it('gives every priced field of every variant one MIGRATION row with no old value', async () => {
      expect(await rows()).toEqual([
        {
          id: 'price_migration_base_price_v_priced',
          variantId: 'v_priced',
          field: 'BASE_PRICE',
          oldValue: null,
          newValue: '10.00',
          currency: 'GHS',
          source: 'MIGRATION',
        },
        {
          id: 'price_migration_price_v_legacy',
          variantId: 'v_legacy',
          field: 'PRICE',
          oldValue: null,
          newValue: '9.99',
          currency: 'GHS',
          source: 'MIGRATION',
        },
        {
          id: 'price_migration_price_v_priced',
          variantId: 'v_priced',
          field: 'PRICE',
          oldValue: null,
          newValue: '11.50',
          currency: 'GHS',
          source: 'MIGRATION',
        },
      ]);
    });

    it('re-running the backfill adds nothing, and skips fields that already have history', async () => {
      const before = await rows();
      await legacy.exec(`UPDATE "Variant" SET "basePrice" = 9.99 WHERE id = 'v_legacy'`);
      await legacy.exec(
        `INSERT INTO "PriceChange" ("id", "variantId", "field", "newValue", "currency", "source")
         VALUES ('pc_admin', 'v_legacy', 'BASE_PRICE', 9.99, 'GHS', 'ADMIN_EDIT')`,
      );

      await legacy.exec(migrationSqlFrom(PRICE_HISTORY, '-- Backfill'));
      await legacy.exec(migrationSqlFrom(PRICE_HISTORY, '-- Backfill'));

      const after = await rows();
      expect(after.filter((r) => r.source === 'MIGRATION')).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
    });
  });
});
