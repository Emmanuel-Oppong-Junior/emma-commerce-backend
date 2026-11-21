import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';
import { signInUser, signUpUser } from '../helpers/auth.helper';
import { CouponFixture, createCoupon } from '../helpers/promotion.helper';

describe('Reviews & Coupons (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  /** Second user used to test cross-user ownership enforcement. */
  let otherUserToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);

    const { accessToken } = await signUpUser(app, {
      name: 'Other User',
      email: 'otheruser@test.com',
      password: 'Other@123',
    });
    otherUserToken = accessToken;
  });

  afterAll(() => app.close());

  // ─── createReview ─────────────────────────────────────────────────────────────

  describe('createReview', () => {
    it('creates a review for a product', async () => {
      // Arrange
      const mutation = `
        mutation {
          createReview(input: { productId: "seed_prod1", score: 5, comment: "Great product!" }) {
            id
            score
            comment
            productId
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.createReview).toMatchObject({
        score: 5,
        comment: 'Great product!',
        productId: 'seed_prod1',
      });
    });

    it('fails when the user tries to review the same product twice', async () => {
      // Arrange — seed_prod1 was already reviewed in the test above
      const mutation = `
        mutation {
          createReview(input: { productId: "seed_prod1", score: 3 }) {
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

  // ─── productReviews ───────────────────────────────────────────────────────────

  describe('productReviews', () => {
    it('returns all reviews for a given product', async () => {
      // Arrange — also add a review from otherUser so there are multiple
      await gqlRequest(
        app,
        `mutation { createReview(input: { productId: "seed_prod1", score: 4 }) { id } }`,
        undefined,
        otherUserToken,
      ).expect(200);

      const query = `
        query {
          productReviews(productId: "seed_prod1") {
            id
            score
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const reviews: Array<{ id: string; score: number }> = res.body.data.productReviews;
      expect(reviews.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── userReviews ──────────────────────────────────────────────────────────────

  describe('userReviews', () => {
    it("returns only the authenticated user's own reviews", async () => {
      // Arrange
      const query = `
        query {
          userReviews {
            id
            score
            productId
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const reviews: Array<{ id: string; productId: string }> = res.body.data.userReviews;
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      // Every returned review belongs to seed_prod1 (the only product reviewed by userToken)
      reviews.forEach((r) => expect(r.productId).toBe('seed_prod1'));
    });
  });

  // ─── updateReview ─────────────────────────────────────────────────────────────

  describe('updateReview', () => {
    let userReviewId: string;

    beforeAll(async () => {
      const query = `
        query {
          userReviews { id }
        }
      `;
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);
      userReviewId = res.body.data.userReviews[0].id;
    });

    it('succeeds when the user updates their own review', async () => {
      // Arrange
      const mutation = `
        mutation {
          updateReview(input: { id: "${userReviewId}", score: 4, comment: "Updated comment" }) {
            id
            score
            comment
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateReview.score).toBe(4);
      expect(res.body.data.updateReview.comment).toBe('Updated comment');
    });

    it("fails when a user tries to update another user's review", async () => {
      // Arrange — otherUser tries to update userToken's review
      const mutation = `
        mutation {
          updateReview(input: { id: "${userReviewId}", score: 1 }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, otherUserToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/your own/i);
    });
  });

  // ─── deleteReview ─────────────────────────────────────────────────────────────

  describe('deleteReview', () => {
    it("deletes the user's own review successfully", async () => {
      // Arrange — create a review from otherUser and let otherUser delete it
      const createMutation = `
        mutation {
          createReview(input: { productId: "seed_prod2", score: 5 }) {
            id
          }
        }
      `;
      const createRes = await gqlRequest(app, createMutation, undefined, otherUserToken).expect(200);
      const reviewId = createRes.body.data.createReview.id;

      const mutation = `
        mutation {
          deleteReview(reviewId: "${reviewId}") {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, otherUserToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteReview.id).toBe(reviewId);
    });
  });

  // ─── validateCouponCode ───────────────────────────────────────────────────────

  describe('validateCouponCode', () => {
    const create = (code: string, overrides: Partial<CouponFixture> = {}) =>
      createCoupon(prisma, { code, type: 'PERCENT', value: 10, ...overrides });
    const validate = (code: string) =>
      gqlRequest(
        app,
        `query { validateCouponCode(code: "${code}") {
          code scope type value minimumSpend { amount currency } promotion { name endsAt }
        } }`,
        undefined,
        userToken,
      ).expect(200);

    it('tells the customer what a valid, active code unlocks, in any letter case', async () => {
      await create('VALID10', { name: 'Ten percent off your order' });

      const res = await validate('valid10');

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.validateCouponCode).toEqual({
        code: 'VALID10',
        scope: 'CART',
        type: 'PERCENT',
        value: '10',
        minimumSpend: null,
        promotion: { name: 'Ten percent off your order', endsAt: null },
      });
    });

    it('fails with an expired coupon', async () => {
      await create('EXPIRED10', { startsAt: new Date('1999-01-01'), endsAt: new Date('2000-01-01') });

      const res = await validate('EXPIRED10');

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/expired/i);
    });

    it('fails with an inactive coupon', async () => {
      await create('INACTIVE10', { isActive: false });

      const res = await validate('INACTIVE10');

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/no longer active/i);
    });

    it('fails when the coupon usage limit has been reached', async () => {
      await create('MAXUSED10', { usageLimit: 5, usedCount: 5 });

      const res = await validate('MAXUSED10');

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/usage limit/i);
    });

    it('states the minimum spend (checkoutQuote applies it to the cart)', async () => {
      await create('MINORDER10', { minimumSpend: 500 });

      const res = await validate('MINORDER10');

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.validateCouponCode.minimumSpend).toEqual(ghs('500.00'));
    });

    it('fails for an unknown code with NOT_FOUND', async () => {
      const res = await validate('NO-SUCH-CODE');

      expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
    });

    it('fails when the user has already used the coupon', async () => {
      // Arrange — create a valid coupon and record a prior use for the seed user
      const { promotion, couponCode } = await create('ALREADYUSED10');

      // Fabricate a prior order and its redemption directly in the DB
      const address = await prisma.address.create({
        data: {
          userId: 'seed_user',
          street: 'Coupon Test St',
          city: 'Accra',
          recipientName: 'Test Customer',
          phone: '+233244000000',
          region: 'GREATER_ACCRA',
          zipCode: '00233',
          country: 'GH',
        },
      });
      const fakeOrder = await prisma.order.create({
        data: {
          orderNumber: await takeOrderNumber(prisma),
          userId: 'seed_user',
          grandTotal: 200,
          currency: 'GHS',
          pricingVersion: 0,
          fulfillmentType: 'DELIVERY',
          shippingAddressId: address.id,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        },
      });
      await prisma.redemption.create({
        data: {
          promotionId: promotion.id,
          couponCodeId: couponCode.id,
          customerId: 'seed_user',
          orderId: fakeOrder.id,
        },
      });

      const res = await validate('ALREADYUSED10');

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/already used/i);
    });
  });
});
