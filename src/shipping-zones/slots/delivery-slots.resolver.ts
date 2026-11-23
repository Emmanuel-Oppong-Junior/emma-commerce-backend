import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { ShippingZoneEntity } from '../entities/shipping-zone.entity';
import { Order } from '../../order/entities/order.entity';
import { DeliverySlotsService, toWindow } from './delivery-slots.service';
import { fromDbDate } from './delivery-slots.repository';
import {
  CreateDeliverySlotInput,
  DeliveryBooking,
  DeliveryClosureEntity,
  DeliveryClosureInput,
  DeliverySlotEntity,
  DeliveryWindow,
  UpdateDeliverySlotInput,
} from './delivery-slots.types';

@Resolver()
export class DeliverySlotsResolver {
  constructor(private readonly slots: DeliverySlotsService) {}

  @RequirePermission('shipping.manage')
  @Mutation(() => DeliverySlotEntity, {
    description: 'Add a weekly delivery window to a zone (STANDARD delivery). Audited',
  })
  createDeliverySlot(
    @ActiveUser('id') actorId: string,
    @Args('zoneId', { type: () => ID }) zoneId: string,
    @Args('input') input: CreateDeliverySlotInput,
  ) {
    return this.slots.createSlot(zoneId, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => DeliverySlotEntity, {
    description: "Change a delivery slot's window, capacity, cutoff or active flag. Audited",
  })
  updateDeliverySlot(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateDeliverySlotInput,
  ) {
    return this.slots.updateSlot(id, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => DeliverySlotEntity, {
    description: 'Delete a delivery slot that was never booked (CONFLICT otherwise: deactivate it). Audited',
  })
  deleteDeliverySlot(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.slots.deleteSlot(id, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => DeliveryClosureEntity, { description: 'Close a zone for deliveries on a date (holiday). Audited' })
  addDeliveryClosure(
    @ActiveUser('id') actorId: string,
    @Args('zoneId', { type: () => ID }) zoneId: string,
    @Args('input') input: DeliveryClosureInput,
  ) {
    return this.slots.addClosure(zoneId, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => DeliveryClosureEntity, { description: 'Reopen a closed date. Audited' })
  removeDeliveryClosure(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.slots.removeClosure(id, actorId);
  }

  @RequirePermission('order.view')
  @Query(() => [DeliveryBooking], {
    description: 'The delivery slots booked on a date (YYYY-MM-DD), with the orders holding their places',
  })
  deliveryBookings(@Args('date') date: string, @Args('zoneId', { type: () => ID, nullable: true }) zoneId?: string) {
    return this.slots.bookingsOn(date, zoneId);
  }
}

@Resolver(() => ShippingZoneEntity)
export class ShippingZoneSlotsResolver {
  constructor(private readonly slots: DeliverySlotsService) {}

  @ResolveField(() => [DeliverySlotEntity], { description: 'Weekly delivery windows for STANDARD delivery' })
  deliverySlots(@Parent() zone: ShippingZoneEntity) {
    return this.slots.zoneSlots(zone.id);
  }

  @ResolveField(() => [DeliveryClosureEntity], { description: 'Dates from today on the zone does not deliver' })
  deliveryClosures(@Parent() zone: ShippingZoneEntity) {
    return this.slots.zoneClosures(zone.id);
  }
}

type OrderWithSlot = Order & {
  deliverySlotId?: string | null;
  deliveryDate?: Date | null;
  deliveryWindowStart?: number | null;
  deliveryWindowEnd?: number | null;
};

@Resolver(() => Order)
export class OrderDeliverySlotResolver {
  @ResolveField(() => DeliveryWindow, { nullable: true, description: 'DELIVERY: the delivery slot booked (P5-A.2)' })
  deliverySlot(@Parent() order: OrderWithSlot): DeliveryWindow | null {
    if (!order.deliverySlotId || !order.deliveryDate) return null;
    return toWindow({
      slotId: order.deliverySlotId,
      date: fromDbDate(order.deliveryDate),
      startMinute: order.deliveryWindowStart!,
      endMinute: order.deliveryWindowEnd!,
    });
  }
}
