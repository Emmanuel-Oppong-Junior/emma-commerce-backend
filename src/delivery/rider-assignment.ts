import { BadRequestException, ConflictException } from '@nestjs/common';
import { FulfillmentType, ShipmentStatus } from '../generated/prisma/client';
import { OWNER_ROLE_KEY, Permission } from '../iam/authorization/permissions';
import { isShipmentOpen } from '../order/shipment-status';

export const RIDE_PERMISSION: Permission = 'delivery.ride';

/** `extensions.reason` values of the rider assignment errors. */
export enum RiderAssignmentReason {
  NOT_A_RIDER = 'NOT_A_RIDER',
  PICKUP_HAS_NO_RIDER = 'PICKUP_HAS_NO_RIDER',
  SHIPMENT_CLOSED = 'SHIPMENT_CLOSED',
  ASSIGN_BEFORE_DISPATCH = 'ASSIGN_BEFORE_DISPATCH',
  RIDER_ON_THE_ROAD = 'RIDER_ON_THE_ROAD',
  ASSIGNMENT_REASON_REQUIRED = 'ASSIGNMENT_REASON_REQUIRED',
}

export interface RiderFacts {
  isActive: boolean;
  /** The user's staff role (null without a membership). */
  role: { key: string; permissions: readonly string[] } | null;
}

/**
 * A rider is an active staff member whose role lists delivery.ride: the system Rider role, or a custom role given it.
 * The Owner, whose role lists every permission, is never a rider.
 */
export function isRiderRole(role: RiderFacts['role']): boolean {
  return !!role && role.key !== OWNER_ROLE_KEY && role.permissions.includes(RIDE_PERMISSION);
}

export function isRider(user: RiderFacts | null): boolean {
  return !!user && user.isActive && isRiderRole(user.role);
}

export function assertRider(user: RiderFacts | null, riderId: string): void {
  if (!isRider(user)) {
    throw new BadRequestException({
      message: `User "${riderId}" is not an active rider (a staff member whose role holds delivery.ride)`,
      extensions: { reason: RiderAssignmentReason.NOT_A_RIDER },
    });
  }
}

export interface AssignableShipment {
  id: string;
  status: ShipmentStatus;
  riderId: string | null;
}

/** Out for delivery, or back from a failed attempt: the goods have left the shop with a rider. */
function dispatched(status: ShipmentStatus): boolean {
  return status === ShipmentStatus.OUT_FOR_DELIVERY || status === ShipmentStatus.FAILED_DELIVERY;
}

function assertAssignable(fulfillmentType: FulfillmentType, shipment: AssignableShipment): void {
  if (fulfillmentType !== FulfillmentType.DELIVERY) {
    throw new BadRequestException({
      message: `Shipment "${shipment.id}" is collected at a pickup point; only delivery shipments have a rider`,
      extensions: { reason: RiderAssignmentReason.PICKUP_HAS_NO_RIDER },
    });
  }
  if (!isShipmentOpen(shipment.status)) {
    throw new ConflictException({
      message: `Shipment "${shipment.id}" is ${shipment.status}; its rider can no longer change`,
      extensions: { reason: RiderAssignmentReason.SHIPMENT_CLOSED },
    });
  }
}

function assertReasonGiven(shipment: AssignableShipment, reason: string | undefined, action: string): void {
  if (!reason?.trim()) {
    throw new BadRequestException({
      message: `Shipment "${shipment.id}" has been dispatched (${shipment.status}); give a reason to ${action} its rider`,
      extensions: { reason: RiderAssignmentReason.ASSIGNMENT_REASON_REQUIRED },
    });
  }
}

/**
 * Whether `riderId` may be given the shipment: delivery shipments only, until delivered, returned or cancelled. The
 * first rider is assigned before dispatch (or after a failed attempt, before the next one), so the delivery code goes
 * out with a rider on the road; replacing a rider after dispatch needs a reason. Returns false when the rider already
 * has it (nothing to do).
 */
export function decideAssignment(
  fulfillmentType: FulfillmentType,
  shipment: AssignableShipment,
  riderId: string,
  reason: string | undefined,
): boolean {
  assertAssignable(fulfillmentType, shipment);
  if (shipment.riderId === riderId) return false;
  if (shipment.status === ShipmentStatus.OUT_FOR_DELIVERY && !shipment.riderId) {
    throw new ConflictException({
      message: `Shipment "${shipment.id}" went out without a rider; assign one before dispatch or after a failed attempt`,
      extensions: { reason: RiderAssignmentReason.ASSIGN_BEFORE_DISPATCH },
    });
  }
  if (shipment.riderId && dispatched(shipment.status)) assertReasonGiven(shipment, reason, 'replace');
  return true;
}

/**
 * Whether the shipment's rider may be removed: not while out for delivery (someone carries the goods: reassign
 * instead); after a failed attempt only with a reason. Returns false when no rider is assigned (nothing to do).
 */
export function decideUnassignment(
  fulfillmentType: FulfillmentType,
  shipment: AssignableShipment,
  reason: string | undefined,
): boolean {
  assertAssignable(fulfillmentType, shipment);
  if (!shipment.riderId) return false;
  if (shipment.status === ShipmentStatus.OUT_FOR_DELIVERY) {
    throw new ConflictException({
      message: `Shipment "${shipment.id}" is out for delivery; reassign it to another rider instead`,
      extensions: { reason: RiderAssignmentReason.RIDER_ON_THE_ROAD },
    });
  }
  if (dispatched(shipment.status)) assertReasonGiven(shipment, reason, 'remove');
  return true;
}

/** The steps a rider takes on their own shipment: out for delivery (from packed or after a failed attempt), failed. */
const RIDER_STEPS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  [ShipmentStatus.OUT_FOR_DELIVERY]: [ShipmentStatus.PACKED, ShipmentStatus.FAILED_DELIVERY],
  [ShipmentStatus.FAILED_DELIVERY]: [ShipmentStatus.OUT_FOR_DELIVERY],
};

export function riderMayMove(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return RIDER_STEPS[to]?.includes(from) ?? false;
}
