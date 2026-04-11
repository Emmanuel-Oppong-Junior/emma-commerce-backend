import { Injectable, NotFoundException } from '@nestjs/common';
import { Order, OrderStatus, Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.PaymentCreateInput): Promise<Payment> {
    return this.prisma.payment.create({ data });
  }

  async findById(id: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({
      where: { id, deleted: false },
      include: { order: true },
    });
  }

  async findByReference(reference: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { transactionId: reference, deleted: false },
    });
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { orderId } });
  }

  async findByUser(userId: string): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { order: { userId }, deleted: false },
      include: { order: true },
    });
  }

  async update(id: string, data: Prisma.PaymentUpdateInput): Promise<Payment> {
    try {
      return await this.prisma.payment.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Payment not found');
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Payment> {
    try {
      return await this.prisma.payment.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Payment not found');
      }
      throw e;
    }
  }

  async findOrderWithUser(orderId: string): Promise<(Order & { user: { email: string } }) | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    }) as Promise<(Order & { user: { email: string } }) | null>;
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: { status },
    });
  }

  async forceUpdateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
  }

  async updatePaymentWithStatus(
    paymentId: string,
    status: PaymentStatus,
    paymentDetails: Prisma.InputJsonValue,
  ): Promise<Payment> {
    return this.prisma.payment.update({
      where: { id: paymentId },
      data: { status, paymentDetails },
    });
  }
}
