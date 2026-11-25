import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

const MINE = `{ myNotificationPreferences { category channel enabled locked } }`;
const UPDATE = `mutation Update($input: UpdateNotificationPreferenceInput!) {
  updateNotificationPreference(input: $input) { category channel enabled locked }
}`;
const RECORD = `mutation Record($input: RecordCustomerConsentInput!) {
  recordCustomerConsent(input: $input) { category channel enabled }
}`;
const HISTORY = `query History($userId: ID!) {
  customerConsentHistory(userId: $userId) { category channel action source actorId }
}`;

type Preference = { category: string; channel: string; enabled: boolean; locked: boolean };

describe('Notification preferences and consent (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;

  const update = (input: object, token = userToken) => gqlRequest(app, UPDATE, { input }, token).expect(200);
  const marketing = (preferences: Preference[], channel: string) =>
    preferences.find((p) => p.category === 'MARKETING' && p.channel === channel)?.enabled;
  const ledger = () =>
    prisma.consentEvent.findMany({ where: { userId: 'seed_user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('shows transactional messages on and locked, marketing off until the customer opts in', async () => {
    const res = await gqlRequest(app, MINE, {}, userToken).expect(200);

    expect(res.body.errors).toBeUndefined();
    const preferences = res.body.data.myNotificationPreferences as Preference[];
    expect(preferences.filter((p) => p.category === 'TRANSACTIONAL').every((p) => p.enabled && p.locked)).toBe(true);
    expect(preferences.filter((p) => p.category === 'MARKETING').map((p) => [p.channel, p.enabled])).toEqual([
      ['EMAIL', false],
      ['SMS', false],
    ]);
  });

  it('refuses switching transactional messages off with a reason, and records nothing', async () => {
    const res = await update({ category: 'TRANSACTIONAL', channel: 'EMAIL', enabled: false });

    expect(res.body.errors[0].extensions).toMatchObject({ code: 'BAD_REQUEST', reason: 'TRANSACTIONAL_ALWAYS_ON' });
    expect(await ledger()).toEqual([]);
  });

  it('records an opt-in and a withdrawal in the ledger, once each, with their source', async () => {
    const granted = await update({ category: 'MARKETING', channel: 'EMAIL', enabled: true, source: 'CHECKOUT' });
    expect(marketing(granted.body.data.updateNotificationPreference, 'EMAIL')).toBe(true);
    // Repeating the same choice is a no-op: no second ledger entry.
    await update({ category: 'MARKETING', channel: 'EMAIL', enabled: true });
    const withdrawn = await update({ category: 'MARKETING', channel: 'EMAIL', enabled: false });
    expect(marketing(withdrawn.body.data.updateNotificationPreference, 'EMAIL')).toBe(false);

    expect((await ledger()).map(({ channel, action, source }) => [channel, action, source])).toEqual([
      ['EMAIL', 'GRANTED', 'CHECKOUT'],
      ['EMAIL', 'WITHDRAWN', 'ACCOUNT_SETTINGS'],
    ]);
  });

  it('needs a verified phone before opting in to marketing SMS', async () => {
    const refused = await update({ category: 'MARKETING', channel: 'SMS', enabled: true });
    expect(refused.body.errors[0].extensions.reason).toBe('PHONE_NOT_VERIFIED');

    await verifyPhoneForCod(prisma);
    const granted = await update({ category: 'MARKETING', channel: 'SMS', enabled: true });
    expect(granted.body.errors).toBeUndefined();
    expect(marketing(granted.body.data.updateNotificationPreference, 'SMS')).toBe(true);
  });

  it('refuses a customer naming a staff or email-link source, and marketing in the in-app feed', async () => {
    const staffSource = await update({
      category: 'MARKETING',
      channel: 'EMAIL',
      enabled: true,
      source: 'STAFF_REQUEST',
    });
    expect(staffSource.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    const inApp = await update({ category: 'MARKETING', channel: 'IN_APP', enabled: true });
    expect(inApp.body.errors[0].extensions.reason).toBe('CHANNEL_NOT_AVAILABLE');
  });

  it("lets staff with user.manage record a customer's request, and read the ledger with user.view", async () => {
    const recorded = await gqlRequest(
      app,
      RECORD,
      { input: { userId: 'seed_user', channel: 'SMS', granted: false } },
      adminToken,
    ).expect(200);
    expect(recorded.body.errors).toBeUndefined();
    expect(marketing(recorded.body.data.recordCustomerConsent, 'SMS')).toBe(false);

    const history = await gqlRequest(app, HISTORY, { userId: 'seed_user' }, adminToken).expect(200);
    expect(history.body.data.customerConsentHistory[0]).toEqual({
      category: 'MARKETING',
      channel: 'SMS',
      action: 'WITHDRAWN',
      source: 'STAFF_REQUEST',
      actorId: 'seed_admin',
    });

    const customer = await gqlRequest(app, HISTORY, { userId: 'seed_user' }, userToken).expect(200);
    expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('keeps the ledger append-only', async () => {
    const [first] = await ledger();
    await expect(
      prisma.consentEvent.update({ where: { id: first.id }, data: { source: 'EMAIL_LINK' } }),
    ).rejects.toThrow('ConsentEvent is append-only');
    await expect(prisma.consentEvent.delete({ where: { id: first.id } })).rejects.toThrow(
      'ConsentEvent is append-only',
    );
  });
});
