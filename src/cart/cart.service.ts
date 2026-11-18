import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddToCartInput } from './dto/add-to-cart.input';

import { Cart, CartItem, Product } from '@prisma/client';
import { UpdateCartItemInput } from './dto/update-cart.input';
import { CartRepository } from './cart.repository';

/**
 * Service for managing user carts in an e-commerce system.
 * Handles adding, updating, and removing items, as well as retrieving and clearing carts.
 */
@Injectable()
export class CartService {
  constructor(private readonly cartRepository: CartRepository) {}

  /**
   * Retrieves the user's cart with its items.
   * @param userId - The ID of the user owning the cart.
   * @returns The user's cart with its items.
   */
  async getCart(userId: string): Promise<(Cart & { items: CartItem[] }) | null> {
    return this.cartRepository.findByUser(userId);
  }

  /**
   * Adds a product to the user's cart, updating quantity if it already exists.
   * @param userId - The ID of the user owning the cart.
   * @param input - The product ID and quantity to add.
   * @returns The updated cart with its items.
   * @throws {NotFoundException} If the product does not exist.
   * @throws {BadRequestException} If the requested quantity exceeds available stock.
   */
  async addToCart(userId: string, input: AddToCartInput): Promise<Cart & { items: CartItem[] }> {
    const { productId, quantity } = input;
    const product = await this.validateProductAndStock(productId, quantity);
    await this.ensureSoldWithoutVariants(product);
    const cart = await this.cartRepository.findOrCreate(userId);
    await this.upsertCartItem(cart.id, product, quantity);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  /**
   * Updates the quantity of an item in the user's cart or removes it if quantity is 0.
   * @param userId - The ID of the user owning the cart.
   * @param input - The cart item ID and new quantity.
   * @returns The updated cart with its items.
   * @throws {NotFoundException} If the cart or item does not exist.
   * @throws {BadRequestException} If the new quantity exceeds stock or is negative.
   */
  async updateCartItem(userId: string, input: UpdateCartItemInput): Promise<Cart & { items: CartItem[] }> {
    const { cartItemId, quantity } = input;
    const cart = await this.getCartOrThrow(userId);
    const item = this.findCartItemOrThrow(cart, cartItemId);

    await this.handleCartItemUpdate(item, quantity);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  /**
   * Removes a specific item from the user's cart.
   * @param userId - The ID of the user owning the cart.
   * @param cartItemId - The ID of the cart item to remove.
   * @returns The updated cart with its items.
   * @throws {NotFoundException} If the cart or item does not exist.
   */
  async removeFromCart(userId: string, cartItemId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.getCartOrThrow(userId);
    const cartHasItem = cart.items.some((i) => i.id === cartItemId);
    if (!cartHasItem) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);
    await this.cartRepository.deleteCartItem(cartItemId);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  /**
   * Clears all items from the user's cart.
   * @param userId - The ID of the user owning the cart.
   * @returns The cleared cart with no items.
   * @throws {NotFoundException} If the cart does not exist.
   */
  async clearCart(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.getCartOrThrow(userId);
    await this.cartRepository.deleteAllCartItems(cart.id);
    return this.getCart(userId) as Promise<Cart & { items: CartItem[] }>;
  }

  /**
   * Validates that a product exists and has sufficient stock.
   * @param productId - The ID of the product to validate.
   * @param quantity - The requested quantity.
   * @returns The product if valid.
   * @throws {NotFoundException} If the product does not exist.
   * @throws {BadRequestException} If the requested quantity exceeds available stock or product is inactive.
   */
  private async validateProductAndStock(productId: string, quantity: number): Promise<Product> {
    const product = await this.cartRepository.findProductById(productId);
    if (!product) throw new NotFoundException(`Product "${productId}" not found`);
    if (!product.isActive) throw new BadRequestException(`Product "${productId}" is not active`);
    if (product.quantity < quantity) {
      throw new BadRequestException(
        `Cannot add ${quantity} of "${product.name}" to cart; only ${product.quantity} in stock`,
      );
    }
    return product;
  }

  private async ensureSoldWithoutVariants(product: Product): Promise<void> {
    // Cart and checkout price and stock the product only, so a variant would be sold at the wrong price (VAR-01).
    if ((await this.cartRepository.countVariants(product.id)) > 0) {
      throw new BadRequestException(
        `"${product.name}" comes in variants and cannot be bought until variant checkout is available`,
      );
    }
  }

  /**
   * Creates a new cart item or updates an existing one with the specified quantity.
   * @param cartId - The ID of the cart.
   * @param product - The product being added or updated.
   * @param quantity - The quantity to add (for new items) or increment (for existing items).
   * @throws {BadRequestException} If the total quantity exceeds available stock.
   */
  private async upsertCartItem(cartId: string, product: Product, quantity: number): Promise<void> {
    const existingItem = await this.cartRepository.findCartItem(cartId, product.id);

    const newQuantity = existingItem ? existingItem.quantity + quantity : quantity;
    if (newQuantity > product.quantity) {
      throw new BadRequestException(
        `Cannot add ${newQuantity} of "${product.name}" to cart; only ${product.quantity} in stock`,
      );
    }

    await this.cartRepository.upsertCartItem(
      existingItem?.id,
      cartId,
      product.id,
      product.price!,
      newQuantity,
      quantity,
    );
  }

  /**
   * Finds a cart item by ID or throws if not found.
   * @param cart - The user's cart.
   * @param cartItemId - The ID of the cart item to find.
   * @returns The cart item.
   * @throws {NotFoundException} If the item does not exist.
   */
  private findCartItemOrThrow(cart: Cart & { items: CartItem[] }, cartItemId: string): CartItem {
    const item = cart.items.find((i) => i.id === cartItemId);
    if (!item) throw new NotFoundException(`Cart item "${cartItemId}" not found in user's cart`);
    return item;
  }

  /**
   * Retrieves the user's cart with its items.
   * @param userId - The ID of the user owning the cart.
   * @returns The user's cart with its items.
   * @throws {NotFoundException} If the cart does not exist.
   */
  async getCartOrThrow(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.cartRepository.findByUser(userId);
    if (!cart) throw new NotFoundException(`Cart for user "${userId}" not found`);
    return cart;
  }

  /**
   * Updates or deletes a cart item based on the new quantity.
   * @param item - The cart item to update or delete.
   * @param quantity - The new quantity (0 or less to delete).
   * @throws {BadRequestException} If the new quantity exceeds stock.
   */
  private async handleCartItemUpdate(item: CartItem, quantity: number): Promise<void> {
    if (quantity <= 0) {
      await this.cartRepository.deleteCartItem(item.id);
      return;
    }
    await this.validateProductAndStock(item.productId, quantity);
    await this.cartRepository.updateCartItem(item.id, { quantity });
  }
}
