import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Variant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVariantInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';

type VariantWithProduct = Variant & { product: { id: string; name: string } };

@Injectable()
export class VariantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProductById(productId: string): Promise<{ id: string } | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  async create(data: CreateVariantInput, db: Prisma.TransactionClient = this.prisma): Promise<VariantWithProduct> {
    return db.variant.create({
      data,
      include: { product: { select: { id: true, name: true } } },
    });
  }

  async findById(variantId: string): Promise<VariantWithProduct | null> {
    return this.prisma.variant.findUnique({
      where: { id: variantId },
      include: { product: { select: { id: true, name: true } } },
    });
  }

  async findByProduct(productId: string): Promise<VariantWithProduct[]> {
    return this.prisma.variant.findMany({
      where: { productId },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async findAll(): Promise<Variant[]> {
    return this.prisma.variant.findMany({ orderBy: { id: 'asc' } });
  }

  async update(
    variantId: string,
    data: UpdateVariantInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<VariantWithProduct> {
    try {
      return await db.variant.update({
        where: { id: variantId },
        data,
        include: { product: { select: { id: true, name: true } } },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Variant "${variantId}" not found`);
      }
      throw e;
    }
  }

  async delete(variantId: string, db: Prisma.TransactionClient = this.prisma): Promise<Variant> {
    try {
      return await db.variant.delete({ where: { id: variantId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Variant "${variantId}" not found`);
      }
      throw e;
    }
  }
}
