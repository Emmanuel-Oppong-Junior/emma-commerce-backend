import {
  cleanText,
  keptDeliveredUnits,
  moderationRefusal,
  PurchasedLine,
  ratingDistribution,
  ratingSummary,
  reportRefusal,
  verifyingLine,
} from './review-rules';

const line = (overrides: Partial<PurchasedLine> = {}): PurchasedLine => ({
  orderItemId: 'item-1',
  orderStatus: 'IN_FULFILMENT',
  orderedAt: new Date('2026-11-01T10:00:00Z'),
  quantity: 2,
  deliveredUnits: 0,
  refundedUnits: 0,
  ...overrides,
});

describe('verified purchase', () => {
  it('counts units in delivered shipments', () => {
    expect(keptDeliveredUnits(line({ deliveredUnits: 1 }))).toBe(1);
  });

  it('counts nothing before any shipment is delivered', () => {
    expect(keptDeliveredUnits(line({ orderStatus: 'CONFIRMED' }))).toBe(0);
    expect(verifyingLine([line({ orderStatus: 'CONFIRMED' })])).toBeNull();
  });

  it('counts every unrefunded unit of a COMPLETED order, even one without shipment rows', () => {
    expect(keptDeliveredUnits(line({ orderStatus: 'COMPLETED' }))).toBe(2);
    expect(keptDeliveredUnits(line({ orderStatus: 'COMPLETED', refundedUnits: 1 }))).toBe(1);
  });

  it('does not count a fully refunded line', () => {
    expect(keptDeliveredUnits(line({ orderStatus: 'COMPLETED', refundedUnits: 2 }))).toBe(0);
    expect(keptDeliveredUnits(line({ deliveredUnits: 2, refundedUnits: 2 }))).toBe(0);
    expect(verifyingLine([line({ orderStatus: 'COMPLETED', refundedUnits: 2 })])).toBeNull();
  });

  it('keeps a delivered unit when only the undelivered one was refunded', () => {
    expect(keptDeliveredUnits(line({ deliveredUnits: 1, refundedUnits: 1 }))).toBe(1);
  });

  it('picks the latest qualifying line', () => {
    const lines = [
      line({ orderItemId: 'old', orderStatus: 'COMPLETED', orderedAt: new Date('2026-10-01T00:00:00Z') }),
      line({ orderItemId: 'new', deliveredUnits: 1, orderedAt: new Date('2026-11-05T00:00:00Z') }),
      line({ orderItemId: 'newest-undelivered', orderedAt: new Date('2026-11-10T00:00:00Z') }),
    ];

    expect(verifyingLine(lines)).toBe('new');
    expect(verifyingLine([])).toBeNull();
  });
});

describe('rating aggregate', () => {
  it('has no average without published reviews', () => {
    expect(ratingSummary(ratingDistribution([]))).toEqual({
      ratingCount: 0,
      ratingAverage: null,
      rating1Count: 0,
      rating2Count: 0,
      rating3Count: 0,
      rating4Count: 0,
      rating5Count: 0,
    });
  });

  it('counts per star and averages half-up to 2 decimals', () => {
    const summary = ratingSummary(
      ratingDistribution([
        { score: 5, count: 1 },
        { score: 4, count: 1 },
        { score: 4, count: 1 },
      ]),
    );

    expect(summary.ratingCount).toBe(3);
    expect(summary.rating4Count).toBe(2);
    expect(summary.rating5Count).toBe(1);
    expect(summary.ratingAverage?.toFixed(2)).toBe('4.33');
    expect(ratingSummary([0, 0, 1, 0, 1]).ratingAverage?.toFixed(2)).toBe('4.00');
    expect(ratingSummary([1, 0, 0, 0, 7]).ratingAverage?.toFixed(2)).toBe('4.50');
    expect(ratingSummary([0, 1, 0, 1, 1]).ratingAverage?.toFixed(2)).toBe('3.67');
  });

  it('follows the published set through edit, hide, unhide and delete', () => {
    // 5 and 3 published; the 3 is edited to 1, then hidden, then unhidden, then deleted.
    expect(ratingSummary([0, 0, 1, 0, 1]).ratingAverage?.toFixed(2)).toBe('4.00');
    expect(ratingSummary([1, 0, 0, 0, 1]).ratingAverage?.toFixed(2)).toBe('3.00');
    expect(ratingSummary([0, 0, 0, 0, 1])).toMatchObject({ ratingCount: 1, rating1Count: 0 });
    expect(ratingSummary([1, 0, 0, 0, 1])).toMatchObject({ ratingCount: 2, rating1Count: 1 });
    expect(ratingSummary([0, 0, 0, 0, 1]).ratingAverage?.toFixed(2)).toBe('5.00');
  });

  it('refuses a score outside 1-5', () => {
    expect(() => ratingDistribution([{ score: 6, count: 1 }])).toThrow('outside 1-5');
  });
});

describe('moderation and reports', () => {
  it('hides only published content and unhides only hidden content', () => {
    expect(moderationRefusal('PUBLISHED', 'HIDE')).toBeNull();
    expect(moderationRefusal('HIDDEN', 'UNHIDE')).toBeNull();
    expect(moderationRefusal('HIDDEN', 'HIDE')).toMatch(/already hidden/);
    expect(moderationRefusal('PUBLISHED', 'UNHIDE')).toMatch(/not hidden/);
  });

  it('refuses reporting your own content', () => {
    expect(reportRefusal('user-1', 'user-1')).toMatch(/your own/);
    expect(reportRefusal('user-1', 'user-2')).toBeNull();
  });

  it('trims text and treats blank as none', () => {
    expect(cleanText('  Nice  ')).toBe('Nice');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});
