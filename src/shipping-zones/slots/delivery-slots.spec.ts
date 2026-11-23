import {
  bookableSlot,
  bookingKey,
  formatMinutes,
  parseTime,
  SlotCalendar,
  SlotTemplate,
  slotTemplateProblem,
  upcomingSlots,
  weekdayOf,
} from './delivery-slots';

// 2026-11-23 is a Monday.
const monday9am = new Date('2026-11-23T09:00:00Z');
const template = (overrides: Partial<SlotTemplate> = {}): SlotTemplate => ({
  id: 'mon-am',
  weekday: 'MONDAY',
  startMinute: 12 * 60,
  endMinute: 14 * 60,
  capacity: 2,
  cutoffHours: 2,
  isActive: true,
  ...overrides,
});
const calendar = (overrides: Partial<SlotCalendar> = {}): SlotCalendar => ({
  templates: [template()],
  closedDates: new Set(),
  booked: new Map(),
  ...overrides,
});

describe('upcomingSlots', () => {
  it('offers each weekday slot on its dates in the next days, today included before the cutoff', () => {
    expect(upcomingSlots(calendar(), monday9am, 8).map((slot) => [slot.date, slot.remaining])).toEqual([
      ['2026-11-23', 2],
      ['2026-11-30', 2],
    ]);
  });

  it('drops a slot once its cutoff has passed (Africa/Accra is UTC)', () => {
    const atCutoff = new Date('2026-11-23T10:00:00Z');

    expect(upcomingSlots(calendar(), atCutoff, 7)).toEqual([]);
    expect(upcomingSlots(calendar(), new Date('2026-11-23T09:59:59Z'), 7)).toHaveLength(1);
  });

  it('shows a full slot with nothing remaining and counts what is booked', () => {
    const booked = new Map([[bookingKey('mon-am', '2026-11-23'), 2]]);
    const half = new Map([[bookingKey('mon-am', '2026-11-23'), 1]]);

    expect(upcomingSlots(calendar({ booked }), monday9am, 1)[0].remaining).toBe(0);
    expect(upcomingSlots(calendar({ booked: half }), monday9am, 1)[0].remaining).toBe(1);
  });

  it('skips closed dates and inactive templates, and sorts by date then start', () => {
    const slots = upcomingSlots(
      calendar({
        templates: [
          template({ id: 'tue-pm', weekday: 'TUESDAY', startMinute: 15 * 60, endMinute: 17 * 60 }),
          template({ id: 'tue-am', weekday: 'TUESDAY', startMinute: 9 * 60, endMinute: 11 * 60 }),
          template({ id: 'off', weekday: 'TUESDAY', isActive: false }),
          template(),
        ],
        closedDates: new Set(['2026-11-23']),
      }),
      monday9am,
      2,
    );

    expect(slots.map((slot) => [slot.date, slot.slotId])).toEqual([
      ['2026-11-24', 'tue-am'],
      ['2026-11-24', 'tue-pm'],
    ]);
  });
});

describe('bookableSlot', () => {
  it('finds a slot that can still be booked and refuses one past its cutoff or on the wrong day', () => {
    expect(bookableSlot(calendar(), monday9am, { slotId: 'mon-am', date: '2026-11-23' })).toMatchObject({
      startMinute: 720,
      capacity: 2,
    });
    // Seven days ahead, today included: next Monday is out of range.
    expect(bookableSlot(calendar(), monday9am, { slotId: 'mon-am', date: '2026-11-30' })).toBeNull();
    expect(
      bookableSlot(calendar(), new Date('2026-11-23T11:00:00Z'), { slotId: 'mon-am', date: '2026-11-23' }),
    ).toBeNull();
    expect(bookableSlot(calendar(), monday9am, { slotId: 'mon-am', date: '2026-11-24' })).toBeNull();
    expect(bookableSlot(calendar(), monday9am, { slotId: 'mon-am', date: '2026-12-07' })).toBeNull();
  });
});

describe('times and dates', () => {
  it.each([
    ['08:30', 510],
    ['00:00', 0],
    ['24:00', 1440],
    ['8:30', null],
    ['12:60', null],
    ['24:01', null],
  ])('parses %p as %p', (value, minutes) => expect(parseTime(value)).toBe(minutes));

  it('formats minutes as HH:MM', () => expect(formatMinutes(510)).toBe('08:30'));

  it('names the weekday of a real date only', () => {
    expect(weekdayOf('2026-11-23')).toBe('MONDAY');
    expect(weekdayOf('2026-02-30')).toBeNull();
  });

  it.each([
    [{ startMinute: 600, endMinute: 600, capacity: 1, cutoffHours: 0 }],
    [{ startMinute: 600, endMinute: 1500, capacity: 1, cutoffHours: 0 }],
    [{ startMinute: 600, endMinute: 700, capacity: 0, cutoffHours: 0 }],
    [{ startMinute: 600, endMinute: 700, capacity: 1, cutoffHours: -1 }],
  ])('refuses the template %p', (slot) => expect(slotTemplateProblem(slot)).toEqual(expect.any(String)));
});
