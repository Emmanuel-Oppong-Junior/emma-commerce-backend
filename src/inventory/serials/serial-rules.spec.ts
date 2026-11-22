import { SerialUnitStatus } from '../../generated/prisma/client';
import {
  assertNoSerialisedOpeningStock,
  assignmentProblem,
  canSerialTransition,
  linesNotReadyToDispatch,
  serialCountProblem,
  serialStatusesFrom,
  trackSerialsChangeProblem,
  warrantyWindow,
} from './serial-rules';

const S = SerialUnitStatus;

describe('serial rules', () => {
  describe('transitions', () => {
    it.each([
      [S.IN_STOCK, S.ASSIGNED],
      [S.IN_STOCK, S.IN_TRANSIT],
      [S.IN_STOCK, S.WRITTEN_OFF],
      [S.ASSIGNED, S.IN_STOCK],
      [S.ASSIGNED, S.SOLD],
      [S.SOLD, S.IN_STOCK],
      [S.IN_TRANSIT, S.IN_STOCK],
      [S.IN_TRANSIT, S.WRITTEN_OFF],
      [S.WRITTEN_OFF, S.IN_STOCK],
    ])('allows %s -> %s', (from, to) => {
      expect(canSerialTransition(from, to)).toBe(true);
    });

    it.each([
      [S.IN_STOCK, S.SOLD],
      [S.ASSIGNED, S.IN_TRANSIT],
      [S.ASSIGNED, S.WRITTEN_OFF],
      [S.SOLD, S.ASSIGNED],
      [S.SOLD, S.WRITTEN_OFF],
      [S.IN_TRANSIT, S.ASSIGNED],
      [S.WRITTEN_OFF, S.SOLD],
      [S.IN_STOCK, S.IN_STOCK],
    ])('refuses %s -> %s', (from, to) => {
      expect(canSerialTransition(from, to)).toBe(false);
    });

    it('lists the statuses each status is reached from', () => {
      expect(serialStatusesFrom(S.IN_STOCK).sort()).toEqual([S.ASSIGNED, S.IN_TRANSIT, S.SOLD, S.WRITTEN_OFF].sort());
      expect(serialStatusesFrom(S.SOLD)).toEqual([S.ASSIGNED]);
      expect(serialStatusesFrom(S.WRITTEN_OFF).sort()).toEqual([S.IN_STOCK, S.IN_TRANSIT].sort());
    });
  });

  describe('serialCountProblem', () => {
    it('needs one serial per unit', () => {
      expect(serialCountProblem(2, ['A', 'B'])).toBeNull();
      expect(serialCountProblem(2, undefined)).toContain('name the 2 units by serial');
      expect(serialCountProblem(1, [])).toContain('name the 1 unit by serial');
      expect(serialCountProblem(3, ['A', 'B'])).toBe('Name exactly 3 serials, one per unit; got 2');
      expect(serialCountProblem(1, ['A', 'B'])).toBe('Name exactly 1 serial, one per unit; got 2');
    });
  });

  describe('dispatch readiness', () => {
    it('holds back every serialised line without exactly its quantity assigned', () => {
      const lines = [
        { orderItemId: 'full', quantity: 2, assigned: 2 },
        { orderItemId: 'short', quantity: 2, assigned: 1 },
        { orderItemId: 'none', quantity: 1, assigned: 0 },
      ];

      expect(linesNotReadyToDispatch(lines).map((line) => line.orderItemId)).toEqual(['short', 'none']);
      expect(linesNotReadyToDispatch([lines[0]])).toEqual([]);
      expect(linesNotReadyToDispatch([])).toEqual([]);
    });

    it('never lets a line hold more units than its quantity', () => {
      expect(assignmentProblem({ orderItemId: 'l1', quantity: 2, assigned: 1 }, 1)).toBeNull();
      expect(assignmentProblem({ orderItemId: 'l1', quantity: 2, assigned: 1 }, 2)).toContain(
        '2 more would be too many',
      );
    });
  });

  describe('warrantyWindow', () => {
    it('ends the given number of months after delivery', () => {
      const deliveredAt = new Date('2026-03-15T10:30:00.000Z');

      expect(warrantyWindow(deliveredAt, 12)).toEqual({
        startsAt: deliveredAt,
        endsAt: new Date('2027-03-15T10:30:00.000Z'),
      });
    });

    it('ends on the last day of a shorter month', () => {
      expect(warrantyWindow(new Date('2026-01-31T08:00:00.000Z'), 1)?.endsAt).toEqual(
        new Date('2026-02-28T08:00:00.000Z'),
      );
      expect(warrantyWindow(new Date('2027-08-31T08:00:00.000Z'), 6)?.endsAt).toEqual(
        new Date('2028-02-29T08:00:00.000Z'),
      );
    });

    it('is null without a warranty', () => {
      expect(warrantyWindow(new Date(), null)).toBeNull();
    });
  });

  describe('trackSerialsChangeProblem', () => {
    const clean = { onHand: 0, inTransit: 0, openOrderLines: 0, trackedUnits: 0 };

    it('turns on only without untracked stock', () => {
      expect(trackSerialsChangeProblem(true, clean)).toBeNull();
      expect(trackSerialsChangeProblem(true, { ...clean, trackedUnits: 4 })).toBeNull();
      expect(trackSerialsChangeProblem(true, { ...clean, onHand: 3, inTransit: 1, openOrderLines: 2 })).toContain(
        '3 on hand, 1 in transit, 2 open order lines',
      );
    });

    it('turns off only when no unit is in stock, assigned or in transit', () => {
      expect(trackSerialsChangeProblem(false, { ...clean, onHand: 5 })).toBeNull();
      expect(trackSerialsChangeProblem(false, { ...clean, trackedUnits: 1 })).toContain('1 serial unit is');
    });
  });

  describe('assertNoSerialisedOpeningStock', () => {
    it('refuses opening stock on a product that tracks serials only', () => {
      expect(() => assertNoSerialisedOpeningStock(true, [{ quantity: 0 }, { quantity: 1 }])).toThrow(
        'receive the units with their serials',
      );
      expect(() => assertNoSerialisedOpeningStock(true, [{ quantity: 0 }])).not.toThrow();
      expect(() => assertNoSerialisedOpeningStock(false, [{ quantity: 5 }])).not.toThrow();
    });
  });
});
