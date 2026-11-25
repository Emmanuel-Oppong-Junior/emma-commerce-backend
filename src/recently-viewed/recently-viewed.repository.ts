import { Injectable } from '@nestjs/common';
import { Prisma, Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_PRODUCT_WHERE } from '../products/products.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class RecentlyViewedRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async isPublicProduct(productId: string): Promise<boolean> {
    return (await this.prisma.product.count({ where: { id: productId, ...PUBLIC_PRODUCT_WHERE } })) > 0;
  }

  /** Serialises one customer's view recordings, so the prune never leaves more than the limit. */
  async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`recently-viewed:${userId}`}))::text`;
  }

  async upsert(tx: Tx, userId: string, productId: string, viewedAt: Date): Promise<void> {
    await tx.recentlyViewedProduct.upsert({
      where: { userId_productId: { userId, productId } },
      create: { userId, productId, viewedAt },
      update: { viewedAt },
    });
  }

  /** Deletes all but the customer's `keep` latest views; returns how many went. */
  prune(tx: Tx, userId: string, keep: number): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "RecentlyViewedProduct" WHERE "userId" = ${userId} AND "productId" NOT IN (
        SELECT "productId" FROM "RecentlyViewedProduct" WHERE "userId" = ${userId}
        ORDER BY "viewedAt" DESC, "productId" DESC LIMIT ${keep}
      )`;
  }

  /** The customer's latest viewed products that are still public, latest first. */
  async findPublicProducts(userId: string, limit: number): Promise<Product[]> {
    const views = await this.prisma.recentlyViewedProduct.findMany({
      where: { userId, product: PUBLIC_PRODUCT_WHERE },
      orderBy: [{ viewedAt: 'desc' }, { productId: 'desc' }],
      take: limit,
      include: { product: true },
    });
    return views.map((view) => view.product);
  }
}
