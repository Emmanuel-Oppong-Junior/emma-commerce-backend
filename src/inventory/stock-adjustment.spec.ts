import { manualAdjustmentError, MANUAL_ADJUSTMENT_REASONS } from './stock-adjustment';

describe('manualAdjustmentError', () => {
  it('accepts every manual reason in the direction it allows', () => {
    expect(manualAdjustmentError({ delta: -2, reason: 'DAMAGED' })).toBeNull();
    expect(manualAdjustmentError({ delta: -1, reason: 'LOST' })).toBeNull();
    expect(manualAdjustmentError({ delta: -5, reason: 'EXPIRED' })).toBeNull();
    expect(manualAdjustmentError({ delta: 3, reason: 'FOUND' })).toBeNull();
    expect(manualAdjustmentError({ delta: 4, reason: 'CORRECTION' })).toBeNull();
    expect(manualAdjustmentError({ delta: -4, reason: 'CORRECTION' })).toBeNull();
    expect(manualAdjustmentError({ delta: 1, reason: 'OTHER', note: 'Supplier sample' })).toBeNull();
  });

  it('keeps STOCK_TAKE for approved stock-takes', () => {
    expect(MANUAL_ADJUSTMENT_REASONS).not.toContain('STOCK_TAKE');
    expect(manualAdjustmentError({ delta: -1, reason: 'STOCK_TAKE' })).toBe('STOCK_TAKE cannot be given by hand');
  });

  it('refuses a zero or fractional change', () => {
    expect(manualAdjustmentError({ delta: 0, reason: 'CORRECTION' })).toMatch(/non-zero whole number, got 0/);
    expect(manualAdjustmentError({ delta: 1.5, reason: 'CORRECTION' })).toMatch(/got 1.5/);
  });

  it('refuses a write-off reason that adds stock, and FOUND that removes it', () => {
    for (const reason of ['DAMAGED', 'LOST', 'EXPIRED'] as const) {
      expect(manualAdjustmentError({ delta: 2, reason })).toBe(
        `${reason} can only remove stock: send a negative delta`,
      );
    }
    expect(manualAdjustmentError({ delta: -2, reason: 'FOUND' })).toBe(
      'FOUND can only add stock: send a positive delta',
    );
  });

  it('requires a note, not just spaces, for OTHER', () => {
    expect(manualAdjustmentError({ delta: -1, reason: 'OTHER' })).toBe('A note is required when the reason is OTHER');
    expect(manualAdjustmentError({ delta: -1, reason: 'OTHER', note: '   ' })).toBe(
      'A note is required when the reason is OTHER',
    );
  });
});
