import { maskEmail } from './email.service';

describe('maskEmail', () => {
  it.each([
    ['kwame.asante@gmail.com', 'k***@gmail.com'],
    ['a@b.co', 'a***@b.co'],
    ['not-an-email', '***'],
  ])('masks %p as %p', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });
});
