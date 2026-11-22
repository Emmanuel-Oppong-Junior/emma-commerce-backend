import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Order } from '../order/entities/order.entity';
import { OrderRefund } from './entities/order-refund.entity';
import { OrderRefundStatus } from './enums/refund-reason.enum';
import { customerRefundStatus, REFUND_REASON_LABELS } from './refund-reason';
import { RefundWithOrderLines } from './refund.repository';
import { RefundsService } from './refunds.service';

export function toOrderRefund(refund: RefundWithOrderLines): OrderRefund {
  return {
    id: refund.id,
    amount: refund.amount,
    taxAmount: refund.taxAmount,
    shippingAmount: refund.shippingAmount,
    reason: refund.reason,
    reasonLabel: REFUND_REASON_LABELS[refund.reason],
    status: OrderRefundStatus[customerRefundStatus(refund.status)],
    lines: refund.lines.map((line) => ({
      orderItemId: line.orderItemId,
      productName: line.orderItem.productName,
      quantity: line.quantity,
      amount: line.amount,
    })),
    createdAt: refund.createdAt,
  };
}

@Resolver(() => Order)
export class OrderRefundsResolver {
  constructor(private readonly refundsService: RefundsService) {}

  // Every order query already limits customers to their own orders; the type leaves out notes, staff and provider ids.
  @ResolveField(() => [OrderRefund], { description: 'Refunds of this order, oldest first' })
  async refunds(@Parent() order: Order): Promise<OrderRefund[]> {
    return (await this.refundsService.findForOrder(order.id)).map(toOrderRefund);
  }
}
