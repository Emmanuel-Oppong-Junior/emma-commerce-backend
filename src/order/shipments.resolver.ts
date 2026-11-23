import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { ShipmentStatus } from '../generated/prisma/client';
import { CancelShipmentInput, CreateShipmentInput } from './dto/create-shipment.input';
import { UpdateShipmentStatusInput } from './dto/update-shipment-status.input';
import { UpdateShippingInput } from './dto/update-shipping.input';
import { Order } from './entities/order.entity';
import { Shipment } from './entities/shipment.entity';
import { ShipmentsService } from './shipments.service';

@Resolver(() => Shipment)
export class ShipmentsResolver {
  constructor(private readonly shipments: ShipmentsService) {}

  @RequirePermission('order.view')
  @Query(() => [Shipment], { description: "An order's shipments with their items and history, oldest first (staff)" })
  orderShipments(@Args('orderId', { type: () => ID }) orderId: string) {
    return this.shipments.getShipments(orderId);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Shipment, {
    description:
      'Create a PENDING shipment of a confirmed or in-fulfilment order with the given lines and units, or every unit ' +
      'not yet in a shipment (staff). BAD_REQUEST for a line not on the order or named twice, and for a ' +
      'cash-on-delivery order not shipped whole (reason COD_ORDER_NOT_SPLIT); CONFLICT for more units than are ' +
      'unshipped (SHIPMENT_QUANTITY_EXCEEDED) or nothing left to ship (NOTHING_TO_SHIP)',
  })
  createShipment(@ActiveUser('id') actorId: string, @Args('input') input: CreateShipmentInput) {
    return this.shipments.createShipment(input.orderId, input.items, actorId);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Order, {
    description:
      'Cancel a shipment that has not been dispatched (staff): its units can be shipped again and the serials ' +
      'picked for it go back on the shelf. CONFLICT once dispatched',
  })
  cancelShipment(@ActiveUser('id') actorId: string, @Args('input') input: CancelShipmentInput) {
    return this.shipments.cancelShipment(input.shipmentId, actorId, input.reason);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Order, {
    description:
      'Move a shipment to its next fulfilment step (staff); the order follows: IN_FULFILMENT on the first step of ' +
      'any shipment, COMPLETED once every unit is delivered (online orders). Dispatch needs a serial on every ' +
      'serialised unit of the shipment (BAD_REQUEST, reason SERIALS_NOT_ASSIGNED)',
  })
  updateShipmentStatus(@ActiveUser('id') actorId: string, @Args('input') input: UpdateShipmentStatusInput) {
    return this.shipments.updateShipmentStatus(
      input.shipmentId,
      input.status as unknown as ShipmentStatus,
      actorId,
      input.reason,
    );
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Order, {
    description: 'Set the carrier and tracking number of a shipment of a confirmed or in-fulfilment order (staff)',
  })
  updateShipping(@ActiveUser('id') actorId: string, @Args('input') input: UpdateShippingInput) {
    return this.shipments.updateShipping(input.shipmentId, input.trackingNumber, input.carrier, actorId);
  }
}
