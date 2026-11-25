import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AuditService } from '../commons/audit.service';
import { featureDisabled } from './require-feature';
import {
  resolveFeatures,
  STORE_FEATURE_KEYS,
  STORE_FEATURES,
  StoreFeatureKey,
  SwitchableFeature,
} from './store-feature-registry';

type Db = Prisma.TransactionClient;

export const FEATURES_CACHE_KEY = 'store-features:v1';
/**
 * Bounds how long another instance can serve a value read just before a change committed: a change deletes the key,
 * but a read that started earlier may write the old value back afterwards.
 */
export const FEATURES_CACHE_TTL_MS = 5_000;

const THE_STORE = { singleton: true } as const;

export interface StoreFeatureView {
  key: StoreFeatureKey;
  enabled: boolean;
  description: string;
}

/**
 * Store-level feature switches (P8-F). Request-path checks read every switch at once from a short Redis cache shared by
 * all instances (deleted on every change); checks inside a business transaction read the row on that transaction.
 */
@Injectable()
export class StoreFeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async isEnabled(feature: SwitchableFeature): Promise<boolean> {
    return (await this.switches())[feature];
  }

  /** The stored value on the caller's transaction, uncached, for decisions committed with it. */
  async isEnabledIn(db: Db, feature: SwitchableFeature): Promise<boolean> {
    const row = await db.storeFeature.findFirst({
      where: { key: feature, store: THE_STORE },
      select: { enabled: true },
    });
    return row?.enabled ?? STORE_FEATURES[feature].defaultEnabled;
  }

  /** BAD_REQUEST with reason FEATURE_DISABLED while `feature` is off; read on `db` when given, else from the cache. */
  async assertEnabled(feature: SwitchableFeature, db?: Db): Promise<void> {
    const enabled = db ? await this.isEnabledIn(db, feature) : await this.isEnabled(feature);
    if (!enabled) throw featureDisabled(feature);
  }

  async list(): Promise<StoreFeatureView[]> {
    const [switches, cashOnDelivery] = await Promise.all([this.switches(), this.cashOnDeliveryEnabled(this.prisma)]);
    return STORE_FEATURE_KEYS.map((key) =>
      this.viewOf(key, key === StoreFeatureKey.CASH_ON_DELIVERY ? cashOnDelivery : switches[key]),
    );
  }

  /**
   * Switches a feature on or off, audited with before and after; cash on delivery writes the Store payment method
   * column. Nothing the feature stored is deleted, so switching it back on restores it as it was.
   */
  async set(key: StoreFeatureKey, enabled: boolean, actorId: string): Promise<StoreFeatureView> {
    await this.audit.record(
      async (tx) => {
        const store = await tx.store.findFirstOrThrow({ where: THE_STORE, select: { id: true } });
        if (key === StoreFeatureKey.CASH_ON_DELIVERY) {
          const was = await this.cashOnDeliveryEnabled(tx);
          await tx.store.update({ where: THE_STORE, data: { cashOnDeliveryEnabled: enabled } });
          return { storeId: store.id, before: was };
        }
        const was = await this.isEnabledIn(tx, key);
        await tx.storeFeature.upsert({
          where: { storeId_key: { storeId: store.id, key } },
          create: { storeId: store.id, key, enabled, updatedById: actorId },
          update: { enabled, updatedById: actorId },
        });
        return { storeId: store.id, before: was };
      },
      (change) => ({
        entity: 'StoreFeature',
        entityId: key,
        action: 'UPDATE',
        userId: actorId,
        details: { storeId: change.storeId, changes: { enabled: { from: change.before, to: enabled } } },
      }),
    );
    await this.redis.del(FEATURES_CACHE_KEY);
    return this.viewOf(key, enabled);
  }

  private async switches(): Promise<Record<SwitchableFeature, boolean>> {
    const cached = await this.redis.get(FEATURES_CACHE_KEY);
    // Merged over the defaults: a value cached by an instance that predates a new feature lacks its key.
    if (cached !== null)
      return { ...resolveFeatures([]), ...(JSON.parse(cached) as Record<SwitchableFeature, boolean>) };
    const rows = await this.prisma.storeFeature.findMany({
      where: { store: THE_STORE },
      select: { key: true, enabled: true },
    });
    const switches = resolveFeatures(rows);
    await this.redis.set(FEATURES_CACHE_KEY, JSON.stringify(switches), 'PX', FEATURES_CACHE_TTL_MS);
    return switches;
  }

  private async cashOnDeliveryEnabled(db: Db): Promise<boolean> {
    const store = await db.store.findFirstOrThrow({ where: THE_STORE, select: { cashOnDeliveryEnabled: true } });
    return store.cashOnDeliveryEnabled;
  }

  private viewOf(key: StoreFeatureKey, enabled: boolean): StoreFeatureView {
    return { key, enabled, description: STORE_FEATURES[key].description };
  }
}
