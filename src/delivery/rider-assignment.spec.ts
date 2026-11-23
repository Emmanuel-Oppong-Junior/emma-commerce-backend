import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { FulfillmentType, ShipmentStatus } from '../generated/prisma/client';
import { assertRider, decideAssignment, decideUnassignment, isRider, riderMayMove } from './rider-assignment';

const S = ShipmentStatus;
const DELIVERY = FulfillmentType.DELIVERY;

function reasonOf(run: () => unknown): { type: unknown; reason?: string } {
  try {
    run();
  } catch (error) {
    const response = (error as HttpException).getResponse() as { extensions?: { reason?: string } };
    return { type: (error as object).constructor, reason: response.extensions?.reason };
  }
  throw new Error('expected an error');
}

describe('rider rules', () => {
  describe('isRider / assertRider', () => {
    it('is an active staff member whose role lists delivery.ride', () => {
      expect(isRider({ isActive: true, role: { key: 'RIDER', permissions: ['delivery.ride'] } })).toBe(true);
      expect(isRider({ isActive: true, role: { key: 'CUSTOM', permissions: ['order.view', 'delivery.ride'] } })).toBe(
        true,
      );
    });

    it.each([
      ['unknown', null],
      ['archived', { isActive: false, role: { key: 'RIDER', permissions: ['delivery.ride'] } }],
      ['a customer', { isActive: true, role: null }],
      ['staff without delivery.ride', { isActive: true, role: { key: 'CASHIER', permissions: ['order.view'] } }],
      [
        'the Owner (whose role lists every permission)',
        { isActive: true, role: { key: 'OWNER', permissions: ['delivery.ride'] } },
      ],
    ])('is not %s', (_case, user) => {
      expect(isRider(user)).toBe(false);
      expect(reasonOf(() => assertRider(user, 'u1'))).toEqual({ type: BadRequestException, reason: 'NOT_A_RIDER' });
    });
  });

  describe('decideAssignment', () => {
    const shipment = (status: ShipmentStatus, riderId: string | null = null) => ({ id: 's1', status, riderId });

    it.each([S.PENDING, S.PICKING, S.PACKED, S.FAILED_DELIVERY])('assigns a first rider while %s', (status) => {
      expect(decideAssignment(DELIVERY, shipment(status), 'r1', undefined)).toBe(true);
    });

    it.each([S.PENDING, S.PICKING, S.PACKED])('reassigns freely before dispatch (%s)', (status) => {
      expect(decideAssignment(DELIVERY, shipment(status, 'r1'), 'r2', undefined)).toBe(true);
    });

    it.each([S.OUT_FOR_DELIVERY, S.FAILED_DELIVERY])('reassigns after dispatch (%s) only with a reason', (status) => {
      expect(reasonOf(() => decideAssignment(DELIVERY, shipment(status, 'r1'), 'r2', '  '))).toEqual({
        type: BadRequestException,
        reason: 'ASSIGNMENT_REASON_REQUIRED',
      });
      expect(decideAssignment(DELIVERY, shipment(status, 'r1'), 'r2', 'Bike broke down')).toBe(true);
    });

    it('does nothing when the rider already has it', () => {
      expect(decideAssignment(DELIVERY, shipment(S.OUT_FOR_DELIVERY, 'r1'), 'r1', undefined)).toBe(false);
    });

    it('refuses a first rider on a shipment already out for delivery', () => {
      expect(reasonOf(() => decideAssignment(DELIVERY, shipment(S.OUT_FOR_DELIVERY), 'r1', 'late'))).toEqual({
        type: ConflictException,
        reason: 'ASSIGN_BEFORE_DISPATCH',
      });
    });

    it.each([S.DELIVERED, S.RETURNED, S.CANCELLED])('refuses a %s shipment', (status) => {
      expect(reasonOf(() => decideAssignment(DELIVERY, shipment(status), 'r1', 'x'))).toEqual({
        type: ConflictException,
        reason: 'SHIPMENT_CLOSED',
      });
    });

    it('refuses a pickup shipment', () => {
      expect(reasonOf(() => decideAssignment(FulfillmentType.PICKUP, shipment(S.PENDING), 'r1', undefined))).toEqual({
        type: BadRequestException,
        reason: 'PICKUP_HAS_NO_RIDER',
      });
    });
  });

  describe('decideUnassignment', () => {
    const shipment = (status: ShipmentStatus, riderId: string | null = 'r1') => ({ id: 's1', status, riderId });

    it('removes the rider before dispatch, and after a failed attempt with a reason', () => {
      expect(decideUnassignment(DELIVERY, shipment(S.PACKED), undefined)).toBe(true);
      expect(reasonOf(() => decideUnassignment(DELIVERY, shipment(S.FAILED_DELIVERY), undefined))).toEqual({
        type: BadRequestException,
        reason: 'ASSIGNMENT_REASON_REQUIRED',
      });
      expect(decideUnassignment(DELIVERY, shipment(S.FAILED_DELIVERY), 'Customer will collect')).toBe(true);
    });

    it('refuses while the rider is on the road, and does nothing without a rider', () => {
      expect(reasonOf(() => decideUnassignment(DELIVERY, shipment(S.OUT_FOR_DELIVERY), 'x'))).toEqual({
        type: ConflictException,
        reason: 'RIDER_ON_THE_ROAD',
      });
      expect(decideUnassignment(DELIVERY, shipment(S.PACKED, null), undefined)).toBe(false);
    });

    it('refuses a closed or pickup shipment', () => {
      expect(reasonOf(() => decideUnassignment(DELIVERY, shipment(S.DELIVERED), 'x')).reason).toBe('SHIPMENT_CLOSED');
      expect(reasonOf(() => decideUnassignment(FulfillmentType.PICKUP, shipment(S.PENDING), 'x')).reason).toBe(
        'PICKUP_HAS_NO_RIDER',
      );
    });
  });

  describe('riderMayMove', () => {
    it.each([
      [S.PACKED, S.OUT_FOR_DELIVERY],
      [S.FAILED_DELIVERY, S.OUT_FOR_DELIVERY],
      [S.OUT_FOR_DELIVERY, S.FAILED_DELIVERY],
    ])('lets a rider go from %s to %s', (from, to) => {
      expect(riderMayMove(from, to)).toBe(true);
    });

    it.each([
      [S.PENDING, S.OUT_FOR_DELIVERY],
      [S.PICKING, S.PACKED],
      [S.PACKED, S.CANCELLED],
      [S.OUT_FOR_DELIVERY, S.DELIVERED],
      [S.FAILED_DELIVERY, S.RETURNED],
    ])('keeps %s to %s for staff', (from, to) => {
      expect(riderMayMove(from, to)).toBe(false);
    });
  });
});
