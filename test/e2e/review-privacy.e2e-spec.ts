import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';

describe('Reviewer privacy on the public catalogue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.review.create({
      data: { id: 'seed_review', score: 5, comment: 'Great', productId: 'seed_prod1', userId: 'seed_user' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows an anonymous visitor only the reviewer display name', async () => {
    const res = await gqlRequest(
      app,
      `{ product(productId: "seed_prod1") { reviews { score user { displayName } } } }`,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.product.reviews).toEqual([{ score: 5, user: { displayName: 'Regular U.' } }]);
  });

  it.each(['email', 'phoneNumber', 'addresses { street }', 'orders { id }'])(
    'rejects an anonymous request for reviewer %s',
    async (selection) => {
      const res = await gqlRequest(app, `{ product(productId: "seed_prod1") { reviews { user { ${selection} } } } }`);

      expect(res.body.errors?.[0]?.message).toMatch(/Cannot query field/);
      expect(JSON.stringify(res.body)).not.toContain('user@example.com');
    },
  );
});
