import { isLive, liveWhere, scheduleProblem } from './schedule';

const NOW = new Date('2026-12-01T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('content schedule', () => {
  it('is live while active with no window', () => {
    expect(isLive({ isActive: true, startsAt: null, endsAt: null }, NOW)).toBe(true);
    expect(isLive({ isActive: false, startsAt: null, endsAt: null }, NOW)).toBe(false);
  });

  it('starts at startsAt (inclusive) and stops at endsAt (exclusive)', () => {
    const window = { isActive: true, startsAt: at('2026-12-01T12:00:00Z'), endsAt: at('2026-12-02T00:00:00Z') };
    expect(isLive(window, NOW)).toBe(true);
    expect(isLive(window, at('2026-12-01T11:59:59Z'))).toBe(false);
    expect(isLive(window, at('2026-12-01T23:59:59Z'))).toBe(true);
    expect(isLive(window, at('2026-12-02T00:00:00Z'))).toBe(false);
  });

  it('never makes an inactive item live inside its window', () => {
    expect(isLive({ isActive: false, startsAt: at('2026-11-01T00:00:00Z'), endsAt: null }, NOW)).toBe(false);
  });

  it('refuses a window that ends before it starts, and accepts open ends', () => {
    expect(scheduleProblem(at('2026-12-02T00:00:00Z'), at('2026-12-01T00:00:00Z'))).toMatch(/must be after/);
    expect(scheduleProblem(at('2026-12-01T00:00:00Z'), at('2026-12-01T00:00:00Z'))).toMatch(/must be after/);
    expect(scheduleProblem(null, at('2026-12-01T00:00:00Z'))).toBeNull();
    expect(scheduleProblem(at('2026-12-01T00:00:00Z'), null)).toBeNull();
  });

  it('builds the same rule as a Prisma filter', () => {
    expect(liveWhere(NOW)).toEqual({
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: NOW } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: NOW } }] },
      ],
    });
  });
});
