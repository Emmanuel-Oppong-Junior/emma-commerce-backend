import { Injectable, NotFoundException } from '@nestjs/common';
import { Address, Order, OrderItem, OrderStatus, Prisma, Product, User } from '@prisma/client';
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
      include: { items: true },
    }) as unknown as Promise<Order[]>;
  }

  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    shippingAddressId: string,
    orderDetails: {
      orderItems: OrderItem[];
      totalAmount: Prisma.Decimal;
      shippingAddressSnapshot?: Record<string, unknown>;
      couponId?: string;
      couponDiscount?: number;
    },
  ): Promise<OrderWithItems> {
    return tx.order.create({
      data: {
        userId,
        shippingAddressId,
        totalAmount: orderDetails.totalAmount,
        shippingAddressSnapshot: (orderDetails.shippingAddressSnapshot as Prisma.JsonObject) ?? Prisma.JsonNull,
        couponId: orderDetails.couponId,
        couponDiscount: orderDetails.couponDiscount,
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

  async updateStatus(orderId: string, status: OrderStatus): Promise<OrderWithItems> {
    try {
      return (await this.prisma.order.update({
        where: { id: orderId },
        data: { status },
        include: { items: { include: { product: true } } },
      })) as unknown as OrderWithItems;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Order "${orderId}" not found`);
      }
      throw e;
    }
  }

  async softDelete(id: string): Promise<OrderWithItems> {
    return this.prisma.order.update({
      where: { id },
      data: { deleted: true, deletedAt: new Date() },
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
}
