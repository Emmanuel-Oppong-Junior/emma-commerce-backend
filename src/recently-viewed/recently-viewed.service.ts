import { Injectable, NotFoundException } from '@nestjs/common';
import { Product } from '../generated/prisma/client';
import { RecentlyViewedRepository } from './recently-viewed.repository';

export const RECENTLY_VIEWED_LIMIT = 20;

@Injectable()
export class RecentlyViewedService {
  constructor(private readonly repository: RecentlyViewedRepository) {}

  /** Records that the user viewed a public product, keeping their latest RECENTLY_VIEWED_LIMIT distinct products. */
  async record(userId: string, productId: string, viewedAt = new Date()): Promise<boolean> {
    if (!(await this.repository.isPublicProduct(productId))) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
    await this.repository.transaction(async (tx) => {
      await this.repository.lockUser(tx, userId);
      await this.repository.upsert(tx, userId, productId, viewedAt);
      await this.repository.prune(tx, userId, RECENTLY_VIEWED_LIMIT);
    });
    return true;
  }

  /** The user's recently viewed products that are still on sale, latest first. */
  list(userId: string, limit: number): Promise<Product[]> {
    return this.repository.findPublicProducts(userId, limit);
  }
}
