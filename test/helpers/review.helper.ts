import { OrderStatus, PaymentMethod, PaymentStatus, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { seedPaymentAttempt, takeOrderNumber } from './db.helper';

export type PurchaseState =
  /** COMPLETED order without shipment rows (completed before split shipments) */
  | 'COMPLETED'
  /** IN_FULFILMENT order whose only shipment was DELIVERED */
  | 'SHIPMENT_DELIVERED'
  /** CONFIRMED order whose shipment is still being packed */
  | 'NOT_DELIVERED'
  /** COMPLETED order whose line was refunded in full */
  | 'REFUNDED';

let purchaseCount = 0;

/**
 * Writes an order of one line (`quantity` units of the product's variant) for `userId` in the given state, straight
 * into the database, for the verified-purchase rule of reviews. Returns the order line id.
 */
export async function purchase(
  prisma: PrismaService,
  userId: string,
  product: { productId: string; variantId: string },
  state: PurchaseState,
  quantity = 1,
): Promise<string> {
  purchaseCount += 1;
  const status =
    state === 'SHIPMENT_DELIVERED'
      ? OrderStatus.IN_FULFILMENT
      : state === 'NOT_DELIVERED'
        ? OrderStatus.CONFIRMED
        : OrderStatus.COMPLETED;
  const order = await prisma.order.create({
    data: {
      orderNumber: await takeOrderNumber(prisma),
      userId,
      status,
      currency: 'GHS',
      pricingVersion: 0,
      grandTotal: 100 * quantity,
      shippingTotal: 0,
      paymentMethod: PaymentMethod.ONLINE,
      contactEmail: 'buyer@example.com',
      contactPhone: `+23324470${String(purchaseCount).padStart(4, '0')}`,
      items: {
        create: {
          productId: product.productId,
          variantId: product.variantId,
          productName: product.productId,
          quantity,
          unitListPrice: 100,
          unitDiscount: 0,
          lineTotal: 100 * quantity,
        },
      },
    },
    include: { items: true },
  });
  const line = order.items[0];
  if (state === 'SHIPMENT_DELIVERED' || state === 'NOT_DELIVERED') {
    await prisma.shipment.create({
      data: {
        orderId: order.id,
        status: state === 'SHIPMENT_DELIVERED' ? ShipmentStatus.DELIVERED : ShipmentStatus.PACKED,
        deliveredAt: state === 'SHIPMENT_DELIVERED' ? new Date() : null,
        items: { create: { orderItemId: line.id, quantity } },
      },
    });
  }
  if (state === 'REFUNDED') {
    const { paymentId } = await seedPaymentAttempt(prisma, {
      orderId: order.id,
      status: PaymentStatus.CAPTURED,
      amount: 100 * quantity,
    });
    await prisma.refund.create({
      data: {
        attemptId: paymentId,
        amount: 100 * quantity,
        status: 'PROCESSED',
        idempotencyKey: `review-test-${order.id}`,
        reason: 'CUSTOMER_REQUEST',
        lines: { create: { orderItemId: line.id, quantity, amount: 100 * quantity } },
      },
    });
  }
  return line.id;
}
