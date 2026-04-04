import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser } from '../helpers/auth.helper';

describe('Wishlist (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  afterAll(() => app.close());

  // ─── wishlist ─────────────────────────────────────────────────────────────────

  describe('wishlist', () => {
    it('auto-creates and returns an empty wishlist on first access', async () => {
      // Arrange
      const query = `
        query {
          wishlist {
            id
            userId
            products {
              id
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.wishlist.id).toBeDefined();
      expect(res.body.data.wishlist.products).toHaveLength(0);
    });
  });

  // ─── addToWishlist ────────────────────────────────────────────────────────────

  describe('addToWishlist', () => {
    it('adds an existing product to the wishlist', async () => {
      // Arrange
      const mutation = `
        mutation {
          addToWishlist(productId: "seed_prod1") {
            id
            products {
              id
              name
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const productIds = res.body.data.addToWishlist.products.map((p: { id: string }) => p.id);
      expect(productIds).toContain('seed_prod1');
    });

    it('fails when the product does not exist', async () => {
      // Arrange
      const mutation = `
        mutation {
          addToWishlist(productId: "nonexistent-product") {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── removeFromWishlist ───────────────────────────────────────────────────────

  describe('removeFromWishlist', () => {
    it('removes a product from the wishlist', async () => {
      // Arrange — product seed_prod1 was added in the previous test
      const mutation = `
        mutation {
          removeFromWishlist(productId: "seed_prod1") {
            id
            products {
              id
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const productIds = res.body.data.removeFromWishlist.products.map((p: { id: string }) => p.id);
      expect(productIds).not.toContain('seed_prod1');
    });
  });

  // ─── clearWishlist ────────────────────────────────────────────────────────────

  describe('clearWishlist', () => {
    it('empties the wishlist', async () => {
      // Arrange — add two products first so clearWishlist has something to remove
      await gqlRequest(app, `mutation { addToWishlist(productId: "seed_prod1") { id } }`, undefined, userToken);
      await gqlRequest(app, `mutation { addToWishlist(productId: "seed_prod2") { id } }`, undefined, userToken);

      const mutation = `
        mutation {
          clearWishlist {
            id
            products {
              id
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.clearWishlist.products).toHaveLength(0);
    });
  });
});
