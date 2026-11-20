import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** What a product listing shows from its active variants. */
export interface VariantSummary {
  minPrice: Prisma.Decimal | null;
  maxPrice: Prisma.Decimal | null;
  totalStock: number;
}

const EMPTY: VariantSummary = { minPrice: null, maxPrice: null, totalStock: 0 };

@Injectable({ scope: Scope.REQUEST })
export class VariantSummaryLoader {
  constructor(private readonly prisma: PrismaService) {}

  /** Price range and stock of each product's active variants: one grouped query per request (no N+1). */
  readonly loader = new DataLoader<string, VariantSummary>(async (productIds: readonly string[]) => {
    const groups = await this.prisma.variant.groupBy({
      by: ['productId'],
      where: { productId: { in: [...productIds] }, isActive: true },
      _min: { price: true },
      _max: { price: true },
      _sum: { quantity: true },
    });
    const byProduct = new Map(
      groups.map((group) => [
        group.productId,
        { minPrice: group._min.price, maxPrice: group._max.price, totalStock: group._sum.quantity ?? 0 },
      ]),
    );
    return productIds.map((id) => byProduct.get(id) ?? EMPTY);
  });
}
