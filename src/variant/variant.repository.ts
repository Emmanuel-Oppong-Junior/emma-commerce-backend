import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AttributeDefinition, Prisma, Variant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type VariantWithProduct = Variant & { product: { id: string; name: string } };
export type ProductForVariants = {
  id: string;
  name: string;
  isTaxable: boolean;
  productType: { key: string; attributes: AttributeDefinition[] };
};

/** Variant create data; the SKU is generated when omitted. */
export type NewVariant = Omit<Prisma.VariantUncheckedCreateInput, 'sku'> & { sku?: string };

const WITH_PRODUCT = { product: { select: { id: true, name: true } } } satisfies Prisma.VariantInclude;

/** A unique-looking SKU for a variant created without one, e.g. "SKU-3F9A0C12B7E4". */
export function generateSku(): string {
  return `SKU-${randomBytes(6).toString('hex').toUpperCase()}`;
}

function conflictMessage(e: Prisma.PrismaClientKnownRequestError): string {
  const target = String((e.meta?.target as string[] | string | undefined) ?? '');
  if (target.includes('sku')) return 'Another variant already uses this SKU';
  if (target.includes('barcode')) return 'Another variant already uses this barcode';
  if (target.includes('optionsKey')) return 'The product already has an active variant with these options';
  return 'The variant conflicts with an existing one';
}

function translate(e: unknown, variantId?: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') return new ConflictException(conflictMessage(e));
    if (e.code === 'P2025' && variantId) return new NotFoundException(`Variant "${variantId}" not found`);
  }
  return e;
}

@Injectable()
export class VariantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProductForVariants(productId: string): Promise<ProductForVariants | null> {
    return this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        isTaxable: true,
        productType: { select: { key: true, attributes: true } },
      },
    });
  }

  async create(data: NewVariant, db: Prisma.TransactionClient = this.prisma): Promise<VariantWithProduct> {
    try {
      return await db.variant.create({ data: { ...data, sku: data.sku ?? generateSku() }, include: WITH_PRODUCT });
    } catch (e) {
      throw translate(e);
    }
  }

  async findById(variantId: string): Promise<VariantWithProduct | null> {
    return this.prisma.variant.findUnique({ where: { id: variantId }, include: WITH_PRODUCT });
  }

  async findPage(
    where: Prisma.VariantWhereInput,
    options: { take: number; skip: number; cursor?: { id: string } },
  ): Promise<[Variant[], number]> {
    return Promise.all([
      this.prisma.variant.findMany({ where, ...options, orderBy: { id: 'asc' } }),
      this.prisma.variant.count({ where }),
    ]);
  }

  /** Another active variant of the product with the same option combination, if any. */
  async findActiveWithOptions(productId: string, optionsKey: string, exceptId?: string): Promise<Variant | null> {
    return this.prisma.variant.findFirst({
      where: { productId, optionsKey, isActive: true, ...(exceptId && { id: { not: exceptId } }) },
    });
  }

  async findBySkuOrBarcode(sku: string | undefined, barcode: string | undefined, exceptId?: string) {
    const or: Prisma.VariantWhereInput[] = [];
    if (sku) or.push({ sku: { equals: sku, mode: 'insensitive' } });
    if (barcode) or.push({ barcode });
    if (!or.length) return null;
    return this.prisma.variant.findFirst({
      where: { OR: or, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true, sku: true, barcode: true },
    });
  }

  async discountExists(discountId: string): Promise<boolean> {
    return (await this.prisma.discount.count({ where: { id: discountId } })) > 0;
  }

  async update(
    variantId: string,
    data: Prisma.VariantUncheckedUpdateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<VariantWithProduct> {
    try {
      return await db.variant.update({ where: { id: variantId }, data, include: WITH_PRODUCT });
    } catch (e) {
      throw translate(e, variantId);
    }
  }

  /** How many cart lines, order lines and stock movements reference the variant. */
  async countHistory(variantId: string): Promise<{ cartItems: number; orderItems: number; stockMovements: number }> {
    const [cartItems, orderItems, stockMovements] = await Promise.all([
      this.prisma.cartItem.count({ where: { variantId } }),
      this.prisma.orderItem.count({ where: { variantId } }),
      this.prisma.stockMovement.count({ where: { variantId } }),
    ]);
    return { cartItems, orderItems, stockMovements };
  }

  async countVariants(productId: string): Promise<number> {
    return this.prisma.variant.count({ where: { productId } });
  }

  async delete(variantId: string, db: Prisma.TransactionClient = this.prisma): Promise<Variant> {
    try {
      return await db.variant.delete({ where: { id: variantId } });
    } catch (e) {
      throw translate(e, variantId);
    }
  }
}
