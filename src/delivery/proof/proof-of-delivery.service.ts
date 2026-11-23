import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, Prisma, ProofOfDeliveryMethod } from '../../generated/prisma/client';
import { AuditService } from '../../commons/audit.service';
import { CloudinaryService } from '../../commons/cloudinary.service';
import { LoggerService } from '../../commons/logger.service';
import { AppMetrics } from '../../observability/metrics';
import { ShipmentsService } from '../../order/shipments.service';
import { PaymentService } from '../../payment/payment.service';
import { DeliveryCodes } from '../code/delivery-codes.service';
import {
  assertCashClaim,
  assertCodeAccepted,
  assertConfirmable,
  assertDeliveryPhoto,
  assertPosition,
  codeFailureKind,
  proofMethod,
} from './proof-of-delivery';
import { ProofOfDeliveryRepository } from './proof-of-delivery.repository';

const CONTEXT = 'ProofOfDelivery';

function coordinate(value: number | undefined): Prisma.Decimal | null {
  return value === undefined ? null : new Prisma.Decimal(value.toFixed(6));
}

export interface CompleteDeliveryParams {
  shipmentId: string;
  code?: string;
  overrideReason?: string;
  photoPublicId?: string;
  recipientName?: string;
  latitude?: number;
  longitude?: number;
  cashCollected?: Prisma.Decimal;
}

export interface DeliveryActor {
  id: string;
  /** Set for a rider's own call: the shipment must be assigned to them. */
  asRider: boolean;
  mayOverride: boolean;
}

/**
 * Confirms a rider's delivery (P5-C.2): with the code texted to the customer at dispatch or a staff override, plus an
 * optional photo, recipient name and position, written as an append-only ProofOfDelivery in the same transaction as
 * DELIVERED (warranty, events, the order's completion). Cash on delivery is recorded in that transaction too, as taken
 * by the shipment's rider (recordCodPayment's rules: the amount is the order total). Audited.
 */
@Injectable()
export class ProofOfDeliveryService {
  constructor(
    private readonly repository: ProofOfDeliveryRepository,
    private readonly shipments: ShipmentsService,
    private readonly payments: PaymentService,
    private readonly codes: DeliveryCodes,
    private readonly cloudinary: CloudinaryService,
    private readonly auditService: AuditService,
    private readonly metrics: AppMetrics,
    private readonly logger: LoggerService,
  ) {}

  async complete(params: CompleteDeliveryParams, actor: DeliveryActor): Promise<void> {
    const { shipmentId } = params;
    const notFound = () => new NotFoundException(`Shipment "${shipmentId}" not found`);
    const found = await this.repository.findShipmentForProof(shipmentId);
    if (!found || (actor.asRider && found.riderId !== actor.id)) throw notFound();

    const method = proofMethod(params, actor.mayOverride && !actor.asRider);
    assertCashClaim(found.order.paymentMethod, params.cashCollected);
    assertDeliveryPhoto(shipmentId, params.photoPublicId);
    assertPosition(params.latitude, params.longitude);
    const dispatchedAt = assertConfirmable(found);
    if (method === ProofOfDeliveryMethod.CODE) {
      const check = await this.codes.check(shipmentId, dispatchedAt, params.code!);
      const failure = codeFailureKind(check);
      if (failure) {
        this.metrics.recordDeliveryCodeFailure(failure);
        this.logger.warn(`Delivery code refused | shipmentId: ${shipmentId} | result: ${failure}`, CONTEXT);
      }
      assertCodeAccepted(check);
    }

    await this.repository.runTransaction(async (tx) => {
      const { order, shipment } = await this.shipments.lockShipment(tx, shipmentId);
      if (actor.asRider && shipment.riderId !== actor.id) throw notFound();
      if (shipment.status !== found.status || shipment.dispatchedAt?.getTime() !== dispatchedAt.getTime()) {
        throw new ConflictException(`Shipment "${shipmentId}" changed while its delivery was confirmed; reload it`);
      }
      const riderId = shipment.riderId!;
      const deliveredAt = new Date();
      const proof = await this.repository.create(tx, {
        shipmentId,
        method,
        overrideReason: method === ProofOfDeliveryMethod.OVERRIDE ? params.overrideReason!.trim() : null,
        deliveredById: actor.id,
        deliveredAt,
        photoUrl: params.photoPublicId ? this.cloudinary.urlFor(params.photoPublicId) : null,
        photoPublicId: params.photoPublicId ?? null,
        recipientName: params.recipientName?.trim() || null,
        latitude: coordinate(params.latitude),
        longitude: coordinate(params.longitude),
      });
      let cashCollectionId: string | undefined;
      if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
        cashCollectionId = await this.payments.recordDeliveredCash(
          tx,
          { orderId: order.id, riderId, amount: params.cashCollected!, collectedAt: deliveredAt },
          actor.id,
        );
      } else {
        await this.shipments.deliverWithProof(tx, order, shipment, actor.id);
      }
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipmentId,
          action: 'PROOF_OF_DELIVERY',
          userId: actor.id,
          details: {
            orderId: order.id,
            proofId: proof.id,
            method,
            riderId,
            ...(proof.overrideReason && { overrideReason: proof.overrideReason }),
            photo: proof.photoPublicId !== null,
            ...(cashCollectionId && { cashCollectionId }),
          },
        },
        tx,
      );
    });

    if (method === ProofOfDeliveryMethod.OVERRIDE) this.metrics.recordDeliveryOverride();
    this.logger.log(
      `Delivery confirmed | shipmentId: ${shipmentId} | method: ${method} | actorId: ${actor.id}`,
      CONTEXT,
    );
  }
}
