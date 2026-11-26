import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { SlugEntityType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SLUG_ENTITY_LABELS } from './slug';

@Injectable()
export class SlugsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Refuses a slug staff typed that another entity of the kind already has (CONFLICT), or null (BAD_REQUEST: the slug
   * can be changed, not removed). Its format is checked by the input. Does nothing when no slug was sent.
   */
  async assertAvailable(type: SlugEntityType, slug: string | null | undefined, exceptId?: string): Promise<void> {
    if (slug === undefined) return;
    if (slug === null) throw new BadRequestException('slug cannot be null; omit it to keep the current slug');
    const ownerId = await this.ownerOf(type, slug);
    if (ownerId && ownerId !== exceptId) {
      throw new ConflictException(`Slug "${slug}" is already used by another ${SLUG_ENTITY_LABELS[type]}`);
    }
  }

  /** The id of the entity of the kind whose current slug this is. */
  async ownerOf(type: SlugEntityType, slug: string): Promise<string | null> {
    const where = { where: { slug }, select: { id: true } };
    const owner = await {
      PRODUCT: () => this.prisma.product.findUnique(where),
      CATEGORY: () => this.prisma.category.findUnique(where),
      SUB_CATEGORY: () => this.prisma.subCategory.findUnique(where),
      BRAND: () => this.prisma.brand.findUnique(where),
      COLLECTION: () => this.prisma.collection.findUnique(where),
    }[type]();
    return owner?.id ?? null;
  }
}
