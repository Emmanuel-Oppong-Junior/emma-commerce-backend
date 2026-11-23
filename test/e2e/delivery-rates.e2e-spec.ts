import { INestApplication } from '@nestjs/common';
import { DeliveryServiceLevel, FulfillmentType, GhanaRegion } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { createPromotion } from '../helpers/promotion.helper';
import { ANY_QUOTE_HASH } from '../helpers/checkout.helper';

const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };
const M = '{ amount }';

// P5-A.1: zones list regions, towns and areas (most specific wins); each prices its service levels with a rate rule.
// Fixtures: Eastern region 40, Koforidua town 25 (EXPRESS 45, 60 from 5 kg), Adweso area of Koforidua 10 (free
// from 400). seed_var2 costs 499.99.
describe('Delivery zones and rate rules (P5-A.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let adminToken: string;
  let shopperCount = 0;

  const adminGql = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, adminToken).expect(200);

  /** A customer with one seed_var2 in the cart and a delivery address. */
  const newShopper = async (place: { city: string; area?: string; region?: GhanaRegion; country?: string }) => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `rates-${shopperCount}@example.com` } });
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
    });
    const address = await prisma.address.create({
      data: {
        userId: user.id,
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: place.region ?? 'EASTERN',
        street: '1 Rate St',
        city: place.city,
        area: place.area,
        country: place.country ?? 'GH',
      },
    });
    return {
      userId: user.id,
      delivery: (serviceLevel?: DeliveryServiceLevel) => ({
        fulfillmentType: FulfillmentType.DELIVERY,
        shippingAddressId: address.id,
        ...(serviceLevel && { serviceLevel }),
      }),
    };
  };

  const reasonOf = (error: unknown) =>
    (error as { getResponse(): { extensions?: { reason?: string } } }).getResponse().extensions?.reason;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);

    for (const [id, name, area, fee] of [
      ['z_eastern', 'Eastern', '{ region: EASTERN }', '40'],
      ['z_koforidua', 'Koforidua', '{ town: "Koforidua" }', '25'],
      ['z_adweso', 'Adweso', '{ town: "koforidua", area: "Adweso" }', '10'],
    ]) {
      const zone = await adminGql(
        `mutation { createShippingZone(input: { name: "${name}", areas: [${area}] }) { id } }`,
      );
      expect(zone.body.errors).toBeUndefined();
      await prisma.shippingZone.update({ where: { id: zone.body.data.createShippingZone.id }, data: { id } });
      const rule = await adminGql(
        `mutation { createRateRule(zoneId: "${id}", input: { serviceLevel: STANDARD, baseFee: "${fee}" }) { id } }`,
      );
      expect(rule.body.errors).toBeUndefined();
    }
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('matching', () => {
    it.each([
      ['an area of the town over the town', { city: 'Koforidua', area: 'adweso ' }, 'z_adweso', '10.00'],
      ['the town over the region', { city: ' KOFORIDUA', area: 'Betom' }, 'z_koforidua', '25.00'],
      ['the region when nothing more specific matches', { city: 'Nkawkaw' }, 'z_eastern', '40.00'],
    ])('prices %s', async (_name, place, zoneId, fee) => {
      const shopper = await newShopper(place);

      const quote = await orders.checkoutQuote(shopper.userId, shopper.delivery());

      expect(quote.delivery).toMatchObject({ zoneId, serviceLevel: 'STANDARD' });
      expect(quote.shippingTotal.toFixed(2)).toBe(fee);
    });

    it.each([
      ['an address no zone covers', { city: 'Ho', region: 'VOLTA' as const }],
      ['an address outside Ghana', { city: 'Koforidua', country: 'NG' }],
    ])('refuses %s at quote and placement, never delivering free', async (_name, place) => {
      const shopper = await newShopper(place);

      const quoted = await orders.checkoutQuote(shopper.userId, shopper.delivery()).catch((e: unknown) => e);
      const placed = await orders
        .createOrderFromCart(shopper.userId, { ...shopper.delivery(), ...contact, quoteHash: ANY_QUOTE_HASH })
        .catch((e: unknown) => e);

      expect(reasonOf(quoted)).toBe('DELIVERY_UNAVAILABLE');
      expect(reasonOf(placed)).toBe('DELIVERY_UNAVAILABLE');
      expect(await prisma.order.count({ where: { userId: shopper.userId } })).toBe(0);
    });

    it('refuses an area another zone lists, naming the clash, and writes nothing', async () => {
      const res = await adminGql(
        'mutation { createShippingZone(input: { name: "Clash", areas: [{ town: "Tema" }, { town: "Ho" }] }) { id } }',
      );

      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(res.body.errors[0].message).toContain('TOWN:tema (zone "Greater Accra")');
      expect(await prisma.shippingZone.count({ where: { name: 'Clash' } })).toBe(0);
    });
  });

  describe('rates', () => {
    beforeAll(async () => {
      const res = await adminGql(
        `mutation { createRateRule(zoneId: "z_koforidua", input: { serviceLevel: EXPRESS, baseFee: "45" }) { id } }`,
      );
      expect(res.body.errors).toBeUndefined();
    });

    it('lists every level the zone offers and prices the one chosen; the quote hash changes with the level', async () => {
      const shopper = await newShopper({ city: 'Koforidua' });

      const standard = await orders.checkoutQuote(shopper.userId, shopper.delivery());
      const express = await orders.checkoutQuote(shopper.userId, shopper.delivery('EXPRESS'));

      expect(standard.deliveryOptions.map((o) => [o.serviceLevel, o.fee.toFixed(2)])).toEqual([
        ['STANDARD', '25.00'],
        ['EXPRESS', '45.00'],
      ]);
      expect(express.shippingTotal.toFixed(2)).toBe('45.00');
      expect(express.quoteHash).not.toBe(standard.quoteHash);
    });

    it('refuses a level the zone does not offer', async () => {
      const shopper = await newShopper({ city: 'Koforidua', area: 'Adweso' });

      const error = await orders.checkoutQuote(shopper.userId, shopper.delivery('EXPRESS')).catch((e: unknown) => e);

      expect(reasonOf(error)).toBe('DELIVERY_LEVEL_UNAVAILABLE');
    });

    it("charges the weight band the cart's weight reaches", async () => {
      const rule = await prisma.rateRule.findFirstOrThrow({
        where: { zoneId: 'z_koforidua', serviceLevel: 'EXPRESS' },
      });
      const banded = await adminGql(
        `mutation { updateRateRule(id: "${rule.id}", input: { weightBands: [{ fromGrams: 5000, fee: "60" }] }) { weightBands { fromGrams } } }`,
      );
      expect(banded.body.errors).toBeUndefined();
      const shopper = await newShopper({ city: 'Koforidua' });

      await prisma.variant.update({ where: { id: 'seed_var2' }, data: { weightGrams: 2500 } });
      const light = await orders.checkoutQuote(shopper.userId, shopper.delivery('EXPRESS'));
      await prisma.cartItem.updateMany({ where: { cart: { userId: shopper.userId } }, data: { quantity: 2 } });
      const heavy = await orders.checkoutQuote(shopper.userId, shopper.delivery('EXPRESS'));
      await prisma.variant.update({ where: { id: 'seed_var2' }, data: { weightGrams: null } });

      expect(light.delivery).toMatchObject({ weightGrams: 2500, weightBandFromGrams: null });
      expect(light.shippingTotal.toFixed(2)).toBe('45.00');
      expect(heavy.delivery).toMatchObject({ weightGrams: 5000, weightBandFromGrams: 5000 });
      expect(heavy.shippingTotal.toFixed(2)).toBe('60.00');
    });

    it('waives the fee once the merchandise total after promotions reaches the threshold', async () => {
      await prisma.rateRule.updateMany({ where: { zoneId: 'z_adweso' }, data: { freeAbove: 400 } });
      const shopper = await newShopper({ city: 'Koforidua', area: 'Adweso' });

      const free = await orders.checkoutQuote(shopper.userId, shopper.delivery());
      await createPromotion(prisma, { id: 'rates_cart_100', type: 'AMOUNT_OFF', value: 100, scope: 'CART' });
      const charged = await orders.checkoutQuote(shopper.userId, shopper.delivery());
      await prisma.promotion.delete({ where: { id: 'rates_cart_100' } });

      expect(free.delivery).toMatchObject({ freeAboveReached: true });
      expect(free.shippingTotal.toFixed(2)).toBe('0.00');
      // 499.99 - 100 = 399.99: below the threshold once the cart promotion applies.
      expect(charged.delivery).toMatchObject({ freeAboveReached: false });
      expect(charged.shippingTotal.toFixed(2)).toBe('10.00');
    });

    it('still applies a free-shipping promotion on top of the zone fee', async () => {
      await createPromotion(prisma, {
        id: 'rates_free_ship',
        type: 'FREE_SHIPPING',
        value: null,
        scope: 'CART',
        shippingZones: { connect: [{ id: 'z_koforidua' }] },
      } as never);
      const shopper = await newShopper({ city: 'Koforidua' });

      const quote = await orders.checkoutQuote(shopper.userId, shopper.delivery());
      await prisma.promotion.delete({ where: { id: 'rates_free_ship' } });

      expect(quote.delivery!.fee.toFixed(2)).toBe('25.00');
      expect(quote.shippingTotal.toFixed(2)).toBe('0.00');
      expect(quote.shippingAdjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([
        ['rates_free_ship', '-25.00'],
      ]);
    });

    it('snapshots the zone, rule, level and fee on the order, which later rate changes leave alone', async () => {
      const shopper = await newShopper({ city: 'Koforidua' });
      const quote = await orders.checkoutQuote(shopper.userId, shopper.delivery('EXPRESS'));

      const order = await orders.createOrderFromCart(shopper.userId, {
        ...shopper.delivery('EXPRESS'),
        ...contact,
        quoteHash: quote.quoteHash,
      });
      await prisma.rateRule.updateMany({
        where: { zoneId: 'z_koforidua', serviceLevel: 'EXPRESS' },
        data: { baseFee: 99 },
      });

      const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored).toMatchObject({
        shippingZoneId: 'z_koforidua',
        shippingZoneName: 'Koforidua',
        rateRuleId: quote.delivery!.rateRuleId,
        serviceLevel: 'EXPRESS',
        pricingVersion: 5,
      });
      expect(stored.shippingFee?.toFixed(2)).toBe('45.00');
      expect(stored.shippingTotal?.toFixed(2)).toBe('45.00');
      const res = await adminGql(
        `{ viewOrder(id: "${order.id}") { shippingZoneName serviceLevel shippingFee ${M} rateRuleId } }`,
      );
      expect(res.body.data.viewOrder).toEqual({
        shippingZoneName: 'Koforidua',
        serviceLevel: 'EXPRESS',
        shippingFee: { amount: '45.00' },
        rateRuleId: quote.delivery!.rateRuleId,
      });
    });
  });

  describe('admin API', () => {
    it('lets customers price nothing: zone and rate mutations need shipping.manage', async () => {
      const userToken = await signInUser(app);

      const zone = await gqlRequest(
        app,
        'mutation { createShippingZone(input: { name: "Nope", areas: [{ town: "Nope" }] }) { id } }',
        undefined,
        userToken,
      ).expect(200);
      const rule = await gqlRequest(
        app,
        'mutation { createRateRule(zoneId: "z_eastern", input: { serviceLevel: EXPRESS, baseFee: "1" }) { id } }',
        undefined,
        userToken,
      ).expect(200);

      expect(zone.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(rule.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('audits zone and rate changes with the fees before and after', async () => {
      const rule = await prisma.rateRule.findFirstOrThrow({ where: { zoneId: 'z_eastern' } });

      const res = await adminGql(`mutation { updateRateRule(id: "${rule.id}", input: { baseFee: "42.50" }) { id } }`);

      expect(res.body.errors).toBeUndefined();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entity: 'RateRule', entityId: rule.id, action: 'UPDATE' },
      });
      expect(audit.details).toEqual({ changes: { baseFee: { from: '40.00', to: '42.50' } } });
      expect(await prisma.auditLog.count({ where: { entity: 'ShippingZone', action: 'CREATE' } })).toBe(3);
    });

    it('shows the public rate card with active rules only', async () => {
      await prisma.rateRule.updateMany({ where: { zoneId: 'z_eastern' }, data: { isActive: false } });

      const res = await gqlRequest(
        app,
        `{ activeShippingZones { id areas { level region town area } rateRules { serviceLevel baseFee ${M} } } }`,
      ).expect(200);
      await prisma.rateRule.updateMany({ where: { zoneId: 'z_eastern' }, data: { isActive: true } });

      const zones = res.body.data.activeShippingZones as { id: string; rateRules: unknown[] }[];
      expect(zones.find((zone) => zone.id === 'z_adweso')).toEqual({
        id: 'z_adweso',
        areas: [{ level: 'AREA', region: null, town: 'koforidua', area: 'adweso' }],
        rateRules: [{ serviceLevel: 'STANDARD', baseFee: { amount: '10.00' } }],
      });
      expect(zones.find((zone) => zone.id === 'z_eastern')!.rateRules).toEqual([]);
    });
  });
});
