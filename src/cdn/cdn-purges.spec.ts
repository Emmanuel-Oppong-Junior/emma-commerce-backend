import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { CdnPurger } from './cdn-purger';
import { CDN_FLUSH_JOB, CdnPurges, PENDING_PURGES_KEY } from './cdn-purges';
import { PURGE_WINDOW_MS } from './purge-plan';

describe('CdnPurges', () => {
  const redis = { sadd: jest.fn(), spop: jest.fn() };
  const queue = { add: jest.fn() };
  const purger: jest.Mocked<CdnPurger> = { purge: jest.fn() };
  const purges = new CdnPurges(redis as unknown as Redis, queue as unknown as Queue, purger);

  beforeEach(() => jest.resetAllMocks());

  describe('enqueue', () => {
    it('adds the change keys to the pending set and schedules the window flush once', async () => {
      await purges.enqueue({ reason: 'product', ids: ['p1'] });

      expect(redis.sadd).toHaveBeenCalledWith(
        PENDING_PURGES_KEY,
        'product|product:p1',
        'product|products',
        'product|slugs',
      );
      expect(queue.add).toHaveBeenCalledWith(
        CDN_FLUSH_JOB,
        {},
        expect.objectContaining({
          delay: expect.any(Number),
          deduplication: { id: CDN_FLUSH_JOB, ttl: PURGE_WINDOW_MS },
        }),
      );
      const [, , options] = queue.add.mock.calls[0];
      expect(options.delay).toBeGreaterThan(PURGE_WINDOW_MS);
    });

    it('purges everything for a change with too many ids to list', async () => {
      await purges.enqueue({ reason: 'stock', ids: null });
      expect(redis.sadd).toHaveBeenCalledWith(PENDING_PURGES_KEY, 'stock|catalogue');
    });

    it.each([undefined, {}, { reason: 'nonsense', ids: [] }, { reason: 'product', ids: [1] }, { reason: 'product' }])(
      'refuses a malformed payload (%j) without touching the pending set',
      async (payload) => {
        await expect(purges.enqueue(payload)).rejects.toThrow('Malformed catalogue.changed.v1 payload');
        expect(redis.sadd).not.toHaveBeenCalled();
      },
    );
  });

  describe('flush', () => {
    it('purges the coalesced keys of everything pending', async () => {
      redis.spop
        .mockResolvedValueOnce(['product|product:p1', 'stock|product:p1', 'product|products'])
        .mockResolvedValueOnce([]);

      await purges.flush();

      expect(purger.purge).toHaveBeenCalledTimes(1);
      expect(purger.purge).toHaveBeenCalledWith({ keys: ['product:p1', 'products'], reasons: ['product', 'stock'] });
    });

    it('does nothing when nothing is pending', async () => {
      redis.spop.mockResolvedValueOnce([]);
      await purges.flush();
      expect(purger.purge).not.toHaveBeenCalled();
    });

    it('puts the keys back when the purge fails, so the retry sends them', async () => {
      redis.spop.mockResolvedValueOnce(['product|product:p1']);
      purger.purge.mockRejectedValueOnce(new Error('CDN down'));

      await expect(purges.flush()).rejects.toThrow('CDN down');
      expect(redis.sadd).toHaveBeenCalledWith(PENDING_PURGES_KEY, 'product|product:p1');
    });
  });
});
