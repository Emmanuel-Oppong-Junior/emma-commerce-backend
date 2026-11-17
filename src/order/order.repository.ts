import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Address,
  FulfillmentType,
  Order,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  Prisma,
  Product,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type OrderWithItems = Order & { items: OrderItem[] };

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
   * Moves the order to `to` only if it is still in one of `from` (and not deleted).
   * Returns null when another request changed it first, so callers can report a conflict.
   */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    to: OrderStatus,
    from: OrderStatus[],
  ): Promise<OrderWithItems | null> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: { in: from }, deleted: false },
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

  async decrementProductStock(tx: Prisma.TransactionClient, productId: string, quantity: number): Promise<Product> {
    return tx.product.update({
      where: { id: productId },
      data: { quantity: { decrement: quantity } },
    });
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

  async findPaymentByOrderId(orderId: string) {
    return this.prisma.payment.findUnique({ where: { orderId } });
  }

  async findExpiredPendingOrders(cutoff: Date): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.ONLINE,
        createdAt: { lt: cutoff },
        payment: { is: null },
        deleted: false,
      },
      include: { items: true },
    }) as unknown as OrderWithItems[];
  }
}
