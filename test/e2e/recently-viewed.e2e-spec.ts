import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser, signUpUser } from '../helpers/auth.helper';

// Recently viewed (P6-G.3): explicit recording, latest first, one entry per product, at most 20, hidden products left out.

type GqlResult = { data?: Record<string, any>; errors?: { message: string; extensions: { code: string } }[] };

describe('Recently viewed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let otherToken: string;

  const gql = async (query: string, token?: string): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;
  const view = (productId: string, token = userToken) =>
    gql(`mutation { recordProductView(productId: "${productId}") }`, token);
  const recent = async (token = userToken, args = '') =>
    ((await gql(`{ recentlyViewed${args} { id } }`, token)).data!.recentlyViewed as { id: string }[]).map((p) => p.id);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    otherToken = (await signUpUser(app, { email: 'browser@rv.test', password: 'Str0ng!Passw0rd', name: 'Yaw Boateng' }))
      .accessToken;
    await prisma.product.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({
        id: `rv_prod_${String(i + 1).padStart(2, '0')}`,
        name: `Viewed ${i + 1}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED' as const,
      })),
    });
  });

  afterAll(() => app.close());

  it('needs a signed-in user and a public product', async () => {
    expect(codeOf(await view('seed_prod1', ''))).toBe('UNAUTHENTICATED');
    expect(codeOf(await gql(`{ recentlyViewed { id } }`))).toBe('UNAUTHENTICATED');
    expect(codeOf(await view('seed_prod_draft'))).toBe('NOT_FOUND');
    expect(codeOf(await view('seed_prod_inactive'))).toBe('NOT_FOUND');
    expect(codeOf(await view('no_such_product'))).toBe('NOT_FOUND');
    expect(await recent()).toEqual([]);
  });

  it('lists views latest first, one entry per product, separately per user', async () => {
    await view('seed_prod1');
    await view('seed_prod2');
    await view('seed_prod1');
    await view('seed_prod2', otherToken);

    expect(await recent()).toEqual(['seed_prod1', 'seed_prod2']);
    expect(await recent(otherToken)).toEqual(['seed_prod2']);
    expect(await recent(userToken, '(limit: 1)')).toEqual(['seed_prod1']);
    expect(codeOf(await gql(`{ recentlyViewed(limit: 21) { id } }`, userToken))).toBe('BAD_REQUEST');
  });

  it('keeps only the latest 20 distinct products', async () => {
    for (let i = 1; i <= 22; i += 1) {
      expect((await view(`rv_prod_${String(i).padStart(2, '0')}`)).data!.recordProductView).toBe(true);
    }

    const ids = await recent();
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('rv_prod_22');
    expect(ids[19]).toBe('rv_prod_03');
    expect(await prisma.recentlyViewedProduct.count({ where: { user: { email: 'user@example.com' } } })).toBe(20);
  });

  it('stays within 20 when views are recorded concurrently', async () => {
    await Promise.all(['seed_prod1', 'seed_prod2', 'rv_prod_01', 'rv_prod_02'].map((id) => view(id)));

    expect(await prisma.recentlyViewedProduct.count({ where: { user: { email: 'user@example.com' } } })).toBe(20);
  });

  it('leaves out products that are no longer on sale', async () => {
    await view('rv_prod_10');
    await prisma.product.update({ where: { id: 'rv_prod_10' }, data: { status: 'ARCHIVED' } });
    await prisma.product.update({ where: { id: 'rv_prod_11' }, data: { isActive: false } });

    const ids = await recent();
    expect(ids).not.toContain('rv_prod_10');
    expect(ids).not.toContain('rv_prod_11');
  });
});
