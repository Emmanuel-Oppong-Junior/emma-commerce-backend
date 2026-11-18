import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CouponsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.CouponCreateInput, db: Prisma.TransactionClient = this.prisma): Promise<Coupon> {
    try {
      return await db.coupon.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Coupon code already exists`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Coupon | null> {
    return this.prisma.coupon.findUnique({ where: { id } });
  }

  async findByCode(code: string): Promise<Coupon | null> {
    return this.prisma.coupon.findUnique({ where: { code } });
  }

  async findAll(): Promise<Coupon[]> {
    return this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async update(
    id: string,
    data: Prisma.CouponUpdateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Coupon> {
    try {
      return await db.coupon.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Coupon "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<Coupon> {
    try {
      return await db.coupon.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Coupon "${id}" not found`);
      }
      throw e;
    }
  }

  async hasUserUsedCoupon(couponId: string, userId: string): Promise<boolean> {
    const usage = await this.prisma.couponUsage.findUnique({
      where: { couponId_userId: { couponId, userId } },
    });
    return !!usage;
  }

  /** Records the use and returns the coupon as it is after the increment (row-locked until the tx ends). */
  async recordUsage(tx: Prisma.TransactionClient, couponId: string, userId: string, orderId: string): Promise<Coupon> {
    await tx.couponUsage.create({ data: { couponId, userId, orderId } });
    return tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
  }

  /** Deletes the usage recorded for the order, if any, and gives the use back to the coupon. */
  async releaseUsage(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const usage = await tx.couponUsage.findUnique({ where: { orderId } });
    if (!usage) return;
    await tx.couponUsage.delete({ where: { id: usage.id } });
    await tx.coupon.update({ where: { id: usage.couponId }, data: { usedCount: { decrement: 1 } } });
  }
}
