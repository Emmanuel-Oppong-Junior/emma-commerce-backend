import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WishList } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type WishlistWithProducts = WishList & { products: { id: string; name: string }[] };

@Injectable()
export class WishlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string): Promise<WishlistWithProducts | null> {
    return this.prisma.wishList.findUnique({
      where: { userId },
      include: { products: true },
    });
  }

  async create(userId: string): Promise<WishlistWithProducts> {
    return this.prisma.wishList.create({
      data: { userId },
      include: { products: true },
    });
  }

  async findProductById(productId: string): Promise<{ id: string } | null> {
    return this.prisma.product.findUnique({ where: { id: productId } });
  }

  async connectProduct(wishListId: string, productId: string): Promise<WishlistWithProducts> {
    try {
      return await this.prisma.wishList.update({
        where: { id: wishListId },
        data: { products: { connect: { id: productId } } },
        include: { products: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Wishlist not found');
      }
      throw e;
    }
  }

  async disconnectProduct(wishListId: string, productId: string): Promise<WishlistWithProducts> {
    try {
      return await this.prisma.wishList.update({
        where: { id: wishListId },
        data: { products: { disconnect: { id: productId } } },
        include: { products: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Wishlist not found');
      }
      throw e;
    }
  }

  async clearProducts(wishListId: string): Promise<WishlistWithProducts> {
    try {
      return await this.prisma.wishList.update({
        where: { id: wishListId },
        data: { products: { set: [] } },
        include: { products: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Wishlist not found');
      }
      throw e;
    }
  }
}
