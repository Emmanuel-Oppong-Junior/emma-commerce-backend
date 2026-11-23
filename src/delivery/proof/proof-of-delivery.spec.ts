import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import {
  assertCashClaim,
  assertCodeAccepted,
  assertConfirmable,
  assertDeliveryPhoto,
  assertPosition,
  codeFailureKind,
  proofMethod,
} from './proof-of-delivery';

function refusal(run: () => unknown): { type: unknown; reason?: string } {
  try {
    run();
  } catch (error) {
    const response = (error as HttpException).getResponse() as { extensions?: { reason?: string } };
    return { type: (error as object).constructor, reason: response.extensions?.reason };
  }
  throw new Error('expected an error');
}

describe('proof of delivery rules', () => {
  describe('proofMethod', () => {
    it('is the code, or an override with a reason by someone allowed to override', () => {
      expect(proofMethod({ code: '123456' }, false)).toBe('CODE');
      expect(proofMethod({ overrideReason: 'Customer has no phone' }, true)).toBe('OVERRIDE');
    });

    it('refuses no proof, both proofs, or an override without delivery.override', () => {
      expect(refusal(() => proofMethod({}, true))).toEqual({
        type: BadRequestException,
        reason: 'PROOF_OF_DELIVERY_REQUIRED',
      });
      expect(refusal(() => proofMethod({ code: ' ', overrideReason: '  ' }, true)).reason).toBe(
        'PROOF_OF_DELIVERY_REQUIRED',
      );
      expect(refusal(() => proofMethod({ code: '1', overrideReason: 'x' }, true)).reason).toBe(
        'PROOF_OF_DELIVERY_REQUIRED',
      );
      expect(refusal(() => proofMethod({ overrideReason: 'x' }, false))).toEqual({
        type: ForbiddenException,
        reason: 'OVERRIDE_NOT_ALLOWED',
      });
    });
  });

  describe('assertConfirmable', () => {
    const at = new Date('2026-11-23T09:00:00Z');

    it('returns the dispatch of a rider’s shipment out for delivery', () => {
      expect(assertConfirmable({ id: 's1', status: 'OUT_FOR_DELIVERY', riderId: 'r1', dispatchedAt: at })).toBe(at);
    });

    it('refuses a shipment without a rider, or not out for delivery', () => {
      expect(
        refusal(() => assertConfirmable({ id: 's1', status: 'OUT_FOR_DELIVERY', riderId: null, dispatchedAt: at })),
      ).toEqual({ type: BadRequestException, reason: 'RIDER_NOT_ASSIGNED' });
      expect(
        refusal(() => assertConfirmable({ id: 's1', status: 'FAILED_DELIVERY', riderId: 'r1', dispatchedAt: at })).type,
      ).toBe(ConflictException);
    });
  });

  describe('assertCodeAccepted', () => {
    it.each([
      [{ result: 'MISMATCH', attemptsLeft: 3 }, 'DELIVERY_CODE_INVALID', 'WRONG_CODE'],
      [{ result: 'LOCKED' }, 'DELIVERY_CODE_LOCKED', 'LOCKED'],
      [{ result: 'NOT_ISSUED' }, 'DELIVERY_CODE_NOT_ISSUED', 'NOT_ISSUED'],
    ] as const)('refuses %p (%s), counted as %s', (check, reason, kind) => {
      expect(refusal(() => assertCodeAccepted(check))).toEqual({ type: BadRequestException, reason });
      expect(codeFailureKind(check)).toBe(kind);
    });

    it('accepts a match', () => {
      expect(() => assertCodeAccepted({ result: 'MATCH' })).not.toThrow();
      expect(codeFailureKind({ result: 'MATCH' })).toBeNull();
    });
  });

  describe('assertCashClaim (cash on delivery is recorded with the delivery)', () => {
    it('needs the cash for COD and refuses it for an order paid online', () => {
      expect(() => assertCashClaim('CASH_ON_DELIVERY', '40.00')).not.toThrow();
      expect(() => assertCashClaim('ONLINE', undefined)).not.toThrow();
      expect(refusal(() => assertCashClaim('CASH_ON_DELIVERY', undefined)).reason).toBe('CASH_COLLECTION_REQUIRED');
      expect(refusal(() => assertCashClaim('ONLINE', '40.00')).reason).toBe('NO_CASH_TO_COLLECT');
    });
  });

  it('takes only photos uploaded for the shipment, and a position as a pair', () => {
    expect(() => assertDeliveryPhoto('s1', undefined)).not.toThrow();
    expect(() => assertDeliveryPhoto('s1', 'proof-of-delivery/s1/abc')).not.toThrow();
    expect(refusal(() => assertDeliveryPhoto('s1', 'proof-of-delivery/s2/abc')).reason).toBe('INVALID_DELIVERY_PHOTO');
    expect(refusal(() => assertDeliveryPhoto('s1', 'ecommerce/abc')).reason).toBe('INVALID_DELIVERY_PHOTO');
    expect(() => assertPosition(5.5, -0.2)).not.toThrow();
    expect(() => assertPosition(5.5, undefined)).toThrow(BadRequestException);
  });
});
