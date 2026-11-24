import { INestApplication } from '@nestjs/common';
import { createValidationPipe } from '../../src/commons/validation-pipe';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { OrderStatus, PaymentStatus } from '../../src/generated/prisma/client';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AllExceptionsFilter } from '../../src/commons/filters/all-exceptions.filter';
import { GqlThrottlerGuard } from '../../src/commons/guards/gql-throttler.guard';
import { PaymentService } from '../../src/payment/payment.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest, MoneyValue } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';
import { signInUser, signUpUser } from '../helpers/auth.helper';
import { quoteHashFor } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

/** Computes the HMAC-SHA512 webhook signature the same way the PaymentService does. */
function computeSignature(body: object): string {
  const secret = process.env.PAYSTACK_SECRET_KEY!;
  return createHmac('sha512', secret).update(JSON.stringify(body)).digest('hex');
}

describe('Payments & Returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let addressId: string;

  // ─── Shared order/payment helpers ─────────────────────────────────────────────

  /** Creates a PENDING order for the seeded user and returns its ID. */
  async function createOrderForUser(): Promise<string> {
    // Add item to cart
    await gqlRequest(
      app,
      `mutation { addToCart(input: { variantId: "seed_var1", quantity: 1 }) { id } }`,
      undefined,
      userToken,
    ).expect(200);

    // Create the order
    const res = await gqlRequest(
      app,
      `mutation { createOrder(input: { quoteHash: "${await quoteHashFor(app, userToken, { fulfillmentType: 'DELIVERY', shippingAddressId: addressId })}", fulfillmentType: DELIVERY, shippingAddressId: "${addressId}", contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id } }`,
      undefined,
      userToken,
    ).expect(200);
    return res.body.data.createOrder.id as string;
  }

  /** Inserts a payment attempt directly into the DB and returns its ID and reference. */
  async function seedPaymentRecord(orderId: string): Promise<{ paymentId: string; reference: string }> {
    return seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING, reference: `test-ref-${Date.now()}` });
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);

    // Create shipping address
    const addrRes = await gqlRequest(
      app,
      `mutation {
        createAddress(input: {
          street: "Pay St"
          city: "Accra"
          recipientName: "Test Customer"
          phone: "0244000000"
          region: GREATER_ACCRA
          zipCode: "00233"
          country: "GH"
        }) { id }
      }`,
      undefined,
      userToken,
    ).expect(200);
    addressId = addrRes.body.data.createAddress.id;
  });

  afterAll(() => app.close());

  // ─── POST /payment/initialize ─────────────────────────────────────────────────

  describe('POST /payment/initialize', () => {
    it('returns a Paystack authorization URL for a valid order', async () => {
      // Arrange — spin up a separate app that mocks the PaymentService so no real
      // Paystack HTTP call is made, while still exercising the controller.
      const mockAuthUrl = 'https://checkout.paystack.com/mock-url';
      const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(GqlThrottlerGuard)
        .useValue({ canActivate: () => true })
        .overrideProvider(PaymentService)
        .useValue({
          initiatePayment: jest.fn().mockResolvedValue({
            id: 'mock-payment-id',
            authorizationUrl: mockAuthUrl,
          }),
        })
        .compile();

      const mockApp = moduleFixture.createNestApplication();
      const logger = moduleFixture.get<LoggerService>(LoggerService);
      mockApp.useLogger(logger);
      mockApp.useGlobalFilters(new AllExceptionsFilter(logger));
      mockApp.useGlobalPipes(createValidationPipe());
      await mockApp.init();

      // Act
      const res = await request(mockApp.getHttpServer())
        .post('/payment/initialize')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ orderId: 'some-order-id', paymentMethod: 'CARD', currency: 'GHS' })
        .expect(201);

      // Assert
      expect(res.body.authorizationUrl).toBe(mockAuthUrl);

      await mockApp.close();
    });
  });

  // ─── verifyPayment (GraphQL) ──────────────────────────────────────────────────

  describe('verifyPayment', () => {
    it('returns the updated payment record when the reference is valid and owned by the user', async () => {
      // Arrange — mock PaymentService to avoid real Paystack verification calls
      const mockPayment = { id: 'mock-payment-id', status: 'CAPTURED' };
      const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(GqlThrottlerGuard)
        .useValue({ canActivate: () => true })
        .overrideProvider(PaymentService)
        .useValue({
          verifyPaymentAsUser: jest.fn().mockResolvedValue(mockPayment),
        })
        .compile();

      const mockApp = moduleFixture.createNestApplication();
      const logger = moduleFixture.get<LoggerService>(LoggerService);
      mockApp.useLogger(logger);
      mockApp.useGlobalFilters(new AllExceptionsFilter(logger));
      mockApp.useGlobalPipes(createValidationPipe());
      await mockApp.init();

      const mutation = `
        mutation {
          verifyPayment(verifyPaymentInput: { reference: "test-reference" }) {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(mockApp, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.verifyPayment.id).toBe('mock-payment-id');

      await mockApp.close();
    });
  });

  // ─── getMyPayments ────────────────────────────────────────────────────────────

  describe('getMyPayments', () => {
    it("returns the authenticated user's own payment records", async () => {
      // Arrange — create an order and seed a payment record directly
      const orderId = await createOrderForUser();
      await seedPaymentRecord(orderId);

      const query = `
        query {
          getMyPayments {
            id
            status
            amount { amount currency }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const payments: Array<{ id: string; amount: MoneyValue }> = res.body.data.getMyPayments;
      expect(payments.length).toBeGreaterThanOrEqual(1);
      for (const payment of payments) expect(payment.amount).toEqual(ghs('100.00'));
    });
  });

  // ─── payment (by ID) ──────────────────────────────────────────────────────────

  describe('payment (by ID)', () => {
    let paymentId: string;

    beforeAll(async () => {
      // Create an order + payment for the main user
      const orderId = await createOrderForUser();
      const result = await seedPaymentRecord(orderId);
      paymentId = result.paymentId;
    });

    it("returns the user's own payment by ID", async () => {
      // Arrange
      const query = `
        query {
          payment(id: "${paymentId}") {
            id
            status
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.payment.id).toBe(paymentId);
    });

    it("fails when a user tries to access another user's payment", async () => {
      // Arrange — sign up a second user, create an order+payment for them
      const { accessToken: user2Token } = await signUpUser(app, {
        name: 'Pay User 2',
        email: 'payuser2@test.com',
        password: 'PayUser@2',
      });
      const addrRes = await gqlRequest(
        app,
        `mutation {
          createAddress(input: {
            street: "Other Pay St"
            city: "Accra"
            recipientName: "Test Customer"
            phone: "0244000000"
            region: GREATER_ACCRA
            zipCode: "00233"
            country: "GH"
          }) { id }
        }`,
        undefined,
        user2Token,
      ).expect(200);
      const user2AddressId = addrRes.body.data.createAddress.id;
      await gqlRequest(
        app,
        `mutation { addToCart(input: { variantId: "seed_var1", quantity: 1 }) { id } }`,
        undefined,
        user2Token,
      ).expect(200);
      const orderRes = await gqlRequest(
        app,
        `mutation { createOrder(input: { quoteHash: "${await quoteHashFor(app, user2Token, { fulfillmentType: 'DELIVERY', shippingAddressId: user2AddressId })}", fulfillmentType: DELIVERY, shippingAddressId: "${user2AddressId}", contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id } }`,
        undefined,
        user2Token,
      ).expect(200);
      const user2OrderId = orderRes.body.data.createOrder.id;
      const { paymentId: user2PaymentId } = await seedPaymentRecord(user2OrderId);

      const query = `
        query {
          payment(id: "${user2PaymentId}") {
            id
          }
        }
      `;

      // Act — user1 tries to access user2's payment
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── POST /payment/webhook ────────────────────────────────────────────────────

  describe('POST /payment/webhook', () => {
    it('returns 401 when the signature is invalid', async () => {
      // Arrange
      const body = {
        event: 'charge.success',
        data: { reference: 'fake-ref', amount: 10000, currency: 'GHS' },
      };

      // Act — send with a deliberately wrong signature
      await request(app.getHttpServer())
        .post('/payment/webhook')
        .set('x-paystack-signature', 'invalid-signature')
        .send(body)
        .expect(401);
    });

    it('returns 200 when the signature is valid (irrelevant event is acknowledged without processing)', async () => {
      // Arrange — use an event type that is not CHARGE_SUCCESS/CHARGE_FAILED so the
      // service acknowledges receipt without making a Paystack verification call.
      const body = {
        event: 'transfer.success',
        data: { reference: 'transfer-ref', amount: 5000, currency: 'GHS' },
      };
      const validSignature = computeSignature(body);

      // Act
      await request(app.getHttpServer())
        .post('/payment/webhook')
        .set('x-paystack-signature', validSignature)
        .send(body)
        .expect(200);
    });
  });

  // ─── requestReturn (P6-R.1: item-level, replaces createReturnRequest) ─────────

  /** Marks the order COMPLETED and its goods delivered (one DELIVERED shipment); returns its single line id. */
  async function deliver(orderId: string): Promise<string> {
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.COMPLETED } });
    await prisma.shipment.update({
      where: { id: await shipmentOf(prisma, orderId) },
      data: { status: 'DELIVERED', dispatchedAt: new Date(), deliveredAt: new Date() },
    });
    const [item] = await prisma.orderItem.findMany({ where: { orderId } });
    return item.id;
  }

  const requestReturn = (orderId: string, orderItemId: string) => `
    mutation {
      requestReturn(input: {
        orderId: "${orderId}"
        lines: [{ orderItemId: "${orderItemId}", quantity: 1, reason: DAMAGED, note: "Item arrived damaged" }]
      }) {
        id
        status
        lines { quantity reason note }
      }
    }
  `;

  describe('requestReturn', () => {
    it('succeeds on a delivered order', async () => {
      // Arrange — create an order and mark its goods delivered in the DB
      const orderId = await createOrderForUser();
      const itemId = await deliver(orderId);

      // Act
      const res = await gqlRequest(app, requestReturn(orderId, itemId), undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.requestReturn.status).toBe('REQUESTED');
      expect(res.body.data.requestReturn.lines).toEqual([
        { quantity: 1, reason: 'DAMAGED', note: 'Item arrived damaged' },
      ]);
    });

    it('fails when the order is not yet delivered', async () => {
      // Arrange — a placed order (default status), nothing delivered
      const orderId = await createOrderForUser();
      const [item] = await prisma.orderItem.findMany({ where: { orderId } });

      // Act
      const res = await gqlRequest(app, requestReturn(orderId, item.id), undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.reason).toBe('NOT_DELIVERED');
    });

    it('fails when the units are already under another return of the order', async () => {
      // Arrange — a delivered order whose only unit is already under a return
      const orderId = await createOrderForUser();
      const itemId = await deliver(orderId);
      await gqlRequest(app, requestReturn(orderId, itemId), undefined, userToken).expect(200);

      // Act
      const res = await gqlRequest(app, requestReturn(orderId, itemId), undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions).toMatchObject({ code: 'CONFLICT', reason: 'RETURN_QUANTITY_EXCEEDED' });
    });
  });

  // ─── myReturns (replaces myReturnRequests) ────────────────────────────────────

  describe('myReturns', () => {
    it("returns the authenticated user's own returns", async () => {
      // Arrange
      const query = `
        query {
          myReturns(first: 50) {
            totalCount
            nodes { id orderId status lines { quantity } }
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const requests: Array<{ id: string }> = res.body.data.myReturns.nodes;
      expect(requests.length).toBeGreaterThanOrEqual(1);
    });
  });
});
