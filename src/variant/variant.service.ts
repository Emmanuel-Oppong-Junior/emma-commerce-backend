import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PriceChangeSource, Prisma, StockMovementReason, Variant } from '../generated/prisma/client';
import { CreateVariantInput, VariantFieldsInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';
import { NewVariant, ProductForVariants, VariantRepository, VariantWithProduct } from './variant.repository';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { TaxService } from '../tax/tax.service';
import { sellingPrice } from '../tax/tax-inclusive-price';
import { checkOptionValues, CheckedOptions, describeProblems } from '../product-types/domain/attribute-validation';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { PriceHistoryService } from '../price-history/price-history.service';

const AUDITED_VARIANT_FIELDS = [
  'productId',
  'sku',
  'barcode',
  'optionValues',
  'basePrice',
  'price',
  'isActive',
  'discountId',
] as const satisfies readonly (keyof Variant)[];

/** A variant ready to insert: options validated, price computed, SKU and barcode checked. */
export interface PreparedVariant {
  data: Omit<NewVariant, 'productId'>;
  quantity: number;
}

export interface VariantPage {
  nodes: Variant[];
  totalCount: number;
  hasNextPage: boolean;
}

@Injectable()
export class VariantService {
  constructor(
    private readonly variantRepository: VariantRepository,
    private readonly auditService: AuditService,
    private readonly taxService: TaxService,
    private readonly stockLedger: StockLedgerService,
    private readonly priceHistory: PriceHistoryService,
  ) {}

  /** Creates a variant; its opening stock is received as a RECEIPT in the same transaction (VAR-05). */
  async createVariant(input: CreateVariantInput, actorId: string): Promise<VariantWithProduct> {
    const product = await this.findProduct(input.productId);
    if (input.discountId) await this.ensureDiscountExists(input.discountId);
    const [prepared] = await this.prepare(product, [input]);
    return this.auditService.record(
      async (tx) => {
        const [created] = await this.insertPrepared(tx, product.id, [prepared], actorId);
        return created;
      },
      (variant) => ({
        entity: 'Variant',
        entityId: variant.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(variant, AUDITED_VARIANT_FIELDS) },
      }),
    );
  }

  /**
   * Validates variants for `product` (option values against its type, unique combinations, free SKUs and barcodes)
   * and prices them. Throws before anything is written. Without `product.id` (a product being created) there are no
   * existing variants to compare with.
   */
  async prepare(
    product: Pick<ProductForVariants, 'isTaxable' | 'productType'> & { id?: string },
    inputs: (VariantFieldsInput & { discountId?: string })[],
  ): Promise<PreparedVariant[]> {
    const rate = product.isTaxable ? await this.taxService.getTotalActiveRate() : new Prisma.Decimal(0);
    const prepared: PreparedVariant[] = [];
    const seenKeys = new Set<string>();
    const seenCodes = new Set<string>();
    for (const input of inputs) {
      const options = this.checkOptions(product, input.optionValues);
      if (seenKeys.has(options.optionsKey)) throw this.duplicateOptions(options);
      seenKeys.add(options.optionsKey);
      for (const code of [input.sku?.toLowerCase(), input.barcode].filter((c): c is string => !!c)) {
        if (seenCodes.has(code)) throw new BadRequestException(`SKU or barcode "${code}" is repeated`);
        seenCodes.add(code);
      }
      await this.ensureCodesFree(input.sku, input.barcode);
      prepared.push({
        quantity: input.quantity,
        data: {
          optionValues: options.values,
          optionsKey: options.optionsKey,
          basePrice: input.basePrice.toFixed(2),
          price: sellingPrice(input.basePrice, product.isTaxable, rate).toFixed(2),
          sku: input.sku,
          barcode: input.barcode,
          weightGrams: input.weightGrams,
          lengthMm: input.lengthMm,
          widthMm: input.widthMm,
          heightMm: input.heightMm,
          image: input.image,
          lowStockThreshold: input.lowStockThreshold,
          discountId: input.discountId,
        },
      });
    }
    for (const key of product.id ? seenKeys : []) {
      const clash = await this.variantRepository.findActiveWithOptions(product.id!, key);
      if (clash)
        throw new ConflictException(`The product already has an active variant (${clash.id}) with these options`);
    }
    return prepared;
  }

  /** Inserts prepared variants with their first prices and opening stock, on the caller's transaction. */
  async insertPrepared(
    tx: Prisma.TransactionClient,
    productId: string,
    prepared: PreparedVariant[],
    actorId: string,
  ): Promise<VariantWithProduct[]> {
    const created: VariantWithProduct[] = [];
    for (const { data, quantity } of prepared) {
      const variant = await this.variantRepository.create({ ...data, productId }, tx);
      await this.priceHistory.recordVariantPrices(tx, variant.id, null, variant, {
        source: PriceChangeSource.VARIANT_CREATED,
        actorId,
        reason: null,
      });
      if (quantity > 0) {
        await this.stockLedger.receive(tx, variant.id, quantity, StockMovementReason.RECEIPT, {
          actorId,
          note: 'Initial stock',
        });
      }
      created.push(variant);
    }
    return created;
  }

  async getVariant(variantId: string): Promise<VariantWithProduct> {
    return this.retrieveVariant(variantId);
  }

  /** Admin list of variants (all products, or one), active and archived, paginated by id (VAR-09). */
  async getVariants(paginate: PaginationArgs, productId?: string): Promise<VariantPage> {
    const take = Math.min(paginate.first ?? 12, 100);
    const [rows, totalCount] = await this.variantRepository.findPage(productId ? { productId } : {}, {
      take: take + 1,
      skip: paginate.after ? 1 : 0,
      ...(paginate.after && { cursor: { id: paginate.after } }),
    });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  async updateVariant(variantId: string, input: UpdateVariantInput, actorId: string): Promise<VariantWithProduct> {
    const existing = await this.retrieveVariant(variantId);
    const product = await this.findProduct(existing.productId);
    if (input.discountId) await this.ensureDiscountExists(input.discountId);
    await this.ensureCodesFree(input.sku, input.barcode, variantId);

    const data: Prisma.VariantUncheckedUpdateInput = {
      sku: input.sku,
      barcode: input.barcode,
      weightGrams: input.weightGrams,
      lengthMm: input.lengthMm,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      image: input.image,
      lowStockThreshold: input.lowStockThreshold,
      discountId: input.discountId,
      isActive: input.isActive,
    };
    let optionsKey = existing.optionsKey;
    if (input.optionValues !== undefined) {
      const options = this.checkOptions(product, input.optionValues);
      data.optionValues = options.values;
      data.optionsKey = optionsKey = options.optionsKey;
    }
    const willBeActive = input.isActive ?? existing.isActive;
    if (willBeActive && (optionsKey !== existing.optionsKey || !existing.isActive)) {
      const clash = await this.variantRepository.findActiveWithOptions(product.id, optionsKey, variantId);
      if (clash)
        throw new ConflictException(`The product already has an active variant (${clash.id}) with these options`);
    }
    if (input.basePrice !== undefined) {
      const rate = product.isTaxable ? await this.taxService.getTotalActiveRate() : new Prisma.Decimal(0);
      data.basePrice = input.basePrice.toFixed(2);
      data.price = sellingPrice(input.basePrice, product.isTaxable, rate).toFixed(2);
    }

    return this.auditService.record(
      async (tx) => {
        if (data.price === undefined) return this.variantRepository.update(variantId, data, tx);
        const before = await this.variantRepository.lockPrices(variantId, tx);
        const updated = await this.variantRepository.update(variantId, data, tx);
        await this.priceHistory.recordVariantPrices(tx, variantId, before, updated, {
          source: PriceChangeSource.ADMIN_EDIT,
          actorId,
          reason: input.priceChangeReason ?? null,
        });
        return updated;
      },
      (updated) => ({
        entity: 'Variant',
        entityId: variantId,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges<Variant>(existing, updated, AUDITED_VARIANT_FIELDS) },
      }),
    );
  }

  /**
   * Deletes a variant nothing refers to. One that a cart, order or stock movement references must be archived
   * (updateVariant isActive: false) instead, so its history keeps its SKU (VAR-07); a product keeps at least one.
   */
  async deleteVariant(variantId: string, actorId: string): Promise<Variant> {
    const existing = await this.retrieveVariant(variantId);
    const history = await this.variantRepository.countHistory(variantId);
    const references = [
      history.orderItems && `${history.orderItems} order line(s)`,
      history.cartItems && `${history.cartItems} cart line(s)`,
      history.stockMovements && `${history.stockMovements} stock movement(s)`,
    ].filter(Boolean);
    if (references.length) {
      throw new ConflictException(
        `Variant "${variantId}" is referenced by ${references.join(', ')}; archive it (isActive: false) instead of deleting it`,
      );
    }
    if ((await this.variantRepository.countVariants(existing.productId)) <= 1) {
      throw new ConflictException(`Variant "${variantId}" is the product's only variant; a product needs at least one`);
    }
    return this.auditService.record(
      (tx) => this.variantRepository.delete(variantId, tx),
      (deleted) => ({
        entity: 'Variant',
        entityId: variantId,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_VARIANT_FIELDS) },
      }),
    );
  }

  private checkOptions(product: Pick<ProductForVariants, 'productType'>, optionValues: unknown): CheckedOptions {
    const checked = checkOptionValues(product.productType.attributes, optionValues);
    if (!checked.ok) {
      throw new BadRequestException(
        `Invalid option values for product type "${product.productType.key}": ${describeProblems(checked.problems)}`,
      );
    }
    return checked.value;
  }

  private duplicateOptions(options: CheckedOptions): BadRequestException {
    return new BadRequestException(`Two variants have the same options (${options.optionsKey || 'none'})`);
  }

  private async ensureCodesFree(sku: string | undefined, barcode: string | undefined, exceptId?: string) {
    const taken = await this.variantRepository.findBySkuOrBarcode(sku, barcode, exceptId);
    if (!taken) return;
    const what = sku && taken.sku?.toLowerCase() === sku.toLowerCase() ? `SKU "${sku}"` : `barcode "${barcode}"`;
    throw new ConflictException(`${what} is already used by variant "${taken.id}"`);
  }

  private async ensureDiscountExists(discountId: string): Promise<void> {
    if (!(await this.variantRepository.discountExists(discountId))) {
      throw new NotFoundException(`Discount "${discountId}" not found`);
    }
  }

  private async findProduct(productId: string): Promise<ProductForVariants> {
    const product = await this.variantRepository.findProductForVariants(productId);
    if (!product) throw new NotFoundException(`Product "${productId}" not found`);
    return product;
  }

  private async retrieveVariant(variantId: string): Promise<VariantWithProduct> {
    const variant = await this.variantRepository.findById(variantId);
    if (!variant) throw new NotFoundException(`Variant "${variantId}" not found`);
    return variant;
  }
}
