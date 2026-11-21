import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { createPromotion } from '../helpers/promotion.helper';

const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'bxgy_pickup' };
const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };

// P2-B.5: BXGY, volume tiers and spend tiers count units of different variants together (mix and match).
describe('BXGY, tiered and spend-X-save-Y promotions (P2-B.5, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let shopperCount = 0;

  /** A customer with laptops (seed_var1, 999.99) and phones (seed_var2, 499.99), both in category seed_cat. */
  const newShopper = async (laptops: number, phones: number) => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `bxgy-${shopperCount}@example.com` } });
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    if (laptops > 0) {
      await prisma.cartItem.create({
        data: { cartId: cart.id, productId: 'seed_prod1', variantId: 'seed_var1', quantity: laptops },
      });
    }
    if (phones > 0) {
      await prisma.cartItem.create({
        data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: phones },
      });
    }
    return user.id;
  };
  /** Quotes and places the cart; returns both, so the charge can be compared with the quote. */
  const quoteAndPlace = async (userId: string) => {
    const quote = await orders.checkoutQuote(userId, pickup);
    const order = await orders.createOrderFromCart(userId, { ...pickup, ...contact, quoteHash: quote.quoteHash });
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: [{ variantId: 'asc' }, { unitDiscount: 'desc' }],
    });
    const adjustments = await prisma.orderAdjustment.findMany({ where: { orderId: order.id } });
    return { quote, order, items, adjustments };
  };
  const itemSummary = (
    items: { variantId: string; quantity: number; unitDiscount: { toFixed(n: number): string } }[],
  ) => items.map((item) => [item.variantId, item.quantity, item.unitDiscount.toFixed(2)]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: { id: 'bxgy_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
  });

  beforeEach(async () => {
    await prisma.promotion.updateMany({ data: { isActive: false } });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('gives the cheapest unit of the category free with BXGY across different variants, charging exactly the quote', async () => {
    await createPromotion(prisma, {
      id: 'b1g1_cat',
      type: 'BXGY',
      value: 100,
      scope: 'CATEGORY',
      targetIds: ['seed_cat'],
      buyQuantity: 1,
      getQuantity: 1,
    });
    const userId = await newShopper(1, 1);

    const { quote, order, items, adjustments } = await quoteAndPlace(userId);

    expect(quote.grandTotal.toFixed(2)).toBe('999.99');
    expect(order.grandTotal.toFixed(2)).toBe(quote.grandTotal.toFixed(2));
    expect(itemSummary(items)).toEqual([
      ['seed_var1', 1, '0.00'],
      ['seed_var2', 1, '499.99'],
    ]);
    expect(adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['b1g1_cat', '-499.99']]);
    expect(await prisma.redemption.findMany({ where: { orderId: order.id }, select: { units: true } })).toEqual([
      { units: 1 },
    ]);
  });

  it('repeats BXGY up to maxApplications and splits the rewarded units from the paid ones', async () => {
    await createPromotion(prisma, {
      id: 'b1g1_phones',
      type: 'BXGY',
      value: 50,
      targetIds: ['seed_prod2'],
      buyQuantity: 1,
      getQuantity: 1,
      maxApplications: 2,
    });
    const userId = await newShopper(0, 5);

    const { quote, order, items } = await quoteAndPlace(userId);

    // 5 phones: 2 applications (the cap) reward 2 at 50% off; 3 pay full price.
    expect(itemSummary(items)).toEqual([
      ['seed_var2', 2, '250.00'],
      ['seed_var2', 3, '0.00'],
    ]);
    expect(quote.grandTotal.toFixed(2)).toBe('1999.95');
    expect(order.grandTotal.toFixed(2)).toBe('1999.95');
  });

  it('chooses a volume tier from the units of all targeted variants together', async () => {
    await createPromotion(prisma, {
      id: 'volume_cat',
      type: 'TIERED',
      value: null,
      scope: 'CATEGORY',
      targetIds: ['seed_cat'],
      tierValueType: 'PERCENT',
      tiers: [
        { minimumQuantity: 2, value: 10 },
        { minimumQuantity: 3, value: 20 },
      ],
    });
    const two = await newShopper(1, 1);
    const three = await newShopper(1, 2);

    const twoQuote = await orders.checkoutQuote(two, pickup);
    const { quote, order, items } = await quoteAndPlace(three);

    expect(twoQuote.lines.map((line) => line.unitDiscount.toFixed(2))).toEqual(['100.00', '50.00']);
    expect(itemSummary(items)).toEqual([
      ['seed_var1', 1, '200.00'],
      ['seed_var2', 2, '100.00'],
    ]);
    expect(quote.grandTotal.toFixed(2)).toBe('1599.97');
    expect(order.grandTotal.toFixed(2)).toBe('1599.97');
  });

  it('takes the best spend tier reached after item promotions off the cart', async () => {
    await createPromotion(prisma, {
      id: 'spend_tiers',
      type: 'TIERED',
      value: null,
      scope: 'CART',
      tierValueType: 'AMOUNT_OFF',
      tiers: [
        { minimumSpend: 1000, value: 100 },
        { minimumSpend: 2000, value: 300 },
      ],
    });
    const plain = await newShopper(2, 1);
    const placed = await quoteAndPlace(plain);
    await createPromotion(prisma, { id: 'laptop_ten', type: 'PERCENT', value: 10, targetIds: ['seed_prod1'] });
    const discounted = await newShopper(2, 1);

    const afterItem = await orders.checkoutQuote(discounted, pickup);

    // 2499.97 reaches the 2000 tier; with 10% off the laptops (2299.97) it still does; one laptop less would not.
    expect(placed.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['spend_tiers', '-300.00']]);
    expect(placed.order.grandTotal.toFixed(2)).toBe('2199.97');
    expect(placed.order.grandTotal.toFixed(2)).toBe(placed.quote.grandTotal.toFixed(2));
    expect(afterItem.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['spend_tiers', '-300.00']]);
    const small = await newShopper(1, 1);
    const smallQuote = await orders.checkoutQuote(small, pickup);
    // 899.99 + 499.99 = 1399.98 after the laptop's 10%: the 1000 tier.
    expect(smallQuote.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['spend_tiers', '-100.00']]);
  });

  describe('admin API', () => {
    let managerToken: string;
    const gql = (query: string) => gqlRequest(app, query, undefined, managerToken).expect(200);
    const FIELDS =
      'id type value buyQuantity getQuantity maxApplications rewardTargetIds tierValueType tiers { minimumQuantity minimumSpend { amount } value }';

    beforeAll(async () => {
      managerToken = await signInAdmin(app);
    });

    it('creates a BXGY promotion with reward targets and a TIERED one, and replaces tiers on update, audited', async () => {
      const bxgy = await gql(
        `mutation { createPromotion(input: {
          name: "Phone + free laptop sleeve", scope: PRODUCT, type: BXGY, value: "100", targetIds: ["seed_prod2"],
          rewardTargetIds: ["seed_prod1"], buyQuantity: 2, getQuantity: 1, maxApplications: 3
        }) { ${FIELDS} } }`,
      );
      const tiered = await gql(
        `mutation { createPromotion(input: {
          name: "Spend more", scope: CART, type: TIERED, tierValueType: AMOUNT_OFF,
          tiers: [{ minimumSpend: "500", value: "50" }, { minimumSpend: "1000", value: "120" }]
        }) { ${FIELDS} } }`,
      );
      expect(bxgy.body.errors).toBeUndefined();
      expect(tiered.body.errors).toBeUndefined();
      expect(bxgy.body.data.createPromotion).toMatchObject({
        type: 'BXGY',
        value: '100',
        buyQuantity: 2,
        getQuantity: 1,
        maxApplications: 3,
        rewardTargetIds: ['seed_prod1'],
        tierValueType: null,
        tiers: [],
      });
      const { id } = tiered.body.data.createPromotion;
      expect(tiered.body.data.createPromotion).toMatchObject({
        value: null,
        tierValueType: 'AMOUNT_OFF',
        tiers: [
          { minimumQuantity: null, minimumSpend: { amount: '500.00' }, value: '50' },
          { minimumQuantity: null, minimumSpend: { amount: '1000.00' }, value: '120' },
        ],
      });

      const updated = await gql(
        `mutation { updatePromotion(id: "${id}", input: { tiers: [{ minimumSpend: "300", value: "20" }] }) { tiers { value } } }`,
      );

      expect(updated.body.data.updatePromotion.tiers).toEqual([{ value: '20' }]);
      expect(await prisma.promotionTier.count({ where: { promotionId: id } })).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entity: 'Promotion', entityId: id, action: 'UPDATE' },
      });
      expect((audit.details as { tiers: unknown }).tiers).toEqual([
        { minimumQuantity: null, minimumSpend: '300', value: '20' },
      ]);
    });

    it.each([
      [
        'BXGY without getQuantity',
        'scope: PRODUCT, type: BXGY, value: "100", buyQuantity: 2',
        'buyQuantity and getQuantity',
      ],
      [
        'descending tiers',
        'scope: PRODUCT, type: TIERED, tierValueType: PERCENT, tiers: [{ minimumQuantity: 5, value: "15" }, { minimumQuantity: 3, value: "10" }]',
        'ascending',
      ],
      [
        'a tier percentage above 100',
        'scope: PRODUCT, type: TIERED, tierValueType: PERCENT, tiers: [{ minimumQuantity: 2, value: "120" }]',
        'at most 100',
      ],
      [
        'a value on TIERED',
        'scope: CART, type: TIERED, value: "5", tierValueType: PERCENT, tiers: [{ minimumSpend: "10", value: "5" }]',
        'takes no value',
      ],
      [
        'reward targets on a percentage',
        'scope: PRODUCT, type: PERCENT, value: "5", rewardTargetIds: ["seed_prod1"]',
        'BXGY promotions only',
      ],
      [
        'an unknown reward target',
        'scope: PRODUCT, type: BXGY, value: "100", buyQuantity: 1, getQuantity: 1, rewardTargetIds: ["nope"]',
        'Unknown PRODUCT target',
      ],
    ])('refuses %s with BAD_REQUEST', async (_case, fields, message) => {
      const res = await gql(`mutation { createPromotion(input: { name: "Bad", ${fields} }) { id } }`);

      expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(res.body.errors[0].message).toContain(message);
    });

    it('needs a recent step-up to create a BXGY or tiered promotion', async () => {
      const redis = app.get<Redis>(REDIS_CLIENT);
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      const res = await gql(
        'mutation { createPromotion(input: { name: "x", scope: PRODUCT, type: BXGY, value: "100", buyQuantity: 1, getQuantity: 1 }) { id } }',
      );

      expect(res.body.errors[0].extensions.reason).toBe('STEP_UP_REQUIRED');
      managerToken = await signInAdmin(app);
    });
  });
});
