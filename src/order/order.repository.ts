import { Injectable } from '@nestjs/common';
import {
  Address,
  FulfillmentType,
  Order,
  OrderAdjustmentTarget,
  OrderItem,
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Shipment,
  ShipmentStatus,
  User,
} from '../generated/prisma/client';
import { FOR_SALE, VariantForSale } from '../cart/cart.repository';
import { findExpiredLotUnits } from '../inventory/lots/lot-stock.repository';
import { ExpiredLotUnits } from '../inventory/lots/lots';
import { PrismaService } from '../prisma/prisma.service';
import { Quote, QuoteLine } from '../pricing/price';
import { TransitionContext, transitionOrder } from './order-transition';
import { isDispatch, PRE_DISPATCH_STATUSES } from './shipment-status';
import { intentAllowedFrom } from '../payment/payment-intent-status';

type OrderWithItems = Order & { items: OrderItem[] };

const SHIPMENT_ITEMS = { items: { orderBy: { id: 'asc' } } } satisfies Prisma.ShipmentInclude;

export type ShipmentWithItems = Prisma.ShipmentGetPayload<{ include: typeof SHIPMENT_ITEMS }>;

export interface OrderSnapshotLine extends QuoteLine {
  productName: string;
  sku: string;
  optionValues: unknown;
}

/** The quote an order was placed at, with what each line was when ordered. */
export interface OrderSnapshot extends Omit<Quote, 'lines'> {
  lines: OrderSnapshotLine[];
}

