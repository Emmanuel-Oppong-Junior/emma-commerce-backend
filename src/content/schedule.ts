// When banners, homepage sections and collections are live (P8-C). Pure: the caller passes `now`.

export interface Scheduled {
  isActive: boolean;
  startsAt: Date | null;
  /** Exclusive: live until just before it. */
  endsAt: Date | null;
}

export function isLive(item: Scheduled, now: Date): boolean {
  return (
    item.isActive && (item.startsAt === null || item.startsAt <= now) && (item.endsAt === null || item.endsAt > now)
  );
}

/** Why the window cannot be a schedule, or null. */
export function scheduleProblem(startsAt: Date | null, endsAt: Date | null): string | null {
  if (startsAt && endsAt && endsAt <= startsAt) {
    return `endsAt ${endsAt.toISOString()} must be after startsAt ${startsAt.toISOString()}`;
  }
  return null;
}

/** The Prisma filter of isLive. */
export function liveWhere(now: Date) {
  return {
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}
