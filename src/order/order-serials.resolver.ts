import { Injectable, Scope } from '@nestjs/common';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { SerialUnit as SerialUnitRow } from '../generated/prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { OrderItemSerial, SerialUnitLookup } from '../inventory/serials/entities/serial-unit.entity';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSerialsService } from './order-serials.service';
import { OrderItemSerialsInput } from './dto/order-item-serials.input';

@Injectable({ scope: Scope.REQUEST })
export class OrderItemSerialsLoader {
  constructor(private readonly serialUnits: SerialUnitsService) {}

  /** The units of each order line: one query per request (no N+1). */
  readonly loader = new DataLoader<string, SerialUnitRow[]>((orderItemIds: readonly string[]) =>
    this.serialUnits.unitsOnOrderItems(orderItemIds),
  );
}

@Resolver(() => Order)
export class OrderSerialsResolver {
  constructor(private readonly orderSerials: OrderSerialsService) {}

  @RequirePermission('order.fulfil')
  @Mutation(() => Order, {
    description:
      'Assign picked units, by serial, to a serial-tracked order line while its shipment is PICKING or PACKED ' +
      '(staff). Each must be IN_STOCK at the order’s location: CONFLICT with reason SERIAL_NOT_AVAILABLE otherwise',
  })
  assignOrderItemSerials(@ActiveUser('id') actorId: string, @Args('input') input: OrderItemSerialsInput) {
    return this.orderSerials.assign(input.orderItemId, input.serials, actorId);
  }

  @RequirePermission('order.fulfil')
  @Mutation(() => Order, {
    description: 'Put units assigned to an order line back in stock, before dispatch (staff)',
  })
  unassignOrderItemSerials(@ActiveUser('id') actorId: string, @Args('input') input: OrderItemSerialsInput) {
    return this.orderSerials.unassign(input.orderItemId, input.serials, actorId);
  }

  @RequirePermission('order.view')
  @Query(() => [SerialUnitLookup], {
    description:
      'Find serialised units by serial (any variant): status, order, customer id, sale date and warranty (staff)',
  })
  async serialUnitLookup(@Args('serial') serial: string): Promise<SerialUnitLookup[]> {
    const units = await this.orderSerials.lookup(serial);
    return units.map(({ variant, orderItem, ...unit }) => ({
      unit,
      sku: variant.sku,
      productName: variant.product.name,
      orderId: orderItem?.order.id ?? null,
      orderNumber: orderItem?.order.orderNumber ?? null,
      customerId: orderItem?.order.userId ?? null,
    }));
  }
}

// Order lines are reached only through order queries, which already limit customers to their own orders.
@Resolver(() => OrderItem)
export class OrderItemSerialsResolver {
  constructor(private readonly serialsLoader: OrderItemSerialsLoader) {}

  @ResolveField(() => [OrderItemSerial], {
    description: 'Serialised units picked for (ASSIGNED) or sold on (SOLD) this line, with their warranty',
  })
  serials(@Parent() item: OrderItem): Promise<OrderItemSerial[]> {
    return this.serialsLoader.loader.load(item.id);
  }
}
