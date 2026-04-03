import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CouponsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.CouponCreateInput): Promise<Coupon> {
    try {
      return await this.prisma.coupon.create({ data });
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

  async update(id: string, data: Prisma.CouponUpdateInput): Promise<Coupon> {
    try {
      return await this.prisma.coupon.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Coupon "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Coupon> {
    try {
      return await this.prisma.coupon.delete({ where: { id } });
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

  async recordUsage(tx: Prisma.TransactionClient, couponId: string, userId: string, orderId: string): Promise<void> {
    await tx.couponUsage.create({ data: { couponId, userId, orderId } });
    await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
  }
}
