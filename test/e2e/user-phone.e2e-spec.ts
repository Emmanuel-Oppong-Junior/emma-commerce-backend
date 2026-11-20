import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';

const UPDATE_MY_PROFILE = `mutation Update($input: UpdateUserInput!) {
  updateMyProfile(updateMyProfileInput: $input) { id phoneNumber }
}`;
const UPDATE_USER = `mutation Update($id: String!, $input: UpdateUserInput!) {
  updateUser(id: $id, updateUserInput: $input) { id phoneNumber }
}`;
const CREATE_USER = `mutation Create($input: CreateUserInput!) { createUser(createUserInput: $input) { id phoneNumber } }`;

const TAKEN = '+233201112222';

describe('User phone numbers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let superAdminToken: string;

  const storedPhone = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneNumber;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.user.create({ data: { id: 'phone_owner', email: 'phone.owner@example.com', phoneNumber: TAKEN } });
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
    superAdminToken = await signInSuperAdmin(app);
  });

  afterAll(() => app.close());

  it('stores a profile phone number in E.164 form', async () => {
    const res = await gqlRequest(app, UPDATE_MY_PROFILE, { input: { phoneNumber: '024 412 3456' } }, userToken).expect(
      200,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateMyProfile.phoneNumber).toBe('+233244123456');
    expect(await storedPhone('seed_user')).toBe('+233244123456');
  });

  it.each(['', '+44 20 7946 0958', '12345'])('rejects the profile phone number %p', async (phoneNumber) => {
    const res = await gqlRequest(app, UPDATE_MY_PROFILE, { input: { phoneNumber } }, userToken).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(await storedPhone('seed_user')).toBe('+233244123456');
  });

  it("answers CONFLICT when the profile phone number is another user's, in any format", async () => {
    const res = await gqlRequest(app, UPDATE_MY_PROFILE, { input: { phoneNumber: '020 111 2222' } }, userToken).expect(
      200,
    );

    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(res.body.errors[0].message).toBe('Phone number is already in use');
    expect(await storedPhone('seed_user')).toBe('+233244123456');
  });

  it('clears the profile phone number with null', async () => {
    const res = await gqlRequest(app, UPDATE_MY_PROFILE, { input: { phoneNumber: null } }, userToken).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateMyProfile.phoneNumber).toBeNull();
    expect(await storedPhone('seed_user')).toBeNull();
  });

  it("answers CONFLICT when an admin gives a user another user's phone number, and records nothing", async () => {
    const auditsBefore = await prisma.auditLog.count({ where: { entity: 'User', entityId: 'seed_user' } });

    const res = await gqlRequest(
      app,
      UPDATE_USER,
      { id: 'seed_user', input: { phoneNumber: '233201112222' } },
      adminToken,
    ).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(res.body.errors[0].message).toBe('Phone number is already in use');
    expect(await storedPhone('seed_user')).toBeNull();
    expect(await prisma.auditLog.count({ where: { entity: 'User', entityId: 'seed_user' } })).toBe(auditsBefore);
  });

  it('normalises a phone number an admin sets', async () => {
    const res = await gqlRequest(
      app,
      UPDATE_USER,
      { id: 'seed_user', input: { phoneNumber: '00233 50 999 8888' } },
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateUser.phoneNumber).toBe('+233509998888');
  });

  it("answers CONFLICT when a new account is created with another user's phone number", async () => {
    const res = await gqlRequest(
      app,
      CREATE_USER,
      {
        input: {
          name: 'New Person',
          email: 'new.person@example.com',
          password: 'NewPerson@123',
          phoneNumber: '+233 20 111 2222',
          isActive: true,
          role: 'USER',
        },
      },
      superAdminToken,
    ).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(res.body.errors[0].message).toBe('Phone number is already in use');
    expect(await prisma.user.findUnique({ where: { email: 'new.person@example.com' } })).toBeNull();
  });
});
