import { ConflictException, Injectable } from '@nestjs/common';
import { AttributeDefinition, Prisma, ProductType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ProductTypeWithAttributes = ProductType & { attributes: AttributeDefinition[] };

const WITH_ATTRIBUTES = {
  attributes: { orderBy: [{ position: 'asc' }, { key: 'asc' }] },
} satisfies Prisma.ProductTypeInclude;

function conflictOnDuplicate(e: unknown, message: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new ConflictException(message);
  return e;
}

@Injectable()
export class ProductTypesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ProductTypeWithAttributes[]> {
    return this.prisma.productType.findMany({ include: WITH_ATTRIBUTES, orderBy: { name: 'asc' } });
  }

  async findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<ProductTypeWithAttributes | null> {
    return db.productType.findUnique({ where: { id }, include: WITH_ATTRIBUTES });
  }

  async findManyByIds(ids: string[]): Promise<ProductTypeWithAttributes[]> {
    return this.prisma.productType.findMany({ where: { id: { in: ids } }, include: WITH_ATTRIBUTES });
  }

  async findAttributeById(id: string): Promise<AttributeDefinition | null> {
    return this.prisma.attributeDefinition.findUnique({ where: { id } });
  }

  async countProducts(productTypeId: string): Promise<number> {
    return this.prisma.product.count({ where: { productTypeId } });
  }

  async create(
    data: Prisma.ProductTypeCreateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ProductTypeWithAttributes> {
    try {
      return await db.productType.create({ data, include: WITH_ATTRIBUTES });
    } catch (e) {
      throw conflictOnDuplicate(e, `A product type with key "${data.key}" already exists`);
    }
  }

  async update(
    id: string,
    data: Prisma.ProductTypeUpdateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ProductTypeWithAttributes> {
    return db.productType.update({ where: { id }, data, include: WITH_ATTRIBUTES });
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<ProductTypeWithAttributes> {
    return db.productType.delete({ where: { id }, include: WITH_ATTRIBUTES });
  }

  async createAttribute(
    data: Prisma.AttributeDefinitionUncheckedCreateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<AttributeDefinition> {
    try {
      return await db.attributeDefinition.create({ data });
    } catch (e) {
      throw conflictOnDuplicate(e, `The product type already has an attribute "${data.key}"`);
    }
  }

  async updateAttribute(
    id: string,
    data: Prisma.AttributeDefinitionUpdateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<AttributeDefinition> {
    return db.attributeDefinition.update({ where: { id }, data });
  }

  async deleteAttribute(id: string, db: Prisma.TransactionClient = this.prisma): Promise<AttributeDefinition> {
    return db.attributeDefinition.delete({ where: { id } });
  }
}
