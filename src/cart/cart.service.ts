import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddToCartInput } from './dto/add-to-cart.input';
import { Cart, CartItem } from '../generated/prisma/client';
import { UpdateCartItemInput } from './dto/update-cart.input';
import { CartRepository, VariantForSale } from './cart.repository';
import { notSellableReason } from '../variant/sellable';

/**
 * Service for managing user carts. A cart line is one variant (SKU) and is priced and stocked from it.
 */
@Injectable()
export class CartService {
  constructor(private readonly cartRepository: CartRepository) {}

  async getCart(userId: string): Promise<(Cart & { items: CartItem[] }) | null> {
    return this.cartRepository.findByUser(userId);
  }

  /**
   * Adds a variant to the user's cart, or adds to its quantity if it is already there.
   * @throws {NotFoundException} If the variant does not exist.
   * @throws {BadRequestException} If it is not on sale or the total quantity exceeds its stock.
   */
  async addToCart(userId: string, input: AddToCartInput): Promise<Cart & { items: CartItem[] }> {
    const variant = await this.findSellableVariant(input.variantId);
    const cart = await this.cartRepository.findOrCreate(userId);
    const existingItem = await this.cartRepository.findCartItem(cart.id, variant.id);
    const newQuantity = (existingItem?.quantity ?? 0) + input.quantity;
    this.ensureInStock(variant, newQuantity);
    await this.cartRepository.upsertCartItem(existingItem?.id, cart.id, variant, variant.price!, newQuantity);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  /**
   * Sets the quantity of a cart line, or removes it when the quantity is 0.
   * @throws {NotFoundException} If the cart or item does not exist.
   * @throws {BadRequestException} If the variant is no longer on sale or the quantity exceeds its stock.
   */
  async updateCartItem(userId: string, input: UpdateCartItemInput): Promise<Cart & { items: CartItem[] }> {
    const { cartItemId, quantity } = input;
    const cart = await this.getCartOrThrow(userId);
    const item = cart.items.find((i) => i.id === cartItemId);
    if (!item) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);

    if (quantity <= 0) {
      await this.cartRepository.deleteCartItem(item.id);
    } else {
      this.ensureInStock(await this.findSellableVariant(item.variantId), quantity);
      await this.cartRepository.updateCartItem(item.id, { quantity });
    }
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  async removeFromCart(userId: string, cartItemId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.getCartOrThrow(userId);
    const cartHasItem = cart.items.some((i) => i.id === cartItemId);
    if (!cartHasItem) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);
    await this.cartRepository.deleteCartItem(cartItemId);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  async clearCart(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.getCartOrThrow(userId);
    await this.cartRepository.deleteAllCartItems(cart.id);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  async getCartOrThrow(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.cartRepository.findByUser(userId);
    if (!cart) throw new NotFoundException(`Cart for user "${userId}" not found`);
    return cart;
  }

  private async findSellableVariant(variantId: string): Promise<VariantForSale> {
    const variant = await this.cartRepository.findVariant(variantId);
    if (!variant) throw new NotFoundException(`Variant "${variantId}" not found`);
    const reason = notSellableReason(variant);
    if (reason) throw new BadRequestException(reason);
    return variant;
  }

  private ensureInStock(variant: VariantForSale, quantity: number): void {
    if (quantity > variant.quantity) {
      throw new BadRequestException(
        `Cannot add ${quantity} of "${variant.product.name}" (${variant.sku}) to cart; only ${variant.quantity} in stock`,
      );
    }
  }
}
