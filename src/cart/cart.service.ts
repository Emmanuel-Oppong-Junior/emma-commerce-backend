import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddToCartInput } from './dto/add-to-cart.input';
import { Cart, CartItem, Prisma } from '../generated/prisma/client';
import { UpdateCartItemInput } from './dto/update-cart.input';
import { CartRepository, VariantForSale } from './cart.repository';
import { notSellableReason } from '../variant/sellable';
import { sellableQuantity } from '../inventory/fulfilment-location';
import { sellableLevels } from '../inventory/lots/lots';

type CartWithItems = Cart & { items: CartItem[] };

/**
 * Service for managing carts: a signed-in user's, found by user, and a guest's (P6-G.1), found by cart id once its
 * token was checked. A cart line is one variant (SKU) and is priced and stocked from it.
 */
@Injectable()
export class CartService {
  constructor(private readonly cartRepository: CartRepository) {}

  async getCart(userId: string): Promise<CartWithItems | null> {
    return this.cartRepository.findByUser(userId);
  }

  /**
   * Adds a variant to the user's cart, or adds to its quantity if it is already there.
   * @throws {NotFoundException} If the variant does not exist.
   * @throws {BadRequestException} If it is not on sale or the total quantity exceeds its stock.
   */
  async addToCart(userId: string, input: AddToCartInput): Promise<CartWithItems> {
    const variant = await this.findSellableVariant(input.variantId);
    const cart = await this.cartRepository.findOrCreate(userId);
    await this.addVariant(cart.id, variant, input.quantity);
    return this.getCart(userId) as Promise<CartWithItems>;
  }

  /**
   * Sets the quantity of a cart line, or removes it when the quantity is 0.
   * @throws {NotFoundException} If the cart or item does not exist.
   * @throws {BadRequestException} If the variant is no longer on sale or the quantity exceeds its stock.
   */
  async updateCartItem(userId: string, input: UpdateCartItemInput): Promise<CartWithItems> {
    await this.setQuantity(await this.getCartOrThrow(userId), input);
    return this.getCart(userId) as Promise<CartWithItems>;
  }

  async removeFromCart(userId: string, cartItemId: string): Promise<CartWithItems> {
    await this.removeItem(await this.getCartOrThrow(userId), cartItemId);
    return this.getCart(userId) as Promise<CartWithItems>;
  }

  async clearCart(userId: string): Promise<CartWithItems> {
    const cart = await this.getCartOrThrow(userId);
    await this.cartRepository.deleteAllCartItems(cart.id);
    return this.getCart(userId) as Promise<CartWithItems>;
  }

  async getCartOrThrow(userId: string, db?: Prisma.TransactionClient): Promise<CartWithItems> {
    const cart = await this.cartRepository.findByUser(userId, db);
    if (!cart) throw new NotFoundException(`Cart for user "${userId}" not found`);
    return cart;
  }

  /** A guest cart by id (its token already checked), with its lines. */
  async getGuestCartOrThrow(cartId: string, db?: Prisma.TransactionClient): Promise<CartWithItems> {
    const cart = await this.cartRepository.findGuestById(cartId, db);
    if (!cart) throw new NotFoundException('Guest cart not found or expired');
    return cart;
  }

  async addToGuestCart(cartId: string, input: AddToCartInput): Promise<CartWithItems> {
    await this.addVariant(cartId, await this.findSellableVariant(input.variantId), input.quantity);
    return this.getGuestCartOrThrow(cartId);
  }

  async updateGuestCartItem(cartId: string, input: UpdateCartItemInput): Promise<CartWithItems> {
    await this.setQuantity(await this.getGuestCartOrThrow(cartId), input);
    return this.getGuestCartOrThrow(cartId);
  }

  async removeFromGuestCart(cartId: string, cartItemId: string): Promise<CartWithItems> {
    await this.removeItem(await this.getGuestCartOrThrow(cartId), cartItemId);
    return this.getGuestCartOrThrow(cartId);
  }

  private async addVariant(cartId: string, variant: VariantForSale, quantity: number): Promise<void> {
    const existingItem = await this.cartRepository.findCartItem(cartId, variant.id);
    const newQuantity = (existingItem?.quantity ?? 0) + quantity;
    await this.ensureInStock(variant, newQuantity);
    await this.cartRepository.upsertCartItem(existingItem?.id, cartId, variant, variant.price!, newQuantity);
  }

  private async setQuantity(cart: CartWithItems, { cartItemId, quantity }: UpdateCartItemInput): Promise<void> {
    const item = cart.items.find((i) => i.id === cartItemId);
    if (!item) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);

    if (quantity <= 0) {
      await this.cartRepository.deleteCartItem(item.id);
    } else {
      await this.ensureInStock(await this.findSellableVariant(item.variantId), quantity);
      await this.cartRepository.updateCartItem(item.id, { quantity });
    }
  }

  private async removeItem(cart: CartWithItems, cartItemId: string): Promise<void> {
    const cartHasItem = cart.items.some((i) => i.id === cartItemId);
    if (!cartHasItem) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);
    await this.cartRepository.deleteCartItem(cartItemId);
  }

  private async findSellableVariant(variantId: string): Promise<VariantForSale> {
    const variant = await this.cartRepository.findVariant(variantId);
    if (!variant) throw new NotFoundException(`Variant "${variantId}" not found`);
    const reason = notSellableReason(variant);
    if (reason) throw new BadRequestException(reason);
    return variant;
  }

  private async ensureInStock(variant: VariantForSale, quantity: number): Promise<void> {
    // One order takes a variant from one location, so the cart allows what the best serving location holds.
    // Only lot-tracked variants have expired units (P4-C.1).
    const expired = variant.product.trackLots
      ? await this.cartRepository.findExpiredLotUnits([variant.id], new Date())
      : [];
    const available = sellableQuantity(sellableLevels(variant.id, variant.stockLevels, expired));
    if (quantity > available) {
      throw new BadRequestException(
        `Cannot add ${quantity} of "${variant.product.name}" (${variant.sku}) to cart; only ${available} in stock`,
      );
    }
  }
}
