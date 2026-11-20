import { Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Prisma, Product, Variant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockCounts } from '../inventory/stock';

type CartWithItems = Cart & { items: CartItem[] };
export type VariantForSale = Variant & { product: Product; stockLevels: StockCounts[] };

/** What checking a variant for sale reads: the variant, its product and its stock at every location. */
export const FOR_SALE = {
  product: true,
  stockLevels: { select: { onHand: true, reserved: true } },
} satisfies Prisma.VariantInclude;

@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
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
