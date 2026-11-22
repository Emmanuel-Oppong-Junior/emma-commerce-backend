import { Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Prisma, Product, Variant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockCounts } from '../inventory/stock';
import { SERVING_LOCATION } from '../inventory/locations/serving-locations';
import { findExpiredLotUnits } from '../inventory/lots/lot-stock.repository';
import { ExpiredLotUnits } from '../inventory/lots/lots';

type CartWithItems = Cart & { items: CartItem[] };
export type VariantForSale = Variant & { product: Product; stockLevels: (StockCounts & { locationId: string })[] };

/** What checking a variant for sale reads: the variant, its product and its stock at each location serving customers. */
export const FOR_SALE = {
  product: true,
  stockLevels: { where: { location: SERVING_LOCATION }, select: { onHand: true, reserved: true, locationId: true } },
} satisfies Prisma.VariantInclude;

@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string, db: Prisma.TransactionClient = this.prisma): Promise<CartWithItems | null> {
    return db.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, variant: true }, orderBy: { createdAt: 'asc' } } },
    });
  }

  async findOrCreate(userId: string): Promise<Cart> {
    const existing = await this.prisma.cart.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { userId } });
  }

  async findVariant(variantId: string): Promise<VariantForSale | null> {
    return this.prisma.variant.findUnique({ where: { id: variantId }, include: FOR_SALE });
  }

  /** Units of the variants' expired lots per location, which are not sellable (P4-C.1). */
  findExpiredLotUnits(variantIds: string[], now: Date): Promise<ExpiredLotUnits[]> {
    return findExpiredLotUnits(this.prisma, variantIds, now);
  }

  async findCartItem(cartId: string, variantId: string): Promise<Pick<CartItem, 'id' | 'quantity'> | null> {
    return this.prisma.cartItem.findFirst({
      where: { cartId, variantId },
      select: { id: true, quantity: true },
    });
  }

  async upsertCartItem(
    existingItemId: string | undefined,
    cartId: string,
    variant: Pick<Variant, 'id' | 'productId'>,
    price: Prisma.Decimal,
    newQuantity: number,
  ): Promise<void> {
    await this.prisma.cartItem.upsert({
      where: { id: existingItemId ?? '' },
      update: { quantity: newQuantity, originalPrice: price },
      create: {
        cartId,
        productId: variant.productId,
        variantId: variant.id,
        quantity: newQuantity,
        originalPrice: price,
      },
    });
  }

  async updateCartItem(id: string, data: Prisma.CartItemUpdateInput): Promise<CartItem> {
    try {
      return await this.prisma.cartItem.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Cart item "${id}" not found`);
      }
      throw e;
    }
  }

  async deleteCartItem(id: string): Promise<void> {
    await this.prisma.cartItem.delete({ where: { id } });
  }

  async deleteAllCartItems(cartId: string): Promise<void> {
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
  }
}
