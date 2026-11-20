import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Address,
  FulfillmentType,
  Order,
  OrderItem,
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  User,
} from '../generated/prisma/client';
import { FOR_SALE, VariantForSale } from '../cart/cart.repository';
import { PrismaService } from '../prisma/prisma.service';
import { OrderSnapshot } from './order-totals';

type OrderWithItems = Order & { items: OrderItem[] };

/** What an order is read with everywhere: its lines with their tax lines, and its adjustments. */
export const ORDER_INCLUDE = {
  items: { include: { product: true, variant: true, taxLines: { orderBy: { name: 'asc' } } } },
  adjustments: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

/**
 * Unpaid online orders older than `cutoff` with no payment attempt, or whose attempts are all pending, failed
 * or abandoned and were last touched before `cutoff`. Never matches an order with a completed payment.
 */
export function abandonedOrderWhere(cutoff: Date): Prisma.OrderWhereInput {
  return {
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.ONLINE,
    createdAt: { lt: cutoff },
    deleted: false,
    OR: [
      { paymentIntent: { is: null } },
      {
        paymentIntent: {
          is: {
            status: PaymentIntentStatus.PENDING,
            attempts: {
              every: {
                status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.ABANDONED] },
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

  /** Writes the order with its line, tax and adjustment snapshot (see snapshotOrder). */
  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    orderDetails: {
      snapshot: OrderSnapshot;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
      pickupLocationSnapshot?: Record<string, unknown>;
      couponId?: string;
      paymentMethod?: PaymentMethod;
      initialStatus?: OrderStatus;
      contactEmail: string;
      contactPhone: string;
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
        couponId: orderDetails.couponId,
        paymentMethod: orderDetails.paymentMethod ?? PaymentMethod.ONLINE,
        status: orderDetails.initialStatus ?? OrderStatus.PENDING,
        contactEmail: orderDetails.contactEmail,
        contactPhone: orderDetails.contactPhone,
      },
    });
    for (const line of snapshot.lines) {
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
          taxLines: { create: line.taxLines },
          adjustments: { create: line.adjustments.map((adjustment) => ({ ...adjustment, orderId: order.id })) },
        },
      });
    }
    if (snapshot.adjustments.length > 0) {
      await tx.orderAdjustment.createMany({
        data: snapshot.adjustments.map((adjustment) => ({ ...adjustment, orderId: order.id })),
      });
    }
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

  async updateShipping(
    orderId: string,
    trackingNumber?: string,
    carrier?: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<OrderWithItems> {
    try {
      return (await db.order.update({
        where: { id: orderId },
        data: { trackingNumber, carrier },
        include: ORDER_INCLUDE,
      })) as unknown as OrderWithItems;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Order "${orderId}" not found`);
      }
      throw e;
    }
  }

  /**
   * Moves the order to `to` only if it is still in one of `from` (and not deleted) and matches `guard`.
   * Returns null when another request changed it first, so callers can report a conflict.
   */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    to: OrderStatus,
    from: OrderStatus[],
    guard?: Prisma.OrderWhereInput,
  ): Promise<OrderWithItems | null> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: { in: from }, deleted: false, ...(guard && { AND: [guard] }) },
      data: { status: to },
    });
    if (count === 0) return null;
    return this.findInTransaction(tx, orderId);
  }

  /** Hides a finished order; returns null if it is not in one of `from` or is already deleted. */
  async softDelete(tx: Prisma.TransactionClient, orderId: string, from: OrderStatus[]): Promise<OrderWithItems | null> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, deleted: false, status: { in: from } },
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

  async findAddressForUser(addressId: string, userId: string): Promise<Address | null> {
    return this.prisma.address.findFirst({ where: { id: addressId, userId } });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
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

  async findVariant(variantId: string): Promise<VariantForSale | null> {
    return this.prisma.variant.findUnique({ where: { id: variantId }, include: FOR_SALE });
  }

  async clearCartItems(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
  }

  async runTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async hasCompletedPayment(orderId: string): Promise<boolean> {
    const completed = await this.prisma.paymentAttempt.count({
      where: { intent: { orderId }, status: PaymentStatus.COMPLETED },
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
