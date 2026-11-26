import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261215110000_referrals';
const EXPAND = '20261217100000_content_seo';
const CONTRACT = '20261217100100_content_seo_contract';

// Created in this order (createdAt), so the backfill gives the older row the plain slug.
const LEGACY_DATA = `
INSERT INTO "Category" ("id", "name", "createdAt", "updatedAt") VALUES
  ('c_new', 'Health & Beauty!', '2026-02-01', now()),
  ('c_old', 'Health and Beauty', '2026-01-01', now()),
  ('c_two', 'Health and Beauty 2', '2026-01-15', now()),
  ('c_script', '电子产品', '2026-01-20', now());
INSERT INTO "SubCategory" ("id", "name", "categoryId", "updatedAt") VALUES
  ('s1', 'Men''s Wear', 'c_old', now());
INSERT INTO "Brand" ("id", "name", "updatedAt") VALUES
  ('b1', 'Crème Brûlée Co.', now());
INSERT INTO "Product" ("id", "name", "createdAt", "updatedAt") VALUES
  ('p1', 'Straße Æble Øre', '2026-01-01', now()),
  ('p2', 'straße æble øre', '2026-01-02', now());
`;

describe('Slug backfill migration (P8-C, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const slugs = async () => ({
    categories: await legacy.query(`SELECT id, slug FROM "Category" ORDER BY id`),
    subCategories: await legacy.query(`SELECT id, slug FROM "SubCategory" ORDER BY id`),
    brands: await legacy.query(`SELECT id, slug FROM "Brand" ORDER BY id`),
    products: await legacy.query(`SELECT id, slug FROM "Product" ORDER BY id`),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_content_seo', { withPublic: true });
  });

  beforeEach(async () => {
    await legacy.recreate();
    await legacy.migrateTo(BEFORE);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(EXPAND));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it('gives every existing row a unique slug from its name, oldest first, without redirects', async () => {
    expect(await slugs()).toEqual({
      categories: [
        { id: 'c_new', slug: 'health-and-beauty-3' },
        { id: 'c_old', slug: 'health-and-beauty' },
        { id: 'c_script', slug: 'category' },
        { id: 'c_two', slug: 'health-and-beauty-2' },
      ],
      subCategories: [{ id: 's1', slug: 'mens-wear' }],
      brands: [{ id: 'b1', slug: 'creme-brulee-co' }],
      products: [
        { id: 'p1', slug: 'strasse-aeble-ore' },
        { id: 'p2', slug: 'strasse-aeble-ore-2' },
      ],
    });
    expect(await legacy.query(`SELECT 1 FROM "SlugRedirect"`)).toEqual([]);
  });

  it('is safe to re-run, then the contract makes slugs unique and well formed', async () => {
    const first = await slugs();
    await legacy.exec(migrationSqlFrom(EXPAND, '-- Backfill'));
    expect(await slugs()).toEqual(first);

    await legacy.exec(migrationSql(CONTRACT));
    const indexes = await legacy.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'legacy_content_seo' AND indexname LIKE '%slug%' ORDER BY 1`,
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'Brand_slug_key',
      'Category_slug_key',
      'Collection_slug_key',
      'Product_slug_key',
      'SubCategory_slug_key',
    ]);
    await expect(legacy.exec(`UPDATE "Product" SET "slug" = 'Bad Slug' WHERE "id" = 'p1'`)).rejects.toThrow(
      'Product_slug_check',
    );
  });

  it('refuses the contract while a row has no slug yet', async () => {
    await legacy.exec(`ALTER TABLE "Brand" DISABLE TRIGGER "Brand_slug_insert";
      INSERT INTO "Brand" ("id", "name", "updatedAt") VALUES ('b_late', 'Late', now());`);

    await expect(legacy.exec(migrationSql(CONTRACT))).rejects.toThrow('Brand_slug_check');
  });
});
