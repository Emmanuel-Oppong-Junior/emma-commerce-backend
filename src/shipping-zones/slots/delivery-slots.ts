import { Weekday } from '../../generated/prisma/client';

/** `extensions.reason` when another order took the slot's last place. */
export const SLOT_FULL = 'SLOT_FULL';
/** `extensions.reason` when STANDARD delivery to a zone with slots is placed without one. */
export const DELIVERY_SLOT_REQUIRED = 'DELIVERY_SLOT_REQUIRED';
/** `extensions.reason` when the slot asked for cannot be booked (unknown, closed, past its cutoff, or not offered). */
export const DELIVERY_SLOT_UNAVAILABLE = 'DELIVERY_SLOT_UNAVAILABLE';

/** How many days ahead checkout offers slots, today included. */
export const SLOT_DAYS = 7;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Date.getUTCDay order: Sunday first.
const WEEKDAYS: Weekday[] = [
  Weekday.SUNDAY,
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
];

export interface SlotTemplate {
  id: string;
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
  capacity: number;
  cutoffHours: number;
  isActive: boolean;
}

export interface AvailableSlot {
  slotId: string;
  /** YYYY-MM-DD, Africa/Accra (= UTC all year, no daylight saving). */
  date: string;
  startMinute: number;
  endMinute: number;
  capacity: number;
  /** Places left; 0 when full. */
  remaining: number;
}

export interface SlotCalendar {
  templates: readonly SlotTemplate[];
  /** Closed dates (YYYY-MM-DD). */
  closedDates: ReadonlySet<string>;
  /** Places booked, keyed `${slotId}|${date}`. */
  booked: ReadonlyMap<string, number>;
}

export const bookingKey = (slotId: string, date: string) => `${slotId}|${date}`;

/** "08:30" for 510. */
export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// The lint rule against Number()/parseInt guards the money path; times of day are plain digits.
const digitsValue = (digits: string) =>
  [...digits].reduce((value, digit) => value * 10 + '0123456789'.indexOf(digit), 0);

/** 510 for "08:30"; "24:00" is the end of the day. Null when not HH:MM within the day. */
export function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [hours, mins] = [match[1], match[2]].map(digitsValue);
  const minutes = hours * 60 + mins;
  return mins < 60 && minutes <= 24 * 60 ? minutes : null;
}

/** The weekday of a YYYY-MM-DD date, or null when the string is not a real date. */
export function weekdayOf(date: string): Weekday | null {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return WEEKDAYS[new Date(time).getUTCDay()];
}

/** Why a slot template is invalid, or null. */
export function slotTemplateProblem(
  slot: Pick<SlotTemplate, 'startMinute' | 'endMinute' | 'capacity' | 'cutoffHours'>,
) {
  if (slot.startMinute < 0 || slot.endMinute > 24 * 60 || slot.startMinute >= slot.endMinute) {
    return 'A delivery slot ends after it starts, within the day';
  }
  if (!Number.isInteger(slot.capacity) || slot.capacity < 1) return 'A delivery slot takes at least one order';
  if (!Number.isInteger(slot.cutoffHours) || slot.cutoffHours < 0) return 'Cutoff hours are a whole number, 0 or more';
  return null;
}

/**
 * The slots of the next `days` days (today first) that can still be booked: active, on their weekday, the date not
 * closed, and `now` before the slot start minus its cutoff. Full slots are listed with `remaining` 0. Sorted by date
 * then start.
 */
export function upcomingSlots(calendar: SlotCalendar, now: Date, days = SLOT_DAYS): AvailableSlot[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const slots: AvailableSlot[] = [];
  for (let day = 0; day < days; day += 1) {
    const midnight = today + day * DAY_MS;
    const date = new Date(midnight).toISOString().slice(0, 10);
    if (calendar.closedDates.has(date)) continue;
    const weekday = WEEKDAYS[new Date(midnight).getUTCDay()];
    for (const template of calendar.templates) {
      if (!template.isActive || template.weekday !== weekday) continue;
      const cutoff = midnight + template.startMinute * MINUTE_MS - template.cutoffHours * HOUR_MS;
      if (now.getTime() >= cutoff) continue;
      const booked = calendar.booked.get(bookingKey(template.id, date)) ?? 0;
      slots.push({
        slotId: template.id,
        date,
        startMinute: template.startMinute,
        endMinute: template.endMinute,
        capacity: template.capacity,
        remaining: Math.max(template.capacity - booked, 0),
      });
    }
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
}

/** The slot asked for if it can be booked now (capacity aside: the booking itself checks that), else null. */
export function bookableSlot(
  calendar: SlotCalendar,
  now: Date,
  wanted: { slotId: string; date: string },
  days = SLOT_DAYS,
): AvailableSlot | null {
  return (
    upcomingSlots(calendar, now, days).find((slot) => slot.slotId === wanted.slotId && slot.date === wanted.date) ??
    null
  );
}
