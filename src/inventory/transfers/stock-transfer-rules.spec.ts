import { StockTransferStatus } from '../../generated/prisma/client';
import { canTransferTransition, MAX_TRANSFER_LINES, receiptOf, transferDraftProblem } from './stock-transfer-rules';

const { DRAFT, DISPATCHED, RECEIVED, PARTIALLY_RECEIVED, CANCELLED } = StockTransferStatus;

describe('canTransferTransition', () => {
  it.each([
    [DRAFT, DISPATCHED],
    [DRAFT, CANCELLED],
    [DISPATCHED, RECEIVED],
    [DISPATCHED, PARTIALLY_RECEIVED],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransferTransition(from, to)).toBe(true);
  });

  it.each([
    [DRAFT, RECEIVED],
    [DISPATCHED, CANCELLED],
    [DISPATCHED, DISPATCHED],
    [RECEIVED, PARTIALLY_RECEIVED],
    [PARTIALLY_RECEIVED, RECEIVED],
    [CANCELLED, DISPATCHED],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransferTransition(from, to)).toBe(false);
  });
});

describe('transferDraftProblem', () => {
  const line = { variantId: 'v1', quantity: 2 };

  it('accepts two locations and valid lines', () => {
    expect(transferDraftProblem('a', 'b', [line, { variantId: 'v2', quantity: 1 }])).toBeNull();
  });

  it('refuses the same location at both ends', () => {
    expect(transferDraftProblem('a', 'a', [line])).toMatch(/two different locations/);
  });

  it('refuses no lines and too many lines', () => {
    expect(transferDraftProblem('a', 'b', [])).toMatch(/at least one line/);
    const many = Array.from({ length: MAX_TRANSFER_LINES + 1 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 }));
    expect(transferDraftProblem('a', 'b', many)).toMatch(/at most/);
  });

  it('refuses a variant twice and a quantity below 1', () => {
    expect(transferDraftProblem('a', 'b', [line, line])).toMatch(/only once/);
    expect(transferDraftProblem('a', 'b', [{ variantId: 'v1', quantity: 0 }])).toMatch(/at least 1/);
  });
});

describe('receiptOf', () => {
  const dispatched = [
    { variantId: 'v1', quantity: 5 },
    { variantId: 'v2', quantity: 3 },
  ];

  it('receives every line in full when nothing is said', () => {
    expect(receiptOf(dispatched, [])).toEqual({
      problem: null,
      status: RECEIVED,
      lines: [
        { variantId: 'v1', quantity: 5, receivedQuantity: 5, variance: 0, varianceNote: null },
        { variantId: 'v2', quantity: 3, receivedQuantity: 3, variance: 0, varianceNote: null },
      ],
    });
  });

  it('records a shortfall as a variance with its note and makes the transfer partially received', () => {
    const outcome = receiptOf(dispatched, [{ variantId: 'v1', receivedQuantity: 3, note: ' Two crushed ' }]);

    expect(outcome).toEqual({
      problem: null,
      status: PARTIALLY_RECEIVED,
      lines: [
        { variantId: 'v1', quantity: 5, receivedQuantity: 3, variance: 2, varianceNote: 'Two crushed' },
        { variantId: 'v2', quantity: 3, receivedQuantity: 3, variance: 0, varianceNote: null },
      ],
    });
  });

  it('needs a note for a shortfall', () => {
    expect(receiptOf(dispatched, [{ variantId: 'v1', receivedQuantity: 4, note: '  ' }]).problem).toMatch(
      /Explain the shortfall of 1/,
    );
  });

  it('refuses receiving more than was dispatched, a negative quantity, an unknown or repeated variant', () => {
    expect(receiptOf(dispatched, [{ variantId: 'v1', receivedQuantity: 6 }]).problem).toMatch(/between 0 and 5/);
    expect(receiptOf(dispatched, [{ variantId: 'v1', receivedQuantity: -1 }]).problem).toMatch(/between 0 and 5/);
    expect(receiptOf(dispatched, [{ variantId: 'v9', receivedQuantity: 1 }]).problem).toMatch(/not on this transfer/);
    expect(
      receiptOf(dispatched, [
        { variantId: 'v1', receivedQuantity: 5 },
        { variantId: 'v1', receivedQuantity: 5 },
      ]).problem,
    ).toMatch(/only once/);
  });

  it('accepts nothing received on a line, with a note', () => {
    const outcome = receiptOf(dispatched, [{ variantId: 'v2', receivedQuantity: 0, note: 'Lost in transit' }]);

    expect(outcome).toMatchObject({ problem: null, status: PARTIALLY_RECEIVED });
  });
});
