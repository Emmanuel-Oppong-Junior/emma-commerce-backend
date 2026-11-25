import { BadRequestException } from '@nestjs/common';
import { createAuditServiceMock } from '../../test/helpers/audit.helper';
import { FEATURES_CACHE_KEY, FEATURES_CACHE_TTL_MS, StoreFeaturesService } from './store-features.service';
import { resolveFeatures, StoreFeatureKey } from './store-feature-registry';

function db(rows: { key: StoreFeatureKey; enabled: boolean }[] = [], cashOnDeliveryEnabled = true) {
  return {
    storeFeature: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(
        async ({ where }: { where: { key: StoreFeatureKey } }) => rows.find((row) => row.key === where.key) ?? null,
      ),
      upsert: jest.fn(),
    },
    store: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'store1', cashOnDeliveryEnabled }),
      update: jest.fn(),
    },
  };
}

function build(rows: { key: StoreFeatureKey; enabled: boolean }[] = [], cached: string | null = null) {
  const prisma = db(rows);
  const tx = db(rows);
  const audit = createAuditServiceMock();
  audit.record.mockImplementation(async (change, entry) => {
    const result = await change(tx as never);
    await audit.log(entry(result), tx as never);
    return result;
  });
  const redis = { get: jest.fn().mockResolvedValue(cached), set: jest.fn(), del: jest.fn() };
  const service = new StoreFeaturesService(prisma as never, audit as never, redis as never);
  return { service, prisma, tx, audit, redis };
}

describe('StoreFeaturesService (P8-F)', () => {
  it('resolves every switchable feature from its row, else the default', () => {
    expect(resolveFeatures([{ key: 'REVIEWS', enabled: false }])).toMatchObject({ REVIEWS: false, LOYALTY: true });
    expect(resolveFeatures([])).not.toHaveProperty('CASH_ON_DELIVERY');
  });

  it('reads the switches from the database on a cache miss and caches them briefly in Redis', async () => {
    const { service, prisma, redis } = build([{ key: 'WISHLIST', enabled: false }]);

    await expect(service.isEnabled('WISHLIST')).resolves.toBe(false);
    await expect(service.isEnabled('REVIEWS')).resolves.toBe(true);

    expect(prisma.storeFeature.findMany).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith(
      FEATURES_CACHE_KEY,
      expect.stringContaining('"WISHLIST":false'),
      'PX',
      FEATURES_CACHE_TTL_MS,
    );
  });

  it('serves a cached value without the database, filling features the cached value lacks', async () => {
    const { service, prisma } = build([], JSON.stringify({ WISHLIST: false }));

    await expect(service.isEnabled('WISHLIST')).resolves.toBe(false);
    await expect(service.isEnabled('RETURNS')).resolves.toBe(true);
    expect(prisma.storeFeature.findMany).not.toHaveBeenCalled();
  });

  it('checks on the caller transaction without the cache', async () => {
    const { service, tx, redis } = build([{ key: 'LOYALTY', enabled: false }]);

    await expect(service.isEnabledIn(tx as never, 'LOYALTY')).resolves.toBe(false);
    await expect(service.isEnabledIn(tx as never, 'REFERRALS')).resolves.toBe(true);
    await expect(service.assertEnabled('LOYALTY', tx as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('refuses with FEATURE_DISABLED and the feature key', async () => {
    const { service } = build([{ key: 'RETURNS', enabled: false }]);

    await expect(service.assertEnabled('RETURNS')).rejects.toMatchObject({
      response: { extensions: { reason: 'FEATURE_DISABLED', feature: 'RETURNS' } },
    });
    await expect(service.assertEnabled('REVIEWS')).resolves.toBeUndefined();
  });

  it('switches a feature on its row, audits before and after on the same transaction, then clears the cache', async () => {
    const { service, tx, audit, redis } = build([{ key: 'REVIEWS', enabled: true }]);

    await expect(service.set('REVIEWS', false, 'owner1')).resolves.toMatchObject({ key: 'REVIEWS', enabled: false });

    expect(tx.storeFeature.upsert).toHaveBeenCalledWith({
      where: { storeId_key: { storeId: 'store1', key: 'REVIEWS' } },
      create: { storeId: 'store1', key: 'REVIEWS', enabled: false, updatedById: 'owner1' },
      update: { enabled: false, updatedById: 'owner1' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      {
        entity: 'StoreFeature',
        entityId: 'REVIEWS',
        action: 'UPDATE',
        userId: 'owner1',
        details: { storeId: 'store1', changes: { enabled: { from: true, to: false } } },
      },
      tx,
    );
    expect(redis.del).toHaveBeenCalledWith(FEATURES_CACHE_KEY);
    expect(audit.record.mock.invocationCallOrder[0]).toBeLessThan(redis.del.mock.invocationCallOrder[0]);
  });

  it('switches cash on delivery through the Store payment method column, never a feature row', async () => {
    const { service, tx, audit } = build();

    await service.set('CASH_ON_DELIVERY', false, 'owner1');

    expect(tx.store.update).toHaveBeenCalledWith({
      where: { singleton: true },
      data: { cashOnDeliveryEnabled: false },
    });
    expect(tx.storeFeature.upsert).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'CASH_ON_DELIVERY',
        details: expect.objectContaining({ changes: { enabled: { from: true, to: false } } }),
      }),
      tx,
    );
  });

  it('lists every feature with cash on delivery read from the Store', async () => {
    const { service, prisma } = build([{ key: 'GUEST_CHECKOUT', enabled: false }]);
    prisma.store.findFirstOrThrow.mockResolvedValue({ cashOnDeliveryEnabled: false });

    const list = await service.list();

    expect(list.map((feature) => feature.key)).toEqual(Object.values(StoreFeatureKey));
    expect(list.find((feature) => feature.key === 'GUEST_CHECKOUT')?.enabled).toBe(false);
    expect(list.find((feature) => feature.key === 'CASH_ON_DELIVERY')?.enabled).toBe(false);
    expect(list.find((feature) => feature.key === 'LOYALTY')?.enabled).toBe(true);
  });
});
