import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Decimal } from '@prisma/client/runtime/client';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signUpUser } from '../helpers/auth.helper';
import { createPromotion } from '../helpers/promotion.helper';

const DAY_MS = 24 * 60 * 60 * 1000;
const contact = { contactEmail: 'trade@example.com', contactPhone: '+233244000000' };
const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'pl_pickup' };

// P2-W.1: price lists per customer group replace the normal price (seed_var2, the phone, 499.99; seed_var1 999.99).
describe('B2B price lists (P2-W.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let orders: OrdersService;
  let customerCount = 0;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const errorOf = (res: { body: { errors?: { extensions: { code: string; reason?: string } }[] } }) =>
    res.body.errors?.[0].extensions;

  /** A signed-up customer with the phone in the cart, in the given customer groups. */
  const newCustomer = async (groupIds: string[], quantity = 1) => {
    customerCount += 1;
    const email = `trade-${customerCount}@example.com`;
    const { accessToken } = await signUpUser(app, { email, password: 'Passw0rd!x', name: 'Trade Buyer' });
    const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.customerGroupMember.createMany({ data: groupIds.map((groupId) => ({ groupId, userId })) });
    const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    const item = await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity },
    });
    return { userId, token: accessToken, cartItemId: item.id };
  };

  /** An active list for the groups, created `ageDays` ago, with entries for the variants. */
  const createList = (
    id: string,
    groupIds: string[],
    entries: { variantId: string; price: Decimal.Value; minQuantity?: number; tiers?: [number, Decimal.Value][] }[],
    fields: { isActive?: boolean; startsAt?: Date; endsAt?: Date; priority?: number; allowPromotions?: boolean } = {},
    ageDays = 1,
  ) =>
    prisma.priceList.create({
      data: {
        id,
        name: id,
        isActive: true,
        createdAt: new Date(Date.now() - ageDays * DAY_MS),
        ...fields,
        customerGroups: { connect: groupIds.map((groupId) => ({ id: groupId })) },
        entries: {
          create: entries.map(({ variantId, price, minQuantity = 1, tiers = [] }) => ({
            variantId,
            price,
            minQuantity,
            tiers: {
              create: tiers.map(([tierQuantity, tierPrice]) => ({ minQuantity: tierQuantity, price: tierPrice })),
            },
          })),
        },
      },
    });

  const linesOf = (quote: Awaited<ReturnType<OrdersService['checkoutQuote']>>) =>
    quote.lines.map((line) => [
      line.variantId,
      line.quantity,
      line.unitListPrice.toFixed(2),
      line.unitDiscount.toFixed(2),
      line.fromPriceList,
    ]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    redis = app.get(REDIS_CLIENT);
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: {
        id: 'pl_pickup',
        name: 'Osu',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'Ghana',
      },
    });
    await prisma.customerGroup.createMany({
      data: [
        { id: 'grp_trade', name: 'Trade' },
        { id: 'grp_vip', name: 'VIP wholesale' },
      ],
    });
  });

  beforeEach(async () => {
    await prisma.priceList.deleteMany();
    await prisma.promotion.updateMany({ data: { isActive: false } });
  });

  afterAll(async () => {
    await prisma.priceList.deleteMany();
    await prisma.customerGroup.deleteMany();
    await resetDb(prisma);
    await app.close();
  });

  it('charges a member the list price exactly as quoted and stores the list on the line; others pay the normal price', async () => {
    await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 450 }]);
    const member = await newCustomer(['grp_trade'], 2);
    const outsider = await newCustomer([], 2);

    const quote = await orders.checkoutQuote(member.userId, pickup);
    const order = await orders.createOrderFromCart(member.userId, {
      ...pickup,
      ...contact,
      quoteHash: quote.quoteHash,
    });
    const outsiderQuote = await orders.checkoutQuote(outsider.userId, pickup);

    expect(linesOf(quote)).toEqual([['seed_var2', 2, '450.00', '0.00', true]]);
    expect(quote.grandTotal.toFixed(2)).toBe('900.00');
    expect(order.grandTotal.toFixed(2)).toBe(quote.grandTotal.toFixed(2));
    expect(order.pricingVersion).toBe(6);
    const [item] = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect([item.unitListPrice.toFixed(2), item.priceListId]).toEqual(['450.00', 'pl_trade']);
    expect(linesOf(outsiderQuote)).toEqual([['seed_var2', 2, '499.99', '0.00', false]]);
    expect(outsiderQuote.grandTotal.toFixed(2)).toBe('999.98');
  });

  it('applies the normal price below the minimum quantity and each tier from its exact boundary', async () => {
    await createList(
      'pl_volume',
      ['grp_trade'],
      [
        {
          variantId: 'seed_var2',
          price: 480,
          minQuantity: 5,
          tiers: [
            [10, 460],
            [20, 440],
          ],
        },
      ],
    );
    const member = await newCustomer(['grp_trade']);
    const priceAt = async (quantity: number) => {
      await prisma.cartItem.update({ where: { id: member.cartItemId }, data: { quantity } });
      const [line] = linesOf(await orders.checkoutQuote(member.userId, pickup));
      return [line[2], line[4]];
    };

    expect(await priceAt(4)).toEqual(['499.99', false]);
    expect(await priceAt(5)).toEqual(['480.00', true]);
    expect(await priceAt(9)).toEqual(['480.00', true]);
    expect(await priceAt(10)).toEqual(['460.00', true]);
    expect(await priceAt(20)).toEqual(['440.00', true]);
  });

  it('gives the lowest price across overlapping lists, ties to the lowest priority number then the oldest', async () => {
    await createList('pl_a', ['grp_trade'], [{ variantId: 'seed_var2', price: 470 }], {}, 3);
    await createList('pl_b', ['grp_vip'], [{ variantId: 'seed_var2', price: 460 }], {}, 2);
    const member = await newCustomer(['grp_trade', 'grp_vip']);
    const listOf = async () => (await orders.checkoutQuote(member.userId, pickup)).lines[0];

    expect((await listOf()).priceList?.priceListId).toBe('pl_b');

    await prisma.priceListEntry.updateMany({ where: { priceListId: 'pl_a' }, data: { price: 460 } });
    expect((await listOf()).priceList?.priceListId).toBe('pl_a');

    await prisma.priceList.update({ where: { id: 'pl_b' }, data: { priority: -1 } });
    expect((await listOf()).priceList?.priceListId).toBe('pl_b');
  });

  it.each([
    ['inactive', { isActive: false }],
    ['expired', { endsAt: new Date(Date.now() - DAY_MS) }],
    ['not started', { startsAt: new Date(Date.now() + DAY_MS) }],
  ])('ignores an %s list', async (_case, fields) => {
    await createList('pl_off', ['grp_trade'], [{ variantId: 'seed_var2', price: 400 }], fields);
    const member = await newCustomer(['grp_trade']);

    expect(linesOf(await orders.checkoutQuote(member.userId, pickup))).toEqual([
      ['seed_var2', 1, '499.99', '0.00', false],
    ]);
  });

  it('never charges above the normal price', async () => {
    await createList('pl_dear', ['grp_trade'], [{ variantId: 'seed_var2', price: 550 }]);
    const member = await newCustomer(['grp_trade']);

    expect(linesOf(await orders.checkoutQuote(member.userId, pickup))[0][2]).toBe('499.99');
  });

  it('keeps list-priced lines out of item and cart promotions unless the list allows promotions', async () => {
    await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 450 }]);
    await createPromotion(prisma, { id: 'promo_phone', type: 'AMOUNT_OFF', value: 10, targetIds: ['seed_prod2'] });
    await createPromotion(prisma, { id: 'promo_cart', type: 'PERCENT', value: 10, scope: 'CART' });
    const member = await newCustomer(['grp_trade']);
    const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: member.userId } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod1', variantId: 'seed_var1', quantity: 1 },
    });

    const excluded = await orders.checkoutQuote(member.userId, pickup);
    const order = await orders.createOrderFromCart(member.userId, {
      ...pickup,
      ...contact,
      quoteHash: excluded.quoteHash,
    });

    // The phone pays 450 with no promotion; only the laptop (999.99) gets the cart promotion's 10%.
    expect(excluded.lines.map((l) => [l.variantId, l.unitDiscount.toFixed(2), l.fromPriceList])).toEqual([
      ['seed_var2', '0.00', true],
      ['seed_var1', '0.00', false],
    ]);
    expect(excluded.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['promo_cart', '-100.00']]);
    expect(excluded.adjustments[0].allocations.map((a) => a.amount.toFixed(2))).toEqual(['0.00', '-100.00']);
    expect(order.grandTotal.toFixed(2)).toBe(excluded.grandTotal.toFixed(2));
    expect(excluded.grandTotal.toFixed(2)).toBe('1349.99');

    await prisma.priceList.update({ where: { id: 'pl_trade' }, data: { allowPromotions: true } });
    await prisma.cartItem.createMany({
      data: [
        { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
        { cartId: cart.id, productId: 'seed_prod1', variantId: 'seed_var1', quantity: 1 },
      ],
    });
    const allowed = await orders.checkoutQuote(member.userId, pickup);

    // 450 - 10 = 440 for the phone; the cart promotion takes 10% of 440 + 999.99.
    expect(allowed.lines[0].unitDiscount.toFixed(2)).toBe('10.00');
    expect(allowed.adjustments.map((a) => a.amount.toFixed(2))).toEqual(['-144.00']);
    expect(allowed.quoteHash).not.toBe(excluded.quoteHash);
  });

  describe('product pages', () => {
    const query = `query { product(productId: "seed_prod2") { variants {
      price { amount } discountedPrice { amount } customerPrice { minQuantity unitPrice { amount currency } promotionsApply }
      priceTiers { minQuantity unitPrice { amount } promotionsApply } } } }`;
    const variantFor = async (token?: string) => {
      const res = await gql(query, token);
      expect(res.body.errors).toBeUndefined();
      return res.body.data.product.variants[0];
    };

    it('shows a member their price and tiers with their token, and the public price without one', async () => {
      await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 480, tiers: [[10, 460]] }]);
      const member = await newCustomer(['grp_trade']);

      const signedIn = await variantFor(member.token);
      const anonymous = await variantFor();

      expect(signedIn).toEqual({
        price: { amount: '499.99' },
        // The list does not allow promotions, so nothing comes off its price: customerPrice is what one unit costs.
        discountedPrice: null,
        customerPrice: { minQuantity: 1, unitPrice: ghs('480.00'), promotionsApply: false },
        priceTiers: [
          { minQuantity: 1, unitPrice: { amount: '480.00' }, promotionsApply: false },
          { minQuantity: 10, unitPrice: { amount: '460.00' }, promotionsApply: false },
        ],
      });
      expect(anonymous).toEqual({
        price: { amount: '499.99' },
        discountedPrice: null,
        customerPrice: null,
        priceTiers: null,
      });
    });

    it('takes promotions off the member price on the page only when the list allows them', async () => {
      await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 480 }], { allowPromotions: true });
      await createPromotion(prisma, { type: 'AMOUNT_OFF', value: 10, targetIds: ['seed_prod2'] });
      const member = await newCustomer(['grp_trade']);

      expect((await variantFor(member.token)).discountedPrice).toEqual({ amount: '470.00' });
      expect((await variantFor()).discountedPrice).toEqual({ amount: '489.99' });

      await prisma.priceList.update({ where: { id: 'pl_trade' }, data: { allowPromotions: false } });
      expect((await variantFor(member.token)).discountedPrice).toBeNull();
    });

    it('shows a signed-in customer their group promotions, not a visitor', async () => {
      await createPromotion(prisma, {
        type: 'AMOUNT_OFF',
        value: 20,
        targetIds: ['seed_prod2'],
        customerGroups: { connect: [{ id: 'grp_vip' }] },
      } as never);
      const vip = await newCustomer(['grp_vip']);

      expect((await variantFor(vip.token)).discountedPrice).toEqual({ amount: '479.99' });
      expect((await variantFor()).discountedPrice).toBeNull();
    });

    it('refuses an invalid or expired token with UNAUTHENTICATED instead of showing the public price', async () => {
      const res = await gql(query, 'not-a-valid-token');

      expect(errorOf(res)?.code).toBe('UNAUTHENTICATED');
      expect(res.body.data?.product ?? null).toBeNull();
    });

    it("never serves one viewer's prices to another, however the requests interleave", async () => {
      await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 450 }]);
      await createList('pl_vip', ['grp_vip'], [{ variantId: 'seed_var2', price: 400 }]);
      const trade = await newCustomer(['grp_trade']);
      const vip = await newCustomer(['grp_vip']);
      const outsider = await newCustomer([]);

      const viewers = [trade.token, vip.token, undefined, outsider.token, trade.token, vip.token, undefined];
      const seen = await Promise.all(viewers.map((token) => variantFor(token)));

      expect(seen.map((variant) => variant.customerPrice?.unitPrice.amount ?? null)).toEqual([
        '450.00',
        '400.00',
        null,
        null,
        '450.00',
        '400.00',
        null,
      ]);
      expect(seen.map((variant) => variant.priceTiers?.length ?? null)).toEqual([1, 1, null, 0, 1, 1, null]);
    });

    it('shows the quote line as priced from a list through checkoutQuote', async () => {
      await createList('pl_trade', ['grp_trade'], [{ variantId: 'seed_var2', price: 450 }]);
      const member = await newCustomer(['grp_trade']);

      const res = await gql(
        `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) { lines { unitListPrice { amount } fromPriceList } } }`,
        member.token,
        { input: pickup },
      );

      expect(res.body.data.checkoutQuote.lines).toEqual([{ unitListPrice: { amount: '450.00' }, fromPriceList: true }]);
    });
  });

  describe('admin API', () => {
    let managerToken: string;
    let supportToken: string;
    let customerToken: string;
    const LIST_FIELDS = `id name currency isActive startsAt endsAt priority allowPromotions customerGroupIds entryCount
      entries { totalCount hasNextPage nodes { variantId price { amount } minQuantity tiers { minQuantity price { amount } } } }`;

    beforeAll(async () => {
      managerToken = await signInAdmin(app);
      const ownerToken = await signInSuperAdmin(app);
      await signUpUser(app, { email: 'pl-support@example.com', password: 'Passw0rd!x', name: 'Support' });
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'pl-support@example.com' } });
      await gql(`mutation { assignStaffRole(userId: "${id}", roleKey: "SUPPORT") { role { key } } }`, ownerToken);
      const signedIn = await gql(
        'mutation S($input: SignInInput!) { signIn(input: $input) { accessToken } }',
        undefined,
        {
          input: { email: 'pl-support@example.com', password: 'Passw0rd!x' },
        },
      );
      supportToken = signedIn.body.data.signIn.accessToken;
      customerToken = (await newCustomer(['grp_trade'])).token;
    });

    it('creates, fills, updates and deletes a price list, auditing every change', async () => {
      const created = await gql(
        `mutation { createPriceList(input: {
          name: "Retailers", isActive: true, priority: 2, allowPromotions: true, customerGroupIds: ["grp_trade"]
        }) { ${LIST_FIELDS} } }`,
        managerToken,
      );
      expect(created.body.errors).toBeUndefined();
      const list = created.body.data.createPriceList;
      expect(list).toMatchObject({
        name: 'Retailers',
        currency: 'GHS',
        isActive: true,
        priority: 2,
        allowPromotions: true,
        customerGroupIds: ['grp_trade'],
        entryCount: 0,
      });

      const filled = await gql(
        `mutation { setPriceListEntries(input: { priceListId: "${list.id}", entries: [
          { variantId: "seed_var2", price: "480", minQuantity: 3, tiers: [{ minQuantity: 10, price: "460" }] },
          { variantId: "seed_var1", price: "950" }
        ] }) { ${LIST_FIELDS} } }`,
        managerToken,
      );
      expect(filled.body.errors).toBeUndefined();
      expect(filled.body.data.setPriceListEntries.entries).toEqual({
        totalCount: 2,
        hasNextPage: false,
        nodes: [
          { variantId: 'seed_var1', price: { amount: '950.00' }, minQuantity: 1, tiers: [] },
          {
            variantId: 'seed_var2',
            price: { amount: '480.00' },
            minQuantity: 3,
            tiers: [{ minQuantity: 10, price: { amount: '460.00' } }],
          },
        ],
      });

      const repriced = await gql(
        `mutation { setPriceListEntries(input: { priceListId: "${list.id}", entries: [
          { variantId: "seed_var2", price: "470" }
        ] }) { entries(first: 1) { totalCount hasNextPage nodes { variantId } } } }`,
        managerToken,
      );
      expect(repriced.body.data.setPriceListEntries.entries).toEqual({
        totalCount: 2,
        hasNextPage: true,
        nodes: [{ variantId: 'seed_var1' }],
      });
      expect(await prisma.priceListTier.count()).toBe(0);

      const updated = await gql(
        `mutation { updatePriceList(id: "${list.id}", input: { allowPromotions: false, customerGroupIds: ["grp_vip"] }) {
          allowPromotions customerGroupIds } }`,
        managerToken,
      );
      const removed = await gql(
        `mutation { removePriceListEntries(input: { priceListId: "${list.id}", variantIds: ["seed_var1"] }) { entryCount } }`,
        managerToken,
      );
      const deleted = await gql(`mutation { deletePriceList(id: "${list.id}") { id } }`, managerToken);

      expect(updated.body.data.updatePriceList).toEqual({ allowPromotions: false, customerGroupIds: ['grp_vip'] });
      expect(removed.body.data.removePriceListEntries.entryCount).toBe(1);
      expect(deleted.body.errors).toBeUndefined();
      expect(await prisma.priceListEntry.count({ where: { priceListId: list.id } })).toBe(0);
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'PriceList', entityId: list.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'DELETE']);
      expect(audit[2].details).toMatchObject({
        setEntries: [
          {
            variantId: 'seed_var2',
            before: { price: '480.00', minQuantity: 3, tiers: [{ minQuantity: 10, price: '460.00' }] },
            after: { price: '470.00', minQuantity: 1, tiers: [] },
          },
        ],
      });
      expect(audit[4].details).toMatchObject({
        removeEntries: [{ variantId: 'seed_var1', before: { price: '950.00' } }],
      });
    });

    it.each([
      [
        'a dearer tier',
        '{ variantId: "seed_var2", price: "480", tiers: [{ minQuantity: 10, price: "481" }] }',
        'at most the price below it',
      ],
      [
        'a tier at the minimum quantity',
        '{ variantId: "seed_var2", price: "480", minQuantity: 10, tiers: [{ minQuantity: 10, price: "470" }] }',
        'ascend',
      ],
      ['an unknown variant', '{ variantId: "nope", price: "1" }', 'Unknown variant ids: nope'],
      [
        'a variant twice',
        '{ variantId: "seed_var2", price: "1" }, { variantId: "seed_var2", price: "2" }',
        'more than once',
      ],
    ])('refuses entries with %s with BAD_REQUEST', async (_case, entries, message) => {
      await createList('pl_admin', [], []);

      const res = await gql(
        `mutation { setPriceListEntries(input: { priceListId: "pl_admin", entries: [${entries}] }) { id } }`,
        managerToken,
      );

      expect(errorOf(res)?.code).toBe('BAD_REQUEST');
      expect(res.body.errors[0].message).toContain(message);
      expect(await prisma.priceListEntry.count()).toBe(0);
    });

    it('refuses a zero price as invalid input', async () => {
      await createList('pl_admin', [], []);

      const res = await gql(
        'mutation { setPriceListEntries(input: { priceListId: "pl_admin", entries: [{ variantId: "seed_var2", price: "0" }] }) { id } }',
        managerToken,
      );

      expect(errorOf(res)?.code).toBe('BAD_USER_INPUT');
    });

    it.each([
      ['a customer', () => customerToken],
      ['staff without pricelist.manage (Support)', () => supportToken],
    ])('refuses %s every price-list operation with FORBIDDEN', async (_who, token) => {
      const operations = [
        'query { priceLists { id } }',
        'query { priceList(id: "x") { id } }',
        'mutation { createPriceList(input: { name: "x" }) { id } }',
        'mutation { updatePriceList(id: "x", input: { name: "y" }) { id } }',
        'mutation { deletePriceList(id: "x") { id } }',
        'mutation { setPriceListEntries(input: { priceListId: "x", entries: [{ variantId: "v", price: "1" }] }) { id } }',
        'mutation { removePriceListEntries(input: { priceListId: "x", variantIds: ["v"] }) { id } }',
      ];
      for (const operation of operations) {
        expect(errorOf(await gql(operation, token()))?.code).toBe('FORBIDDEN');
      }
    });

    it('does not let a customer read which list or group gives their price', async () => {
      const res = await gqlRequest(
        app,
        'query { product(productId: "seed_prod2") { variants { customerPrice { priceListId } } } }',
        undefined,
        customerToken,
      ).expect(400);

      expect(errorOf(res)?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('needs a recent step-up for every price-list change, not for reads', async () => {
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      const changes = [
        'mutation { createPriceList(input: { name: "x" }) { id } }',
        'mutation { updatePriceList(id: "x", input: { name: "y" }) { id } }',
        'mutation { deletePriceList(id: "x") { id } }',
        'mutation { setPriceListEntries(input: { priceListId: "x", entries: [{ variantId: "v", price: "1" }] }) { id } }',
        'mutation { removePriceListEntries(input: { priceListId: "x", variantIds: ["v"] }) { id } }',
      ];
      for (const change of changes) {
        expect(errorOf(await gql(change, managerToken))?.reason).toBe('STEP_UP_REQUIRED');
      }
      expect((await gql('query { priceLists { id } }', managerToken)).body.errors).toBeUndefined();
      managerToken = await signInAdmin(app);
    });
  });
});
