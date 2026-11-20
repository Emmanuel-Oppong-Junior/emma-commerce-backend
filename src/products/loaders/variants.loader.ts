import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Variant } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class VariantsLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches the lookup of each product's active variants (archived ones are history, not for sale) in one query.
   * Prevents N+1 queries when resolving the `variants` field on Product.
   */
  readonly loader = new DataLoader<string, Variant[]>(
    async (productIds: readonly string[]) => {
      const ids = [...productIds];

      const variants = await this.prisma.variant.findMany({
        where: { productId: { in: ids }, isActive: true },
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
