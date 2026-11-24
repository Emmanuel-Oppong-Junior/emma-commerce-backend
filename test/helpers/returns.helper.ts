import { OrderStatus, PaymentProvider, PaymentStatus, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { seedPaymentAttempt, takeOrderNumber } from './db.helper';

export interface DeliveredLine {
  productId: string;
  variantId: string;
  quantity: number;
  unitPrice: number;
  /** The line's share of order-level discounts (<= 0). */
  orderAdjustmentShare?: number;
}

export interface DeliveredOrder {
  orderId: string;
  itemIds: string[];
  shipmentId: string;
  reference: string | null;
}

/**
 * A COMPLETED order written directly: its lines, one DELIVERED shipment carrying every unit (delivered `deliveredAt`,
 * default now) and, unless `payment` is null, a captured payment of its grand total (Paystack, or cash on delivery).
 */
export async function seedDeliveredOrder(
  prisma: PrismaService,
  options: {
    userId?: string;
    lines: DeliveredLine[];
    deliveredAt?: Date;
    shippingTotal?: number;
    payment?: 'PAYSTACK' | 'CASH_ON_DELIVERY' | null;
    stockLocationId?: string;
    shippingZoneId?: string;
  },
): Promise<DeliveredOrder> {
  const shippingTotal = options.shippingTotal ?? 0;
  const merchandise = options.lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity + (line.orderAdjustmentShare ?? 0),
    0,
  );
  const grandTotal = merchandise + shippingTotal;
  const cod = options.payment === 'CASH_ON_DELIVERY';
  const order = await prisma.order.create({
    data: {
      orderNumber: await takeOrderNumber(prisma),
      userId: options.userId ?? 'seed_user',
      currency: 'GHS',
      pricingVersion: 5,
      subtotal: merchandise,
      discountTotal: 0,
      taxTotal: 0,
      shippingTotal,
      grandTotal,
      status: OrderStatus.COMPLETED,
      paymentMethod: cod ? 'CASH_ON_DELIVERY' : 'ONLINE',
      contactEmail: 'user@example.com',
      contactPhone: '+233244300000',
      stockLocationId: options.stockLocationId,
      shippingZoneId: options.shippingZoneId,
      items: {
        create: options.lines.map((line) => ({
          productId: line.productId,
          variantId: line.variantId,
          productName: `Product ${line.productId}`,
          sku: `SKU-${line.variantId}`,
          quantity: line.quantity,
          unitListPrice: line.unitPrice,
          unitDiscount: 0,
          unitNet: line.unitPrice,
          unitTax: 0,
          lineTotal: line.unitPrice * line.quantity,
          orderAdjustmentShare: line.orderAdjustmentShare ?? 0,
        })),
      },
    },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
  const itemIds = options.lines.map(
    (line) => order.items.find((item) => item.variantId === line.variantId && item.productId === line.productId)!.id,
  );
  const deliveredAt = options.deliveredAt ?? new Date();
  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      status: ShipmentStatus.DELIVERED,
      dispatchedAt: deliveredAt,
      deliveredAt,
      items: { create: order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity })) },
      events: { create: { from: null, to: ShipmentStatus.DELIVERED } },
    },
  });
  let reference: string | null = null;
  if (options.payment === 'PAYSTACK' || options.payment === undefined) {
    ({ reference } = await seedPaymentAttempt(prisma, {
      orderId: order.id,
      status: PaymentStatus.CAPTURED,
      amount: grandTotal,
    }));
  } else if (cod) {
    const intent = await prisma.paymentIntent.create({
      data: { orderId: order.id, amount: grandTotal, status: 'CAPTURED' },
    });
    await prisma.paymentAttempt.create({
      data: {
        intentId: intent.id,
        provider: PaymentProvider.CASH_ON_DELIVERY,
        channel: PaymentProvider.CASH_ON_DELIVERY,
        amount: grandTotal,
        currency: 'GHS',
        status: PaymentStatus.CAPTURED,
      },
    });
  }
  return { orderId: order.id, itemIds, shipmentId: shipment.id, reference };
}
