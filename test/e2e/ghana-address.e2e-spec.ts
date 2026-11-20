import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser } from '../helpers/auth.helper';

const FULL_ADDRESS =
  'id recipientName phone region street city area landmark ghanaPostGps latitude longitude zipCode country';
const CREATE = `mutation CreateAddress($input: CreateAddressInput!) { createAddress(input: $input) { ${FULL_ADDRESS} } }`;
const UPDATE = `mutation UpdateAddress($addressId: String!, $input: UpdateAddressInput!) {
  updateAddress(addressId: $addressId, input: $input) { ${FULL_ADDRESS} }
}`;

const required = {
  recipientName: 'Kofi Boateng',
  phone: '024 412 3456',
  region: 'ASHANTI',
  street: '7 Prempeh II St',
  city: 'Kumasi',
};

describe('Ghana addresses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let otherAddressId: string;

  const createAddress = (input: Record<string, unknown>) => gqlRequest(app, CREATE, { input }, userToken);
  const updateAddress = (addressId: string, input: Record<string, unknown>) =>
    gqlRequest(app, UPDATE, { addressId, input }, userToken);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    const owner = await prisma.user.create({ data: { email: 'address.owner@example.com', role: 'USER' } });
    const otherAddress = await prisma.address.create({
      data: { ...required, phone: '+233244123456', region: 'ASHANTI', country: 'GH', userId: owner.id },
    });
    otherAddressId = otherAddress.id;
  });

  afterAll(() => app.close());

  it('creates an address with every field and returns recipient, phone, GhanaPostGPS and country normalised', async () => {
    const res = await createAddress({
      ...required,
      recipientName: '  Kofi Boateng ',
      area: 'Adum',
      landmark: 'Behind the Kejetia market',
      ghanaPostGps: 'ak 484 9321',
      latitude: 6.6885,
      longitude: -1.6244,
      zipCode: null,
      country: 'gh',
    }).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createAddress).toEqual({
      id: expect.any(String),
      recipientName: 'Kofi Boateng',
      phone: '+233244123456',
      region: 'ASHANTI',
      street: '7 Prempeh II St',
      city: 'Kumasi',
      area: 'Adum',
      landmark: 'Behind the Kejetia market',
      ghanaPostGps: 'AK-484-9321',
      latitude: 6.6885,
      longitude: -1.6244,
      zipCode: null,
      country: 'GH',
    });
  });

  it('defaults the country to GH and needs no zip code', async () => {
    const res = await createAddress(required).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createAddress).toMatchObject({ country: 'GH', zipCode: null, phone: '+233244123456' });
  });

  // The schema marks them non-null, so GraphQL validation refuses the document before any resolver runs.
  it.each(['region', 'recipientName', 'phone'])('rejects a new address without %s', async (field) => {
    const fields = Object.entries({ ...required, region: undefined })
      .filter(([name]) => name !== field && name !== 'region')
      .map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
    if (field !== 'region') fields.push('region: ASHANTI');
    const before = await prisma.address.count();

    const res = await gqlRequest(
      app,
      `mutation { createAddress(input: { ${fields.join(', ')} }) { id } }`,
      {},
      userToken,
    );

    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(res.body.errors[0].message).toContain(`.${field}"`);
    expect(await prisma.address.count()).toBe(before);
  });

  it.each([
    ['recipientName', '   '],
    ['phone', '+234 803 123 4567'],
    ['phone', ''],
    ['ghanaPostGps', 'Accra'],
    ['country', 'NG'],
    ['latitude', 5.6],
  ])('rejects an invalid %s (%p)', async (field, value) => {
    const res = await createAddress({ ...required, [field]: value }).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it.each(['street', 'city', 'region', 'recipientName', 'phone'])(
    'rejects an update setting the required field %s to null and keeps the address',
    async (field) => {
      const created = await createAddress(required).expect(200);
      const id = created.body.data.createAddress.id;

      const res = await updateAddress(id, { [field]: null }).expect(200);

      expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      const stored = await prisma.address.findUniqueOrThrow({ where: { id } });
      expect(stored[field as keyof typeof stored]).not.toBeNull();
      await prisma.address.delete({ where: { id } });
    },
  );

  it('clears optional fields set to null and normalises a changed phone', async () => {
    const created = await createAddress({
      ...required,
      area: 'Adum',
      landmark: 'Kejetia',
      ghanaPostGps: 'AK-484-9321',
      latitude: 6.6885,
      longitude: -1.6244,
      zipCode: '00233',
    }).expect(200);
    const id = created.body.data.createAddress.id;

    const res = await updateAddress(id, {
      phone: '00233 20 123 4567',
      area: null,
      landmark: null,
      ghanaPostGps: null,
      latitude: null,
      longitude: null,
      zipCode: null,
    }).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateAddress).toMatchObject({
      phone: '+233201234567',
      area: null,
      landmark: null,
      ghanaPostGps: null,
      latitude: null,
      longitude: null,
      zipCode: null,
      region: 'ASHANTI',
    });
  });

  it.each([
    ['read', 'query Q($addressId: String!) { address(addressId: $addressId) { id } }'],
    [
      'update',
      'mutation M($addressId: String!) { updateAddress(addressId: $addressId, input: { street: "Taken" }) { id } }',
    ],
    ['delete', 'mutation M($addressId: String!) { deleteAddress(addressId: $addressId) { id } }'],
  ])('answers NOT_FOUND to a %s of another customer’s address, without naming the caller', async (_, query) => {
    const res = await gqlRequest(app, query, { addressId: otherAddressId }, userToken).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
    expect(res.body.errors[0].message).toBe(`Address "${otherAddressId}" not found`);
    const stored = await prisma.address.findUniqueOrThrow({ where: { id: otherAddressId } });
    expect(stored.street).toBe('7 Prempeh II St');
  });
});
