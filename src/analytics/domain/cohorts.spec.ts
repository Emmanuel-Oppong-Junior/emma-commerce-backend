import { Decimal } from '@prisma/client/runtime/client';
import { addMonths, assembleCohorts, monthsBetween, parseMonth } from './cohorts';

const month = (text: string) => parseMonth(text)!;

describe('cohorts (P8-A)', () => {
  it('reads YYYY-MM months and counts months between them', () => {
    expect(month('2026-03').toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(parseMonth('2026-13')).toBeNull();
    expect(monthsBetween(month('2025-11'), month('2026-02'))).toBe(3);
    expect(addMonths(month('2025-12'), 1)).toEqual(month('2026-01'));
  });

  it('fills every cohort and month, computing the repeat rate and stopping at the current month', () => {
    const cohorts = assembleCohorts(
      [{ month: month('2026-01'), customers: 3, repeatCustomers: 1 }],
      [
        { month: month('2026-01'), offset: 0, activeCustomers: 3, orders: 3, netRevenue: new Decimal('300.00') },
        { month: month('2026-01'), offset: 2, activeCustomers: 1, orders: 1, netRevenue: new Decimal('-20.00') },
      ],
      { firstMonth: month('2026-01'), lastMonth: month('2026-03'), followMonths: 12, currentMonth: month('2026-03') },
    );

    expect(cohorts).toEqual([
      {
        month: month('2026-01'),
        customers: 3,
        repeatCustomers: 1,
        repeatRate: 0.3333,
        months: [
          { offset: 0, activeCustomers: 3, orders: 3, netRevenue: new Decimal('300') },
          { offset: 1, activeCustomers: 0, orders: 0, netRevenue: new Decimal('0') },
          { offset: 2, activeCustomers: 1, orders: 1, netRevenue: new Decimal('-20') },
        ],
      },
      {
        month: month('2026-02'),
        customers: 0,
        repeatCustomers: 0,
        repeatRate: null,
        months: [
          { offset: 0, activeCustomers: 0, orders: 0, netRevenue: new Decimal('0') },
          { offset: 1, activeCustomers: 0, orders: 0, netRevenue: new Decimal('0') },
        ],
      },
      {
        month: month('2026-03'),
        customers: 0,
        repeatCustomers: 0,
        repeatRate: null,
        months: [{ offset: 0, activeCustomers: 0, orders: 0, netRevenue: new Decimal('0') }],
      },
    ]);
  });

  it('follows a cohort for at most followMonths months', () => {
    const [cohort] = assembleCohorts([], [], {
      firstMonth: month('2024-01'),
      lastMonth: month('2024-01'),
      followMonths: 2,
      currentMonth: month('2026-01'),
    });

    expect(cohort.months.map((each) => each.offset)).toEqual([0, 1, 2]);
  });

  it('gives a future cohort no months', () => {
    const [cohort] = assembleCohorts([], [], {
      firstMonth: month('2026-05'),
      lastMonth: month('2026-05'),
      followMonths: 3,
      currentMonth: month('2026-03'),
    });

    expect(cohort.months).toEqual([]);
  });
});
