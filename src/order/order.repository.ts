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
  Product,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type OrderWithItems = Order & { items: OrderItem[] };

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
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<OrderWithItems[]>;
  }

  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { deleted: false },
      include: { items: { include: { product: true } } },
    }) as unknown as Promise<Order[]>;
  }

  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    orderDetails: {
      orderItems: OrderItem[];
      subtotal: Prisma.Decimal;
      shippingFee: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
      pickupLocationSnapshot?: Record<string, unknown>;
      couponId?: string;
      couponDiscount?: number;
      paymentMethod?: PaymentMethod;
      initialStatus?: OrderStatus;
      contactEmail: string;
      contactPhone: string;
    },
  ): Promise<OrderWithItems> {
    return tx.order.create({
      data: {
        userId,
        fulfillmentType: orderDetails.fulfillmentType,
        shippingAddressId: orderDetails.shippingAddressId,
        pickupLocationId: orderDetails.pickupLocationId,
        subtotal: orderDetails.subtotal,
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
      include: { items: { include: { product: true } } },
    }) as unknown as OrderWithItems;
  }

  async findAddressById(addressId: string): Promise<Address | null> {
    return this.prisma.address.findUnique({ where: { id: addressId } });
  }

  async updateShipping(orderId: string, trackingNumber?: string, carrier?: string): Promise<OrderWithItems> {
    try {
      return (await this.prisma.order.update({
        where: { id: orderId },
        data: { trackingNumber, carrier },
        include: { items: { include: { product: true } } },
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
      include: { items: { include: { product: true } } },
    }) as unknown as OrderWithItems;
  }

  async findAddressForUser(addressId: string, userId: string): Promise<Address | null> {
    return this.prisma.address.findFirst({ where: { id: addressId, userId } });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async updateProductStock(tx: Prisma.TransactionClient, productId: string, delta: number): Promise<Product> {
    return tx.product.update({
      where: { id: productId },
      data: { quantity: { increment: delta } },
    });
  }

  /** Takes `quantity` units only if that many are left; returns null when stock is short. */
  async decrementProductStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantity: number,
  ): Promise<Product | null> {
    const { count } = await tx.product.updateMany({
      where: { id: productId, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    if (count === 0) return null;
    return tx.product.findUniqueOrThrow({ where: { id: productId } });
  }

  async findProductById(productId: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  async findProduct(tx: Prisma.TransactionClient, productId: string): Promise<Product | null> {
    return tx.product.findUnique({ where: { id: productId } });
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
