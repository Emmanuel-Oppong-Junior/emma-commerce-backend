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

  /** A guest cart (P6-G.1) by id, with its lines. */
  async findGuestById(cartId: string, db: Prisma.TransactionClient = this.prisma): Promise<CartWithItems | null> {
    return db.cart.findFirst({
      where: { id: cartId, userId: null },
      include: { items: { include: { product: true, variant: true }, orderBy: { createdAt: 'asc' } } },
    });
  }

  /** The live guest cart whose token hashes to `tokenHash`, its idle expiry moved to `expiresAt`; null if none. */
  async touchGuest(tokenHash: string, now: Date, expiresAt: Date): Promise<Cart | null> {
    const { count } = await this.prisma.cart.updateMany({
      where: { guestTokenHash: tokenHash, guestExpiresAt: { gt: now } },
      data: { guestExpiresAt: expiresAt },
    });
    return count === 0 ? null : this.prisma.cart.findUnique({ where: { guestTokenHash: tokenHash } });
  }

  async createGuest(tokenHash: string, expiresAt: Date): Promise<Cart> {
    return this.prisma.cart.create({ data: { guestTokenHash: tokenHash, guestExpiresAt: expiresAt } });
  }

  /** The phone a guest is verifying: a different number than before is no longer verified. */
  async setGuestPhone(cartId: string, phone: string): Promise<void> {
    await this.prisma.cart.updateMany({
      where: { id: cartId, userId: null, OR: [{ guestPhone: null }, { NOT: { guestPhone: phone } }] },
      data: { guestPhone: phone, guestPhoneVerifiedAt: null },
    });
  }

  /** Marks the guest's phone verified, conditional on it still being the number the code was sent to. */
  async markGuestPhoneVerified(cartId: string, phone: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.cart.updateMany({
      where: { id: cartId, userId: null, guestPhone: phone },
      data: { guestPhoneVerifiedAt: at },
    });
    return count === 1;
  }

  /** Deletes guest carts idle past their expiry (their lines go with them); returns how many. */
  async deleteExpiredGuests(now: Date): Promise<number> {
    const { count } = await this.prisma.cart.deleteMany({ where: { userId: null, guestExpiresAt: { lte: now } } });
    return count;
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
