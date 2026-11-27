import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Category } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class CategoryLoader {
  constructor(private readonly prisma: PrismaService) {}

  /** Batches the parent-category lookups of the sub-categories in a request. */
  readonly loader = new DataLoader<string, Category | null>(
    async (categoryIds: readonly string[]) => {
      const ids = [...categoryIds];
      const categories = await this.prisma.category.findMany({ where: { id: { in: ids } } });
      const byId = new Map(categories.map((category) => [category.id, category]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    { cache: false },
  );
}
