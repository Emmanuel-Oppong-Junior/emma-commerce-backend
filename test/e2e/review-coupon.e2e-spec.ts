import { INestApplication } from '@nestjs/common';
import { DiscountType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';
import { signInUser, signUpUser } from '../helpers/auth.helper';

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

  // ─── validateCoupon ───────────────────────────────────────────────────────────

  describe('validateCoupon', () => {
    const createCoupon = (
      overrides: Partial<{
        code: string;
        discountType: DiscountType;
        value: number;
        usageLimit: number | null;
        usedCount: number;
        expiresAt: Date | null;
        isActive: boolean;
        minimumOrderAmount: number | null;
      }> = {},
    ) =>
      prisma.coupon.create({
        data: {
          code: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          discountType: 'PERCENTAGE',
          value: 10,
          isActive: true,
          usageLimit: null,
          expiresAt: null,
          minimumOrderAmount: null,
          ...overrides,
        },
      });

    it('succeeds with a valid, active coupon', async () => {
      // Arrange
      const coupon = await createCoupon({ code: 'VALID10', value: 10 });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "200" }) {
            valid
            discountAmount { amount currency }
            message
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.validateCoupon.valid).toBe(true);
      expect(res.body.data.validateCoupon.discountAmount).toEqual(ghs('20.00'));
      expect(res.body.data.validateCoupon.message).toBe('Coupon applied. You save 20.00.');
    });

    it('fails with an expired coupon', async () => {
      // Arrange
      const coupon = await createCoupon({
        code: 'EXPIRED10',
        expiresAt: new Date('2000-01-01'),
      });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "200" }) {
            valid
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/expired/i);
    });

    it('fails with an inactive coupon', async () => {
      // Arrange
      const coupon = await createCoupon({ code: 'INACTIVE10', isActive: false });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "200" }) {
            valid
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/no longer active/i);
    });

    it('fails when the coupon usage limit has been reached', async () => {
      // Arrange — usedCount equals usageLimit
      const coupon = await createCoupon({
        code: 'MAXUSED10',
        usageLimit: 5,
        usedCount: 5,
      });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "200" }) {
            valid
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/usage limit/i);
    });

    it('fails when the order total is below the minimum required amount', async () => {
      // Arrange — minimum order is 500; order total is 100
      const coupon = await createCoupon({
        code: 'MINORDER10',
        minimumOrderAmount: 500,
      });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "100" }) {
            valid
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/at least/i);
    });

    it('fails when the user has already used the coupon', async () => {
      // Arrange — create a valid coupon and record a prior usage for the seed user
      const coupon = await createCoupon({ code: 'ALREADYUSED10' });

      // Fabricate a prior order and usage record directly in the DB
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
      await prisma.couponUsage.create({
        data: {
          couponId: coupon.id,
          userId: 'seed_user',
          orderId: fakeOrder.id,
        },
      });

      const mutation = `
        mutation {
          validateCoupon(input: { code: "${coupon.code}", orderTotal: "200" }) {
            valid
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/already used/i);
    });
  });
});
