import { bucketStart, dayKey, daysOf, groupByBucket, parseDay, ReportBucket, reportRange } from './report-range';

const day = (text: string) => parseDay(text)!;

describe('report ranges (P8-A)', () => {
  it('reads a YYYY-MM-DD day as its UTC midnight and refuses days that do not exist', () => {
    expect(parseDay('2026-02-28')?.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(parseDay('2026-13-01')).toBeNull();
    expect(parseDay('2026-1-01')).toBeNull();
  });

  it('includes the whole last day: firstDay..lastDay becomes [firstDay, lastDay + 1)', () => {
    const result = reportRange('2026-01-01', '2026-01-31');

    expect(result).toEqual({ range: { from: day('2026-01-01'), to: day('2026-02-01') } });
  });

  it('accepts a single day', () => {
    expect(reportRange('2026-03-05', '2026-03-05')).toEqual({
      range: { from: day('2026-03-05'), to: day('2026-03-06') },
    });
  });

  it('refuses a last day before the first, an impossible day and more than 731 days', () => {
    expect(reportRange('2026-02-01', '2026-01-31')).toEqual({
      problem: 'The last day 2026-01-31 is before the first day 2026-02-01',
    });
    expect(reportRange('2026-02-30', '2026-03-01')).toEqual({ problem: '"2026-02-30" is not a day (YYYY-MM-DD)' });
    expect(reportRange('2024-01-01', '2025-12-31')).toEqual({ range: expect.anything() });
    expect(reportRange('2024-01-01', '2026-01-01')).toEqual({ problem: 'A report covers at most 731 days' });
  });

  it('starts weeks on Monday and months on the first', () => {
    // 2026-01-07 is a Wednesday; 2026-01-04 a Sunday.
    expect(dayKey(bucketStart(day('2026-01-07'), ReportBucket.WEEK))).toBe('2026-01-05');
    expect(dayKey(bucketStart(day('2026-01-04'), ReportBucket.WEEK))).toBe('2025-12-29');
    expect(dayKey(bucketStart(day('2026-01-07'), ReportBucket.MONTH))).toBe('2026-01-01');
    expect(dayKey(bucketStart(day('2026-01-07'), ReportBucket.DAY))).toBe('2026-01-07');
  });

  it('groups every day of a range into buckets cut to the range', () => {
    const days = daysOf({ from: day('2026-01-07'), to: day('2026-01-20') }).map((each) => ({ day: each }));

    const weeks = groupByBucket(days, ReportBucket.WEEK).map((group) => [
      dayKey(group.firstDay),
      dayKey(group.lastDay),
      group.rows.length,
    ]);

    expect(weeks).toEqual([
      ['2026-01-07', '2026-01-11', 5],
      ['2026-01-12', '2026-01-18', 7],
      ['2026-01-19', '2026-01-19', 1],
    ]);
  });

  it('groups months and sorts days given out of order', () => {
    const days = [day('2026-02-02'), day('2026-01-31'), day('2026-02-01')].map((each) => ({ day: each }));

    expect(groupByBucket(days, ReportBucket.MONTH).map((group) => [dayKey(group.firstDay), group.rows.length])).toEqual(
      [
        ['2026-01-31', 1],
        ['2026-02-01', 2],
      ],
    );
  });
});
