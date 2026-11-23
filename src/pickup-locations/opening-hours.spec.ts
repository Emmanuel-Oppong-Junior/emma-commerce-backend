import { formatOpeningHours, OpeningHours, openingHoursProblem } from './opening-hours';

const day = (weekday: OpeningHours['weekday'], opens: number, closes: number): OpeningHours => ({
  weekday,
  opensMinute: opens * 60,
  closesMinute: closes * 60,
});
const weekdays = (['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).map((weekday) =>
  day(weekday, 8, 17),
);

describe('formatOpeningHours', () => {
  it('groups consecutive days with the same hours and names closed days', () => {
    expect(formatOpeningHours([...weekdays, day('SATURDAY', 9, 13)])).toBe(
      'Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed',
    );
  });

  it('breaks a run where the hours change, whatever order the days come in', () => {
    expect(formatOpeningHours([day('WEDNESDAY', 8, 12), ...weekdays.filter((d) => d.weekday !== 'WEDNESDAY')])).toBe(
      'Mon-Tue 08:00-17:00, Wed 08:00-12:00, Thu-Fri 08:00-17:00, Sat-Sun closed',
    );
  });

  it('says so when no hours are set', () => {
    expect(formatOpeningHours([])).toBe('Opening hours not set');
  });
});

describe('openingHoursProblem', () => {
  it('accepts a week with each day once, closing after it opens', () => {
    expect(openingHoursProblem([...weekdays, day('SUNDAY', 0, 24)])).toBeNull();
  });

  it.each([
    ['a repeated weekday', [day('MONDAY', 8, 12), day('MONDAY', 13, 17)]],
    ['a day closing before it opens', [day('MONDAY', 17, 8)]],
    ['a day past midnight', [day('MONDAY', 20, 25)]],
  ])('refuses %s', (_name, hours) => {
    expect(openingHoursProblem(hours)).toEqual(expect.any(String));
  });
});
