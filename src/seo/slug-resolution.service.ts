import { Injectable } from '@nestjs/common';
import { SlugEntityType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_PRODUCT_WHERE } from '../products/products.service';
import { liveWhere } from '../content/schedule';
import { SlugResolution } from './entities/slug-resolution.entity';

type Visible = { id: string; slug: string } | null;

@Injectable()
export class SlugResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The entity of the kind that has this slug now, else the one that had it (its current slug, redirected), as
   * customers may see it: products active and PUBLISHED, collections live; null otherwise. Redirects point at the
   * entity, so any number of renames lands on the current slug in one step.
   */
  async resolve(type: SlugEntityType, slug: string, now: Date = new Date()): Promise<SlugResolution | null> {
    const current = await this.visible(type, { slug }, now);
    if (current) return { type, ...current, redirected: false };
    const redirect = await this.prisma.slugRedirect.findUnique({
      where: { entityType_fromSlug: { entityType: type, fromSlug: slug } },
    });
    const entityId =
      redirect &&
      (redirect.productId ??
        redirect.categoryId ??
        redirect.subCategoryId ??
        redirect.brandId ??
        redirect.collectionId);
    if (!entityId) return null;
    const target = await this.visible(type, { id: entityId }, now);
    return target ? { type, ...target, redirected: true } : null;
  }

  private visible(type: SlugEntityType, where: { slug: string } | { id: string }, now: Date): Promise<Visible> {
    const select = { id: true, slug: true };
    switch (type) {
      case 'PRODUCT':
        return this.prisma.product.findFirst({ where: { ...where, ...PUBLIC_PRODUCT_WHERE }, select });
      case 'CATEGORY':
        return this.prisma.category.findFirst({ where, select });
      case 'SUB_CATEGORY':
        return this.prisma.subCategory.findFirst({ where, select });
      case 'BRAND':
        return this.prisma.brand.findFirst({ where, select });
      case 'COLLECTION':
        return this.prisma.collection.findFirst({ where: { ...where, ...liveWhere(now) }, select });
    }
  }
}
