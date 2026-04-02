import { Injectable, NotFoundException } from '@nestjs/common';
import { Variant } from '@prisma/client';
import { CreateVariantInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';
import { VariantRepository } from './variant.repository';

@Injectable()
export class VariantService {
  constructor(private readonly variantRepository: VariantRepository) {}

  /**
   * Creates a new variant for a product.
   * @param data - The variant data to create.
   * @returns The created variant.
   */
  async createVariant(data: CreateVariantInput) {
    await this.ensureProductExists(data.productId);
    return this.variantRepository.create(data);
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
  async updateVariant(variantId: string, data: UpdateVariantInput): Promise<Variant> {
    await this.retrieveVariant(variantId);
    return this.variantRepository.update(variantId, data);
  }

  /**
   * Deletes a variant.
   * @param variantId - The ID of the variant.
   * @returns The deleted variant.
   */
  async deleteVariant(variantId: string): Promise<Variant> {
    await this.retrieveVariant(variantId);
    return this.variantRepository.delete(variantId);
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
