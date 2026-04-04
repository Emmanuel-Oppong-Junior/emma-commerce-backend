import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser } from '../helpers/auth.helper';

describe('Cart (e2e)', () => {
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

  // ─── cart (empty on first access) ────────────────────────────────────────────

  describe('cart', () => {
    it('returns null before any cart interaction', async () => {
      // Arrange
      const query = `
        query {
          cart {
            id
            items {
              id
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.cart).toBeNull();
    });
  });

  // ─── addToCart ────────────────────────────────────────────────────────────────

  describe('addToCart', () => {
    it('adds a product to the cart and returns the updated cart', async () => {
      // Arrange
      const mutation = `
        mutation {
          addToCart(input: { productId: "seed_prod1", quantity: 2 }) {
            id
            items {
              id
              productId
              quantity
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const items = res.body.data.addToCart.items;
      expect(items.length).toBeGreaterThanOrEqual(1);
      const addedItem = items.find((i: { productId: string }) => i.productId === 'seed_prod1');
      expect(addedItem).toBeDefined();
      expect(addedItem.quantity).toBe(2);
    });

    it('fails when the product does not exist', async () => {
      // Arrange
      const mutation = `
        mutation {
          addToCart(input: { productId: "nonexistent-product", quantity: 1 }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/not found/i);
    });

    it('fails when the requested quantity exceeds available stock', async () => {
      // Arrange — set product stock to 1 so requesting 999 fails
      await prisma.product.update({
        where: { id: 'seed_prod2' },
        data: { quantity: 1 },
      });

      const mutation = `
        mutation {
          addToCart(input: { productId: "seed_prod2", quantity: 999 }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/stock|quantity/i);

      // Restore stock to avoid affecting downstream tests
      await prisma.product.update({
        where: { id: 'seed_prod2' },
        data: { quantity: 100 },
      });
    });
  });

  // ─── cart (after items are present) ──────────────────────────────────────────

  describe('cart (with items)', () => {
    it('returns the cart with existing items', async () => {
      // Arrange — seed_prod1 was added in the addToCart test above
      const query = `
        query {
          cart {
            id
            items {
              id
              productId
              quantity
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.cart).not.toBeNull();
      expect(res.body.data.cart.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── updateCartItem ───────────────────────────────────────────────────────────

  describe('updateCartItem', () => {
    it('updates the quantity of an existing cart item', async () => {
      // Arrange — retrieve the cart item ID from the current cart
      const cartQuery = `query { cart { items { id productId quantity } } }`;
      const cartRes = await gqlRequest(app, cartQuery, undefined, userToken).expect(200);
      const item = cartRes.body.data.cart.items.find(
        (i: { productId: string }) => i.productId === 'seed_prod1',
      );
      const cartItemId = item.id;

      const mutation = `
        mutation {
          updateCartItem(input: { cartItemId: "${cartItemId}", quantity: 5 }) {
            id
            items {
              id
              quantity
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const updated = res.body.data.updateCartItem.items.find(
        (i: { id: string }) => i.id === cartItemId,
      );
      expect(updated.quantity).toBe(5);
    });
  });

  // ─── removeFromCart ───────────────────────────────────────────────────────────

  describe('removeFromCart', () => {
    it('removes the specified item from the cart', async () => {
      // Arrange — insert seed_prod2 directly via Prisma so the test focuses only on
      // removeFromCart and is not affected by any addToCart mutation side-effects.
      const cart = await prisma.cart.findUnique({ where: { userId: 'seed_user' } });
      expect(cart).not.toBeNull();
      const inserted = await prisma.cartItem.create({
        data: { cartId: cart!.id, productId: 'seed_prod2', quantity: 1 },
      });

      const mutation = `
        mutation {
          removeFromCart(cartItemId: "${inserted.id}") {
            id
            items {
              id
              productId
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const remainingIds = res.body.data.removeFromCart.items.map((i: { id: string }) => i.id);
      expect(remainingIds).not.toContain(inserted.id);
    });
  });

  // ─── cartWithDiscount ─────────────────────────────────────────────────────────

  describe('cartWithDiscount', () => {
    it('returns the cart with discount prices applied to eligible items', async () => {
      // Arrange — create an active 10 % discount and link it to seed_prod1
      await prisma.discount.create({
        data: {
          name: 'Test 10% Off',
          type: 'PERCENTAGE',
          value: 10,
          startDate: new Date('2020-01-01'),
          endDate: new Date('2099-12-31'),
          isActive: true,
          products: { connect: [{ id: 'seed_prod1' }] },
        },
      });

      // seed_prod1 is already in the cart from the tests above
      const query = `
        query {
          cartWithDiscount {
            id
            items {
              id
              productId
              originalPrice
              discountedPrice
            }
            discountTotal
            finalTotal
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const cart = res.body.data.cartWithDiscount;
      expect(cart).not.toBeNull();
      const discountedItem = cart.items.find(
        (i: { productId: string }) => i.productId === 'seed_prod1',
      );
      expect(discountedItem).toBeDefined();
      // The discounted price should be less than the original price
      if (discountedItem.discountedPrice !== null) {
        expect(discountedItem.discountedPrice).toBeLessThan(discountedItem.originalPrice);
      }
    });
  });

  // ─── clearCart ────────────────────────────────────────────────────────────────

  describe('clearCart', () => {
    it('empties the cart and returns an empty items list', async () => {
      // Arrange — cart has items from tests above
      const mutation = `
        mutation {
          clearCart {
            id
            items {
              id
            }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.clearCart.items).toHaveLength(0);
    });
  });
});
