import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Category, Prisma, Product, SubCategory, Tag } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface VariantOptions {
  id: string;
  optionValues: Prisma.InputJsonObject;
  optionsKey: string;
}

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.ProductCreateInput,
    include?: Prisma.ProductInclude,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Product> {
    try {
      return await db.product.create({ data, include });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A product with this SKU already exists');
      }
      throw e;
    }
  }

  async update(
    id: string,
    data: Prisma.ProductUpdateInput,
    include?: Prisma.ProductInclude,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Product> {
    try {
      return await db.product.update({ where: { id }, data, include });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Product not found');
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<Product> {
    try {
      return await db.product.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Product not found');
      }
      throw e;
    }
  }

  async findById(id: string, select?: Prisma.ProductSelect): Promise<Product | null> {
    const opts: Prisma.ProductFindUniqueArgs = { where: { id } };
    if (select && Object.keys(select).length) opts.select = { ...select, id: true, productTypeId: true };
    return this.prisma.product.findUnique(opts);
  }

  async findFirst(where: Prisma.ProductWhereInput, select?: Prisma.ProductSelect): Promise<Product | null> {
    const opts: Prisma.ProductFindFirstArgs = { where };
    if (select && Object.keys(select).length) opts.select = { ...select, id: true, productTypeId: true };
    return this.prisma.product.findFirst(opts);
  }

  async findMany(
    options: { take?: number; skip?: number; cursor?: { id: string } },
    where: Prisma.ProductWhereInput,
    orderBy: Prisma.ProductOrderByWithRelationInput,
    select?: Prisma.ProductSelect,
  ): Promise<Product[]> {
    const queryOptions: Prisma.ProductFindManyArgs = {
      ...options,
      where,
      orderBy,
    };
    if (select && Object.keys(select).length) queryOptions.select = { ...select, id: true, productTypeId: true };
    return this.prisma.product.findMany(queryOptions);
  }

  async count(where: Prisma.ProductWhereInput): Promise<number> {
    return this.prisma.product.count({ where });
  }

  async updateTags(
    productId: string,
    operation: 'connect' | 'disconnect',
    tagId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Product> {
    return db.product.update({
      where: { id: productId },
      data: { tags: { [operation]: { id: tagId } } },
      include: { tags: true },
    });
  }

  // Cross-entity validation queries

  async findCategoryById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  async findSubCategoryById(id: string): Promise<SubCategory | null> {
    return this.prisma.subCategory.findUnique({ where: { id } });
  }

  async findTagById(id: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { id } });
  }

  async findVariantOptions(productId: string): Promise<{ id: string; optionValues: Prisma.JsonValue }[]> {
    return this.prisma.variant.findMany({ where: { productId }, select: { id: true, optionValues: true } });
  }

  async updateVariantOptions(variant: VariantOptions, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    await db.variant.update({
      where: { id: variant.id },
      data: { optionValues: variant.optionValues, optionsKey: variant.optionsKey },
    });
  }

  async countCartItems(productId: string): Promise<number> {
    return this.prisma.cartItem.count({ where: { productId } });
  }

  async countOrderItems(productId: string): Promise<number> {
    return this.prisma.orderItem.count({ where: { productId } });
  }
}
