import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PaymentMethod, ProofOfDeliveryMethod, ShipmentStatus } from '../../generated/prisma/client';
import { Permission } from '../../iam/authorization/permissions';
import { DeliveryCodeCheck } from '../code/delivery-codes.service';

export const OVERRIDE_PERMISSION: Permission = 'delivery.override';

/** Cloudinary folder of delivery photos; each shipment's photos sit in their own sub-folder. */
export const DELIVERY_PHOTO_FOLDER = 'proof-of-delivery';

/** `extensions.reason` values of the proof-of-delivery errors. */
export enum ProofOfDeliveryReason {
  PROOF_OF_DELIVERY_REQUIRED = 'PROOF_OF_DELIVERY_REQUIRED',
  OVERRIDE_NOT_ALLOWED = 'OVERRIDE_NOT_ALLOWED',
  RIDER_NOT_ASSIGNED = 'RIDER_NOT_ASSIGNED',
  DELIVERY_CODE_INVALID = 'DELIVERY_CODE_INVALID',
  DELIVERY_CODE_LOCKED = 'DELIVERY_CODE_LOCKED',
  DELIVERY_CODE_NOT_ISSUED = 'DELIVERY_CODE_NOT_ISSUED',
  CASH_COLLECTION_REQUIRED = 'CASH_COLLECTION_REQUIRED',
  NO_CASH_TO_COLLECT = 'NO_CASH_TO_COLLECT',
  INVALID_DELIVERY_PHOTO = 'INVALID_DELIVERY_PHOTO',
}

export function deliveryPhotoFolder(shipmentId: string): string {
  return `${DELIVERY_PHOTO_FOLDER}/${shipmentId}`;
}

export interface ProofClaim {
  code?: string;
  overrideReason?: string;
}

/**
 * The proof a delivery is confirmed with: the customer's code, or a staff override with a reason (customer without a
 * phone, code lost or locked). Exactly one; an override needs delivery.override.
 */
export function proofMethod(claim: ProofClaim, mayOverride: boolean): ProofOfDeliveryMethod {
  const code = claim.code?.trim();
  const reason = claim.overrideReason?.trim();
  if (code && reason) {
    throw new BadRequestException({
      message: 'Send either the delivery code or an override reason, not both',
      extensions: { reason: ProofOfDeliveryReason.PROOF_OF_DELIVERY_REQUIRED },
    });
  }
  if (reason) {
    if (!mayOverride) {
      throw new ForbiddenException({
        message: 'Confirming a delivery without its code needs the delivery.override permission',
        extensions: { reason: ProofOfDeliveryReason.OVERRIDE_NOT_ALLOWED },
      });
    }
    return ProofOfDeliveryMethod.OVERRIDE;
  }
  if (code) return ProofOfDeliveryMethod.CODE;
  throw new BadRequestException({
    message: 'A delivery is confirmed with the code texted to the customer, or a staff override with a reason',
    extensions: { reason: ProofOfDeliveryReason.PROOF_OF_DELIVERY_REQUIRED },
  });
}

export interface ShipmentForProof {
  id: string;
  status: ShipmentStatus;
  riderId: string | null;
  dispatchedAt: Date | null;
}

/** Only a rider's shipment out for delivery is confirmed with a proof; returns its dispatch time. */
export function assertConfirmable(shipment: ShipmentForProof): Date {
  if (!shipment.riderId) {
    throw new BadRequestException({
      message: `Shipment "${shipment.id}" has no rider; mark it delivered with updateShipmentStatus`,
      extensions: { reason: ProofOfDeliveryReason.RIDER_NOT_ASSIGNED },
    });
  }
  if (shipment.status !== ShipmentStatus.OUT_FOR_DELIVERY || !shipment.dispatchedAt) {
    throw new ConflictException(
      `Shipment "${shipment.id}" is ${shipment.status}; only one out for delivery is delivered`,
    );
  }
  return shipment.dispatchedAt;
}

/** Throws for anything but a matching code. */
export function assertCodeAccepted(check: DeliveryCodeCheck): void {
  switch (check.result) {
    case 'MATCH':
      return;
    case 'MISMATCH':
      throw new BadRequestException({
        message: `The delivery code is wrong; ${check.attemptsLeft} attempt(s) left before it locks`,
        extensions: { reason: ProofOfDeliveryReason.DELIVERY_CODE_INVALID, attemptsLeft: check.attemptsLeft },
      });
    case 'LOCKED':
      throw new BadRequestException({
        message:
          'The delivery code is locked after too many wrong entries; staff can confirm the delivery with an override',
        extensions: { reason: ProofOfDeliveryReason.DELIVERY_CODE_LOCKED },
      });
    case 'NOT_ISSUED':
      throw new BadRequestException({
        message:
          'No delivery code was sent for this dispatch (yet); wait for it, or staff can confirm with an override',
        extensions: { reason: ProofOfDeliveryReason.DELIVERY_CODE_NOT_ISSUED },
      });
  }
}

/**
 * Cash on delivery is recorded in the same call as the delivery (the order completes on its cash), so it must be sent;
 * an order paid online takes none.
 */
export function assertCashClaim(paymentMethod: PaymentMethod, cashCollected: unknown): void {
  if (paymentMethod === PaymentMethod.CASH_ON_DELIVERY && cashCollected == null) {
    throw new BadRequestException({
      message: 'This order is paid on delivery: send the cash collected (the order total) with the delivery',
      extensions: { reason: ProofOfDeliveryReason.CASH_COLLECTION_REQUIRED },
    });
  }
  if (paymentMethod !== PaymentMethod.CASH_ON_DELIVERY && cashCollected != null) {
    throw new BadRequestException({
      message: 'This order was paid online; there is no cash to collect',
      extensions: { reason: ProofOfDeliveryReason.NO_CASH_TO_COLLECT },
    });
  }
}

/** A delivery photo must have been uploaded for this shipment (POST /delivery/.../photo). */
export function assertDeliveryPhoto(shipmentId: string, publicId: string | undefined): void {
  if (publicId !== undefined && !publicId.startsWith(`${deliveryPhotoFolder(shipmentId)}/`)) {
    throw new BadRequestException({
      message: `photoPublicId "${publicId}" was not uploaded for shipment "${shipmentId}"`,
      extensions: { reason: ProofOfDeliveryReason.INVALID_DELIVERY_PHOTO },
    });
  }
}

export function assertPosition(latitude: number | undefined, longitude: number | undefined): void {
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new BadRequestException('Send latitude and longitude together');
  }
}

/** The refusal staff steps and recordCodPayment give for a rider's shipment: it is delivered with a proof. */
export function proofRequired(shipmentId: string): BadRequestException {
  return new BadRequestException({
    message: `Shipment "${shipmentId}" is with a rider: confirm the delivery with its code or an override (completeDelivery)`,
    extensions: { reason: ProofOfDeliveryReason.PROOF_OF_DELIVERY_REQUIRED },
  });
}

/** Metric label of a refused code (bounded). */
export function codeFailureKind(check: DeliveryCodeCheck): 'WRONG_CODE' | 'LOCKED' | 'NOT_ISSUED' | null {
  switch (check.result) {
    case 'MISMATCH':
      return 'WRONG_CODE';
    case 'LOCKED':
      return 'LOCKED';
    case 'NOT_ISSUED':
      return 'NOT_ISSUED';
    default:
      return null;
  }
}
