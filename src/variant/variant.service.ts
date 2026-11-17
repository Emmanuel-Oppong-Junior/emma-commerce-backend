import { Injectable, NotFoundException } from '@nestjs/common';
import { Variant } from '@prisma/client';
import { CreateVariantInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';
import { VariantRepository } from './variant.repository';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

const AUDITED_VARIANT_FIELDS = ['productId', 'size', 'color', 'price'] as const satisfies readonly (keyof Variant)[];

@Injectable()
export class VariantService {
  constructor(
    private readonly variantRepository: VariantRepository,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new variant for a product.
   * @param data - The variant data to create.
   * @returns The created variant.
   */
  async createVariant(data: CreateVariantInput, actorId: string) {
    await this.ensureProductExists(data.productId);
    return this.auditService.record(
      (tx) => this.variantRepository.create(data, tx),
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
   * Retrieves a specific variant by ID.
   * @param variantId - The ID of the variant.
   * @returns The variant with its product.
   */
  async getVariant(variantId: string): Promise<Variant & { product: { id: string; name: string } }> {
    return this.retrieveVariant(variantId);
  }

  /**
   * Retrieves all variants for a product.
   * @param productId - The ID of the product.
   * @returns List of variants with their products.
   */
  async getProductVariants(productId: string): Promise<(Variant & { product: { id: string; name: string } })[]> {
    await this.ensureProductExists(productId);
    return this.variantRepository.findByProduct(productId);
  }

  /**
   * Retrieves all variants (admin only).
   * @returns List of all variants.
   */
  async getAllVariants(): Promise<Variant[]> {
    return this.variantRepository.findAll();
  }

  /**
   * Updates an existing variant.
   * @param variantId - The ID of the variant.
   * @param data - The variant data to update.
   * @returns The updated variant.
   */
  async updateVariant(variantId: string, data: UpdateVariantInput, actorId: string): Promise<Variant> {
    const existing = await this.retrieveVariant(variantId);
    return this.auditService.record(
      (tx) => this.variantRepository.update(variantId, data, tx),
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
   * Deletes a variant.
   * @param variantId - The ID of the variant.
   * @returns The deleted variant.
   */
  async deleteVariant(variantId: string, actorId: string): Promise<Variant> {
    await this.retrieveVariant(variantId);
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

  private async ensureProductExists(productId: string): Promise<void> {
    const product = await this.variantRepository.findProductById(productId);
    if (!product) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
  }

  private async retrieveVariant(variantId: string): Promise<Variant & { product: { id: string; name: string } }> {
    const variant = await this.variantRepository.findById(variantId);
    if (!variant) {
      throw new NotFoundException(`Variant "${variantId}" not found`);
    }
    return variant;
  }
}