/** What an order is read with everywhere: lines with tax lines, adjustments, shipments, history and payment status. */
export const ORDER_INCLUDE = {
  items: { include: { product: true, variant: true, taxLines: { orderBy: { name: 'asc' } } } },
  adjustments: { orderBy: { createdAt: 'asc' } },
  shipments: {
    include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, items: { orderBy: { id: 'asc' } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  statusEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  paymentIntent: { select: { status: true } },
} satisfies Prisma.OrderInclude;

/** An order as fulfilment reads it under its row lock. */
export type OrderForFulfilment = Pick<
  Order,
  'id' | 'userId' | 'status' | 'deleted' | 'fulfillmentType' | 'paymentMethod'
>;

/**
 * Unpaid online orders older than `cutoff` with no payment attempt, or whose attempts are all pending, failed
 * or cancelled and were last touched before `cutoff`. Never matches an order with a captured payment.
 */
export function abandonedOrderWhere(cutoff: Date): Prisma.OrderWhereInput {
  return {
    status: OrderStatus.PLACED,
    paymentMethod: PaymentMethod.ONLINE,
    createdAt: { lt: cutoff },
    deleted: false,
    OR: [
      { paymentIntent: { is: null } },
      {
        paymentIntent: {
          is: {
            status: { in: [PaymentIntentStatus.PENDING, PaymentIntentStatus.FAILED] },
            attempts: {
              every: {
                status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.CANCELLED] },
                updatedAt: { lt: cutoff },
              },
            },
          },
        },
      },
    ],
  };
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, include?: Prisma.OrderInclude): Promise<OrderWithItems | null> {
    return this.prisma.order.findUnique({
      where: { id },
      include: include ?? ORDER_INCLUDE,
    }) as Promise<OrderWithItems | null>;
  }

  async findByUser(userId: string): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: { userId, deleted: false },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<OrderWithItems[]>;
  }

  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { deleted: false },
      include: ORDER_INCLUDE,
    }) as unknown as Promise<Order[]>;
  }

  /** Writes the PLACED order with its line, tax and adjustment snapshot (the quote) and first history event. */
  /** `userId` is null for a guest order (P6-G.1), which then carries the guest's verified phone and name. */
  async create(
    tx: Prisma.TransactionClient,
    userId: string | null,
    orderDetails: {
      snapshot: OrderSnapshot;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
      pickupLocationSnapshot?: Record<string, unknown>;
      couponCodeId?: string;
      paymentMethod?: PaymentMethod;
      contactEmail: string | null;
      contactPhone: string;
      codPhone?: string;
      stockLocationId?: string;
      shippingZoneName?: string;
      guestPhone?: string;
      guestPhoneVerifiedAt?: Date | null;
      contactName?: string;
    },
  ): Promise<OrderWithItems> {
    const { snapshot } = orderDetails;
    const orderNumber = await this.takeOrderNumber(tx);
    const order = await tx.order.create({
      data: {
        orderNumber,
        userId,
        currency: snapshot.currency,
        pricingVersion: snapshot.pricingVersion,
        subtotal: snapshot.subtotal,
        discountTotal: snapshot.discountTotal,
        taxTotal: snapshot.taxTotal,
        shippingTotal: snapshot.shippingTotal,
        grandTotal: snapshot.grandTotal,
        fulfillmentType: orderDetails.fulfillmentType,
        shippingAddressId: orderDetails.shippingAddressId,
        pickupLocationId: orderDetails.pickupLocationId,
        shippingAddressSnapshot: (orderDetails.shippingAddressSnapshot as Prisma.JsonObject) ?? Prisma.JsonNull,
        pickupLocationSnapshot: (orderDetails.pickupLocationSnapshot as Prisma.JsonObject) ?? Prisma.JsonNull,
        couponCodeId: orderDetails.couponCodeId,
        paymentMethod: orderDetails.paymentMethod ?? PaymentMethod.ONLINE,
        status: OrderStatus.PLACED,
        contactEmail: orderDetails.contactEmail,
        contactPhone: orderDetails.contactPhone,
        codPhone: orderDetails.codPhone,
        guestPhone: orderDetails.guestPhone,
        guestPhoneVerifiedAt: orderDetails.guestPhoneVerifiedAt,
        contactName: orderDetails.contactName,
        stockLocationId: orderDetails.stockLocationId,
        shippingZoneId: snapshot.shippingZoneId,
        shippingZoneName: orderDetails.shippingZoneName ?? null,
        rateRuleId: snapshot.delivery?.rateRuleId ?? null,
        serviceLevel: snapshot.delivery?.serviceLevel ?? null,
        shippingFee: snapshot.delivery ? snapshot.shippingFee : null,
        deliverySlotId: snapshot.delivery?.slot?.slotId ?? null,
        deliveryDate: snapshot.delivery?.slot ? new Date(`${snapshot.delivery.slot.date}T00:00:00Z`) : null,
        deliveryWindowStart: snapshot.delivery?.slot?.startMinute ?? null,
        deliveryWindowEnd: snapshot.delivery?.slot?.endMinute ?? null,
        statusEvents: { create: { from: null, to: OrderStatus.PLACED, actorId: userId } },
      },
    });
    for (const [index, line] of snapshot.lines.entries()) {
      const orderAdjustmentShare = snapshot.adjustments.reduce(
        (share, adjustment) => share.add(adjustment.allocations[index]),
        new Prisma.Decimal(0),
      );
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: line.productId,
          variantId: line.variantId,
          productName: line.productName,
          sku: line.sku,
          optionValues: line.optionValues as Prisma.InputJsonValue,
          quantity: line.quantity,
          unitListPrice: line.unitListPrice,
          unitDiscount: line.unitDiscount,
          unitNet: line.unitNet,
          unitTax: line.unitTax,
          lineTotal: line.lineTotal,
          orderAdjustmentShare,
          priceListId: line.priceList?.priceListId ?? null,
          taxLines: { create: line.taxLines },
          adjustments: { create: line.adjustments.map((adjustment) => ({ ...adjustment, orderId: order.id })) },
        },
      });
    }
    const orderAdjustments = [
      ...snapshot.adjustments.map((adjustment) => ({ ...adjustment, target: OrderAdjustmentTarget.MERCHANDISE })),
      ...snapshot.shippingAdjustments.map((adjustment) => ({ ...adjustment, target: OrderAdjustmentTarget.SHIPPING })),
    ];
    if (orderAdjustments.length > 0) {
      await tx.orderAdjustment.createMany({
        data: orderAdjustments.map(({ type, target, sourceId, code, amount }) => ({
          orderId: order.id,
          type,
          target,
          sourceId,
          code,
          amount,
        })),
      });
    }
    return this.findInTransaction(tx, order.id);
  }

  /**
   * Writes a PLACED replacement order for an exchange (P6-R.1): the original order's customer, contact and fulfilment
   * (address or pickup point, zone and service level, no delivery slot), one zero-priced line per replacement variant
   * and a zero total, since the returned units paid for it. Its own stock is reserved by the caller.
   */
  async createReplacement(
    tx: Prisma.TransactionClient,
    original: Order,
    lines: {
      productId: string;
      variantId: string;
      productName: string;
      sku: string;
      optionValues: unknown;
      quantity: number;
    }[],
    stockLocationId: string,
    pricingVersion: number,
  ): Promise<OrderWithItems> {
    const zero = new Prisma.Decimal(0);
    const order = await tx.order.create({
      data: {
        orderNumber: await this.takeOrderNumber(tx),
        userId: original.userId,
        currency: original.currency,
        pricingVersion,
        subtotal: zero,
        discountTotal: zero,
        taxTotal: zero,
        shippingTotal: zero,
        grandTotal: zero,
        fulfillmentType: original.fulfillmentType,
        shippingAddressId: original.shippingAddressId,
        pickupLocationId: original.pickupLocationId,
        shippingAddressSnapshot: (original.shippingAddressSnapshot as Prisma.JsonObject | null) ?? Prisma.JsonNull,
        pickupLocationSnapshot: (original.pickupLocationSnapshot as Prisma.JsonObject | null) ?? Prisma.JsonNull,
        paymentMethod: PaymentMethod.ONLINE,
        status: OrderStatus.PLACED,
        contactEmail: original.contactEmail,
        contactPhone: original.contactPhone,
        stockLocationId,
        shippingZoneId: original.shippingZoneId,
        shippingZoneName: original.shippingZoneName,
        rateRuleId: original.rateRuleId,
        serviceLevel: original.serviceLevel,
        shippingFee: original.shippingZoneId ? zero : null,
        statusEvents: { create: { from: null, to: OrderStatus.PLACED, reason: 'Replacement for returned goods' } },
        items: {
          create: lines.map((line) => ({
            productId: line.productId,
            variantId: line.variantId,
            productName: line.productName,
            sku: line.sku,
            optionValues: (line.optionValues as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
            quantity: line.quantity,
            unitListPrice: zero,
            unitDiscount: zero,
            unitNet: zero,
            unitTax: zero,
            lineTotal: zero,
          })),
        },
      },
    });
    return this.findInTransaction(tx, order.id);
  }

  /**
   * Takes the store's next order number. The row lock it takes is held until the order transaction ends, so
   * concurrent orders get distinct numbers; a rolled-back order leaves a gap.
   */
  private async takeOrderNumber(tx: Prisma.TransactionClient): Promise<number> {
    const [taken] = await tx.$queryRaw<{ orderNumber: number }[]>`
      UPDATE "Store" SET "nextOrderNumber" = "nextOrderNumber" + 1
      WHERE "singleton"
      RETURNING "nextOrderNumber" - 1 AS "orderNumber"`;
    if (!taken) throw new Error('No Store row exists to number the order; apply the database migrations');
    return taken.orderNumber;
  }

  async findAddressById(addressId: string): Promise<Address | null> {
    return this.prisma.address.findUnique({ where: { id: addressId } });
  }

  /**
   * Moves the order to `to` if it is still in one of `from` (and not deleted) and matches `context.guard`, and writes
   * its history event (see transitionOrder). Returns null when another request changed it first, so callers can
   * report a conflict.
   */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    to: OrderStatus,
    from: readonly OrderStatus[],
    context?: TransitionContext,
  ): Promise<OrderWithItems | null> {
    const left = await transitionOrder(tx, orderId, to, from, context);
    return left === null ? null : this.findInTransaction(tx, orderId);
  }

  /** Locks the order row for a fulfilment change, so shipment and order move together; null if it does not exist. */
  async lockForFulfilment(tx: Prisma.TransactionClient, orderId: string): Promise<OrderForFulfilment | null> {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    return tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true, deleted: true, fulfillmentType: true, paymentMethod: true },
    });
  }

  /**
   * Moves a shipment from `from` to `to` with a conditional write, stamps dispatch, delivery and cancellation times,
   * and writes its history event. Returns the shipment with its items, or null when another request moved it first.
   */
  async transitionShipment(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    from: ShipmentStatus,
    to: ShipmentStatus,
    context: { actorId?: string; reason?: string } = {},
  ): Promise<ShipmentWithItems | null> {
    const now = new Date();
    const { count } = await tx.shipment.updateMany({
      where: { id: shipmentId, status: from },
      data: {
        status: to,
        ...(isDispatch(to) && { dispatchedAt: now }),
        ...(to === ShipmentStatus.DELIVERED && { deliveredAt: now }),
        ...(to === ShipmentStatus.CANCELLED && { cancelledAt: now }),
      },
    });
    if (count === 0) return null;
    await tx.shipmentStatusEvent.create({
      data: { shipmentId, from, to, actorId: context.actorId, reason: context.reason },
    });
    return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: SHIPMENT_ITEMS });
  }

  /**
   * Cancels the order's shipments that have not been dispatched (the order is being cancelled), each with its history
   * event. Call on the order's cancel transaction.
   */
  async cancelOpenShipments(
    tx: Prisma.TransactionClient,
    orderId: string,
    context: { actorId?: string; reason?: string },
  ): Promise<void> {
    const open = await tx.shipment.findMany({
      where: { orderId, status: { in: PRE_DISPATCH_STATUSES } },
      select: { id: true, status: true },
    });
    for (const shipment of open) {
      await this.transitionShipment(tx, shipment.id, shipment.status, ShipmentStatus.CANCELLED, context);
    }
  }

  async updateShipmentTracking(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    tracking: { trackingNumber?: string; carrier?: string },
  ): Promise<Shipment> {
    return tx.shipment.update({ where: { id: shipmentId }, data: tracking });
  }

  async findTimeline(orderId: string) {
    return this.prisma.orderStatusEvent.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async findShipments(orderId: string) {
    return this.prisma.shipment.findMany({
      where: { orderId },
      include: ORDER_INCLUDE.shipments.include,
      orderBy: ORDER_INCLUDE.shipments.orderBy,
    });
  }

  async findPaymentStatus(orderId: string): Promise<PaymentIntentStatus | null> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { orderId }, select: { status: true } });
    return intent?.status ?? null;
  }

  /** Cancels the order's payment intent if it is still open (pending or failed); a captured one is left alone. */
  async cancelOpenPaymentIntent(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await tx.paymentIntent.updateMany({
      where: { orderId, status: { in: intentAllowedFrom(PaymentIntentStatus.CANCELLED) } },
      data: { status: PaymentIntentStatus.CANCELLED },
    });
  }

  /** The order an order line belongs to; null when the line does not exist. */
  async findItemOrderId(tx: Prisma.TransactionClient, orderItemId: string): Promise<string | null> {
    const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { orderId: true } });
    return item?.orderId ?? null;
  }

  async findForTransaction(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithItems> {
    return this.findInTransaction(tx, orderId);
  }

  /** Hides a finished order; returns null if it is not in one of `from` or is already deleted. */
  async softDelete(
    tx: Prisma.TransactionClient,
    orderId: string,
    from: readonly OrderStatus[],
  ): Promise<OrderWithItems | null> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, deleted: false, status: { in: [...from] } },
      data: { deleted: true, deletedAt: new Date() },
    });
    if (count === 0) return null;
    return this.findInTransaction(tx, orderId);
  }

  private async findInTransaction(tx: Prisma.TransactionClient, orderId: string): Promise<OrderWithItems> {
    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    }) as unknown as OrderWithItems;
  }

  async findAddressForUser(
    addressId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Address | null> {
    return db.address.findFirst({ where: { id: addressId, userId } });
  }

  async findUserById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  /**
   * Locks the user's cart row until the order transaction ends, so two checkouts of the same cart run one after the
   * other (the second then finds the cart empty). NO KEY UPDATE does not block adding items to the cart meanwhile.
   */
  async lockCart(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "Cart" WHERE "userId" = ${userId} FOR NO KEY UPDATE`;
  }

  /** lockCart for a guest cart (P6-G.1), by its id. */
  async lockGuestCart(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "Cart" WHERE "id" = ${cartId} FOR NO KEY UPDATE`;
  }

  /**
   * Share-locks the variants and their products, in id order (so concurrent checkouts cannot deadlock), before their
   * prices are read: a price change waits for the order to commit, so the order is priced at what it reads.
   */
  async lockVariants(tx: Prisma.TransactionClient, variantIds: string[]): Promise<void> {
    if (variantIds.length === 0) return;
    await tx.$queryRaw`
      SELECT v.id FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
      WHERE v.id = ANY(${variantIds}::text[])
      ORDER BY v.id
      FOR SHARE OF v, p`;
  }

  /**
   * Re-checks in the order transaction that the variant is still on sale (it may have been archived or its product
   * unpublished since the cart was priced) and share-locks it and its product until the order commits, so neither can
   * be taken off sale meanwhile. False when it is no longer on sale.
   */
  async lockSellableVariant(tx: Prisma.TransactionClient, variantId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
      WHERE v.id = ${variantId} AND v."isActive" AND p."isActive" AND p.status = 'PUBLISHED'
      FOR SHARE OF v, p`;
    return rows.length === 1;
  }

  /** Units of the variants' expired lots per location, which are not sellable (P4-C.1). */
  findExpiredLotUnits(variantIds: string[], now: Date): Promise<ExpiredLotUnits[]> {
    return findExpiredLotUnits(this.prisma, variantIds, now);
  }

  async findVariant(variantId: string, db: Prisma.TransactionClient = this.prisma): Promise<VariantForSale | null> {
    return db.variant.findUnique({ where: { id: variantId }, include: FOR_SALE });
  }

  async clearCartItems(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
  }

  async runTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async hasCapturedPayment(orderId: string, db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const completed = await db.paymentAttempt.count({
      where: { intent: { orderId }, status: PaymentStatus.CAPTURED },
    });
    return completed > 0;
  }

  async findExpiredPendingOrders(cutoff: Date): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: abandonedOrderWhere(cutoff),
      include: { items: true },
    }) as unknown as OrderWithItems[];
  }

  /**
   * Runs `fn` only when no other process holds the Postgres advisory lock `lockKey`; returns null otherwise.
   * The lock belongs to a transaction kept open while `fn` runs, so it is released even if the process dies.
   */
  async runWithAdvisoryLock<T>(lockKey: number, maxDurationMs: number, fn: () => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked`;
        return locked ? fn() : null;
      },
      { timeout: maxDurationMs },
    );
  }
}
