import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  assertCollectedAmount,
  assertCollectedAt,
  assertCollector,
  assertStaffRider,
  COLLECTED_AT_CLOCK_SKEW_MS,
} from './cash-collection';

describe('cash collection rules', () => {
  describe('assertStaffRider', () => {
    it('accepts an active staff member', () => {
      expect(() => assertStaffRider({ isActive: true, isStaff: true }, 'u1')).not.toThrow();
    });

    it.each([null, { isActive: true, isStaff: false }, { isActive: false, isStaff: true }])('refuses %p', (rider) => {
      expect(() => assertStaffRider(rider, 'u1')).toThrow(BadRequestException);
    });
  });

  describe('assertCollector', () => {
    const reasonOf = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return ((error as BadRequestException).getResponse() as { extensions: { reason: string } }).extensions.reason;
      }
      return null;
    };

    it('needs a rider for a delivery', () => {
      expect(reasonOf(() => assertCollector({ isActive: true, isStaff: true, isRider: true }, 'u1', 'DELIVERY'))).toBe(
        null,
      );
      expect(reasonOf(() => assertCollector({ isActive: true, isStaff: true, isRider: false }, 'u1', 'DELIVERY'))).toBe(
        'NOT_A_RIDER',
      );
      expect(reasonOf(() => assertCollector({ isActive: false, isStaff: true, isRider: true }, 'u1', 'DELIVERY'))).toBe(
        'RIDER_NOT_STAFF',
      );
    });

    it('takes any active staff member at the pickup counter', () => {
      expect(reasonOf(() => assertCollector({ isActive: true, isStaff: true, isRider: false }, 'u1', 'PICKUP'))).toBe(
        null,
      );
      expect(reasonOf(() => assertCollector(null, 'u1', 'PICKUP'))).toBe('RIDER_NOT_STAFF');
    });
  });

  describe('assertCollectedAmount', () => {
    it('accepts the amount due written with any scale', () => {
      expect(() => assertCollectedAmount(new Prisma.Decimal('250.50'), new Prisma.Decimal('250.5'))).not.toThrow();
    });

    it('refuses anything else', () => {
      expect(() => assertCollectedAmount(new Prisma.Decimal('250.50'), new Prisma.Decimal('250.49'))).toThrow(
        'The cash collected (250.49) must equal the amount due (250.50)',
      );
    });
  });

  describe('assertCollectedAt', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    const dispatchedAt = new Date('2026-11-22T09:00:00Z');

    it('accepts a time between dispatch and now, and a few minutes of clock skew', () => {
      expect(() => assertCollectedAt(dispatchedAt, now, dispatchedAt)).not.toThrow();
      expect(() =>
        assertCollectedAt(new Date(now.getTime() + COLLECTED_AT_CLOCK_SKEW_MS), now, dispatchedAt),
      ).not.toThrow();
    });

    it('refuses a time beyond the skew or before dispatch', () => {
      expect(() =>
        assertCollectedAt(new Date(now.getTime() + COLLECTED_AT_CLOCK_SKEW_MS + 1), now, dispatchedAt),
      ).toThrow(/in the future/);
      expect(() => assertCollectedAt(new Date(dispatchedAt.getTime() - 1), now, dispatchedAt)).toThrow(
        /before the order was dispatched/,
      );
    });

    it('skips the dispatch check for shipments migrated without a dispatch time', () => {
      expect(() => assertCollectedAt(new Date('2020-01-01T00:00:00Z'), now, null)).not.toThrow();
    });
  });
});
