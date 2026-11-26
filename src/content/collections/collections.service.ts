import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Collection, CollectionType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import { SlugsService } from '../../seo/slugs.service';
import { ProductsService } from '../../products/products.service';
import { ProductConnection } from '../../products/entities/product-connection.entity';
import { PaginationArgs } from '../../commons/dto/paginate.args';
import { ProductSortArgs } from '../../products/dto/product-sort.args';
import { liveWhere, scheduleProblem } from '../schedule';
import { CollectionRules, collectionSearchRequest, rulesProblem, toCollectionRules } from './collection-rules';
import {
  CollectionRulesInput,
  CreateCollectionInput,
  MAX_COLLECTION_PRODUCTS,
  UpdateCollectionInput,
} from './dto/collection.input';

const AUDITED_FIELDS = [
  'name',
  'slug',
  'description',
  'imageUrl',
  'type',
  'rules',
  'isActive',
  'startsAt',
  'endsAt',
  'metaTitle',
  'metaDescription',
  'ogImageUrl',
] as const satisfies readonly (keyof Collection)[];

const MAX_LISTED_COLLECTIONS = 100;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly slugs: SlugsService,
    private readonly products: ProductsService,
  ) {}

  async create(input: CreateCollectionInput, actorId: string): Promise<Collection> {
    const { rules: rulesInput, productIds, ...fields } = input;
    this.assertSchedule(fields.startsAt ?? null, fields.endsAt ?? null);
    await this.slugs.assertAvailable('COLLECTION', fields.slug);
    let rules: CollectionRules | undefined;
    if (input.type === CollectionType.RULE) {
      if (productIds) throw new BadRequestException('A rule-based collection takes rules, not productIds');
      rules = await this.checkRules(rulesInput);
    } else {
      if (rulesInput) throw new BadRequestException('A manual collection takes productIds, not rules');
      await this.assertProductsExist(productIds ?? []);
    }
    return this.audit.record(
      async (tx) => {
        const collection = await tx.collection.create({
          data: { ...fields, rules: rules as Prisma.InputJsonObject | undefined },
        });
        await this.writeProducts(tx, collection.id, productIds ?? []);
        return collection;
      },
      (collection) => ({
        entity: 'Collection',
        entityId: collection.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(collection, AUDITED_FIELDS), productIds: productIds ?? [] },
      }),
    );
  }

  async update(id: string, input: UpdateCollectionInput, actorId: string): Promise<Collection> {
    const existing = await this.findOrThrow(id);
    const { rules: rulesInput, ...fields } = input;
    this.assertSchedule(
      fields.startsAt !== undefined ? fields.startsAt : existing.startsAt,
      fields.endsAt !== undefined ? fields.endsAt : existing.endsAt,
    );
    if (fields.name === null) throw new BadRequestException('name cannot be null');
    await this.slugs.assertAvailable('COLLECTION', fields.slug, id);
    const data: Prisma.CollectionUpdateInput = { ...fields, name: fields.name ?? undefined };
    if (rulesInput !== undefined) {
      if (existing.type !== CollectionType.RULE) throw new BadRequestException('A manual collection has no rules');
      data.rules = (await this.checkRules(rulesInput)) as Prisma.InputJsonObject;
    }
    return this.audit.record(
      (tx) => tx.collection.update({ where: { id }, data }),
      (updated) => ({
        entity: 'Collection',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_FIELDS) },
      }),
    );
  }

  /** Replaces the products of a manual collection with these, in this order. */
  async setProducts(id: string, productIds: string[], actorId: string): Promise<Collection> {
    const existing = await this.findOrThrow(id);
    if (existing.type !== CollectionType.MANUAL) {
      throw new BadRequestException('A rule-based collection lists the products matching its rules; change its rules');
    }
    await this.assertProductsExist(productIds);
    const before = await this.productIds(id);
    return this.audit.record(
      async (tx) => {
        await tx.collectionProduct.deleteMany({ where: { collectionId: id } });
        await this.writeProducts(tx, id, productIds);
        // Bumps updatedAt, so the change shows on the collection.
        return tx.collection.update({ where: { id }, data: { updatedAt: new Date() } });
      },
      () => ({
        entity: 'Collection',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { productIds: { from: before, to: productIds } },
      }),
    );
  }

  async remove(id: string, actorId: string): Promise<Collection> {
    await this.findOrThrow(id);
    return this.audit.record(
      (tx) => tx.collection.delete({ where: { id } }),
      (deleted) => ({
        entity: 'Collection',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_FIELDS) },
      }),
    );
  }

  /** The live collection with this current slug (an old slug: resolveSlug). */
  findLiveBySlug(slug: string, now: Date = new Date()): Promise<Collection | null> {
    return this.prisma.collection.findFirst({ where: { slug, ...liveWhere(now) } });
  }

  /** The live collections by name, at most 100. */
  findLive(now: Date = new Date()): Promise<Collection[]> {
    return this.prisma.collection.findMany({
      where: liveWhere(now),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_LISTED_COLLECTIONS,
    });
  }

  findAll(): Promise<Collection[]> {
    return this.prisma.collection.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  findById(id: string): Promise<Collection | null> {
    return this.prisma.collection.findUnique({ where: { id } });
  }

  /** What customers see of the collection's products: published ones, paginated through the product search. */
  productsPage(
    collection: Collection,
    paginate: PaginationArgs,
    sort: ProductSortArgs,
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    return this.products.findPage(collectionSearchRequest(collection, paginate, sort), requestedData);
  }

  /** A manual collection's products in order, in any status. */
  async productIds(collectionId: string): Promise<string[]> {
    const rows = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      orderBy: { position: 'asc' },
      select: { productId: true },
    });
    return rows.map((row) => row.productId);
  }

  private async findOrThrow(id: string): Promise<Collection> {
    const collection = await this.findById(id);
    if (!collection) throw new NotFoundException(`Collection "${id}" not found`);
    return collection;
  }

  private assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
    const problem = scheduleProblem(startsAt, endsAt);
    if (problem) throw new BadRequestException(problem);
  }

  private async checkRules(input: CollectionRulesInput | undefined): Promise<CollectionRules> {
    const rules = toCollectionRules(input ?? {});
    const problem = rulesProblem(rules);
    if (problem) throw new BadRequestException(problem);
    const missing = await this.missingRuleTargets(rules);
    if (missing) throw new NotFoundException(missing);
    return rules;
  }

  /** The first id a rule names that does not exist, as a message. */
  private async missingRuleTargets(rules: CollectionRules): Promise<string | null> {
    const checks: [string, string | undefined, (id: string) => Promise<unknown>][] = [
      ['Category', rules.categoryId, (id) => this.prisma.category.findUnique({ where: { id } })],
      ['Sub-category', rules.subcategoryId, (id) => this.prisma.subCategory.findUnique({ where: { id } })],
      ['Brand', rules.brandId, (id) => this.prisma.brand.findUnique({ where: { id } })],
      ['Tag', rules.tagId, (id) => this.prisma.tag.findUnique({ where: { id } })],
      ['Product type', rules.productTypeId, (id) => this.prisma.productType.findUnique({ where: { id } })],
    ];
    for (const [label, id, find] of checks) {
      if (id && !(await find(id))) return `${label} "${id}" not found`;
    }
    return null;
  }

  private async assertProductsExist(productIds: string[]): Promise<void> {
    if (productIds.length > MAX_COLLECTION_PRODUCTS) {
      throw new BadRequestException(`A collection holds at most ${MAX_COLLECTION_PRODUCTS} products`);
    }
    const repeated = productIds.find((id, index) => productIds.indexOf(id) !== index);
    if (repeated) throw new BadRequestException(`Product "${repeated}" is listed twice`);
    if (!productIds.length) return;
    const found = await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true } });
    const known = new Set(found.map((product) => product.id));
    const missing = productIds.find((id) => !known.has(id));
    if (missing) throw new NotFoundException(`Product "${missing}" not found`);
  }

  private async writeProducts(tx: Prisma.TransactionClient, collectionId: string, productIds: string[]) {
    if (!productIds.length) return;
    await tx.collectionProduct.createMany({
      data: productIds.map((productId, position) => ({ collectionId, productId, position })),
    });
  }
}
