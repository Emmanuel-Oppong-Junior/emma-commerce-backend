import { INestApplication } from '@nestjs/common';
import { FulfillmentType, Store } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';

const SETTINGS_FIELDS = `id legalName tradingName tin vatRegistered pricesIncludeTax currency supportEmail supportPhone`;
const SHOPPERS = 20;

describe('Store settings and order numbering (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let original: Store;

  const updateSettings = (token: string, input: string) =>
    gqlRequest(
      app,
      `mutation { updateStoreSettings(input: { ${input} }) { ${SETTINGS_FIELDS} } }`,
      undefined,
      token,
    ).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    original = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });
  });

  afterAll(async () => {
    const { legalName, tradingName, tin, vatRegistered, pricesIncludeTax, supportEmail, supportPhone } = original;
    await prisma.store.update({
      where: { singleton: true },
      data: { legalName, tradingName, tin, vatRegistered, pricesIncludeTax, supportEmail, supportPhone },
    });
    await app.close();
  });

  it('holds exactly one store row, and the database refuses a second one', async () => {
    expect(await prisma.store.count()).toBe(1);

    await expect(
      prisma.$executeRaw`INSERT INTO "Store" ("id", "legalName", "tradingName", "updatedAt")
        VALUES ('second', 'Other', 'Other', now())`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO "Store" ("id", "singleton", "legalName", "tradingName", "updatedAt")
        VALUES ('second', false, 'Other', 'Other', now())`,
    ).rejects.toThrow();
    expect(await prisma.store.count()).toBe(1);
  });

  it('serves the settings to anyone, without the order counter', async () => {
    const res = await gqlRequest(app, `{ storeSettings { ${SETTINGS_FIELDS} } }`).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.storeSettings).toMatchObject({
      id: original.id,
      legalName: original.legalName,
      currency: 'GHS',
      pricesIncludeTax: true,
    });

    const counter = await gqlRequest(app, `{ storeSettings { nextOrderNumber } }`).expect(400);
    expect(counter.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('lets a super admin change the settings, audited', async () => {
    const superAdminToken = await signInSuperAdmin(app);

    const res = await updateSettings(
      superAdminToken,
      `tradingName: "Emma Mart", tin: "GHA-123456789-0", vatRegistered: true, supportEmail: "help@example.com", supportPhone: "+233244000000"`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateStoreSettings).toMatchObject({
      tradingName: 'Emma Mart',
      tin: 'GHA-123456789-0',
      vatRegistered: true,
      supportEmail: 'help@example.com',
      supportPhone: '+233244000000',
      legalName: original.legalName,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Store', entityId: original.id } });
    expect(audit).toMatchObject({ action: 'UPDATE', userId: 'seed_super_admin' });
    expect(audit.details).toMatchObject({
      changes: {
        tradingName: { from: original.tradingName, to: 'Emma Mart' },
        vatRegistered: { from: false, to: true },
      },
    });
  });

  it('rejects an invalid TIN with BAD_USER_INPUT and changes nothing', async () => {
    const superAdminToken = await signInSuperAdmin(app);
    const before = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });

    const res = await updateSettings(superAdminToken, `tin: "P001/234"`);

    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect((await prisma.store.findUniqueOrThrow({ where: { singleton: true } })).tin).toBe(before.tin);
  });

  it.each([
    ['an admin', signInAdmin],
    ['a customer', signInUser],
  ])('forbids %s to change the settings', async (_who, signIn) => {
    const token = await signIn(app);
    const before = await prisma.store.findUniqueOrThrow({ where: { singleton: true } });

    const res = await updateSettings(token, `tradingName: "Hijacked"`);

    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect((await prisma.store.findUniqueOrThrow({ where: { singleton: true } })).tradingName).toBe(before.tradingName);
  });

  it('requires a sign-in to change the settings', async () => {
    const res = await gqlRequest(app, `mutation { updateStoreSettings(input: { tradingName: "Anon" }) { id } }`).expect(
      200,
    );

    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it(`gives ${SHOPPERS} concurrent orders distinct numbers from the store counter, at or above 10001`, async () => {
    const orders = app.get(OrdersService);
    const location = await prisma.pickupLocation.create({
      data: { name: 'Shop', address: '1 High St', city: 'Accra', state: 'Greater Accra', country: 'Ghana' },
    });
    const shopperIds = Array.from({ length: SHOPPERS }, (_, n) => `numbering_shopper_${n}`);
    await prisma.user.createMany({ data: shopperIds.map((id) => ({ id, email: `${id}@example.com` })) });
    for (const userId of shopperIds) {
      await prisma.cart.create({
        data: { userId, items: { create: { productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 } } },
      });
    }
    const counterBefore = (await prisma.store.findUniqueOrThrow({ where: { singleton: true } })).nextOrderNumber;

    const placed = await Promise.all(
      shopperIds.map((userId) =>
        placeOrderFromCart(orders, userId, {
          fulfillmentType: FulfillmentType.PICKUP,
          pickupLocationId: location.id,
          contactEmail: 'shopper@example.com',
          contactPhone: '+233244000000',
        }),
      ),
    );

    const numbers = placed.map((order) => order.orderNumber).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(SHOPPERS);
    expect(numbers[0]).toBeGreaterThanOrEqual(Math.max(10001, counterBefore));
    expect(numbers).toEqual(Array.from({ length: SHOPPERS }, (_, n) => counterBefore + n));
    const counterAfter = (await prisma.store.findUniqueOrThrow({ where: { singleton: true } })).nextOrderNumber;
    expect(counterAfter).toBe(counterBefore + SHOPPERS);
  });
});
