import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Banner as BannerRow, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import { isLive, liveWhere, scheduleProblem } from '../schedule';
import { BannerLinkColumns, bannerLinkColumns, bannerLinkOf, BannerLinkType } from './banner-link';
import { Banner, BannerLink, CreateBannerInput, UpdateBannerInput } from './banner.entities';

export const MAX_BANNERS_PER_PLACEMENT = 20;

const AUDITED_FIELDS = [
  'title',
  'subtitle',
  'altText',
  'imageUrl',
  'mobileImageUrl',
  'placement',
  'position',
  'isActive',
  'startsAt',
  'endsAt',
  'linkProductId',
  'linkCategoryId',
  'linkCollectionId',
  'linkPath',
  'linkUrl',
] as const satisfies readonly (keyof BannerRow)[];

const WITH_TARGETS = {
  linkProduct: { select: { slug: true, isActive: true, status: true } },
  linkCategory: { select: { slug: true } },
  linkCollection: { select: { slug: true, isActive: true, startsAt: true, endsAt: true } },
} satisfies Prisma.BannerInclude;

type BannerWithTargets = Prisma.BannerGetPayload<{ include: typeof WITH_TARGETS }>;

const ORDER: Prisma.BannerOrderByWithRelationInput[] = [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
const REQUIRED_FIELDS = ['title', 'imageUrl', 'placement', 'position', 'isActive'] as const;

@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateBannerInput, actorId: string): Promise<Banner> {
    const { link, ...fields } = input;
    this.assertSchedule(fields.startsAt ?? null, fields.endsAt ?? null);
    const columns = await this.linkColumns(link ?? null);
    const created = await this.audit.record(
      (tx) => tx.banner.create({ data: { ...fields, ...columns }, include: WITH_TARGETS }),
      (banner) => ({
        entity: 'Banner',
        entityId: banner.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(banner, AUDITED_FIELDS) },
      }),
    );
    return toBanner(created, false);
  }

  async update(id: string, input: UpdateBannerInput, actorId: string): Promise<Banner> {
    const existing = await this.findOrThrow(id);
    const { link, ...fields } = input;
    const nulled = REQUIRED_FIELDS.find((field) => fields[field] === null);
    if (nulled) throw new BadRequestException(`${nulled} cannot be null`);
    this.assertSchedule(
      fields.startsAt !== undefined ? fields.startsAt : existing.startsAt,
      fields.endsAt !== undefined ? fields.endsAt : existing.endsAt,
    );
    const columns = link === undefined ? {} : await this.linkColumns(link);
    const data = { ...fields, ...columns } as Prisma.BannerUncheckedUpdateInput;
    const updated = await this.audit.record(
      (tx) => tx.banner.update({ where: { id }, data, include: WITH_TARGETS }),
      (banner) => ({
        entity: 'Banner',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, banner, AUDITED_FIELDS) },
      }),
    );
    return toBanner(updated, false);
  }

  async remove(id: string, actorId: string): Promise<Banner> {
    await this.findOrThrow(id);
    const deleted = await this.audit.record(
      (tx) => tx.banner.delete({ where: { id }, include: WITH_TARGETS }),
      (banner) => ({
        entity: 'Banner',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(banner, AUDITED_FIELDS) },
      }),
    );
    return toBanner(deleted, false);
  }

  /** The live banners of a placement by position, with links only to what customers can see. */
  async findLive(placement: string, limit = MAX_BANNERS_PER_PLACEMENT, now: Date = new Date()): Promise<Banner[]> {
    const rows = await this.prisma.banner.findMany({
      where: { placement, ...liveWhere(now) },
      include: WITH_TARGETS,
      orderBy: ORDER,
      take: Math.min(limit, MAX_BANNERS_PER_PLACEMENT),
    });
    return rows.map((row) => toBanner(row, true, now));
  }

  /** Every banner, live or not, optionally of one placement, by placement then position. */
  async findAll(placement?: string): Promise<Banner[]> {
    const rows = await this.prisma.banner.findMany({
      where: placement ? { placement } : {},
      include: WITH_TARGETS,
      orderBy: [{ placement: 'asc' }, ...ORDER],
    });
    return rows.map((row) => toBanner(row, false));
  }

  private async findOrThrow(id: string): Promise<BannerRow> {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException(`Banner "${id}" not found`);
    return banner;
  }

  private assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
    const problem = scheduleProblem(startsAt, endsAt);
    if (problem) throw new BadRequestException(problem);
  }

  /** The link columns, after checking the link and that its product, category or collection exists. */
  private async linkColumns(link: Parameters<typeof bannerLinkColumns>[0]): Promise<BannerLinkColumns> {
    const result = bannerLinkColumns(link);
    if (result.problem !== undefined) throw new BadRequestException(result.problem);
    const { linkProductId, linkCategoryId, linkCollectionId } = result.columns;
    const missing =
      (linkProductId && !(await this.prisma.product.findUnique({ where: { id: linkProductId } })) && 'Product') ||
      (linkCategoryId && !(await this.prisma.category.findUnique({ where: { id: linkCategoryId } })) && 'Category') ||
      (linkCollectionId &&
        !(await this.prisma.collection.findUnique({ where: { id: linkCollectionId } })) &&
        'Collection');
    if (missing) throw new NotFoundException(`${missing} "${link?.targetId}" not found`);
    return result.columns;
  }
}

/** The banner as GraphQL shows it; `publicView` hides a link to a product or collection customers cannot see. */
function toBanner(row: BannerWithTargets, publicView: boolean, now: Date = new Date()): Banner {
  return { ...row, link: toLink(row, publicView, now) };
}

function toLink(row: BannerWithTargets, publicView: boolean, now: Date): BannerLink | null {
  const link = bannerLinkOf(row);
  if (!link) return null;
  switch (link.type) {
    case BannerLinkType.PRODUCT: {
      const product = row.linkProduct;
      const visible = product && product.isActive && product.status === 'PUBLISHED';
      return publicView && !visible ? null : { ...link, slug: product?.slug ?? null };
    }
    case BannerLinkType.CATEGORY:
      return { ...link, slug: row.linkCategory?.slug ?? null };
    case BannerLinkType.COLLECTION: {
      const collection = row.linkCollection;
      return publicView && !(collection && isLive(collection, now))
        ? null
        : { ...link, slug: collection?.slug ?? null };
    }
    default:
      return link;
  }
}
