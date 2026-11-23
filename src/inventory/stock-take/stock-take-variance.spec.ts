import { Decimal } from '@prisma/client/runtime/client';
import { StockTakeLineFacts, varianceOf, varianceReport, variancesToPost } from './stock-take-variance';

function line(overrides: Partial<StockTakeLineFacts> = {}): StockTakeLineFacts {
  return {
    variantId: 'v1',
    sku: 'SKU-1',
    productName: 'Kente scarf',
    expectedAtOpen: 10,
    expectedQuantity: null,
    countedQuantity: null,
    variance: null,
    unitPrice: new Decimal('25.50'),
    unitCost: null,
    ...overrides,
  };
}

describe('varianceOf', () => {
  it('is what was counted minus what should have been on the shelf at the count', () => {
    expect(varianceOf(7, 10)).toBe(-3);
    expect(varianceOf(12, 10)).toBe(2);
    expect(varianceOf(8, 8)).toBe(0);
  });

  it('measures against the expected quantity at the count, so a sale during the count is no variance', () => {
    const expectedAtOpen = 10;
    const soldDuringCount = 2;
    const expectedAtCount = expectedAtOpen - soldDuringCount;

    expect(varianceOf(8, expectedAtCount)).toBe(0);
    expect(varianceOf(7, expectedAtCount)).toBe(-1);
  });
});

describe('varianceReport', () => {
  it('reports counted lines with the change since open, the variance and its value at the current price', () => {
    const report = varianceReport([
      line({ variantId: 'v1', expectedQuantity: 8, countedQuantity: 7, variance: -1 }),
      line({ variantId: 'v2', expectedAtOpen: 3, expectedQuantity: 5, countedQuantity: 7, variance: 2 }),
    ]);

    expect(report.lines).toEqual([
      expect.objectContaining({ variantId: 'v1', expectedAtOpen: 10, changeSinceOpen: -2, variance: -1 }),
      expect.objectContaining({ variantId: 'v2', expectedAtOpen: 3, changeSinceOpen: 2, variance: 2 }),
    ]);
    expect(report.lines[0].varianceValue?.toFixed(2)).toBe('-25.50');
    expect(report.lines[1].varianceValue?.toFixed(2)).toBe('51.00');
  });

  it('totals shortages and surpluses separately and nets them, leaving uncounted lines out', () => {
    const { totals, lines } = varianceReport([
      line({ variantId: 'v1', expectedQuantity: 8, countedQuantity: 5, variance: -3 }),
      line({ variantId: 'v2', expectedQuantity: 5, countedQuantity: 6, variance: 1, unitPrice: new Decimal('10') }),
      line({ variantId: 'v3', expectedQuantity: 4, countedQuantity: 4, variance: 0 }),
      line({ variantId: 'v4' }),
    ]);

    expect(lines.map((l) => l.variantId)).toEqual(['v1', 'v2', 'v3']);
    expect(totals).toMatchObject({
      lineCount: 4,
      countedCount: 3,
      uncountedCount: 1,
      linesWithVariance: 2,
      shortageUnits: 3,
      surplusUnits: 1,
      netVarianceUnits: -2,
    });
    expect(totals.shortageValue.toFixed(2)).toBe('76.50');
    expect(totals.surplusValue.toFixed(2)).toBe('10.00');
    expect(totals.netVarianceValue.toFixed(2)).toBe('-66.50');
  });

  it('counts the units of a variant without a price but gives it no value', () => {
    const { lines, totals } = varianceReport([
      line({ expectedQuantity: 2, countedQuantity: 0, variance: -2, unitPrice: null }),
    ]);

    expect(lines[0].varianceValue).toBeNull();
    expect(totals.shortageUnits).toBe(2);
    expect(totals.shortageValue.toFixed(2)).toBe('0.00');
  });
});

describe('varianceReport at cost (P4-E.1)', () => {
  it('values variances at the weighted-average cost, totalling only lines whose cost is known', () => {
    const { lines, totals } = varianceReport([
      line({
        variantId: 'v1',
        expectedQuantity: 8,
        countedQuantity: 5,
        variance: -3,
        unitCost: new Decimal('12.3456'),
      }),
      line({ variantId: 'v2', expectedQuantity: 5, countedQuantity: 7, variance: 2, unitCost: new Decimal('4.5') }),
      line({ variantId: 'v3', expectedQuantity: 5, countedQuantity: 4, variance: -1 }),
    ]);

    expect(lines.map((l) => l.varianceCostValue?.toFixed(4) ?? null)).toEqual(['-37.0368', '9.0000', null]);
    expect(totals.shortageCostValue.toFixed(4)).toBe('37.0368');
    expect(totals.surplusCostValue.toFixed(4)).toBe('9.0000');
    expect(totals.netVarianceCostValue.toFixed(4)).toBe('-28.0368');
    expect(totals.shortageValue.toFixed(2)).toBe('102.00');
  });
});

describe('variancesToPost', () => {
  it('keeps the counted lines that differ, in variant order', () => {
    const posted = variancesToPost([
      { variantId: 'v3', variance: 2 },
      { variantId: 'v1', variance: -1 },
      { variantId: 'v2', variance: 0 },
      { variantId: 'v0', variance: null },
    ]);

    expect(posted).toEqual([
      { variantId: 'v1', variance: -1 },
      { variantId: 'v3', variance: 2 },
    ]);
  });
});
