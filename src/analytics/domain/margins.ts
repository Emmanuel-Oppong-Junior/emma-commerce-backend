import { Decimal } from '@prisma/client/runtime/client';
import { roundHalfUp } from '../../commons/money/money';

const RATE_DECIMAL_PLACES = 4;

/** Sums of AnalyticsDailyVariant rows: tax-exclusive net sales, split by whether the line's cost was known. */
export interface MarginSums {
  unitsSold: number;
  costedNetSales: Decimal;
  cogs: Decimal;
  unknownCostUnits: number;
  unknownCostNetSales: Decimal;
}

export interface Margin {
  unitsSold: number;
  /** Tax-exclusive net sales of every line: costed + unknown cost */
  netSales: Decimal;
  costedNetSales: Decimal;
  /** Cost of goods sold of the costed lines, half-up to the pesewa */
  cogs: Decimal;
  /** costedNetSales - cogs (as rounded); lines of unknown cost are left out, never counted at zero cost */
  grossMargin: Decimal;
  /** grossMargin / costedNetSales to 4 dp (0.2500 = 25 %); null without costed sales */
  marginRate: Decimal | null;
  unknownCostUnits: number;
  unknownCostNetSales: Decimal;
}

export function margin(sums: MarginSums): Margin {
  const cogs = roundHalfUp(sums.cogs);
  const grossMargin = roundHalfUp(sums.costedNetSales.sub(cogs));
  return {
    unitsSold: sums.unitsSold,
    netSales: sums.costedNetSales.add(sums.unknownCostNetSales),
    costedNetSales: sums.costedNetSales,
    cogs,
    grossMargin,
    marginRate: sums.costedNetSales.isZero()
      ? null
      : grossMargin.div(sums.costedNetSales).toDecimalPlaces(RATE_DECIMAL_PLACES, Decimal.ROUND_HALF_UP),
    unknownCostUnits: sums.unknownCostUnits,
    unknownCostNetSales: sums.unknownCostNetSales,
  };
}
