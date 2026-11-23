import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Order } from './entities/order.entity';
import { TrackingStep } from './entities/tracking-step.entity';
import { OrdersService } from './order.service';
import { ShipmentHistory, trackingTimeline } from './tracking-timeline';

type OrderWithHistory = Order & {
  statusEvents?: Parameters<typeof trackingTimeline>[0];
  shipments?: ShipmentHistory[];
};

// Order queries already limit customers to their own orders, and the steps carry no actor or staff reason.
@Resolver(() => Order)
export class OrderTrackingResolver {
  constructor(private readonly ordersService: OrdersService) {}

  @ResolveField(() => [TrackingStep], {
    description:
      'Customer tracking timeline (P5-B.2): order and shipment status changes, oldest first; poll it for updates',
  })
  async trackingTimeline(@Parent() order: OrderWithHistory): Promise<TrackingStep[]> {
    const [events, shipments] = await Promise.all([
      order.statusEvents ?? this.ordersService.getTimeline(order.id),
      order.shipments ?? this.ordersService.getShipments(order.id),
    ]);
    return trackingTimeline(events, shipments);
  }
}
