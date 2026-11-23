import { Weekday } from '../generated/prisma/client';
import { formatMinutes } from '../shipping-zones/slots/delivery-slots';

/** One weekday's opening hours, minutes from midnight in Africa/Accra (= UTC). A weekday absent is closed. */
export interface OpeningHours {
  weekday: Weekday;
  opensMinute: number;
  closesMinute: number;
}

const WEEK: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];
const SHORT: Record<Weekday, string> = {
  MONDAY: 'Mon',
  TUESDAY: 'Tue',
  WEDNESDAY: 'Wed',
  THURSDAY: 'Thu',
  FRIDAY: 'Fri',
  SATURDAY: 'Sat',
  SUNDAY: 'Sun',
};

/** Why a week of opening hours is invalid, or null: at most one entry per weekday, each closing after it opens. */
export function openingHoursProblem(hours: readonly OpeningHours[]): string | null {
  if (new Set(hours.map((day) => day.weekday)).size !== hours.length) return 'Give each weekday at most once';
  if (hours.some((day) => day.opensMinute < 0 || day.closesMinute > 24 * 60 || day.opensMinute >= day.closesMinute)) {
    return 'Each day closes after it opens, within the day';
  }
  return null;
}

/**
 * The week in one line, consecutive days with the same hours grouped: "Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun
 * closed". No hours at all: "Opening hours not set".
 */
export function formatOpeningHours(hours: readonly OpeningHours[]): string {
  if (hours.length === 0) return 'Opening hours not set';
  const byDay = new Map(hours.map((day) => [day.weekday, day]));
  const label = (weekday: Weekday) => {
    const day = byDay.get(weekday);
    return day ? `${formatMinutes(day.opensMinute)}-${formatMinutes(day.closesMinute)}` : 'closed';
  };
  const groups: { from: Weekday; to: Weekday; hours: string }[] = [];
  for (const weekday of WEEK) {
    const last = groups[groups.length - 1];
    if (last && last.hours === label(weekday)) last.to = weekday;
    else groups.push({ from: weekday, to: weekday, hours: label(weekday) });
  }
  return groups
    .map((group) => `${SHORT[group.from]}${group.to === group.from ? '' : `-${SHORT[group.to]}`} ${group.hours}`)
    .join(', ');
}
