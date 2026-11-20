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
  Variant,
} from '../generated/prisma/client';
import { VariantForSale } from '../cart/cart.repository';
import { PrismaService } from '../prisma/prisma.service';

type OrderWithItems = Order & { items: OrderItem[] };
export type NewOrderItem = Omit<Prisma.OrderItemUncheckedCreateWithoutOrderInput, 'optionValues' | 'quantity'> & {
  quantity: number;
  optionValues: Prisma.InputJsonValue;
};

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
      include: include ?? { items: true },
    }) as Promise<OrderWithItems | null>;
  }

  async findByUser(userId: string): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: { userId, deleted: false },
      include: { items: { include: { product: true, variant: true } } },
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<OrderWithItems[]>;
  }

  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { deleted: false },
      include: { items: { include: { product: true, variant: true } } },
    }) as unknown as Promise<Order[]>;
  }

  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    orderDetails: {
      orderItems: NewOrderItem[];
      subtotal: Prisma.Decimal;
      discountTotal: Prisma.Decimal;
      shippingFee: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
      pickupLocationSnapshot?: Record<string, unknown>;
      couponId?: string;
      couponDiscount?: Prisma.Decimal;
      paymentMethod?: PaymentMethod;
      initialStatus?: OrderStatus;
      contactEmail: string;
      contactPhone: string;
    },
  ): Promise<OrderWithItems> {
    const orderNumber = await this.takeOrderNumber(tx);
    return tx.order.create({
      data: {
        orderNumber,
        userId,
        fulfillmentType: orderDetails.fulfillmentType,
        shippingAddressId: orderDetails.shippingAddressId,
        pickupLocationId: orderDetails.pickupLocationId,
        subtotal: orderDetails.subtotal,
        discountTotal: orderDetails.discountTotal,
        shippingFee: orderDetails.shippingFee,
        totalAmount: orderDetails.totalAmount,
        shippingAddressSnapshot: (orderDetails.shippingAddressSnapshot as Prisma.JsonObject) ?? Prisma.JsonNull,
        pickupLocationSnapshot: (orderDetails.pickupLocationSnapshot as Prisma.JsonObject) ?? Prisma.JsonNull,
        couponId: orderDetails.couponId,
        couponDiscount: orderDetails.couponDiscount,
        paymentMethod: orderDetails.paymentMethod ?? PaymentMethod.ONLINE,
        status: orderDetails.initialStatus ?? OrderStatus.PENDING,
        contactEmail: orderDetails.contactEmail,
        contactPhone: orderDetails.contactPhone,
        items: { create: orderDetails.orderItems },
      },
      include: { items: { include: { product: true, variant: true } } },
    }) as unknown as OrderWithItems;
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
        include: { items: { include: { product: true, variant: true } } },
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
      include: { items: { include: { product: true, variant: true } } },
    }) as unknown as OrderWithItems;
  }

  async findAddressForUser(addressId: string, userId: string): Promise<Address | null> {
    return this.prisma.address.findFirst({ where: { id: addressId, userId } });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Puts `quantity` units back on the variant (cancellation, expiry); returns its new stock. */
  async restoreVariantStock(tx: Prisma.TransactionClient, variantId: string, quantity: number): Promise<Variant> {
    return tx.variant.update({ where: { id: variantId }, data: { quantity: { increment: quantity } } });
  }

  /** Takes `quantity` units of an on-sale variant only if that many are left; null when short or no longer on sale. */
  async decrementVariantStock(
    tx: Prisma.TransactionClient,
    variantId: string,
    quantity: number,
  ): Promise<Variant | null> {
    const { count } = await tx.variant.updateMany({
      // Re-checks sellability in the transaction: the variant may have been archived or its product unpublished since
      // the cart was priced.
      where: {
        id: variantId,
        quantity: { gte: quantity },
        isActive: true,
        product: { isActive: true, status: 'PUBLISHED' },
      },
      data: { quantity: { decrement: quantity } },
    });
    if (count === 0) return null;
    return tx.variant.findUniqueOrThrow({ where: { id: variantId } });
  }

  async findVariant(variantId: string): Promise<VariantForSale | null> {
    return this.prisma.variant.findUnique({ where: { id: variantId }, include: { product: true } });
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
