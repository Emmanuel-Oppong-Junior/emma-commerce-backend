import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Review } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProductById(productId: string): Promise<{ id: string } | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  async findExisting(userId: string, productId: string): Promise<Review | null> {
    return this.prisma.review.findFirst({ where: { userId, productId } });
  }

  async create(
    data: Prisma.ReviewCreateInput,
  ): Promise<Review & { user: { id: string; email: string }; product: { id: string; name: string } }> {
    return this.prisma.review.create({
      data,
      include: {
        user: { select: { id: true, email: true } },
        product: { select: { id: true, name: true } },
      },
    });
  }

  async findById(
    reviewId: string,
  ): Promise<(Review & { user: { id: string; email: string }; product: { id: string; name: string } }) | null> {
    return this.prisma.review.findUnique({
      where: { id: reviewId },
      include: {
        user: { select: { id: true, email: true } },
        product: { select: { id: true, name: true } },
      },
    });
  }

  async findByProduct(productId: string): Promise<(Review & { user: { id: string; email: string } })[]> {
    return this.prisma.review.findMany({
      where: { productId },
      include: { user: { select: { id: true, email: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async findByUser(userId: string): Promise<(Review & { product: { id: string; name: string } })[]> {
    return this.prisma.review.findMany({
      where: { userId },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async update(
    id: string,
    data: Pick<Review, 'score' | 'comment'>,
  ): Promise<Review & { user: { id: string; email: string }; product: { id: string; name: string } }> {
    try {
      return await this.prisma.review.update({
        where: { id },
        data,
        include: {
          user: { select: { id: true, email: true } },
          product: { select: { id: true, name: true } },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Review "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Review> {
    try {
      return await this.prisma.review.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Review "${id}" not found`);
      }
      throw e;
    }
  }
}
