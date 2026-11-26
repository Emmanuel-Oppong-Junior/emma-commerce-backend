import { slugProblem } from './slug';

describe('slugProblem', () => {
  it.each(['shoes', 'summer-sale-2026', 'a', '3d-printers'])('accepts "%s"', (slug) => {
    expect(slugProblem(slug)).toBeNull();
  });

  it.each(['', 'Shoes', 'summer sale', '-shoes', 'shoes-', 'shoes--men', 'crème', 'a_b', 'a/b'])(
    'refuses "%s"',
    (slug) => {
      expect(slugProblem(slug)).toMatch(/must be lower-case letters and digits/);
    },
  );

  it('refuses a slug over 100 characters', () => {
    expect(slugProblem('a'.repeat(101))).toMatch(/longer than 100/);
    expect(slugProblem('a'.repeat(100))).toBeNull();
  });
});
