import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, stockOf } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { quoteHashFor } from '../helpers/checkout.helper';

const M = '{ amount currency }';

// VAR-01 accept criterion: variants are purchasable at their own price and stock, end to end.
describe('Buying variants (SKUs) end to end (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;
  let shirtId: string;
  let variantIds: Record<string, string>;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const addToCart = (variantId: string, quantity: number, token = customerToken) =>
    gql(
      `mutation { addToCart(input: { variantId: "${variantId}", quantity: ${quantity} }) { items { variantId quantity originalPrice ${M} } } }`,
      token,
    );
  const createOrder = async (token = customerToken, couponCode?: string) =>
    gql(
      `mutation($coupon: String, $quoteHash: String!) { createOrder(input: { fulfillmentType: PICKUP, pickupLocationId: "sku_pickup", contactEmail: "buyer@example.com", contactPhone: "+233244000000", couponCode: $coupon, quoteHash: $quoteHash }) {
        id subtotal ${M} discountTotal ${M} grandTotal ${M} adjustments { type amount ${M} }
        items { variantId sku optionValues quantity unitListPrice ${M} unitDiscount ${M} lineTotal ${M} variant { id } }
      } }`,
      token,
      {
        coupon: couponCode ?? null,
        quoteHash: await quoteHashFor(app, token, {
          fulfillmentType: 'PICKUP',
          pickupLocationId: 'sku_pickup',
          couponCode: couponCode ?? null,
        }),
      },
    );
  const stock = async (variantId: string) => (await stockOf(prisma, variantId)).available;
  const clearCarts = () => prisma.cartItem.deleteMany();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: { id: 'sku_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
    await prisma.tax.create({ data: { name: 'VAT sku test', rate: '0.20' } });
    adminToken = await signInAdmin(app);
    customerToken = await signInUser(app);

    const created = await gql(
      `mutation($input: CreateProductInput!) { createProduct(createProductInput: $input) { id variants { id sku optionValues price ${M} available } } }`,
      adminToken,
      {
        input: {
          name: 'Kente shirt',
          isActive: true,
          status: 'PUBLISHED',
          isTaxable: true,
          productTypeId: 'product_type_apparel',
          variants: [
            { optionValues: { size: 'M', colour: 'Gold' }, basePrice: '100.00', quantity: 5, sku: 'KENTE-M' },
            { optionValues: { size: 'L', colour: 'Gold' }, basePrice: '150.00', quantity: 1, sku: 'KENTE-L' },
          ],
        },
      },
    );
    expect(created.body.errors).toBeUndefined();
    shirtId = created.body.data.createProduct.id;
    variantIds = Object.fromEntries(
      created.body.data.createProduct.variants.map((v: { id: string; sku: string }) => [v.sku, v.id]),
    );
  });

  afterEach(clearCarts);
  afterAll(() => app.close());

  it('createProduct makes each variant its own priced SKU (tax added) with its initial stock logged', async () => {
    const variants = await prisma.variant.findMany({ where: { productId: shirtId }, orderBy: { sku: 'asc' } });
    const logs = await prisma.stockMovement.findMany({
      where: { variant: { productId: shirtId } },
      orderBy: { onHandDelta: 'asc' },
    });
    const stocked = await Promise.all(variants.map((v) => stock(v.id)));

    expect(variants.map((v, i) => [v.sku, v.price?.toFixed(2), v.basePrice?.toFixed(2), stocked[i]])).toEqual([
      ['KENTE-L', '180.00', '150.00', 1],
      ['KENTE-M', '120.00', '100.00', 5],
    ]);
    expect(logs.map((l) => [l.variantId, l.reason, l.onHandDelta, l.note])).toEqual([
      [variantIds['KENTE-L'], 'RECEIPT', 1, 'Initial stock'],
      [variantIds['KENTE-M'], 'RECEIPT', 5, 'Initial stock'],
    ]);
  });

  it('shows the price range and stock of the active variants on the product and filters on them in SQL', async () => {
    const res = await gql(
      `{ product(productId: "${shirtId}") { priceRange { min ${M} max ${M} } totalStock inStock variants { sku } } }`,
    );
    const cheap = await gql(`{ products(filterArgs: { priceMax: "130.00" }) { edges { node { id } } } }`);
    const pricey = await gql(
      `{ products(filterArgs: { priceMin: "170.00", priceMax: "190.00" }) { edges { node { id } } } }`,
    );

    expect(res.body.data.product).toMatchObject({
      priceRange: { min: ghs('120.00'), max: ghs('180.00') },
      totalStock: 6,
      inStock: true,
    });
    expect(cheap.body.data.products.edges.map((e: { node: { id: string } }) => e.node.id)).toContain(shirtId);
    expect(pricey.body.data.products.edges.map((e: { node: { id: string } }) => e.node.id)).toEqual([shirtId]);
  });

  it("sells the chosen variant at its own price, applies a product discount, a coupon, snapshots the SKU and takes that variant's stock", async () => {
    const discount = await prisma.discount.create({
      data: {
        name: 'Shirt week',
        type: 'PERCENTAGE',
        value: 10,
        isActive: true,
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 86_400_000),
        products: { connect: { id: shirtId } },
      },
    });
    await prisma.coupon.create({ data: { code: 'SKU10', discountType: 'FLAT', value: 10 } });
    try {
      const cart = await addToCart(variantIds['KENTE-M'], 2);
      const order = await createOrder(customerToken, 'SKU10');

      expect(cart.body.data.addToCart.items).toEqual([
        { variantId: variantIds['KENTE-M'], quantity: 2, originalPrice: ghs('120.00') },
      ]);
      expect(order.body.errors).toBeUndefined();
      const placed = order.body.data.createOrder;
      expect(placed.items).toEqual([
        {
          variantId: variantIds['KENTE-M'],
          sku: 'KENTE-M',
          optionValues: { size: 'M', colour: 'Gold' },
          quantity: 2,
          unitListPrice: ghs('120.00'),
          unitDiscount: ghs('12.00'),
          lineTotal: ghs('216.00'),
          variant: { id: variantIds['KENTE-M'] },
        },
      ]);
      expect(placed).toMatchObject({
        subtotal: ghs('240.00'),
        discountTotal: ghs('34.00'),
        grandTotal: ghs('206.00'),
      });
      expect(placed.adjustments).toEqual(
        expect.arrayContaining([
          { type: 'DISCOUNT', amount: ghs('-24.00') },
          { type: 'COUPON', amount: ghs('-10.00') },
        ]),
      );
      expect(await stock(variantIds['KENTE-M'])).toBe(3);
      expect(await stock(variantIds['KENTE-L'])).toBe(1);
      const deduction = await prisma.stockMovement.findFirst({
        where: { reason: 'RESERVE', variant: { productId: shirtId } },
      });
      expect(deduction).toMatchObject({ variantId: variantIds['KENTE-M'], reservedDelta: 2, refId: placed.id });

      const cancelled = await gql(`mutation { cancelOrder(orderId: "${placed.id}") { status } }`, customerToken);

      expect(cancelled.body.data.cancelOrder.status).toBe('CANCELLED');
      expect(await stock(variantIds['KENTE-M'])).toBe(5);
      const restore = await prisma.stockMovement.findFirst({
        where: { reason: 'RELEASE', variant: { productId: shirtId } },
      });
      expect(restore).toMatchObject({ variantId: variantIds['KENTE-M'], reservedDelta: -2, refId: placed.id });
    } finally {
      await prisma.discount.delete({ where: { id: discount.id } });
    }
  });

  it('sells the last unit of a variant once when two customers check out at the same time', async () => {
    const other = await signUpUser(app, { email: 'second-buyer@example.com', password: 'Passw0rd!x', name: 'Second' });
    await addToCart(variantIds['KENTE-L'], 1);
    await addToCart(variantIds['KENTE-L'], 1, other.accessToken);

    const results = await Promise.all([createOrder(customerToken), createOrder(other.accessToken)]);

    const succeeded = results.filter((res) => !res.body.errors);
    const failed = results.filter((res) => res.body.errors);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].body.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(await stock(variantIds['KENTE-L'])).toBe(0);
    expect(await prisma.stockMovement.count({ where: { variantId: variantIds['KENTE-L'], reason: 'RESERVE' } })).toBe(
      1,
    );
  });

  it('refuses an archived variant at addToCart, and at checkout when archived after it was added', async () => {
    const m = variantIds['KENTE-M'];
    await addToCart(m, 1);
    await prisma.variant.update({ where: { id: m }, data: { isActive: false } });
    try {
      const add = await addToCart(m, 1);
      const order = await createOrder();

      expect(add.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(add.body.errors[0].message).toBe('"Kente shirt" (KENTE-M) is no longer sold');
      expect(order.body.errors[0].message).toBe('"Kente shirt" (KENTE-M) is no longer sold; remove it from the cart');
      expect(await stock(m)).toBe(5);
    } finally {
      await prisma.variant.update({ where: { id: m }, data: { isActive: true } });
    }
  });

  it('refuses a variant of an unpublished product', async () => {
    const res = await addToCart('seed_var_draft', 1);

    expect(res.body.errors[0].message).toBe('"Unreleased Tablet" (SEED-TAB-DRAFT) is not on sale');
  });

  it('needs a variant id: a product id is neither accepted as input nor found as a variant', async () => {
    const byProductField = await gqlRequest(
      app,
      `mutation { addToCart(input: { productId: "${shirtId}", quantity: 1 }) { id } }`,
      undefined,
      customerToken,
    );
    const productIdAsVariant = await addToCart(shirtId, 1);

    expect(byProductField.status).toBe(400);
    expect(productIdAsVariant.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('restocks and adjusts a variant through the logged paths only (restockProduct is gone)', async () => {
    const restock = await gql(
      `mutation { restockVariant(input: { variantId: "${variantIds['KENTE-L']}", quantity: 4, reason: "Delivery" }) { variantId reason onHandDelta } }`,
      adminToken,
    );
    const legacy = await gqlRequest(
      app,
      `mutation { restockProduct(input: { productId: "${shirtId}", quantity: 1 }) { id } }`,
      undefined,
      adminToken,
    );

    expect(restock.body.data.restockVariant).toEqual({
      variantId: variantIds['KENTE-L'],
      reason: 'RECEIPT',
      onHandDelta: 4,
    });
    expect(await stock(variantIds['KENTE-L'])).toBe(4);
    expect(legacy.status).toBe(400);
  });
});
