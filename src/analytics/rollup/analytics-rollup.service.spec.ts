import { AnalyticsRollupService, ROLLUP_RECENT_DAYS } from './analytics-rollup.service';
import { AnalyticsCounter } from '../counters/analytics-counters';

const day = (text: string) => new Date(`${text}T00:00:00Z`);

describe('AnalyticsRollupService', () => {
  const tx = { $executeRaw: jest.fn() };
  let prisma: { $transaction: jest.Mock };
  let repository: { rebuild: jest.Mock; setCounter: jest.Mock };
  let counters: { read: jest.Mock };
  let service: AnalyticsRollupService;

  beforeEach(() => {
    tx.$executeRaw.mockReset();
    prisma = { $transaction: jest.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)) };
    repository = { rebuild: jest.fn(), setCounter: jest.fn() };
    counters = { read: jest.fn(async (_counter: AnalyticsCounter, days: Date[]) => days.map(() => null)) };
    service = new AnalyticsRollupService(
      prisma as never,
      repository as never,
      counters as never,
      {
        log: jest.fn(),
      } as never,
    );
  });

  it('recomputes today and the days before it on each recurring run', async () => {
    const now = new Date('2026-03-10T14:00:00Z');

    await service.rebuildRecent(now);

    expect(repository.rebuild).toHaveBeenCalledWith(
      tx,
      { from: day(`2026-03-0${10 - ROLLUP_RECENT_DAYS}`), to: day('2026-03-11') },
      now,
    );
  });

  it('rebuilds a long range in chunks of 31 days, each under the advisory lock', async () => {
    await service.rebuild({ from: day('2026-01-01'), to: day('2026-03-05') });

    expect(repository.rebuild.mock.calls.map(([, range]) => range)).toEqual([
      { from: day('2026-01-01'), to: day('2026-02-01') },
      { from: day('2026-02-01'), to: day('2026-03-04') },
      { from: day('2026-03-04'), to: day('2026-03-05') },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('copies the Redis counters of each day, keeping the stored count when a counter is gone', async () => {
    counters.read.mockImplementation(async (counter: AnalyticsCounter) =>
      counter === AnalyticsCounter.CartsStarted ? [4, null] : [null, 9],
    );

    await service.rebuild({ from: day('2026-03-01'), to: day('2026-03-03') });

    expect(repository.setCounter.mock.calls.map((call) => call.slice(1))).toEqual([
      ['cartsStarted', day('2026-03-01'), 4],
      ['checkoutQuotes', day('2026-03-02'), 9],
    ]);
  });

  it('refuses a rebuild job whose range is not a valid half-open range', async () => {
    await expect(service.rebuildJob({ from: '2026-03-02', to: '2026-03-02' })).rejects.toThrow(/invalid range/);
    await expect(service.rebuildJob({ from: 'yesterday', to: '2026-03-02' })).rejects.toThrow(/invalid range/);
    expect(repository.rebuild).not.toHaveBeenCalled();
  });
});
