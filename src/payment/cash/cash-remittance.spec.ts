import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  assertCollectionsRemittable,
  assertReceivedAt,
  assertRemittanceNotEmpty,
  assertRemittingRider,
  DiscrepancyKind,
  remittanceNote,
  remittanceTotals,
} from './cash-remittance';

const d = (value: string) => new Prisma.Decimal(value);
const collections = [{ amount: d('250.50') }, { amount: d('99.50') }];

describe('cash remittance rules', () => {
  describe('remittanceTotals', () => {
    it('matches when the cash equals the collections', () => {
      const totals = remittanceTotals(collections, d('350'));

      expect(totals.expectedAmount.toFixed(2)).toBe('350.00');
      expect(totals.discrepancy.toFixed(2)).toBe('0.00');
      expect(totals.kind).toBeNull();
    });

    it('is SHORT by the missing cash and OVER by the extra, to the pesewa', () => {
      const short = remittanceTotals(collections, d('329.99'));
      const over = remittanceTotals(collections, d('350.01'));

      expect(short.discrepancy.toFixed(2)).toBe('-20.01');
      expect(short.kind).toBe(DiscrepancyKind.SHORT);
      expect(over.discrepancy.toFixed(2)).toBe('0.01');
      expect(over.kind).toBe(DiscrepancyKind.OVER);
    });

    it('treats cash with no collections (an adjusting entry) as all over', () => {
      const totals = remittanceTotals([], d('20'));

      expect(totals.expectedAmount.toFixed(2)).toBe('0.00');
      expect(totals.discrepancy.toFixed(2)).toBe('20.00');
      expect(totals.kind).toBe(DiscrepancyKind.OVER);
    });
  });

  describe('remittanceNote', () => {
    it('needs no note when the remittance matches, and drops a blank one', () => {
      expect(remittanceNote(remittanceTotals(collections, d('350')), '  ')).toBeNull();
    });

    it('requires a note for a discrepancy (DISCREPANCY_NOTE_REQUIRED) and trims the one given', () => {
      const short = remittanceTotals(collections, d('330'));

      expect(() => remittanceNote(short, undefined)).toThrow(BadRequestException);
      expect(() => remittanceNote(short, '   ')).toThrow(
        'The remittance is short by 20.00 (expected 350.00); add a note explaining the difference',
      );
      expect(remittanceNote(short, '  Customer paid 20 by MoMo  ')).toBe('Customer paid 20 by MoMo');
    });
  });

  describe('assertRemittanceNotEmpty', () => {
    it('refuses no collections with no cash, and a collection listed twice', () => {
      expect(() => assertRemittanceNotEmpty([], d('0'))).toThrow(BadRequestException);
      expect(() => assertRemittanceNotEmpty(['c1', 'c1'], d('10'))).toThrow('A collection is listed more than once');
    });

    it('accepts collections with no cash (all short) and cash with no collections', () => {
      expect(() => assertRemittanceNotEmpty(['c1'], d('0'))).not.toThrow();
      expect(() => assertRemittanceNotEmpty([], d('5'))).not.toThrow();
    });
  });

  describe('assertReceivedAt', () => {
    it('accepts a past time and refuses one well in the future', () => {
      const now = new Date('2026-11-22T12:00:00Z');

      expect(() => assertReceivedAt(new Date('2026-11-21T12:00:00Z'), now)).not.toThrow();
      expect(() => assertReceivedAt(new Date('2026-11-22T13:00:00Z'), now)).toThrow(/in the future/);
    });
  });

  describe('assertCollectionsRemittable', () => {
    const own = { id: 'c1', riderId: 'r1', remittanceId: null };

    it("accepts the rider's unremitted collections", () => {
      expect(() => assertCollectionsRemittable(['c1'], [own], 'r1')).not.toThrow();
    });

    it('refuses an unknown collection (NOT_FOUND), another rider’s (BAD_REQUEST) and a remitted one (CONFLICT)', () => {
      expect(() => assertCollectionsRemittable(['c1', 'c9'], [own], 'r1')).toThrow(NotFoundException);
      expect(() => assertCollectionsRemittable(['c1'], [{ ...own, riderId: 'r2' }], 'r1')).toThrow(BadRequestException);
      expect(() => assertCollectionsRemittable(['c1'], [{ ...own, riderId: null }], 'r1')).toThrow(BadRequestException);
      expect(() => assertCollectionsRemittable(['c1'], [{ ...own, remittanceId: 'rem0' }], 'r1')).toThrow(
        ConflictException,
      );
    });
  });

  describe('assertRemittingRider', () => {
    it('accepts an active staff member, and a former rider who still owes collected cash', () => {
      expect(() => assertRemittingRider({ isActive: true, isStaff: true, hasCollections: false }, 'r1')).not.toThrow();
      expect(() => assertRemittingRider({ isActive: false, isStaff: false, hasCollections: true }, 'r1')).not.toThrow();
    });

    it('refuses an unknown user, a customer and an archived staff member who never collected', () => {
      expect(() => assertRemittingRider(null, 'r1')).toThrow(BadRequestException);
      expect(() => assertRemittingRider({ isActive: true, isStaff: false, hasCollections: false }, 'r1')).toThrow(
        BadRequestException,
      );
      expect(() => assertRemittingRider({ isActive: false, isStaff: true, hasCollections: false }, 'r1')).toThrow(
        BadRequestException,
      );
    });
  });
});
