import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

const CREATE_ZONE = `mutation CreateZone($fee: Decimal!) {
  createShippingZone(input: { name: "Volta", cities: ["ho"], fee: $fee }) { fee { amount currency } }
}`;

describe('Money and Decimal on the GraphQL API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const codeOf = (res: { body: { errors?: { extensions?: { code?: string } }[] } }) =>
    res.body.errors?.[0]?.extensions?.code;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterEach(async () => {
    await prisma.shippingZone.deleteMany({ where: { name: 'Volta' } });
    await prisma.store.update({ where: { singleton: true }, data: { currency: 'GHS' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes a money input as a decimal string and returns it as Money with 2 decimal places', async () => {
    const res = await gqlRequest(app, CREATE_ZONE, { fee: '12.5' }, adminToken).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createShippingZone.fee).toEqual(ghs('12.50'));
    const zone = await prisma.shippingZone.findUniqueOrThrow({ where: { name: 'Volta' } });
    expect(zone.fee.toFixed(2)).toBe('12.50');
  });

  it.each([
    ['exponent notation', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['text', 'twelve'],
    ['more than 2 decimal places', '12.505'],
    ['a negative amount', '-1.00'],
    ['a JSON number', 12.5],
  ])('rejects %s in a variable with BAD_USER_INPUT and writes nothing', async (_name, fee) => {
    const res = await gqlRequest(app, CREATE_ZONE, { fee }, adminToken).expect(200);

    expect(codeOf(res)).toBe('BAD_USER_INPUT');
    expect(await prisma.shippingZone.count({ where: { name: 'Volta' } })).toBe(0);
  });

  it('rejects an invalid inline literal with BAD_USER_INPUT too', async () => {
    const res = await gqlRequest(
      app,
      `mutation { createShippingZone(input: { name: "Volta", cities: ["ho"], fee: 12.5 }) { id } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(codeOf(res)).toBe('BAD_USER_INPUT');
    expect(await prisma.shippingZone.count({ where: { name: 'Volta' } })).toBe(0);
  });

  it('labels amounts with the store currency', async () => {
    await prisma.store.update({ where: { singleton: true }, data: { currency: 'USD' } });

    const res = await gqlRequest(
      app,
      `{ product(productId: "seed_prod1") { variants { price { amount currency } } } }`,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.product.variants[0].price).toEqual({ amount: '999.99', currency: 'USD' });
  });

  it('returns a tax rate as a Decimal string', async () => {
    const res = await gqlRequest(
      app,
      `mutation { createTax(input: { name: "Money API levy", rate: "0.025" }) { rate } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createTax.rate).toBe('0.025');
    await prisma.tax.deleteMany({ where: { name: 'Money API levy' } });
  });
});
