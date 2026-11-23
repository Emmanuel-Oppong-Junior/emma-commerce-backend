import { Decimal } from '@prisma/client/runtime/client';
import { DeliveryServiceLevel } from '../generated/prisma/client';

/** `extensions.reason` when the zone has no active rate rule for the service level asked for. */
export const DELIVERY_LEVEL_UNAVAILABLE = 'DELIVERY_LEVEL_UNAVAILABLE';

export interface WeightBand {
  fromGrams: number;
  fee: Decimal;
}

export interface DeliveryRate {
  id: string;
  serviceLevel: DeliveryServiceLevel;
  baseFee: Decimal;
  freeAbove: Decimal | null;
  isActive: boolean;
  weightBands: readonly WeightBand[];
}

export interface DeliveryFee {
  rateRuleId: string;
  serviceLevel: DeliveryServiceLevel;
  /** What delivery costs before free-shipping promotions. */
  fee: Decimal;
  /** The weight band charged; null when the cart is below every band (the base fee). */
  weightBandFromGrams: number | null;
  /** The rule's free-above threshold was reached, so the fee is 0. */
  freeAboveReached: boolean;
}

/**
 * Why a rule's fees are invalid, or null: bands start above 0 g, go strictly up in weight and never get cheaper,
 * starting from the base fee.
 */
export function rateRuleProblem(rule: Pick<DeliveryRate, 'baseFee' | 'weightBands'>): string | null {
  let previous: WeightBand | null = null;
  for (const band of rule.weightBands) {
    if (!Number.isInteger(band.fromGrams) || band.fromGrams <= 0) {
      return 'Weight bands start at a whole number of grams above 0';
    }
    if (previous && band.fromGrams <= previous.fromGrams) return 'Weight bands must go up in weight, without repeats';
    if (band.fee.lt(previous?.fee ?? rule.baseFee)) {
      return 'A heavier weight band cannot cost less than a lighter one or the base fee';
    }
    previous = band;
  }
  return null;
}

/**
 * The delivery fee of the zone's active rule for the service level, or null when the zone does not offer it. The
 * fee is the heaviest band the cart's weight reaches (else the base fee), and 0 once `merchandiseTotal` (the
 * merchandise total after item and cart promotions, tax included) reaches the rule's free-above threshold.
 */
export function deliveryFee(
  rules: readonly DeliveryRate[],
  serviceLevel: DeliveryServiceLevel,
  weightGrams: number,
  merchandiseTotal: Decimal,
): DeliveryFee | null {
  const rule = rules.find((candidate) => candidate.isActive && candidate.serviceLevel === serviceLevel);
  if (!rule) return null;
  const band = [...rule.weightBands]
    .sort((a, b) => b.fromGrams - a.fromGrams)
    .find((candidate) => weightGrams >= candidate.fromGrams);
  const freeAboveReached = rule.freeAbove !== null && merchandiseTotal.gte(rule.freeAbove);
  return {
    rateRuleId: rule.id,
    serviceLevel,
    fee: freeAboveReached ? new Decimal(0) : (band?.fee ?? rule.baseFee),
    weightBandFromGrams: band?.fromGrams ?? null,
    freeAboveReached,
  };
}

/** The service levels the zone offers, in enum order. */
export function offeredLevels(rules: readonly DeliveryRate[]): DeliveryServiceLevel[] {
  return Object.values(DeliveryServiceLevel).filter((level) =>
    rules.some((rule) => rule.isActive && rule.serviceLevel === level),
  );
}
