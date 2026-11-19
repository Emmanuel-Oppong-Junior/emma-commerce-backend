import { Kind } from 'graphql';
import { InputType } from '@nestjs/graphql';
import { IsOptional, validate } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DecimalInputField, GraphQLDecimal, InvalidDecimalInput, IsMoneyAmount, IsRate } from './decimal.scalar';
import { createValidationPipe } from '../validation-pipe';

@InputType('DecimalScalarSpecInput')
class PriceInput {
  @DecimalInputField()
  @IsMoneyAmount()
  price: Decimal;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount({ positive: true })
  minimum?: Decimal;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsRate()
  rate?: Decimal;
}

describe('GraphQLDecimal', () => {
  it.each(['12.50', '0', '0.15', '-3.2', '1000000'])('parses %s straight to a Decimal', (text) => {
    const parsed = GraphQLDecimal.parseValue(text);

    expect(parsed).toBeInstanceOf(Decimal);
    expect((parsed as Decimal).equals(new Decimal(text))).toBe(true);
  });

  it.each([
    ['exponent notation', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a word', 'twelve'],
    ['a leading plus', '+5'],
    ['a bare point', '5.'],
    ['surrounding space', ' 5'],
    ['a JSON number', 12.5],
    ['an empty string', ''],
    ['an overlong string', '1'.repeat(41)],
  ])('hands %s on as invalid input for the validators to reject', (_name, value) => {
    expect(GraphQLDecimal.parseValue(value)).toBeInstanceOf(InvalidDecimalInput);
  });

  it('parses string literals and marks other literals invalid', () => {
    expect(GraphQLDecimal.parseLiteral({ kind: Kind.STRING, value: '9.99' })).toEqual(new Decimal('9.99'));
    expect(GraphQLDecimal.parseLiteral({ kind: Kind.FLOAT, value: '9.99' })).toBeInstanceOf(InvalidDecimalInput);
    expect(GraphQLDecimal.parseLiteral({ kind: Kind.INT, value: '9' })).toBeInstanceOf(InvalidDecimalInput);
  });

  it('serializes a Decimal as a plain decimal string, never in exponent form', () => {
    expect(GraphQLDecimal.serialize(new Decimal('0.150000'))).toBe('0.15');
    expect(GraphQLDecimal.serialize(new Decimal('0.0000001'))).toBe('0.0000001');
    expect(GraphQLDecimal.serialize(new Decimal('12.50'))).toBe('12.5');
  });

  it('refuses to serialize something that is not a decimal', () => {
    expect(() => GraphQLDecimal.serialize(12.5)).toThrow('Decimal cannot represent 12.5');
  });
});

describe('Decimal inputs through the ValidationPipe', () => {
  const pipe = createValidationPipe();
  const transform = (value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype: PriceInput }) as Promise<PriceInput>;
  const messagesFor = async (value: Record<string, unknown>) => {
    try {
      await transform(value);
      return [];
    } catch (error) {
      return (error as { getResponse(): { message: string[] } }).getResponse().message;
    }
  };

  it('keeps the parsed Decimal instance (class-transformer would rebuild it with new Decimal() and throw)', async () => {
    const price = new Decimal('12.50');

    const input = await transform({ price, rate: new Decimal('0.15') });

    expect(input.price).toBe(price);
    expect(input.rate).toBeInstanceOf(Decimal);
    expect(input.minimum).toBeUndefined();
  });

  it('rejects input the scalar could not parse', async () => {
    await expect(messagesFor({ price: new InvalidDecimalInput('1e3') })).resolves.toEqual([
      'price must be a decimal string such as "12.50" (no exponent, NaN or Infinity)',
    ]);
  });

  it('rejects money with more than 2 decimal places', async () => {
    await expect(messagesFor({ price: new Decimal('12.505') })).resolves.toEqual([
      'price must have at most 2 decimal places',
    ]);
  });

  it('rejects negative money, and zero where it must be positive', async () => {
    await expect(messagesFor({ price: new Decimal('-0.01') })).resolves.toEqual(['price must be at least 0']);
    await expect(messagesFor({ price: new Decimal(1), minimum: new Decimal(0) })).resolves.toEqual([
      'minimum must be greater than 0',
    ]);
  });

  it('rejects money a DECIMAL(14,2) column cannot hold', async () => {
    await expect(messagesFor({ price: new Decimal('1000000000000') })).resolves.toEqual([
      'price must be less than 1000000000000',
    ]);
    await expect(messagesFor({ price: new Decimal('999999999999.99') })).resolves.toEqual([]);
  });

  it('accepts rates from 0 to 1 with up to 6 decimal places', async () => {
    await expect(messagesFor({ price: new Decimal(1), rate: new Decimal('0.125000') })).resolves.toEqual([]);
    await expect(messagesFor({ price: new Decimal(1), rate: new Decimal('0.1234567') })).resolves.toEqual([
      'rate must have at most 6 decimal places',
    ]);
    await expect(messagesFor({ price: new Decimal(1), rate: new Decimal('1.01') })).resolves.toEqual([
      'rate must be at most 1',
    ]);
  });

  it('still lets a validator see an omitted optional value as absent', async () => {
    const errors = await validate(Object.assign(new PriceInput(), { price: new Decimal(1) }));

    expect(errors).toEqual([]);
  });
});
