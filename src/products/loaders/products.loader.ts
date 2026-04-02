import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Product } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class ProductsLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches product lookups by ID in a single request.
   * Prevents N+1 queries when resolving the `product` field on CartItem, OrderItem, Review, etc.
   */
  readonly loader = new DataLoader<string, Product | null>(
    async (productIds: readonly string[]) => {
      const ids = [...productIds];

      const products = await this.prisma.product.findMany({
        where: { id: { in: ids } },
      });

      const productsById = new Map<string, Product>();
      for (const product of products) productsById.set(product.id, product);

      return ids.map((id) => productsById.get(id) ?? null);
    },
    { cache: false },
  );
}
