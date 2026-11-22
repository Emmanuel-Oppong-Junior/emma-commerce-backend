import { ConflictException } from '@nestjs/common';
import {
  ACTIVE_STOCK_TAKE_STATUSES,
  assertStockTakeTransition,
  canStockTakeTransition,
  stockTakeStatusesFrom,
} from './stock-take-status';

describe('stock-take status machine', () => {
  it('goes OPEN -> SUBMITTED -> APPROVED', () => {
    expect(canStockTakeTransition('OPEN', 'SUBMITTED')).toBe(true);
    expect(canStockTakeTransition('SUBMITTED', 'APPROVED')).toBe(true);
  });

  it('cancels only before approval', () => {
    expect(stockTakeStatusesFrom('CANCELLED')).toEqual(['OPEN', 'SUBMITTED']);
    expect(canStockTakeTransition('APPROVED', 'CANCELLED')).toBe(false);
  });

  it('never approves an open session or reopens a submitted one', () => {
    expect(canStockTakeTransition('OPEN', 'APPROVED')).toBe(false);
    expect(canStockTakeTransition('SUBMITTED', 'OPEN')).toBe(false);
    expect(stockTakeStatusesFrom('APPROVED')).toEqual(['SUBMITTED']);
  });

  it('treats APPROVED and CANCELLED as final', () => {
    for (const to of ['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED'] as const) {
      expect(canStockTakeTransition('APPROVED', to)).toBe(false);
      expect(canStockTakeTransition('CANCELLED', to)).toBe(false);
    }
  });

  it('holds the location while OPEN or SUBMITTED', () => {
    expect(ACTIVE_STOCK_TAKE_STATUSES).toEqual(['OPEN', 'SUBMITTED']);
  });

  it('refuses a move the table does not allow with a conflict naming the session', () => {
    expect(() => assertStockTakeTransition('st1', 'APPROVED', 'CANCELLED')).toThrow(
      new ConflictException('Stock-take "st1" cannot move from APPROVED to CANCELLED'),
    );
    expect(() => assertStockTakeTransition('st1', 'OPEN', 'SUBMITTED')).not.toThrow();
  });
});
