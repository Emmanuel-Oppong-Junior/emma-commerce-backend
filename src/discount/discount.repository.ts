import { Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Discount, Order, OrderItem, Prisma, Product, Variant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DiscountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.DiscountCreateInput): Promise<Discount> {
    return this.prisma.discount.create({ data });
  }

  async update(id: string, data: Prisma.DiscountUpdateInput): Promise<Discount> {
    try {
      return await this.prisma.discount.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Discount with ID ${id} not found`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Discount | null> {
    return this.prisma.discount.findUnique({ where: { id } });
  }

  async findAll(): Promise<Discount[]> {
    return this.prisma.discount.findMany();
  }

  async delete(id: string): Promise<Discount> {
    try {
      return await this.prisma.discount.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Discount with ID ${id} not found`);
      }
      throw e;
    }
  }

  async findProductById(id: string, select?: Prisma.ProductSelect): Promise<Partial<Product> | null> {
    return this.prisma.product.findUnique({ where: { id }, select: select ?? undefined });
  }

  async findProductWithDiscounts(
    productId: string,
  ): Promise<{ categoryId: string | null; discounts: Discount[] } | null> {
    return this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        categoryId: true,
        discounts: {
          where: { isActive: true, startDate: { lte: new Date() }, endDate: { gte: new Date() } },
        },
      },
    });
  }

  async findVariantById(id: string, select?: Prisma.VariantSelect): Promise<Partial<Variant> | null> {
    return this.prisma.variant.findUnique({ where: { id }, select: select ?? undefined });
  }

  async findCategoryDiscounts(categoryId: string): Promise<Discount[]> {
    return this.prisma.discount.findMany({
      where: {
        isActive: true,
        startDate: { lte: new Date() },
        endDate: { gte: new Date() },
        categories: { some: { id: categoryId } },
      },
    });
  }

  async findVariantDiscounts(variantId: string): Promise<Discount[]> {
    return this.prisma.discount.findMany({
      where: {
        isActive: true,
        startDate: { lte: new Date() },
        endDate: { gte: new Date() },
        variants: { some: { id: variantId } },
      },
    });
  }

  async getInvalidIds(ids: string[], model: 'product' | 'variant' | 'category'): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    const count = await this.prisma[model].count({ where: { id: { in: ids } } });
    if (count !== ids.length) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      const existingItems = await this.prisma[model].findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const existingIdSet = new Set(existingItems.map((item: { id: string }) => item.id));
      return ids.filter((id) => !existingIdSet.has(id));
    }
    return [];
  }

  async findCartById(
    cartId: string,
  ): Promise<(Cart & { items: (CartItem & { product: Product; variant?: Variant })[] }) | null> {
    return this.prisma.cart.findUnique({
      where: { id: cartId },
      include: { items: { include: { product: true, variant: true } } },
    }) as Promise<(Cart & { items: (CartItem & { product: Product; variant?: Variant })[] }) | null>;
  }

  async updateCartItem(
    id: string,
    data: Prisma.CartItemUncheckedUpdateInput,
    tx: PrismaService = this.prisma,
  ): Promise<CartItem> {
    return tx.cartItem.update({ where: { id }, data });
  }

  async findOrderById(
    orderId: string,
  ): Promise<(Order & { items: (OrderItem & { product: Product; variant?: Variant })[] }) | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true, variant: true } } },
    }) as Promise<(Order & { items: (OrderItem & { product: Product; variant?: Variant })[] }) | null>;
  }

  async updateOrderItem(
    id: string,
    data: Prisma.OrderItemUncheckedUpdateInput,
    tx: PrismaService = this.prisma,
  ): Promise<OrderItem> {
    return tx.orderItem.update({ where: { id }, data });
  }

  async addItemsToDiscount(
    id: string,
    data: Pick<Prisma.DiscountUpdateInput, 'products' | 'variants' | 'categories'>,
  ): Promise<Discount> {
    return this.prisma.discount.update({ where: { id }, data });
  }

  async removeItemsFromDiscount(
    id: string,
    data: Pick<Prisma.DiscountUpdateInput, 'products' | 'variants' | 'categories'>,
  ): Promise<Discount> {
    return this.prisma.discount.update({ where: { id }, data });
  }

  async updateOrderWithDiscount(
    orderId: string,
    totalAmount: number,
    discountTotal: number,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { totalAmount, discountTotal, totalWithOutDiscount: totalAmount - discountTotal },
      include: { items: true },
    }) as unknown as Order & { items: OrderItem[] };
  }
}
