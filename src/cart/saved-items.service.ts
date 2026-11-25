import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { notSellableReason } from '../variant/sellable';
import { MAX_STOCK_QUANTITY } from '../variant/dto/create-variant.input';
import { CartService } from './cart.service';

/** How many variants a customer can keep saved for later. */
export const SAVED_ITEMS_LIMIT = 100;

const WITH_VARIANT = { variant: { include: { product: true } } } satisfies Prisma.SavedCartItemInclude;
export type SavedItemWithVariant = Prisma.SavedCartItemGetPayload<{ include: typeof WITH_VARIANT }>;

/**
 * "Saved for later" (P6-G.2): a customer's variants moved out of the cart, one row per variant. Moving a line back
 * goes through CartService.addToCart, so it is checked for sale and stock exactly like adding it; cart pricing and
 * checkout are untouched.
 */
@Injectable()
export class SavedItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
  ) {}

  list(userId: string): Promise<SavedItemWithVariant[]> {
    return this.prisma.savedCartItem.findMany({
      where: { userId },
      include: WITH_VARIANT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Moves a cart line to the saved list (adding its quantity to the variant's saved row, if any) and returns the cart.
   * @throws NotFoundException if the line is not in the user's cart; ConflictException (SAVED_ITEMS_LIMIT_REACHED).
   */
  async saveForLater(userId: string, cartItemId: string): Promise<Cart & { items: CartItem[] }> {
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.cartItem.findFirst({ where: { id: cartItemId, cart: { userId } } });
      if (!item) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);
      const existing = await tx.savedCartItem.findUnique({
        where: { userId_variantId: { userId, variantId: item.variantId } },
      });
      if (!existing && (await tx.savedCartItem.count({ where: { userId } })) >= SAVED_ITEMS_LIMIT) {
        throw new ConflictException({
          message: `At most ${SAVED_ITEMS_LIMIT} items can be saved for later`,
          extensions: { reason: 'SAVED_ITEMS_LIMIT_REACHED' },
        });
      }
      await tx.savedCartItem.upsert({
        where: { userId_variantId: { userId, variantId: item.variantId } },
        create: { userId, variantId: item.variantId, quantity: item.quantity },
        update: { quantity: Math.min((existing?.quantity ?? 0) + item.quantity, MAX_STOCK_QUANTITY) },
      });
      await tx.cartItem.delete({ where: { id: item.id } });
    });
    return this.cart.getCartOrThrow(userId);
  }

  /**
   * Puts a saved variant back in the cart (with its saved quantity) and removes it from the list; returns the cart.
   * @throws NotFoundException; BadRequestException with reason SAVED_ITEM_UNAVAILABLE when it is no longer on sale, or
   * the cart's stock refusal.
   */
  async moveToCart(userId: string, savedItemId: string): Promise<Cart & { items: CartItem[] }> {
    const saved = await this.findOwn(userId, savedItemId);
    const reason = notSellableReason(saved.variant);
    if (reason) throw new BadRequestException({ message: reason, extensions: { reason: 'SAVED_ITEM_UNAVAILABLE' } });
    const cart = await this.cart.addToCart(userId, { variantId: saved.variantId, quantity: saved.quantity });
    // Added first, then removed: a failure in between leaves the item in both lists, never in neither.
    await this.prisma.savedCartItem.deleteMany({ where: { id: saved.id, userId } });
    return cart;
  }

  async remove(userId: string, savedItemId: string): Promise<boolean> {
    const { count } = await this.prisma.savedCartItem.deleteMany({ where: { id: savedItemId, userId } });
    if (count === 0) throw new NotFoundException(`Saved item "${savedItemId}" not found`);
    return true;
  }

  private async findOwn(userId: string, savedItemId: string): Promise<SavedItemWithVariant> {
    const saved = await this.prisma.savedCartItem.findFirst({
      where: { id: savedItemId, userId },
      include: WITH_VARIANT,
    });
    if (!saved) throw new NotFoundException(`Saved item "${savedItemId}" not found`);
    return saved;
  }
}
