import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { HomepageSection as SectionRow, HomepageSectionType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import { Product } from '../../products/entities/product.entity';
import { liveWhere, scheduleProblem } from '../schedule';
import { CollectionsService } from '../collections/collections.service';
import { BannersService } from '../banners/banners.service';
import {
  BannerStripConfig,
  BrandStripConfig,
  CategoryGridConfig,
  checkSectionConfig,
  ProductCarouselConfig,
  RichTextConfig,
  SectionConfig,
  SectionConfigValues,
} from './section-config';
import {
  CreateHomepageSectionInput,
  HomepageBlock,
  HomepageSection,
  UpdateHomepageSectionInput,
} from './homepage.entities';

/** Live sections the homepage shows at most. */
export const MAX_HOMEPAGE_SECTIONS = 20;

const AUDITED_FIELDS = [
  'type',
  'title',
  'position',
  'config',
  'isActive',
  'startsAt',
  'endsAt',
] as const satisfies readonly (keyof SectionRow)[];

const ORDER: Prisma.HomepageSectionOrderByWithRelationInput[] = [
  { position: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class HomepageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly collections: CollectionsService,
    private readonly banners: BannersService,
  ) {}

  async create(input: CreateHomepageSectionInput, actorId: string): Promise<HomepageSection> {
    const { config: values, ...fields } = input;
    this.assertSchedule(fields.startsAt ?? null, fields.endsAt ?? null);
    const config = await this.checkConfig(input.type, values);
    return this.audit.record(
      (tx) => tx.homepageSection.create({ data: { ...fields, config: config as unknown as Prisma.InputJsonObject } }),
      (section) => ({
        entity: 'HomepageSection',
        entityId: section.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(section, AUDITED_FIELDS) },
      }),
    ) as Promise<HomepageSection>;
  }

  async update(id: string, input: UpdateHomepageSectionInput, actorId: string): Promise<HomepageSection> {
    const existing = await this.prisma.homepageSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Homepage section "${id}" not found`);
    const { config: values, ...fields } = input;
    if (fields.position === null || fields.isActive === null) {
      throw new BadRequestException('position and isActive cannot be null');
    }
    if (values === null) throw new BadRequestException('config cannot be null');
    this.assertSchedule(
      fields.startsAt !== undefined ? fields.startsAt : existing.startsAt,
      fields.endsAt !== undefined ? fields.endsAt : existing.endsAt,
    );
    const data: Prisma.HomepageSectionUpdateInput = { ...fields };
    if (values !== undefined)
      data.config = (await this.checkConfig(existing.type, values)) as unknown as Prisma.InputJsonObject;
    return this.audit.record(
      (tx) => tx.homepageSection.update({ where: { id }, data }),
      (updated) => ({
        entity: 'HomepageSection',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_FIELDS) },
      }),
    ) as Promise<HomepageSection>;
  }

  async remove(id: string, actorId: string): Promise<HomepageSection> {
    const existing = await this.prisma.homepageSection.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Homepage section "${id}" not found`);
    return this.audit.record(
      (tx) => tx.homepageSection.delete({ where: { id } }),
      (deleted) => ({
        entity: 'HomepageSection',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_FIELDS) },
      }),
    ) as Promise<HomepageSection>;
  }

  findAll(): Promise<HomepageSection[]> {
    return this.prisma.homepageSection.findMany({ orderBy: ORDER }) as Promise<HomepageSection[]>;
  }

  /**
   * The live sections by position (at most 20), each with what customers may see: published products of a live
   * collection, existing categories and brands, live banners. A section left with nothing to show is dropped.
   */
  async homepage(now: Date = new Date()): Promise<HomepageBlock[]> {
    const sections = await this.prisma.homepageSection.findMany({
      where: liveWhere(now),
      orderBy: ORDER,
      take: MAX_HOMEPAGE_SECTIONS,
    });
    const configs = sections.map((section) => section.config as unknown as SectionConfig);
    const categoryIds = configs.flatMap((config) => (config as Partial<CategoryGridConfig>).categoryIds ?? []);
    const brandIds = configs.flatMap((config) => (config as Partial<BrandStripConfig>).brandIds ?? []);
    const [categories, brands] = await Promise.all([
      categoryIds.length ? this.prisma.category.findMany({ where: { id: { in: categoryIds } } }) : [],
      brandIds.length ? this.prisma.brand.findMany({ where: { id: { in: brandIds } } }) : [],
    ]);
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const brandById = new Map(brands.map((brand) => [brand.id, brand]));

    const blocks = await Promise.all(
      sections.map(async (section, index): Promise<HomepageBlock> => {
        const config = configs[index];
        const block: HomepageBlock = {
          id: section.id,
          type: section.type,
          title: section.title,
          products: [],
          categories: [],
          brands: [],
          banners: [],
          text: null,
        };
        switch (section.type) {
          case HomepageSectionType.PRODUCT_CAROUSEL:
            block.products = await this.carouselProducts(config as ProductCarouselConfig, now);
            break;
          case HomepageSectionType.CATEGORY_GRID:
            block.categories = pick(
              (config as CategoryGridConfig).categoryIds,
              categoryById,
            ) as HomepageBlock['categories'];
            break;
          case HomepageSectionType.BRAND_STRIP:
            block.brands = pick((config as BrandStripConfig).brandIds, brandById) as HomepageBlock['brands'];
            break;
          case HomepageSectionType.BANNER_STRIP: {
            const { bannerPlacement, bannerLimit } = config as BannerStripConfig;
            block.banners = await this.banners.findLive(bannerPlacement, bannerLimit, now);
            break;
          }
          case HomepageSectionType.RICH_TEXT:
            block.text = (config as RichTextConfig).text;
            break;
        }
        return block;
      }),
    );
    return blocks.filter(
      (block) =>
        block.text !== null ||
        block.products.length + block.categories.length + block.brands.length + block.banners.length > 0,
    );
  }

  private async carouselProducts(config: ProductCarouselConfig, now: Date): Promise<Product[]> {
    const collection = await this.prisma.collection.findFirst({
      where: { id: config.collectionId, ...liveWhere(now) },
    });
    if (!collection) return [];
    const page = await this.collections.productsPage(collection, { first: config.productLimit }, {});
    return page.edges.map((edge) => edge.node);
  }

  private assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
    const problem = scheduleProblem(startsAt, endsAt);
    if (problem) throw new BadRequestException(problem);
  }

  /** The stored config, after checking it fits the type and that what it names exists. */
  private async checkConfig(type: HomepageSectionType, values: SectionConfigValues): Promise<SectionConfig> {
    const checked = checkSectionConfig(type, values);
    if (checked.problem !== undefined) throw new BadRequestException(checked.problem);
    const config = checked.config;
    if (
      'collectionId' in config &&
      !(await this.prisma.collection.findUnique({ where: { id: config.collectionId } }))
    ) {
      throw new NotFoundException(`Collection "${config.collectionId}" not found`);
    }
    if ('categoryIds' in config) await this.assertAllExist('Category', config.categoryIds);
    if ('brandIds' in config) await this.assertAllExist('Brand', config.brandIds);
    return config;
  }

  private async assertAllExist(label: 'Category' | 'Brand', ids: string[]): Promise<void> {
    const where = { where: { id: { in: ids } }, select: { id: true } };
    const found =
      label === 'Category' ? await this.prisma.category.findMany(where) : await this.prisma.brand.findMany(where);
    const known = new Set(found.map((row) => row.id));
    const missing = ids.find((id) => !known.has(id));
    if (missing) throw new NotFoundException(`${label} "${missing}" not found`);
  }
}

/** The rows of `ids` that exist, in the order of `ids`. */
function pick<T>(ids: string[], byId: Map<string, T>): T[] {
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
