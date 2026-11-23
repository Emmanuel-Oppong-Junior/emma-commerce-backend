import { Injectable, Scope } from '@nestjs/common';
import { Args, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { ProofOfDelivery, ShipmentStatus } from '../../generated/prisma/client';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { ActiveAccess, RequirePermission } from '../../iam/authorization/policy.decorators';
import { hasPermission, StaffAccess } from '../../iam/authorization/staff-access';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';
import { Shipment } from '../../order/entities/shipment.entity';
import { TrackingStep } from '../../order/entities/tracking-step.entity';
import { ShipmentsRepository } from '../../order/shipments.repository';
import { RiderDelivery } from '../entities/rider-delivery.entity';
import { RidersService } from '../riders.service';
import { OVERRIDE_PERMISSION } from './proof-of-delivery';
import { DeliveryConfirmation, ProofOfDeliveryEntity } from './proof-of-delivery.entity';
import { CompleteDeliveryInput, CompleteMyDeliveryInput } from './proof-of-delivery.inputs';
import { ProofOfDeliveryRepository } from './proof-of-delivery.repository';
import { ProofOfDeliveryService } from './proof-of-delivery.service';

@Injectable({ scope: Scope.REQUEST })
export class ProofOfDeliveryLoader {
  constructor(private readonly repository: ProofOfDeliveryRepository) {}

  /** The proofs of the shipments in one request, in one query. */
  readonly loader = new DataLoader<string, ProofOfDelivery | null>(async (ids: readonly string[]) => {
    const proofs = new Map((await this.repository.findByShipmentIds(ids)).map((proof) => [proof.shipmentId, proof]));
    return ids.map((id) => proofs.get(id) ?? null);
  });
}

function toEntity(proof: ProofOfDelivery): ProofOfDeliveryEntity {
  return {
    ...proof,
    latitude: proof.latitude?.toNumber() ?? null,
    longitude: proof.longitude?.toNumber() ?? null,
  };
}

const COMPLETION_ERRORS =
  'NOT_FOUND for a shipment that is not yours; BAD_REQUEST: PROOF_OF_DELIVERY_REQUIRED, DELIVERY_CODE_INVALID ' +
  '(extensions.attemptsLeft), DELIVERY_CODE_LOCKED (after 5 wrong codes), DELIVERY_CODE_NOT_ISSUED, ' +
  'CASH_COLLECTION_REQUIRED, NO_CASH_TO_COLLECT, COLLECTION_AMOUNT_MISMATCH, INVALID_DELIVERY_PHOTO; CONFLICT when ' +
  'the shipment is not out for delivery';

@Resolver(() => Shipment)
export class ProofOfDeliveryResolver {
  constructor(
    private readonly proofs: ProofOfDeliveryService,
    private readonly ridersService: RidersService,
    private readonly shipmentsRepository: ShipmentsRepository,
    private readonly proofLoader: ProofOfDeliveryLoader,
  ) {}

  @RequirePermission('delivery.ride')
  @Mutation(() => RiderDelivery, {
    description:
      'Deliver one of your shipments out for delivery with the code the customer received by SMS, an optional photo ' +
      '(uploaded first), recipient name and position; for cash on delivery also the cash collected (the order ' +
      `total), recorded as yours. ${COMPLETION_ERRORS}`,
  })
  async completeMyDelivery(@ActiveUser('id') riderId: string, @Args('input') input: CompleteMyDeliveryInput) {
    await this.proofs.complete(input, { id: riderId, asRider: true, mayOverride: false });
    return this.ridersService.myDelivery(riderId, input.shipmentId);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Shipment, {
    description:
      'Deliver a rider’s shipment out for delivery (staff): with the customer’s code, or overrideReason instead ' +
      '(needs delivery.override: FORBIDDEN reason OVERRIDE_NOT_ALLOWED). Cash on delivery is recorded as taken by ' +
      `the shipment’s rider. BAD_REQUEST RIDER_NOT_ASSIGNED for a shipment without a rider. ${COMPLETION_ERRORS}`,
  })
  async completeDelivery(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('input') input: CompleteDeliveryInput,
  ) {
    await this.proofs.complete(input, {
      id: actorId,
      asRider: false,
      mayOverride: hasPermission(access, OVERRIDE_PERMISSION),
    });
    return this.shipmentsRepository.findWithHistory(input.shipmentId);
  }

  @ResolveField(() => ProofOfDeliveryEntity, {
    nullable: true,
    description: 'How a rider’s delivery was confirmed: code or override, photo, recipient, position (staff)',
    middleware: [staffWith('order.view')],
  })
  async proofOfDelivery(@Parent() shipment: Shipment): Promise<ProofOfDeliveryEntity | null> {
    const proof = await this.proofLoader.loader.load(shipment.id);
    return proof && toEntity(proof);
  }
}

// Tracking steps are reached only through order queries, which already limit customers to their own orders.
@Resolver(() => TrackingStep)
export class TrackingStepProofResolver {
  constructor(private readonly proofLoader: ProofOfDeliveryLoader) {}

  @ResolveField(() => DeliveryConfirmation, {
    nullable: true,
    description:
      'On a DELIVERED step of a rider’s shipment: how the delivery was confirmed (code or override) and when',
  })
  async deliveryConfirmation(@Parent() step: TrackingStep): Promise<DeliveryConfirmation | null> {
    if (step.shipmentStatus !== ShipmentStatus.DELIVERED || !step.shipmentId) return null;
    const proof = await this.proofLoader.loader.load(step.shipmentId);
    return proof && { method: proof.method, confirmedAt: proof.deliveredAt };
  }
}
