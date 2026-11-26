import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CDN_PURGER, CdnPurger } from '../../src/cdn/cdn-purger';
import { PurgeRequest } from '../../src/cdn/purge-plan';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, SeedResult, setStock } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';
import { createPromotion } from '../helpers/promotion.helper';

// Event-driven CDN invalidation (P9-C): catalogue writes record catalogue.changed.v1 in their own transaction (database
// triggers), nothing on rollback; the worker coalesces the keys and sends them through the CdnPurger (logging adapter).

async function waitUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

describe('CDN purges on catalogue changes (P9-C, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seed: SeedResult;

  const catalogueEvents = async () =>
    (await prisma.outboxEvent.findMany({ where: { type: 'catalogue.changed.v1' }, orderBy: { createdAt: 'asc' } })).map(
      (event) => event.payload as { reason: string; ids: string[] | null },
    );
  const clearEvents = () => prisma.outboxEvent.deleteMany();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    seed = await seedMinimal(prisma);
  });

  beforeEach(clearEvents);

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('recording', () => {
    it('records the change with the transaction that makes it', async () => {
      await prisma.product.update({ where: { id: seed.productIds.prod1 }, data: { name: 'Renamed product' } });
      expect(await catalogueEvents()).toEqual([{ reason: 'product', ids: [seed.productIds.prod1] }]);
    });

    it('records nothing when the transaction rolls back', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.product.update({ where: { id: seed.productIds.prod1 }, data: { name: 'Never committed' } });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      expect(await catalogueEvents()).toEqual([]);
    });

    it('records one event per statement, naming every changed product', async () => {
      await prisma.variant.updateMany({
        where: { id: { in: [seed.variantIds.prod1, seed.variantIds.prod2] } },
        data: { weightGrams: 250 },
      });
      const events = await catalogueEvents();
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('product');
      expect([...events[0].ids!].sort()).toEqual([seed.productIds.prod1, seed.productIds.prod2].sort());
    });

    it('records stock only when it crosses in or out of availability', async () => {
      await setStock(prisma, seed.variantIds.prod1, 40);
      expect(await catalogueEvents()).toEqual([]);

      await setStock(prisma, seed.variantIds.prod1, 0);
      expect(await catalogueEvents()).toEqual([{ reason: 'stock', ids: [seed.productIds.prod1] }]);

      await clearEvents();
      await setStock(prisma, seed.variantIds.prod1, 50);
      expect(await catalogueEvents()).toEqual([{ reason: 'stock', ids: [seed.productIds.prod1] }]);
    });

    it('ignores order-number and promotion-usage counters, but not a promotion switched on', async () => {
      const promotion = await createPromotion(prisma, {
        scope: 'PRODUCT',
        type: 'PERCENT',
        value: '10',
        targetIds: [seed.productIds.prod1],
      });
      await clearEvents();

      await prisma.store.updateMany({ data: { nextOrderNumber: { increment: 1 } } });
      await prisma.promotion.update({ where: { id: promotion.id }, data: { usedCount: { increment: 1 } } });
      expect(await catalogueEvents()).toEqual([]);

      await prisma.promotion.update({ where: { id: promotion.id }, data: { isActive: false } });
      expect(await catalogueEvents()).toEqual([{ reason: 'promotion', ids: null }]);
    });
  });

  describe('purging', () => {
    let worker: INestApplicationContext;
    let purges: PurgeRequest[];

    beforeAll(async () => {
      // The recording tests' events would otherwise reach the new worker's relay first.
      await clearEvents();
      worker = await createTestWorker();
      await clearQueues(worker);
      purges = [];
      jest.spyOn(worker.get<CdnPurger>(CDN_PURGER), 'purge').mockImplementation(async (request) => {
        purges.push(request);
      });
    });

    afterAll(async () => {
      await clearQueues(worker);
      await worker.close();
    });

    it('purges the brand, its family and slug resolution once after a staff edit commits', async () => {
      const adminToken = await signInAdmin(app);
      const res = await gqlRequest(
        app,
        `mutation { updateBrand(id: "${seed.brandId}", input: { description: "New description" }) { id } }`,
        undefined,
        adminToken,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();

      const purge = await waitUntil(async () => purges.find((request) => request.reasons.includes('brand')));

      expect(purge.keys).toEqual(expect.arrayContaining([`brand:${seed.brandId}`, 'brands', 'slugs']));
      await sleep(1_000);
      expect(purges.filter((request) => request.keys.includes(`brand:${seed.brandId}`))).toHaveLength(1);
    });

    it('coalesces a burst of changes into one purge per window', async () => {
      purges.length = 0;
      for (const name of ['One', 'Two', 'Three']) {
        await prisma.product.update({ where: { id: seed.productIds.prod2 }, data: { name } });
      }
      await setStock(prisma, seed.variantIds.prod2, 0);

      const purge = await waitUntil(async () => purges.find((request) => request.reasons.includes('product')));

      expect(purge).toEqual({
        keys: [`product:${seed.productIds.prod2}`, 'products', 'slugs'],
        reasons: ['product', 'stock'],
      });
      await sleep(1_000);
      expect(purges).toHaveLength(1);
    });
  });
});
