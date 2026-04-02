import { Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CartWithItems = Cart & { items: CartItem[] };

@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true } } },
    });
  }

  async findOrCreate(userId: string): Promise<Cart> {
    const existing = await this.prisma.cart.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { userId } });
  }

  async findProductById(productId: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  async findCartItem(cartId: string, productId: string): Promise<Pick<CartItem, 'id' | 'quantity'> | null> {
    return this.prisma.cartItem.findFirst({
      where: { cartId, productId },
      select: { id: true, quantity: true },
    });
  }

  async upsertCartItem(
    existingItemId: string | undefined,
    cartId: string,
    productId: string,
    price: Prisma.Decimal,
    newQuantity: number,
    quantity: number,
  ): Promise<void> {
    await this.prisma.cartItem.upsert({
      where: { id: existingItemId ?? '' },
      update: { quantity: newQuantity, originalPrice: price },
      create: { cartId, productId, quantity, originalPrice: price },
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
