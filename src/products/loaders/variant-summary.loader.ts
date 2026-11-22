import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SERVING_LOCATION_SQL } from '../../inventory/locations/serving-locations';
import { expiredLotUnitsSql } from '../../inventory/lots/lot-stock.repository';

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

  /** Price range and available stock of each product's active variants: two grouped queries per request (no N+1). */
  readonly loader = new DataLoader<string, VariantSummary>(async (productIds: readonly string[]) => {
    const [groups, stock] = await Promise.all([
      this.prisma.variant.groupBy({
        by: ['productId'],
        where: { productId: { in: [...productIds] }, isActive: true },
        _min: { price: true },
        _max: { price: true },
      }),
      // Each variant counts what one order can take of it: its best serving location, expired lots left out (see
      // Variant.available).
      this.prisma.$queryRaw<{ productId: string; available: number }[]>`
        SELECT s."productId", COALESCE(sum(s.sellable), 0)::int AS available
        FROM (
          SELECT v."productId",
                 GREATEST(max(sl."onHand" - sl."reserved" - ${expiredLotUnitsSql('sl', new Date())}), 0) AS sellable
          FROM "Variant" v
          JOIN "StockLevel" sl ON sl."variantId" = v.id
          JOIN "StockLocation" l ON l."id" = sl."locationId"
          WHERE v."productId" IN (${Prisma.join([...productIds])}) AND v."isActive" AND ${SERVING_LOCATION_SQL}
          GROUP BY v."productId", v.id
        ) s
        GROUP BY s."productId"`,
    ]);
    const availableByProduct = new Map(stock.map((row) => [row.productId, row.available]));
    const byProduct = new Map(
      groups.map((group) => [
        group.productId,
        {
          minPrice: group._min.price,
          maxPrice: group._max.price,
          totalStock: availableByProduct.get(group.productId) ?? 0,
        },
      ]),
    );
    return productIds.map((id) => byProduct.get(id) ?? EMPTY);
  });
}
