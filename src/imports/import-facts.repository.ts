import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { GENERAL_PRODUCT_TYPE_ID } from '../products/products.service';
import { CatalogueFacts, ExistingProduct, ExistingVariant } from './kinds/products-import';
import { VariantPriceFacts } from './kinds/prices-import';
import { LocationFacts, StockLevelFacts, StockVariantFacts } from './kinds/stock-import';

type Db = Prisma.TransactionClient;

const VARIANT_FIELDS = {
  id: true,
  sku: true,
  barcode: true,
  productId: true,
  optionsKey: true,
  optionValues: true,
  isActive: true,
  basePrice: true,
  weightGrams: true,
  lowStockThreshold: true,
} satisfies Prisma.VariantSelect;

/** Reads what import rows refer to, in bulk, on the given client (a transaction when applying). */
@Injectable()
export class ImportFactsRepository {
  /** Variant ids by lower-cased SKU (SKUs are unique ignoring letter case, as VariantService checks). */
  private async variantIdsBySku(db: Db, skus: readonly string[]): Promise<string[]> {
    const lowered = [...new Set(skus.map((sku) => sku.toLowerCase()))];
    if (lowered.length === 0) return [];
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Variant" WHERE lower("sku") = ANY(${lowered}::text[])
    `;
    return rows.map((row) => row.id);
  }

  /** Row-locks the variants with these SKUs (in id order) until the transaction ends. */
  async lockVariantsBySku(db: Db, skus: readonly string[]): Promise<void> {
    const lowered = [...new Set(skus.map((sku) => sku.toLowerCase()))];
    if (lowered.length === 0) return;
    await db.$queryRaw`
      SELECT "id" FROM "Variant" WHERE lower("sku") = ANY(${lowered}::text[]) ORDER BY "id" FOR UPDATE
    `;
  }

  /** Product id of each existing SKU, by lower-cased SKU. */
  async productIdsBySku(db: Db, skus: readonly string[]): Promise<Map<string, { productId: string }>> {
    const variants = await db.variant.findMany({
      where: { id: { in: await this.variantIdsBySku(db, skus) } },
      select: { sku: true, productId: true },
    });
    return new Map(variants.map((variant) => [variant.sku.toLowerCase(), { productId: variant.productId }]));
  }

  async catalogueFacts(
    db: Db,
    rows: readonly { values: Record<string, string> }[],
    taxRate: Prisma.Decimal,
  ): Promise<CatalogueFacts> {
    const skus = rows.flatMap((row) => (row.values.sku ? [row.values.sku] : []));
    const barcodes = [...new Set(rows.flatMap((row) => (row.values.barcode ? [row.values.barcode] : [])))];
    const variantIds = await this.variantIdsBySku(db, skus);
    const variants = await db.variant.findMany({ where: { id: { in: variantIds } }, select: VARIANT_FIELDS });
    const productIds = [
      ...new Set([
        ...variants.map((variant) => variant.productId),
        ...rows.flatMap((row) => (row.values.product_id ? [row.values.product_id] : [])),
      ]),
    ];
    const [products, owners, productTypes, categories, subcategories, brands, tags] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          name: true,
          description: true,
          shortDescription: true,
          productTypeId: true,
          isTaxable: true,
          status: true,
          attributes: true,
          categoryId: true,
          subcategoryId: true,
          brandId: true,
          tags: { select: { id: true } },
          variants: { select: VARIANT_FIELDS },
        },
      }),
      db.variant.findMany({ where: { barcode: { in: barcodes } }, select: { id: true, barcode: true } }),
      db.productType.findMany({ include: { attributes: { orderBy: { position: 'asc' } } } }),
      db.category.findMany({ select: { id: true, name: true } }),
      db.subCategory.findMany({ select: { id: true, name: true, categoryId: true } }),
      db.brand.findMany({ select: { id: true, name: true } }),
      db.tag.findMany({ select: { id: true, name: true } }),
    ]);
    return {
      productTypes: productTypes.map((type) => ({ id: type.id, key: type.key, attributes: type.attributes })),
      defaultProductTypeId: GENERAL_PRODUCT_TYPE_ID,
      categories,
      subcategories,
      brands,
      tags,
      variantsBySku: new Map(
        variants.map((variant): [string, ExistingVariant] => [variant.sku.toLowerCase(), variant]),
      ),
      products: new Map(
        products.map(({ tags: productTags, ...product }): [string, ExistingProduct] => [
          product.id,
          { ...product, tagIds: productTags.map((tag) => tag.id) },
        ]),
      ),
      barcodeOwners: new Map(owners.map((owner) => [owner.barcode!, owner.id])),
      taxRate,
    };
  }

  async priceFacts(db: Db, skus: readonly string[]): Promise<Map<string, VariantPriceFacts>> {
    const variants = await db.variant.findMany({
      where: { id: { in: await this.variantIdsBySku(db, skus) } },
      select: { id: true, sku: true, basePrice: true, price: true, product: { select: { isTaxable: true } } },
    });
    return new Map(
      variants.map((variant) => [
        variant.sku.toLowerCase(),
        { id: variant.id, basePrice: variant.basePrice, price: variant.price, isTaxable: variant.product.isTaxable },
      ]),
    );
  }

  async stockVariantFacts(db: Db, skus: readonly string[]): Promise<Map<string, StockVariantFacts>> {
    const variants = await db.variant.findMany({
      where: { id: { in: await this.variantIdsBySku(db, skus) } },
      select: { id: true, sku: true, product: { select: { trackLots: true, trackSerials: true } } },
    });
    return new Map(variants.map((variant) => [variant.sku.toLowerCase(), { id: variant.id, ...variant.product }]));
  }

  async locations(db: Db): Promise<LocationFacts[]> {
    return db.stockLocation.findMany({
      where: { store: { singleton: true } },
      select: { id: true, name: true, isActive: true, isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Levels keyed `${variantId}@${locationId}`. */
  async stockLevels(db: Db, variantIds: readonly string[]): Promise<Map<string, StockLevelFacts>> {
    const levels = await db.stockLevel.findMany({
      where: { variantId: { in: [...variantIds] } },
      select: { variantId: true, locationId: true, onHand: true, reserved: true },
    });
    return new Map(levels.map((level) => [`${level.variantId}@${level.locationId}`, level]));
  }

  /** The variant's level at the location, row-locked until the transaction ends (null: no level yet). */
  async lockStockLevel(db: Db, variantId: string, locationId: string): Promise<StockLevelFacts | null> {
    const [level] = await db.$queryRaw<StockLevelFacts[]>`
      SELECT "onHand", "reserved" FROM "StockLevel"
      WHERE "variantId" = ${variantId} AND "locationId" = ${locationId}
      FOR UPDATE
    `;
    return level ?? null;
  }
}
