import { createValidationPipe, InputValidationException } from '../validation-pipe';
import { IsGhanaPhone, normaliseGhanaPhone } from './ghana-phone';

describe('normaliseGhanaPhone', () => {
  it.each([
    ['0244123456', '+233244123456'],
    ['233244123456', '+233244123456'],
    ['+233244123456', '+233244123456'],
    ['00233244123456', '+233244123456'],
    ['024 412 3456', '+233244123456'],
    ['+233 24-412-3456', '+233244123456'],
    ['(024) 412.3456', '+233244123456'],
    [' 0302123456 ', '+233302123456'],
    ['0554123456', '+233554123456'],
  ])('normalises %p to %p', (input, expected) => {
    expect(normaliseGhanaPhone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['244123456', 'national number without a prefix'],
    ['0044123456', 'national number starting with 0'],
    ['+2330244123456', 'trunk 0 kept after the country code'],
    ['024412345', 'too short'],
    ['02441234567', 'too long'],
    ['+234244123456', 'another country code'],
    ['+1 202 555 0100', 'non-Ghana number'],
    ['024412345a', 'letters'],
    ['+233+244123456', 'two plus signs'],
    ['0244/123456', 'unsupported separator'],
  ])('rejects %p (%s)', (input) => {
    expect(normaliseGhanaPhone(input)).toBeNull();
  });
});

describe('@IsGhanaPhone', () => {
  class PhoneInput {
    @IsGhanaPhone()
    phone: string;
  }

  const pipe = createValidationPipe();
  const validate = (value: unknown) =>
    pipe.transform({ phone: value }, { type: 'body', metatype: PhoneInput }) as Promise<PhoneInput>;

  it('stores the E.164 form of an accepted number', async () => {
    await expect(validate('024 412 3456')).resolves.toEqual({ phone: '+233244123456' });
  });

  it.each(['', '12345', null, 244123456])('rejects %p with a validation error', async (value) => {
    await expect(validate(value)).rejects.toThrow(InputValidationException);
  });
});
