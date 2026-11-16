import { INestApplication } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser, signUpUser } from '../helpers/auth.helper';

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let addressId: string;
  /** Set once the first createOrder test succeeds; reused in query/cancel tests. */
  let createdOrderId: string;

  // ─── helpers ──────────────────────────────────────────────────────────────────

  const addItemToCart = (token: string, productId = 'seed_prod1', qty = 1) =>
    gqlRequest(
      app,
      `mutation { addToCart(input: { productId: "${productId}", quantity: ${qty} }) { id } }`,
      undefined,
      token,
    ).expect(200);

  const clearUserCart = (token: string) =>
    gqlRequest(app, `mutation { clearCart { id } }`, undefined, token).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);

    // Create a shipping address for the main user
    const addrRes = await gqlRequest(
      app,
      `mutation {
        createAddress(input: {
          street: "1 Order St"
          city: "Accra"
          state: "Greater Accra"
          zipCode: "00233"
          country: "Ghana"
        }) { id }
      }`,
      undefined,
      userToken,
    ).expect(200);
    addressId = addrRes.body.data.createAddress.id;

    // Populate the cart with a product
    await addItemToCart(userToken);
  });

  afterAll(() => app.close());

  // ─── createOrder ──────────────────────────────────────────────────────────────

  describe('createOrder', () => {
    it('creates an order from the populated cart with a valid shipping address', async () => {
      // Arrange — cart already has seed_prod1 (added in beforeAll)
      const mutation = `
        mutation {
          createOrder(input: { shippingAddressId: "${addressId}" }) {
            id
            status
            totalAmount
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
      expect(res.body.data.createOrder.status).toBe('PENDING');
      expect(res.body.data.createOrder.items.length).toBeGreaterThanOrEqual(1);

      // Persist the order ID for subsequent tests
      createdOrderId = res.body.data.createOrder.id;
    });

    it('fails when the cart is empty', async () => {
      // Arrange — cart was consumed by the previous test; no items remain
      const mutation = `
        mutation {
          createOrder(input: { shippingAddressId: "${addressId}" }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });

    it('fails when the shipping address does not exist', async () => {
      // Arrange — re-add items to cart, then pass a bogus addressId
      await addItemToCart(userToken);

      const mutation = `
        mutation {
          createOrder(input: { shippingAddressId: "nonexistent-address-id" }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();

      // Cleanup — clear the cart items that were re-added
      await clearUserCart(userToken);
    });

    it('decrements product stock after a successful order', async () => {
      // Arrange — record the current stock, add the product to cart, create an order
      const productBefore = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod2' } });
      await addItemToCart(userToken, 'seed_prod2', 2);

      const mutation = `
        mutation {
          createOrder(input: { shippingAddressId: "${addressId}" }) {
            id
          }
        }
      `;

      // Act
      await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod2' } });
      expect(Number(productAfter.quantity)).toBe(Number(productBefore.quantity) - 2);
    });

    it('applies a valid coupon discount to the order', async () => {
      // Arrange — create an active flat-amount coupon, add items to cart
      const coupon = await prisma.coupon.create({
        data: {
          code: 'ORDER-FLAT-50',
          discountType: 'FLAT',
          value: 50,
          isActive: true,
        },
      });
      await addItemToCart(userToken, 'seed_prod1', 1);

      const mutation = `
        mutation {
          createOrder(input: {
            shippingAddressId: "${addressId}"
            couponCode: "${coupon.code}"
          }) {
            id
            couponDiscount
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(Number(res.body.data.createOrder.couponDiscount)).toBeGreaterThan(0);
    });
  });

  // ─── userOrders ───────────────────────────────────────────────────────────────

  describe('userOrders', () => {
    it("returns the authenticated user's own orders", async () => {
      // Arrange
      const query = `
        query {
          userOrders {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const orders: Array<{ id: string }> = res.body.data.userOrders;
      expect(orders.length).toBeGreaterThanOrEqual(1);
      const ids = orders.map((o) => o.id);
      expect(ids).toContain(createdOrderId);
    });
  });

  // ─── order (by ID) ────────────────────────────────────────────────────────────

  describe('order', () => {
    it('returns a single order owned by the authenticated user', async () => {
      // Arrange
      const query = `
        query {
          order(orderId: "${createdOrderId}") {
            id
            status
            totalAmount
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.order.id).toBe(createdOrderId);
    });

    it("fails when a user tries to access another user's order", async () => {
      // Arrange — sign up a second user, create an order for them, then try to access it as user1
      const { accessToken: user2Token } = await signUpUser(app, {
        name: 'User Two',
        email: 'user2order@test.com',
        password: 'UserTwo@1',
      });

      // Create address + order for user2
      const addrRes = await gqlRequest(
        app,
        `mutation {
          createAddress(input: {
            street: "2 Other St"
            city: "Kumasi"
            state: "Ashanti"
            zipCode: "00100"
            country: "Ghana"
          }) { id }
        }`,
        undefined,
        user2Token,
      ).expect(200);
      const user2AddressId = addrRes.body.data.createAddress.id;
      await addItemToCart(user2Token);
      const orderRes = await gqlRequest(
        app,
        `mutation { createOrder(input: { shippingAddressId: "${user2AddressId}" }) { id } }`,
        undefined,
        user2Token,
      ).expect(200);
      const user2OrderId = orderRes.body.data.createOrder.id;

      const query = `
        query {
          order(orderId: "${user2OrderId}") {
            id
          }
        }
      `;

      // Act — user1 tries to access user2's order
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert — service throws NotFoundException (no info leakage)
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/not found/i);
    });
  });

  // ─── cancelOrder ─────────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('cancels a PENDING order and restores product stock', async () => {
      // Arrange — create a fresh order to cancel
      await addItemToCart(userToken, 'seed_prod1', 1);
      const orderRes = await gqlRequest(
        app,
        `mutation { createOrder(input: { shippingAddressId: "${addressId}" }) { id } }`,
        undefined,
        userToken,
      ).expect(200);
      const pendingOrderId = orderRes.body.data.createOrder.id;

      const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } });

      const mutation = `
        mutation {
          cancelOrder(orderId: "${pendingOrderId}") {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.cancelOrder.status).toBe('CANCELLED');

      // Stock should be restored
      const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } });
      expect(Number(stockAfter.quantity)).toBe(Number(stockBefore.quantity) + 1);
    });

    it('fails when trying to cancel a DELIVERED order', async () => {
      // Arrange — create an order and forcibly set its status to DELIVERED in the DB
      await addItemToCart(userToken, 'seed_prod1', 1);
      const orderRes = await gqlRequest(
        app,
        `mutation { createOrder(input: { shippingAddressId: "${addressId}" }) { id } }`,
        undefined,
        userToken,
      ).expect(200);
      const deliveredOrderId = orderRes.body.data.createOrder.id;
      await prisma.order.update({
        where: { id: deliveredOrderId },
        data: { status: OrderStatus.DELIVERED },
      });

      const mutation = `
        mutation {
          cancelOrder(orderId: "${deliveredOrderId}") {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── finalizeOrder ────────────────────────────────────────────────────────────

  describe('finalizeOrder', () => {
    it('finalizes a PENDING order and returns the updated order', async () => {
      // Arrange — create a fresh order
      await addItemToCart(userToken, 'seed_prod1', 1);
      const orderRes = await gqlRequest(
        app,
        `mutation { createOrder(input: { shippingAddressId: "${addressId}" }) { id } }`,
        undefined,
        userToken,
      ).expect(200);
      const finalizeOrderId = orderRes.body.data.createOrder.id;

      const mutation = `
        mutation {
          finalizeOrder(id: "${finalizeOrderId}") {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.finalizeOrder.id).toBe(finalizeOrderId);
    });
  });
});
