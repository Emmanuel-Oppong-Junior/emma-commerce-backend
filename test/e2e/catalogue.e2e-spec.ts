import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, SeedResult } from '../helpers/db.helper';

describe('Public Catalogue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seed: SeedResult;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    seed = await seedMinimal(prisma);
  });

  afterAll(() => app.close());

  // ─── products ─────────────────────────────────────────────────────────────────

  describe('products (public)', () => {
    it('returns a paginated product list without authentication', async () => {
      // Arrange
      const query = `
        query {
          products(paginationArgs: { first: 10 }) {
            edges {
              node {
                id
                name
                priceRange { min { amount currency } max { amount currency } }
                totalStock
                isActive
              }
              cursor
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              pageSize
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const { edges, pageInfo } = res.body.data.products;
      expect(edges.length).toBeGreaterThanOrEqual(2);
      expect(pageInfo.hasNextPage).toBe(false);
      expect(pageInfo.pageSize).toBeGreaterThanOrEqual(2);
    });

    it('filters products by categoryId', async () => {
      // Arrange
      const query = `
        query {
          products(
            paginationArgs: { first: 10 }
            filterArgs: { categoryId: "${seed.categoryId}" }
          ) {
            edges {
              node {
                id
                name
              }
            }
            pageInfo {
              pageSize
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const { edges } = res.body.data.products;
      expect(edges.length).toBe(2);
      const names = edges.map((e: { node: { name: string } }) => e.node.name);
      expect(names).toContain('Laptop');
      expect(names).toContain('Phone');
    });

    it('filters products by price range', async () => {
      // Arrange — only the Laptop costs ≥ 900
      const query = `
        query {
          products(
            paginationArgs: { first: 10 }
            filterArgs: { priceMin: "900" }
          ) {
            edges {
              node {
                id
                name
                priceRange { min { amount currency } }
              }
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const { edges } = res.body.data.products;
      expect(edges.length).toBe(1);
      expect(edges[0].node.name).toBe('Laptop');
      expect(edges[0].node.priceRange.min).toEqual(ghs('999.99'));
    });
  });

  // ─── product (by ID) ──────────────────────────────────────────────────────────

  describe('product (public)', () => {
    it('returns a single product by ID without authentication', async () => {
      // Arrange
      const productId = seed.productIds.prod1;
      const query = `
        query {
          product(productId: "${productId}") {
            id
            name
            totalStock
            isActive
            variants { price { amount currency } quantity sku }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.product).toMatchObject({
        id: productId,
        name: 'Laptop',
        isActive: true,
        variants: [{ price: ghs('999.99'), sku: 'SEED-LAP-001' }],
      });
    });

    it('returns null for a non-existent product ID', async () => {
      // Arrange
      const query = `
        query {
          product(productId: "non-existent-id") {
            id
            name
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.product).toBeNull();
    });
  });

  // ─── categories ───────────────────────────────────────────────────────────────

  describe('categories (public)', () => {
    it('returns all categories without authentication', async () => {
      // Arrange
      const query = `
        query {
          categories {
            id
            name
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const categories: Array<{ id: string; name: string }> = res.body.data.categories;
      expect(categories.length).toBeGreaterThanOrEqual(1);
      const found = categories.find((c) => c.id === seed.categoryId);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Electronics');
    });
  });

  // ─── brands ───────────────────────────────────────────────────────────────────

  describe('brands (public)', () => {
    it('returns all brands without authentication', async () => {
      // Arrange
      const query = `
        query {
          brands {
            id
            name
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const brands: Array<{ id: string; name: string }> = res.body.data.brands;
      expect(brands).toBeDefined();
      expect(brands!.length).toBeGreaterThanOrEqual(1);
      const found = brands!.find((b) => b.id === seed.brandId);
      expect(found?.name).toBe('Test Brand');
    });
  });

  // ─── brand (by ID) ────────────────────────────────────────────────────────────

  describe('brand (public)', () => {
    it('returns a single brand by ID without authentication', async () => {
      // Arrange
      const query = `
        query {
          brand(id: "${seed.brandId}") {
            id
            name
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.brand).toMatchObject({
        id: seed.brandId,
        name: 'Test Brand',
      });
    });

    it('returns null for a non-existent brand ID', async () => {
      // Arrange
      const query = `
        query {
          brand(id: "non-existent-brand") {
            id
            name
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.brand).toBeNull();
    });
  });
});
