import { Injectable, Scope } from '@nestjs/common';
import DataLoader = require('dataloader');
import { Variant } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class VariantsLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches variant lookups for multiple products in a single request.
   * Prevents N+1 queries when resolving the `variants` field on Product.
   */
  readonly loader = new DataLoader<string, Variant[]>(
    async (productIds: readonly string[]) => {
      const ids = [...productIds];

      const variants = await this.prisma.variant.findMany({
        where: { productId: { in: ids } },
        orderBy: { id: 'asc' },
      });

      const variantsByProductId = new Map<string, Variant[]>();
      for (const id of ids) variantsByProductId.set(id, []);
      for (const variant of variants) {
        variantsByProductId.get(variant.productId)?.push(variant);
      }

      return ids.map((id) => variantsByProductId.get(id) ?? []);
    },
    { cache: false },
  );
}
