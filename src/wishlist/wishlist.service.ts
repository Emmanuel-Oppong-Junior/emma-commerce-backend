import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WishList } from '../generated/prisma/client';
import { WishlistRepository } from './wishlist.repository';

@Injectable()
export class WishlistService {
  constructor(private readonly wishlistRepository: WishlistRepository) {}

  /**
   * Retrieves the user's wishlist or creates one if it doesn't exist.
   * @param userId - The ID of the user.
   * @returns The user's wishlist with product details.
   */
  async getOrCreateWishlist(userId: string) {
    const wishlist = await this.wishlistRepository.findByUser(userId);
    return wishlist || (await this.wishlistRepository.create(userId));
  }

  /**
   * Adds a product to the user's wishlist.
   * @param userId - The ID of the user.
   * @param productId - The ID of the product.
   * @returns The updated wishlist.
   */
  async addToWishlist(userId: string, productId: string) {
    await this.validateProductExists(productId);
    const wishlist = await this.getOrCreateWishlist(userId);
    await this.ensureProductNotInWishlist(wishlist, productId);
    this.enforceWishlistLimit(wishlist);
    return this.wishlistRepository.connectProduct(wishlist.id, productId);
  }

  /**
   * Removes a product from the user's wishlist.
   * @param userId - The ID of the user.
   * @param productId - The ID of the product.
   * @returns The updated wishlist.
   */
  async removeFromWishlist(userId: string, productId: string) {
    const wishlist = await this.getOrCreateWishlist(userId);
    await this.ensureProductInWishlist(wishlist, productId);
    return this.wishlistRepository.disconnectProduct(wishlist.id, productId);
  }

  /**
   * Clears all products from the user's wishlist.
   * @param userId - The ID of the user.
   * @returns The updated wishlist.
   */
  async clearWishlist(userId: string) {
    const wishlist = await this.getOrCreateWishlist(userId);
    return this.wishlistRepository.clearProducts(wishlist.id);
  }

  private async validateProductExists(productId: string): Promise<void> {
    const product = await this.wishlistRepository.findProductById(productId);
    if (!product) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
  }

  private enforceWishlistLimit(wishlist: WishList & { products: { id: string }[] }): void {
    if (wishlist.products.length >= 100) {
      throw new UnprocessableEntityException('Wishlist is full — maximum of 100 products allowed');
    }
  }

  private async ensureProductNotInWishlist(
    wishList: WishList & { products: { id: string }[] },
    productId: string,
  ): Promise<void> {
    if (this.isProductInWishlist(wishList, productId)) {
      throw new BadRequestException(`Product "${productId}" is already in your wishlist`);
    }
  }

  private async ensureProductInWishlist(wishlist: WishList & { products: { id: string }[] }, productId: string) {
    if (!this.isProductInWishlist(wishlist, productId)) {
      throw new NotFoundException(`Product "${productId}" not found in your wishlist`);
    }
  }

  private isProductInWishlist(wishList: WishList & { products: { id: string }[] }, productId: string): boolean {
    return wishList.products.some((product) => product.id === productId);
  }
}
