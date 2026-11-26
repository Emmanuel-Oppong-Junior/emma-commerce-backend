import { INestApplication, INestApplicationContext } from '@nestjs/common';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { parse } from 'csv-parse/sync';
import writeXlsxFile from 'write-excel-file/node';
import { ImportJobStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { ImportApplier } from '../../src/imports/import-applier';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, setStock, stockOf } from '../helpers/db.helper';
import { getAuthHeader, signInAdmin, signInSuperAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';

type Body = { data?: Record<string, any>; errors?: { message: string; extensions?: Record<string, unknown> }[] };
type Cells = (string | number)[][];

const FINAL: ImportJobStatus[] = ['VALIDATED', 'COMPLETED', 'FAILED', 'CANCELLED'];

const csvFile = (rows: Cells) => Buffer.from(rows.map((row) => row.join(',')).join('\n') + '\n');
const xlsxFile = (rows: Cells, sheet = 'Sheet1') =>
  writeXlsxFile(
    rows.map((row) => row.map((value) => ({ value }))),
    { sheet },
  ).toBuffer();

// P8-I accept criteria on real Postgres and Redis: an upload is sniffed and stored, the worker validates it into a
// per-row report (dry run), applying writes through the catalogue rules, PriceChange (IMPORT) and the stock ledger,
// invalid rows are reported and skipped, a re-run never applies a row twice, and exports escape formulas.
describe('Bulk imports and exports (P8-I, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let adminToken: string;
  let clerkToken: string;
  let supportToken: string;
  let customerToken: string;
  let defaultLocationId: string;
  let shopLocationId: string;

  const server = () => app.getHttpServer();
  const gql = async (query: string, token = adminToken): Promise<Body> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body as Body;

  const upload = (
    path: string,
    file: Buffer,
    name: string,
    token = adminToken,
    fields: Record<string, string> = {},
  ) => {
    const req = request(server()).post(`/imports/${path}`).set(getAuthHeader(token));
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req.attach('file', file, name);
  };

  const waitForJob = async (id: string, statuses: ImportJobStatus[] = FINAL) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const job = await prisma.importJob.findUniqueOrThrow({ where: { id } });
      if (statuses.includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`Import job ${id} stayed ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const uploadAndWait = async (
    path: string,
    file: Buffer,
    name: string,
    token = adminToken,
    fields: Record<string, string> = {},
    statuses: ImportJobStatus[] = FINAL,
  ) => {
    const res = await upload(path, file, name, token, fields).expect(201);
    return waitForJob(res.body.id, statuses);
  };

  const rowsOf = (jobId: string) => prisma.importRow.findMany({ where: { jobId }, orderBy: { rowNumber: 'asc' } });

  const staffMember = async (email: string, roleKey: string): Promise<string> => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: email.split('@')[0] });
    const [user, store, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email } }),
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return accessToken;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    worker = await createTestWorker();
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    customerToken = await signInUser(app);
    clerkToken = await staffMember('clerk-import@example.com', 'INVENTORY_CLERK');
    supportToken = await staffMember('support-import@example.com', 'SUPPORT');
    const defaultLocation = await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } });
    defaultLocationId = defaultLocation.id;
    shopLocationId = (
      await prisma.stockLocation.create({ data: { storeId: defaultLocation.storeId, name: 'Osu Shop' } })
    ).id;
    await prisma.tag.create({ data: { id: 'tag_new', name: 'New arrivals' } });
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  describe('products', () => {
    it('validates a CSV as a dry run, reports invalid rows and applies the valid ones on request', async () => {
      const job = await uploadAndWait(
        'products',
        csvFile([
          ['sku', 'product_key', 'name', 'category', 'tags', 'base_price', 'weight_grams', 'status'],
          ['IMP-TEE-S', 'tee', 'Import Tee', 'Electronics', 'New arrivals', '50.00', '200', 'PUBLISHED'],
          ['IMP-MUG', 'mug', 'Import Mug', '', '', '55.00', '', ''],
          ['IMP-BAD', 'bad', 'Bad', 'No such category', '', '10.00', '', ''],
          ['SEED-LAP-001', '', 'Laptop renamed', '', '', '1.00', '', ''],
        ]),
        'products.csv',
      );

      expect(job).toMatchObject({ status: 'VALIDATED', kind: 'PRODUCTS', format: 'CSV', totalRows: 4, validRows: 3 });
      expect(job.file).toBeNull();
      const rows = await rowsOf(job.id);
      expect(rows.map((row) => [row.rowNumber, row.status, row.action])).toEqual([
        [2, 'VALID', 'CREATE'],
        [3, 'VALID', 'CREATE'],
        [4, 'INVALID', 'NONE'],
        [5, 'VALID', 'UPDATE'],
      ]);
      expect(rows[2].errors).toEqual(['No category is called "No such category"']);
      expect(rows[3].warnings).toEqual([
        'base_price is ignored for an existing SKU: change prices with a PRICES import',
      ]);
      expect(await prisma.variant.count({ where: { sku: { startsWith: 'IMP-TEE' } } })).toBe(0);

      const report = await request(server())
        .get(`/imports/catalog/${job.id}/report?format=csv`)
        .set(getAuthHeader(adminToken))
        .expect(200);
      expect(report.headers['content-type']).toContain('text/csv');
      const reportRows = parse(report.text.replace(/^﻿/, '')) as string[][];
      expect(reportRows[0]).toEqual(['row', 'sku', 'status', 'action', 'errors', 'warnings', 'entity_id']);
      expect(reportRows[3]).toEqual([
        '4',
        'IMP-BAD',
        'INVALID',
        'NONE',
        'No category is called "No such category"',
        '',
        '',
      ]);

      const applied = await gql(`mutation { applyProductImport(id: "${job.id}") { status } }`);
      expect(applied.errors).toBeUndefined();
      const done = await waitForJob(job.id, ['COMPLETED', 'FAILED']);

      expect(done).toMatchObject({ status: 'COMPLETED', appliedRows: 3, failedRows: 0, appliedById: 'seed_admin' });
      const product = await prisma.product.findFirstOrThrow({
        where: { name: 'Import Tee' },
        include: { variants: { orderBy: { sku: 'asc' } }, tags: true },
      });
      expect(product).toMatchObject({ status: 'PUBLISHED', categoryId: 'seed_cat' });
      expect(product.tags.map((tag) => tag.id)).toEqual(['tag_new']);
      expect(product.variants.map((v) => [v.sku, v.basePrice?.toFixed(2), v.price?.toFixed(2)])).toEqual([
        ['IMP-TEE-S', '50.00', '50.00'],
      ]);
      expect(await prisma.variant.count({ where: { sku: 'IMP-MUG', product: { name: 'Import Mug' } } })).toBe(1);
      expect(await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } })).toMatchObject({
        name: 'Laptop renamed',
      });
      expect((await prisma.variant.findUniqueOrThrow({ where: { id: 'seed_var1' } })).basePrice?.toFixed(2)).toBe(
        '999.99',
      );
      const priceChanges = await prisma.priceChange.findMany({ where: { variantId: product.variants[0].id } });
      expect(priceChanges.map((change) => change.source)).toEqual(['IMPORT', 'IMPORT']);
      expect(await prisma.product.count({ where: { name: 'Bad' } })).toBe(0);

      const audits = await prisma.auditLog.findMany({ where: { entityId: job.id }, orderBy: { createdAt: 'asc' } });
      expect(audits.map((audit) => [audit.action, (audit.details as Record<string, unknown>).to ?? null])).toEqual([
        ['CREATE', null],
        ['STATUS_CHANGE', 'APPLYING'],
        ['STATUS_CHANGE', 'COMPLETED'],
      ]);
      expect(
        await prisma.auditLog.count({ where: { entity: 'Product', entityId: product.id, action: 'CREATE' } }),
      ).toBe(1);

      const listed = await gql(
        `{ catalogImportJob(id: "${job.id}") { status appliedRows rows(status: INVALID) { totalCount nodes { rowNumber errors } } } }`,
      );
      expect(listed.data!.catalogImportJob).toEqual({
        status: 'COMPLETED',
        appliedRows: 3,
        rows: { totalCount: 1, nodes: [{ rowNumber: 4, errors: ['No category is called "No such category"'] }] },
      });
    });

    it('applies an Excel file straight away when uploaded with apply=true, checking product type attributes', async () => {
      const type = await prisma.productType.create({
        data: {
          key: 'import_apparel',
          name: 'Import apparel',
          attributes: {
            create: [
              {
                key: 'size',
                label: 'Size',
                dataType: 'TEXT',
                isVariantAxis: true,
                isRequired: true,
                allowedValues: ['S', 'M'],
              },
              { key: 'material', label: 'Material', dataType: 'TEXT', isRequired: true, allowedValues: [] },
            ],
          },
        },
      });

      const job = await uploadAndWait(
        'products',
        await xlsxFile([
          ['SKU', 'Product Key', 'Name', 'Product Type', 'attr.material', 'option.size', 'Base Price'],
          ['IMP-DRESS-S', 'dress', 'Import Dress', 'import_apparel', 'Silk', 's', '120'],
          ['IMP-DRESS-M', 'dress', '', '', '', 'XL', '120'],
        ]),
        'dress.xlsx',
        adminToken,
        { apply: 'true' },
        ['COMPLETED', 'FAILED'],
      );

      expect(job).toMatchObject({ status: 'COMPLETED', format: 'XLSX', validRows: 0, invalidRows: 2, appliedRows: 0 });
      expect((await rowsOf(job.id)).map((row) => row.errors)).toEqual([
        ['Row(s) 3 of the same product are invalid, so this row is not imported'],
        ['Invalid options: size must be one of S, M'],
      ]);

      const fixed = await uploadAndWait(
        'products',
        await xlsxFile([
          ['sku', 'product_key', 'name', 'product_type', 'attr.material', 'option.size', 'base_price'],
          ['IMP-DRESS-S', 'dress', 'Import Dress', 'import_apparel', 'Silk', 's', '120'],
          ['IMP-DRESS-M', 'dress', '', '', '', 'M', '125'],
        ]),
        'dress.xlsx',
        adminToken,
        { apply: 'true' },
        ['COMPLETED', 'FAILED'],
      );
      expect(fixed).toMatchObject({ status: 'COMPLETED', appliedRows: 2 });
      const dress = await prisma.product.findFirstOrThrow({
        where: { name: 'Import Dress' },
        include: { variants: true },
      });
      expect(dress).toMatchObject({ productTypeId: type.id, attributes: { material: 'Silk' } });
      expect(dress.variants.map((v) => v.optionsKey).sort()).toEqual(['size=m', 'size=s']);
    });

    it('refuses the job when the header has unknown or missing columns', async () => {
      const job = await uploadAndWait(
        'products',
        csvFile([
          ['name', 'colour'],
          ['A', 'red'],
        ]),
        'bad.csv',
      );

      expect(job).toMatchObject({
        status: 'FAILED',
        error: 'Missing required column(s): sku; Unknown column(s): colour',
      });
      expect(job.file).toBeNull();
      expect(await rowsOf(job.id)).toEqual([]);
    });
  });

  describe('prices', () => {
    it('needs a fresh step-up, then sets base prices with IMPORT price history (CSV and a named Excel sheet)', async () => {
      const redis = worker.get<Redis>(REDIS_CLIENT);
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);
      const stale = await upload(
        'prices',
        csvFile([
          ['sku', 'base_price'],
          ['SEED-PHN-001', '450.00'],
        ]),
        'p.csv',
      ).expect(403);
      expect(JSON.stringify(stale.body)).toContain('STEP_UP_REQUIRED');
      adminToken = await signInAdmin(app);

      const job = await uploadAndWait(
        'prices',
        csvFile([
          ['sku', 'base_price', 'reason'],
          ['seed-phn-001', '450.00', 'Black Friday'],
          ['SEED-TAB-DRAFT', '299.99', ''],
          ['NO-SUCH-SKU', '1.00', ''],
        ]),
        'prices.csv',
        adminToken,
        { apply: 'true' },
        ['COMPLETED', 'FAILED'],
      );

      expect(job).toMatchObject({ status: 'COMPLETED', validRows: 2, invalidRows: 1, appliedRows: 1, skippedRows: 1 });
      expect((await prisma.variant.findUniqueOrThrow({ where: { id: 'seed_var2' } })).basePrice?.toFixed(2)).toBe(
        '450.00',
      );
      const changes = await prisma.priceChange.findMany({ where: { variantId: 'seed_var2', source: 'IMPORT' } });
      expect(
        changes.map((change) => [change.field, change.newValue.toFixed(2), change.reason, change.actorId]).sort(),
      ).toEqual([
        ['BASE_PRICE', '450.00', 'Black Friday', 'seed_admin'],
        ['PRICE', '450.00', 'Black Friday', 'seed_admin'],
      ]);

      const xlsx = await uploadAndWait(
        'prices',
        await xlsxFile(
          [
            ['sku', 'base_price'],
            ['SEED-PHN-001', '425.50'],
          ],
          'Prices',
        ),
        'prices.xlsx',
        adminToken,
        { sheet: 'prices' },
      );
      expect(xlsx).toMatchObject({ status: 'VALIDATED', sheetName: 'prices', validRows: 1 });
      const applied = await gql(`mutation { applyPriceImport(id: "${xlsx.id}") { status } }`);
      expect(applied.errors).toBeUndefined();
      await waitForJob(xlsx.id, ['COMPLETED']);
      expect((await prisma.variant.findUniqueOrThrow({ where: { id: 'seed_var2' } })).price?.toFixed(2)).toBe('425.50');
    });
  });

  describe('stock', () => {
    it('lets an inventory clerk adjust stock through the ledger at the right location, refusing tracked variants', async () => {
      await prisma.product.create({
        data: {
          id: 'imp_lots',
          name: 'Milk',
          trackLots: true,
          variants: { create: { id: 'imp_var_lots', sku: 'IMP-MILK', price: 5, basePrice: 5 } },
        },
      });
      await prisma.product.create({
        data: {
          id: 'imp_serials',
          name: 'Phone',
          trackSerials: true,
          variants: { create: { id: 'imp_var_serials', sku: 'IMP-PHONE', price: 5, basePrice: 5 } },
        },
      });
      const before = await stockOf(prisma, 'seed_var1');

      const job = await uploadAndWait(
        'stock',
        csvFile([
          ['sku', 'location', 'delta', 'count', 'reason', 'note'],
          ['SEED-LAP-001', '', '-2', '', 'DAMAGED', 'Dropped'],
          ['SEED-LAP-001', 'osu shop', '', '6', '', ''],
          ['IMP-MILK', '', '3', '', 'FOUND', ''],
          ['IMP-PHONE', '', '', '1', '', ''],
          ['SEED-PHN-001', 'Nowhere', '1', '', 'FOUND', ''],
        ]),
        'stock.csv',
        clerkToken,
      );

      expect(job).toMatchObject({ status: 'VALIDATED', validRows: 2, invalidRows: 3 });
      const rows = await rowsOf(job.id);
      expect(rows[2].errors[0]).toMatch(/tracks lots/);
      expect(rows[3].errors[0]).toMatch(/tracks serial numbers/);
      expect(rows[4].errors).toEqual(['No stock location is called "Nowhere"']);

      const applied = await gql(`mutation { applyStockImport(id: "${job.id}") { status } }`, clerkToken);
      expect(applied.errors).toBeUndefined();
      expect(await waitForJob(job.id, ['COMPLETED'])).toMatchObject({ appliedRows: 2 });

      const movements = await prisma.stockMovement.findMany({
        where: { refType: 'ImportJob', refId: job.id },
        orderBy: { onHandDelta: 'asc' },
      });
      expect(movements.map((m) => [m.locationId, m.onHandDelta, m.reason, m.adjustmentReason, m.note])).toEqual([
        [defaultLocationId, -2, 'ADJUSTMENT', 'DAMAGED', 'Dropped'],
        [shopLocationId, 6, 'ADJUSTMENT', 'CORRECTION', null],
      ]);
      expect(await stockOf(prisma, 'seed_var1')).toEqual({
        onHand: before.onHand + 4,
        reserved: before.reserved,
        available: before.available + 4,
      });
      expect(
        (await rowsOf(job.id))
          .filter((row) => row.status === 'APPLIED')
          .map((row) => row.entityId)
          .sort(),
      ).toEqual(movements.map((m) => m.id).sort());
    });

    it('fails a row the ledger refuses at apply time, applies the rest, and never applies a row twice', async () => {
      await setStock(prisma, 'seed_var2', 5);
      const job = await uploadAndWait(
        'stock',
        csvFile([
          ['sku', 'delta', 'reason'],
          ['SEED-PHN-001', '-5', 'LOST'],
          ['SEED-TAB-DRAFT', '4', 'FOUND'],
        ]),
        'stock.csv',
        clerkToken,
      );
      expect(job).toMatchObject({ status: 'VALIDATED', validRows: 2 });
      await setStock(prisma, 'seed_var2', 2);

      await gql(`mutation { applyStockImport(id: "${job.id}") { status } }`, clerkToken);
      const done = await waitForJob(job.id, ['COMPLETED']);

      expect(done).toMatchObject({ appliedRows: 1, failedRows: 1 });
      const rows = await rowsOf(job.id);
      expect(rows[0]).toMatchObject({ status: 'FAILED' });
      expect(rows[0].errors).toEqual(['Cannot remove 5 unit(s): only 2 on hand']);
      expect(rows[1]).toMatchObject({ status: 'APPLIED' });

      // A retried apply run (e.g. the worker died after committing) finds no VALID rows left.
      const movementsBefore = await prisma.stockMovement.count({ where: { refId: job.id } });
      await prisma.importJob.update({ where: { id: job.id }, data: { status: 'APPLYING' } });
      await worker.get(ImportApplier).apply(job.id);

      expect(await prisma.stockMovement.count({ where: { refId: job.id } })).toBe(movementsBefore);
      expect(await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: 'COMPLETED',
        appliedRows: 1,
        failedRows: 1,
      });
    });

    it('cancels a validated job, which can then no longer be applied', async () => {
      const job = await uploadAndWait(
        'stock',
        csvFile([
          ['sku', 'delta', 'reason'],
          ['SEED-LAP-001', '1', 'FOUND'],
        ]),
        's.csv',
        clerkToken,
      );

      const cancelled = await gql(`mutation { cancelStockImport(id: "${job.id}") { status } }`, clerkToken);
      const applied = await gql(`mutation { applyStockImport(id: "${job.id}") { status } }`, clerkToken);

      expect(cancelled.data!.cancelStockImport.status).toBe('CANCELLED');
      expect(applied.errors![0].extensions!.code).toBe('CONFLICT');
    });
  });

  describe('files and permissions', () => {
    it('refuses oversized, legacy, macro-enabled and missing files before storing anything', async () => {
      const jobsBefore = await prisma.importJob.count();
      const zip = (names: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(names)]);

      await upload('products', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'), 'big.csv').expect(413);
      const legacy = await upload('products', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'old.csv').expect(400);
      const macro = await upload('products', zip('xl/workbook.xml xl/vbaProject.bin'), 'evil.xlsx').expect(400);
      await request(server()).post('/imports/products').set(getAuthHeader(adminToken)).expect(400);

      expect(JSON.stringify(legacy.body)).toContain('Legacy Excel');
      expect(JSON.stringify(macro.body)).toContain('Macro-enabled');
      expect(await prisma.importJob.count()).toBe(jobsBefore);
    });

    it('keeps each kind to its permission', async () => {
      const file = csvFile([
        ['sku', 'delta', 'reason'],
        ['SEED-LAP-001', '1', 'FOUND'],
      ]);

      await upload('stock', file, 's.csv', customerToken).expect(403);
      await upload('products', file, 'p.csv', clerkToken).expect(403);
      await upload('stock', file, 's.csv', supportToken).expect(403);
      await request(server()).get('/imports/stock/template').expect(401);
      const template = await request(server())
        .get('/imports/stock/template?format=xlsx')
        .set(getAuthHeader(clerkToken))
        .expect(200);
      expect(template.headers['content-disposition']).toContain('stock-import.xlsx');
      expect((await gql('{ catalogImportJobs { totalCount } }', clerkToken)).errors![0].extensions!.code).toBe(
        'FORBIDDEN',
      );
      expect((await gql('{ stockImportJobs { totalCount } }', supportToken)).errors![0].extensions!.code).toBe(
        'FORBIDDEN',
      );
      const clerkJobs = await gql('{ stockImportJobs { totalCount nodes { kind } } }', clerkToken);
      expect(clerkJobs.data!.stockImportJobs.nodes.every((job: { kind: string }) => job.kind === 'STOCK')).toBe(true);
    });
  });

  describe('exports', () => {
    it('exports products and stock as CSV/XLSX with formulas escaped, audited', async () => {
      await prisma.product.update({ where: { id: 'seed_prod2' }, data: { name: '=HYPERLINK("http://evil.test")' } });

      const res = await request(server())
        .get('/exports/products?format=csv')
        .set(getAuthHeader(clerkToken))
        .expect(200);
      const [header, ...rows] = parse(res.text.replace(/^﻿/, '')) as string[][];
      const phone = rows.find((row) => row[0] === 'SEED-PHN-001')!;

      expect(header.slice(0, 3)).toEqual(['sku', 'product_id', 'name']);
      expect(header).toEqual(expect.arrayContaining(['on_hand.Osu Shop', 'option.size', 'attr.material']));
      expect(phone[2]).toBe('\'=HYPERLINK("http://evil.test")');
      expect(rows.map((row) => row[0])).toEqual(expect.arrayContaining(['IMP-TEE-S', 'IMP-DRESS-M']));

      const stock = await request(server())
        .get('/exports/stock?format=xlsx')
        .set(getAuthHeader(clerkToken))
        .expect(200);
      expect(stock.headers['content-type']).toContain('spreadsheetml');
      expect(await prisma.auditLog.count({ where: { entity: 'Export', action: 'EXPORT' } })).toBe(2);
      await request(server()).get('/exports/products').set(getAuthHeader(customerToken)).expect(403);
    });

    it('exports orders in a range, guest orders included, with customer details only on the guarded route', async () => {
      await prisma.order.create({
        data: {
          orderNumber: 990001,
          userId: 'seed_user',
          currency: 'GHS',
          pricingVersion: 0,
          grandTotal: 120,
          contactPhone: '+233241234567',
          contactEmail: 'user@example.com',
          createdAt: new Date('2026-11-10T10:00:00Z'),
        },
      });
      await prisma.order.create({
        data: {
          orderNumber: 990002,
          currency: 'GHS',
          pricingVersion: 0,
          grandTotal: 80,
          contactPhone: '+233201112222',
          contactName: 'Guest Buyer',
          guestPhone: '+233201112222',
          guestPhoneVerifiedAt: new Date('2026-11-11T09:00:00Z'),
          paymentMethod: 'ONLINE',
          createdAt: new Date('2026-11-11T10:00:00Z'),
        },
      });
      const range = 'from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

      const plain = await request(server()).get(`/exports/orders?${range}`).set(getAuthHeader(adminToken)).expect(200);
      const [header, ...rows] = parse(plain.text.replace(/^﻿/, '')) as string[][];
      expect(header).not.toContain('customer_phone');
      expect(rows.map((row) => [row[0], row[6]])).toEqual([
        ['990001', 'false'],
        ['990002', 'true'],
      ]);

      await request(server()).get(`/exports/orders/with-customers?${range}`).set(getAuthHeader(adminToken)).expect(403);
      await request(server())
        .get(`/exports/orders?from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z`)
        .set(getAuthHeader(adminToken))
        .expect(400);
      await request(server()).get('/exports/orders').set(getAuthHeader(adminToken)).expect(400);

      const ownerToken = await signInSuperAdmin(app);
      const full = await request(server())
        .get(`/exports/orders/with-customers?${range}&format=csv`)
        .set(getAuthHeader(ownerToken))
        .expect(200);
      const [fullHeader, ...fullRows] = parse(full.text.replace(/^﻿/, '')) as string[][];
      const column = (name: string) => fullHeader.indexOf(name);
      expect(fullRows.map((row) => [row[column('customer_name')], row[column('customer_phone')]])).toEqual([
        ['Regular User', '+233241234567'],
        ['Guest Buyer', '+233201112222'],
      ]);
      expect(
        await prisma.auditLog.findFirstOrThrow({
          where: { entity: 'Export', entityId: 'orders', userId: 'seed_super_admin' },
        }),
      ).toMatchObject({ details: expect.objectContaining({ customerDetails: true, rows: 2 }) });
    });
  });
});
