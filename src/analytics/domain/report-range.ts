/** Longest report range in days (two years, a leap day included). */
export const MAX_REPORT_DAYS = 731;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

export enum ReportBucket {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

/** Whole UTC days (= Africa/Accra, no daylight saving): `from` included, `to` excluded, both at UTC midnight. */
export interface DayRange {
  from: Date;
  to: Date;
}

/** The UTC midnight of a YYYY-MM-DD day; null when the text is not a day that exists. */
export function parseDay(text: string): Date | null {
  const match = DAY_TEXT.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

/**
 * The half-open range of the inclusive days `firstDay`..`lastDay` (YYYY-MM-DD), or why it is refused: a day that
 * does not exist, a last day before the first, or more than `maxDays` days.
 */
export function reportRange(
  firstDay: string,
  lastDay: string,
  maxDays = MAX_REPORT_DAYS,
): { range: DayRange } | { problem: string } {
  const from = parseDay(firstDay);
  if (!from) return { problem: `"${firstDay}" is not a day (YYYY-MM-DD)` };
  const last = parseDay(lastDay);
  if (!last) return { problem: `"${lastDay}" is not a day (YYYY-MM-DD)` };
  if (last < from) return { problem: `The last day ${lastDay} is before the first day ${firstDay}` };
  const range = { from, to: addDays(last, 1) };
  if (daysIn(range) > maxDays) return { problem: `A report covers at most ${maxDays} days` };
  return { range };
}

export function daysIn(range: DayRange): number {
  return Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS);
}

/** Every day of the range, in order. */
export function daysOf(range: DayRange): Date[] {
  return Array.from({ length: daysIn(range) }, (_, index) => addDays(range.from, index));
}

/** The first day of the bucket holding `day`: the day itself, its ISO week's Monday, or the first of its month. */
export function bucketStart(day: Date, bucket: ReportBucket): Date {
  if (bucket === ReportBucket.DAY) return day;
  if (bucket === ReportBucket.MONTH) return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return addDays(day, -sinceMonday);
}

/**
 * Groups the rows of consecutive days into buckets, in order. A bucket spans the days it holds, so given every day of
 * a range the first and last bucket are cut to it (a WEEK report starting on a Wednesday opens with Wednesday-Sunday).
 */
export function groupByBucket<T extends { day: Date }>(
  rows: readonly T[],
  bucket: ReportBucket,
): { firstDay: Date; lastDay: Date; rows: T[] }[] {
  const groups = new Map<number, T[]>();
  for (const row of [...rows].sort((a, b) => a.day.getTime() - b.day.getTime())) {
    const start = bucketStart(row.day, bucket).getTime();
    groups.set(start, [...(groups.get(start) ?? []), row]);
  }
  return [...groups.values()].map((days) => ({
    firstDay: days[0].day,
    lastDay: days[days.length - 1].day,
    rows: days,
  }));
}
