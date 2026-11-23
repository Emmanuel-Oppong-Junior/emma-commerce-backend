import { Injectable, Scope } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { Shipment } from '../order/entities/shipment.entity';
import {
  AssignShipmentRiderInput,
  FailMyDeliveryInput,
  MyDeliveriesArgs,
  UnassignShipmentRiderInput,
} from './dto/rider.inputs';
import { DeliveryRider, RiderDelivery } from './entities/rider-delivery.entity';
import { RidersRepository } from './riders.repository';
import { RidersService } from './riders.service';

@Injectable({ scope: Scope.REQUEST })
export class ShipmentRiderLoader {
  constructor(private readonly repository: RidersRepository) {}

  /** The riders of the shipments in one request, in one query. */
  readonly loader = new DataLoader<string, DeliveryRider | null>(async (ids: readonly string[]) => {
    const riders = new Map((await this.repository.findRidersByIds(ids)).map((rider) => [rider.id, rider]));
    return ids.map((id) => riders.get(id) ?? null);
  });
}

@Resolver(() => Shipment)
export class RidersResolver {
  constructor(
    private readonly ridersService: RidersService,
    private readonly riderLoader: ShipmentRiderLoader,
  ) {}

  @RequirePermission('order.fulfil')
  @Query(() => [DeliveryRider], { description: 'Active riders a delivery shipment can be assigned to (staff)' })
  riders() {
    return this.ridersService.findRiders();
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Shipment, {
    description:
      'Assign a delivery shipment to a rider (staff), until it is delivered, returned or cancelled. BAD_REQUEST for a ' +
      'pickup shipment (reason PICKUP_HAS_NO_RIDER) or someone who is not an active rider (NOT_A_RIDER); replacing ' +
      'the rider after dispatch needs a reason (ASSIGNMENT_REASON_REQUIRED); CONFLICT for a closed shipment ' +
      '(SHIPMENT_CLOSED) or a first rider on a shipment already out for delivery (ASSIGN_BEFORE_DISPATCH). Audited',
  })
  assignShipmentRider(@ActiveUser('id') actorId: string, @Args('input') input: AssignShipmentRiderInput) {
    return this.ridersService.assign(input.shipmentId, input.riderId, actorId, input.reason);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Shipment, {
    description:
      'Remove the rider of a delivery shipment (staff): before dispatch, or after a failed attempt with a reason. ' +
      'CONFLICT while it is out for delivery (reason RIDER_ON_THE_ROAD: reassign instead). Audited',
  })
  unassignShipmentRider(@ActiveUser('id') actorId: string, @Args('input') input: UnassignShipmentRiderInput) {
    return this.ridersService.unassign(input.shipmentId, actorId, input.reason);
  }

  @ResolveField(() => DeliveryRider, {
    nullable: true,
    description: 'The rider delivering it (staff)',
    middleware: [staffWith('order.view')],
  })
  rider(@Parent() shipment: Shipment & { riderId?: string | null }): Promise<DeliveryRider | null> | null {
    return shipment.riderId ? this.riderLoader.loader.load(shipment.riderId) : null;
  }
}

/** The signed-in rider's own deliveries: small payloads for a phone, nothing beyond what the delivery needs. */
@Resolver(() => RiderDelivery)
export class MyDeliveriesResolver {
  constructor(private readonly ridersService: RidersService) {}

  @RequirePermission('delivery.ride')
  @Query(() => [RiderDelivery], {
    description: 'Shipments assigned to the signed-in rider: open ones by default, oldest assignment first',
  })
  myDeliveries(@ActiveUser('id') riderId: string, @Args() args: MyDeliveriesArgs) {
    return this.ridersService.myDeliveries(riderId, args);
  }

  @RequirePermission('delivery.ride')
  @Query(() => RiderDelivery, { description: 'One shipment assigned to the signed-in rider; NOT_FOUND otherwise' })
  myDelivery(@ActiveUser('id') riderId: string, @Args('shipmentId', { type: () => ID }) shipmentId: string) {
    return this.ridersService.myDelivery(riderId, shipmentId);
  }

  @RequirePermission('delivery.ride')
  @Mutation(() => RiderDelivery, {
    description:
      'Take one of your shipments out for delivery (from PACKED, or again after a failed attempt). NOT_FOUND when it ' +
      'is not assigned to you; CONFLICT from any other status',
  })
  startMyDelivery(@ActiveUser('id') riderId: string, @Args('shipmentId', { type: () => ID }) shipmentId: string) {
    return this.ridersService.startDelivery(riderId, shipmentId);
  }

  @RequirePermission('delivery.ride')
  @Mutation(() => RiderDelivery, {
    description: 'Record that a delivery you took out failed, with what happened. NOT_FOUND when it is not yours',
  })
  failMyDelivery(@ActiveUser('id') riderId: string, @Args('input') input: FailMyDeliveryInput) {
    return this.ridersService.failDelivery(riderId, input.shipmentId, input.reason);
  }
}
