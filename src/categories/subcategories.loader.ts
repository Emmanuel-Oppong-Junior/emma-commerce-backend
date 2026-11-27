import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { SubCategory } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class SubCategoriesOfCategoryLoader {
  constructor(private readonly prisma: PrismaService) {}

  /** Batches each category's sub-categories (by name) for categories whose select did not load them. */
  readonly loader = new DataLoader<string, SubCategory[]>(
    async (categoryIds: readonly string[]) => {
      const ids = [...categoryIds];
      const rows = await this.prisma.subCategory.findMany({
        where: { categoryId: { in: ids } },
        orderBy: { name: 'asc' },
      });
      return ids.map((id) => rows.filter((row) => row.categoryId === id));
    },
    { cache: false },
  );
}
