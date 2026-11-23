import { Field, FieldOptions } from '@nestjs/graphql';
import { GraphQLError, GraphQLScalarType, Kind, ValueNode } from 'graphql';
import { Transform, Type } from 'class-transformer';
import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const MAX_DECIMAL_TEXT_LENGTH = 40;
/** The largest amount a DECIMAL(14,2) money column holds. */
const MONEY_LIMIT = new Decimal('1000000000000');

/**
 * Input that is not a plain decimal string. The scalar hands it on instead of throwing, so the validators below can
 * reject it with BAD_USER_INPUT whether it came inline or as a variable (Apollo reports inline scalar errors as
 * GRAPHQL_VALIDATION_FAILED).
 */
export class InvalidDecimalInput {
  constructor(readonly received: unknown) {}
}

function parseDecimalText(value: unknown): Decimal | InvalidDecimalInput {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_TEXT_LENGTH || !DECIMAL_TEXT.test(value)) {
    return new InvalidDecimalInput(value);
  }
  return new Decimal(value);
}

export const GraphQLDecimal = new GraphQLScalarType({
  name: 'Decimal',
  description:
    'An exact decimal number as a string, e.g. "12.50" or "0.15": digits with an optional "-" and decimal point; no exponent, NaN or Infinity. Money inputs allow at most 2 decimal places.',
  serialize(value: unknown): string {
    if (value instanceof Decimal) return value.toFixed();
    if (typeof value === 'string' && DECIMAL_TEXT.test(value)) return value;
    throw new GraphQLError(`Decimal cannot represent ${String(value)}`);
  },
  parseValue: parseDecimalText,
  parseLiteral(ast: ValueNode) {
    return parseDecimalText(ast.kind === Kind.STRING ? ast.value : undefined);
  },
});

/**
 * A `Decimal` input field. The parsed Decimal is passed through the ValidationPipe untouched: class-transformer would
 * otherwise rebuild it with `new Decimal()`, which throws.
 */
export function DecimalInputField(options: FieldOptions = {}): PropertyDecorator {
  return (target, property) => {
    Field(() => GraphQLDecimal, options)(target, property);
    Type(() => Object)(target, property);
    Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key], { toClassOnly: true })(
      target,
      property,
    );
  };
}

interface DecimalRule {
  maxDecimalPlaces: number;
  min: Decimal;
  minExclusive: boolean;
  max: Decimal;
  maxExclusive: boolean;
}

function decimalProblem(value: unknown, rule: DecimalRule): string | null {
  if (!(value instanceof Decimal)) return 'must be a decimal string such as "12.50" (no exponent, NaN or Infinity)';
  if (value.decimalPlaces() > rule.maxDecimalPlaces) return `must have at most ${rule.maxDecimalPlaces} decimal places`;
  if (rule.minExclusive ? value.lte(rule.min) : value.lt(rule.min)) {
    return `must be ${rule.minExclusive ? 'greater than' : 'at least'} ${rule.min.toFixed()}`;
  }
  if (rule.maxExclusive ? value.gte(rule.max) : value.gt(rule.max)) {
    return `must be ${rule.maxExclusive ? 'less than' : 'at most'} ${rule.max.toFixed()}`;
  }
  return null;
}

function registerDecimalRule(name: string, rule: DecimalRule, options?: ValidationOptions): PropertyDecorator {
  return (target, property) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: String(property),
      options,
      validator: {
        validate: (value: unknown) => decimalProblem(value, rule) === null,
        defaultMessage: (args: ValidationArguments) => `${args.property} ${decimalProblem(args.value, rule)}`,
      },
    });
}

/** A money amount in the store currency: a Decimal with at most 2 decimal places, not negative (or positive). */
export function IsMoneyAmount(options: { positive?: boolean } & ValidationOptions = {}): PropertyDecorator {
  const { positive = false, ...validationOptions } = options;
  return registerDecimalRule(
    'isMoneyAmount',
    { maxDecimalPlaces: 2, min: new Decimal(0), minExclusive: positive, max: MONEY_LIMIT, maxExclusive: true },
    validationOptions,
  );
}

/** A rate between 0 and 1 inclusive with at most 6 decimal places (DECIMAL(9,6)), e.g. "0.15" for 15%. */
export function IsRate(options?: ValidationOptions): PropertyDecorator {
  return registerDecimalRule(
    'isRate',
    { maxDecimalPlaces: 6, min: new Decimal(0), minExclusive: false, max: new Decimal(1), maxExclusive: false },
    options,
  );
}

/** The largest unit cost a DECIMAL(14,4) cost column holds. */
const UNIT_COST_LIMIT = new Decimal('10000000000');

/** A unit cost (P4-E.1): a Decimal with at most 4 decimal places, not negative, below 10^10. */
export function IsUnitCost(options?: ValidationOptions): PropertyDecorator {
  return registerDecimalRule(
    'isUnitCost',
    { maxDecimalPlaces: 4, min: new Decimal(0), minExclusive: false, max: UNIT_COST_LIMIT, maxExclusive: true },
    options,
  );
}
