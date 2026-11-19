import { Decimal } from '@prisma/client/runtime/client';
import { Currency } from '../../generated/prisma/client';

export type MoneyRounding = 'HALF_UP' | 'NONE';

const MINOR_UNITS_PER_MAJOR = 100;
const DECIMAL_PLACES = 2;

/**
 * THE rounding rule for money: half-up (half away from zero) to 2 dp, applied per component and per line. It matches
 * Postgres `ROUND(numeric, 2)`. Pending confirmation by a tax adviser: GRA's rounding rule has not been verified.
 */
export function roundHalfUp(value: Decimal.Value): Decimal {
  const rounded = new Decimal(value).toDecimalPlaces(DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
  // -0.004 rounds to -0, which would print as "-0.00".
  return rounded.isZero() ? new Decimal(0) : rounded;
}

/** Whole minor units (pesewas), as payment providers take them. Throws if `amount` has more than 2 decimal places. */
export function toMinorUnits(amount: Decimal.Value): number {
  const minor = exactMinorUnits(new Decimal(amount));
  // eslint-disable-next-line no-restricted-syntax -- providers take an integer JSON number; checked safe below
  const units = minor.toNumber();
  if (!Number.isSafeInteger(units)) throw new RangeError(`${minor.toString()} minor units is too large to send`);
  return units;
}

function exactMinorUnits(amount: Decimal): Decimal {
  const minor = amount.mul(MINOR_UNITS_PER_MAJOR);
  if (!minor.isInteger()) throw new RangeError(`${amount.toString()} is not a whole number of minor units`);
  return minor;
}

/**
 * An amount in one currency, kept as an exact decimal (ADR-0004). Arithmetic never goes through a JS number, and
 * mixing currencies throws. Amounts are kept unrounded until `roundHalfUp`, `toString` or `toMinorUnits`.
 *
 * Rounding follows `roundHalfUp`, the single money rounding rule.
 */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: Currency,
  ) {}

  static of(value: Decimal.Value, currency: Currency): Money {
    const amount = new Decimal(value);
    if (!amount.isFinite()) throw new RangeError(`Money amount must be finite, got ${amount.toString()}`);
    return new Money(amount, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(new Decimal(0), currency);
  }

  static max(first: Money, second: Money): Money {
    return first.greaterThanOrEqual(second) ? first : second;
  }

  static min(first: Money, second: Money): Money {
    return first.lessThanOrEqual(second) ? first : second;
  }

  add(other: Money): Money {
    return new Money(this.amount.add(this.sameCurrency(other).amount), this.currency);
  }

  subtract(other: Money): Money {
    return new Money(this.amount.sub(this.sameCurrency(other).amount), this.currency);
  }

  times(quantity: Decimal.Value): Money {
    return new Money(this.amount.mul(quantity), this.currency);
  }

  /** amount × rate, rounded half-up to 2 dp unless `rounding` is NONE (for intermediate steps). */
  applyRate(rate: Decimal.Value, rounding: MoneyRounding = 'HALF_UP'): Money {
    const applied = new Money(this.amount.mul(rate), this.currency);
    return rounding === 'HALF_UP' ? applied.roundHalfUp() : applied;
  }

  /**
   * Splits this amount (exact to 2 dp, not negative) in proportion to `weights` so the parts add up exactly to it:
   * each part gets its floor in pesewas and the pesewas left over go to the largest remainders, earlier parts first
   * on ties. Weights must not be negative and must not all be zero.
   */
  allocate(weights: readonly Decimal.Value[]): Money[] {
    if (weights.length === 0) throw new RangeError('Cannot allocate money over no weights');
    const shares = weights.map((weight) => new Decimal(weight));
    if (shares.some((share) => share.isNegative() || !share.isFinite())) {
      throw new RangeError(`Allocation weights must be finite and not negative, got [${shares.join(', ')}]`);
    }
    const totalWeight = shares.reduce((sum, share) => sum.add(share), new Decimal(0));
    if (totalWeight.isZero()) throw new RangeError('Cannot allocate money when every weight is zero');
    if (this.isNegative()) throw new RangeError(`Cannot allocate a negative amount, got ${this.toString()}`);

    const totalMinor = exactMinorUnits(this.amount);
    const exactParts = shares.map((share) => totalMinor.mul(share).div(totalWeight));
    const floors = exactParts.map((part) => part.floor());
    let leftover = totalMinor.sub(floors.reduce((sum, part) => sum.add(part), new Decimal(0)));
    const byRemainder = exactParts
      .map((part, index) => ({ index, remainder: part.sub(floors[index]) }))
      .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
    for (const { index } of byRemainder) {
      if (leftover.lte(0)) break;
      floors[index] = floors[index].add(1);
      leftover = leftover.sub(1);
    }
    return floors.map((minor) => new Money(minor.div(MINOR_UNITS_PER_MAJOR), this.currency));
  }

  roundHalfUp(): Money {
    return new Money(roundHalfUp(this.amount), this.currency);
  }

  equals(other: Money): boolean {
    return this.amount.equals(this.sameCurrency(other).amount);
  }

  greaterThan(other: Money): boolean {
    return this.amount.gt(this.sameCurrency(other).amount);
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.amount.gte(this.sameCurrency(other).amount);
  }

  lessThan(other: Money): boolean {
    return this.amount.lt(this.sameCurrency(other).amount);
  }

  lessThanOrEqual(other: Money): boolean {
    return this.amount.lte(this.sameCurrency(other).amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.gt(0);
  }

  /** Whole pesewas, as payment providers take them. Throws if the amount has more than 2 decimal places. */
  toMinorUnits(): number {
    return toMinorUnits(this.amount);
  }

  /** The amount to 2 dp, half-up, without the currency (e.g. "480.00"). */
  toString(): string {
    return roundHalfUp(this.amount).toFixed(DECIMAL_PLACES);
  }

  private sameCurrency(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new TypeError(`Cannot combine ${this.currency} and ${other.currency} amounts`);
    }
    return other;
  }
}
