import { Decimal } from '@prisma/client/runtime/client';

/**
 * A line's variance: what was counted minus what should have been on the shelf when it was counted. The expected
 * quantity is read with the count, so units sold, received or adjusted between opening the session and counting the
 * line are already in it and are not mistaken for a variance; units that move after the count are left alone too,
 * because approval posts the variance as a delta, never the counted quantity.
 */
export function varianceOf(countedQuantity: number, expectedQuantity: number): number {
  return countedQuantity - expectedQuantity;
}

export interface StockTakeLineFacts {
  variantId: string;
  sku: string;
  productName: string;
  expectedAtOpen: number;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  variance: number | null;
  /** The variant's current price (tax-inclusive); null when it has none */
  unitPrice: Decimal | null;
  /** The variant's weighted-average cost (P4-E.1); null when unknown */
  unitCost: Decimal | null;
}

export interface VarianceReportLine {
  variantId: string;
  sku: string;
  productName: string;
  expectedAtOpen: number;
  /** Net change of the expected quantity between opening the session and counting the line (sales, receipts...) */
  changeSinceOpen: number;
  expectedQuantity: number;
  countedQuantity: number;
  variance: number;
  unitPrice: Decimal | null;
  varianceValue: Decimal | null;
  unitCost: Decimal | null;
  /** variance × unitCost; null when the cost is unknown */
  varianceCostValue: Decimal | null;
}

export interface VarianceTotals {
  lineCount: number;
  countedCount: number;
  uncountedCount: number;
  linesWithVariance: number;
  shortageUnits: number;
  surplusUnits: number;
  netVarianceUnits: number;
  shortageValue: Decimal;
  surplusValue: Decimal;
  netVarianceValue: Decimal;
  /** At cost, over the lines whose cost is known */
  shortageCostValue: Decimal;
  surplusCostValue: Decimal;
  netVarianceCostValue: Decimal;
}

export interface VarianceReport {
  lines: VarianceReportLine[];
  totals: VarianceTotals;
}

function isCounted(
  line: StockTakeLineFacts,
): line is StockTakeLineFacts & { expectedQuantity: number; countedQuantity: number; variance: number } {
  return line.countedQuantity !== null && line.expectedQuantity !== null && line.variance !== null;
}

/**
 * The counted lines with their variance valued at the variant's current price and at its weighted-average cost
 * (P4-E.1; lines of unknown price or cost add nothing to those totals), and totals over the session. Uncounted lines are only counted: approval leaves their stock as it is.
 */
export function varianceReport(lines: StockTakeLineFacts[]): VarianceReport {
  const zero = new Decimal(0);
  const totals: VarianceTotals = {
    lineCount: lines.length,
    countedCount: 0,
    uncountedCount: 0,
    linesWithVariance: 0,
    shortageUnits: 0,
    surplusUnits: 0,
    netVarianceUnits: 0,
    shortageValue: zero,
    surplusValue: zero,
    netVarianceValue: zero,
    shortageCostValue: zero,
    surplusCostValue: zero,
    netVarianceCostValue: zero,
  };
  const reported: VarianceReportLine[] = [];
  for (const line of lines) {
    if (!isCounted(line)) {
      totals.uncountedCount += 1;
      continue;
    }
    totals.countedCount += 1;
    const varianceValue = line.unitPrice ? line.unitPrice.mul(line.variance) : null;
    const varianceCostValue = line.unitCost ? line.unitCost.mul(line.variance) : null;
    if (varianceCostValue && line.variance < 0) {
      totals.shortageCostValue = totals.shortageCostValue.sub(varianceCostValue);
    } else if (varianceCostValue) {
      totals.surplusCostValue = totals.surplusCostValue.add(varianceCostValue);
    }
    if (line.variance !== 0) totals.linesWithVariance += 1;
    if (line.variance < 0) {
      totals.shortageUnits -= line.variance;
      if (varianceValue) totals.shortageValue = totals.shortageValue.sub(varianceValue);
    } else if (varianceValue) {
      totals.surplusValue = totals.surplusValue.add(varianceValue);
    }
    if (line.variance > 0) totals.surplusUnits += line.variance;
    reported.push({
      variantId: line.variantId,
      sku: line.sku,
      productName: line.productName,
      expectedAtOpen: line.expectedAtOpen,
      changeSinceOpen: line.expectedQuantity - line.expectedAtOpen,
      expectedQuantity: line.expectedQuantity,
      countedQuantity: line.countedQuantity,
      variance: line.variance,
      unitPrice: line.unitPrice,
      varianceValue,
      unitCost: line.unitCost,
      varianceCostValue,
    });
  }
  totals.netVarianceUnits = totals.surplusUnits - totals.shortageUnits;
  totals.netVarianceValue = totals.surplusValue.sub(totals.shortageValue);
  totals.netVarianceCostValue = totals.surplusCostValue.sub(totals.shortageCostValue);
  return { lines: reported, totals };
}

/** The variances approval posts: counted lines that differ, in variant order so concurrent approvals lock alike. */
export function variancesToPost<T extends { variantId: string; variance: number | null }>(
  lines: T[],
): (T & { variance: number })[] {
  return lines
    .filter((line): line is T & { variance: number } => line.variance !== null && line.variance !== 0)
    .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
}
