import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { RedisThrottlerStorage, THROTTLE_KEY_PREFIX } from '../../src/commons/throttler/redis-throttler.storage';

const FORGOT_PASSWORD = `mutation ($input: ForgotPasswordInput!) { forgotPassword(input: $input) }`;

async function deleteThrottleKeys(redis: Redis): Promise<void> {
  const keys = await redis.keys(`${THROTTLE_KEY_PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

describe('Redis throttler storage (e2e)', () => {
  let app: INestApplication;
  let storage: RedisThrottlerStorage;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    storage = new RedisThrottlerStorage(app.get<Redis>(REDIS_CLIENT));
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts hits within the window and blocks the hit after the limit for the block duration', async () => {
    const key = randomUUID();
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await storage.increment(key, 60_000, 2, 1_000, 'test'));

    expect(hits.map((hit) => [hit.totalHits, hit.isBlocked])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(hits[0].timeToExpire).toBeGreaterThan(58);
    expect(hits[2].timeToBlockExpire).toBe(1);

    const whileBlocked = await storage.increment(key, 60_000, 2, 1_000, 'test');
    expect(whileBlocked).toMatchObject({ totalHits: 3, isBlocked: true });

    await sleep(1_100);
    await expect(storage.increment(key, 60_000, 2, 1_000, 'test')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('keeps separate counts per throttler name for the same key', async () => {
    const key = randomUUID();
    await storage.increment(key, 60_000, 1, 60_000, 'auth');

    await expect(storage.increment(key, 60_000, 1, 60_000, 'global')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    await expect(storage.increment(key, 60_000, 1, 60_000, 'auth')).resolves.toMatchObject({ isBlocked: true });
  });

  it('starts a new window once the ttl has passed', async () => {
    const key = randomUUID();
    await storage.increment(key, 300, 5, 300, 'test');
    await storage.increment(key, 300, 5, 300, 'test');
    await sleep(400);

    await expect(storage.increment(key, 300, 5, 300, 'test')).resolves.toMatchObject({ totalHits: 1 });
  });
});

describe('Throttle limits shared across API instances (e2e)', () => {
  let first: INestApplication;
  let second: INestApplication;

  const withRedisThrottling = () =>
    createTestApp((builder) =>
      builder.overrideProvider(ThrottlerStorage).useFactory({
        factory: (redis: Redis) => new RedisThrottlerStorage(redis),
        inject: [REDIS_CLIENT],
      }),
    );

  beforeAll(async () => {
    ({ app: first } = await withRedisThrottling());
    ({ app: second } = await withRedisThrottling());
    await deleteThrottleKeys(first.get<Redis>(REDIS_CLIENT));
  });

  afterAll(async () => {
    await deleteThrottleKeys(first.get<Redis>(REDIS_CLIENT));
    await Promise.all([first.close(), second.close()]);
  });

  it('refuses the fourth forgotPassword from one client even when the requests hit different instances', async () => {
    const send = (app: INestApplication) =>
      gqlRequest(app, FORGOT_PASSWORD, { input: { email: `nobody-${randomUUID()}@example.com` } });

    for (const app of [first, second, first]) {
      const res = await send(app).expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.forgotPassword).toBe(true);
    }

    const refused = await send(second);
    expect(refused.body.data?.forgotPassword ?? null).toBeNull();
    expect(refused.body.errors?.[0]?.message).toMatch(/too many requests/i);
  });
});
