import { Injectable, NotFoundException } from '@nestjs/common';
import { TaxRate } from '@prisma/client';
import { TaxRepository } from './tax.repository';
import { CreateTaxRateInput } from './dto/create-tax-rate.input';
import { UpdateTaxRateInput } from './dto/update-tax-rate.input';
import { Decimal } from '@prisma/client/runtime/library';

const DEFAULT_TAX_RATE = new Decimal('0.1');

@Injectable()
export class TaxService {
  constructor(private readonly taxRepository: TaxRepository) {}

  /**
   * Creates a new tax rate for a country or region.
   * @param input - Tax rate creation data including country, optional region, and rate.
   * @returns The created tax rate.
   */
  async createTaxRate(input: CreateTaxRateInput): Promise<TaxRate> {
    return this.taxRepository.create({
      country: input.country,
      region: input.region,
      rate: input.rate,
      isActive: input.isActive ?? true,
    });
  }

  /**
   * Updates an existing tax rate by ID.
   * @param id - The ID of the tax rate to update.
   * @param input - Partial tax rate data to apply.
   * @returns The updated tax rate.
   */
  async updateTaxRate(id: string, input: UpdateTaxRateInput): Promise<TaxRate> {
    return this.taxRepository.update(id, input);
  }

  /**
   * Deletes a tax rate by ID.
   * @param id - The ID of the tax rate to delete.
   * @returns The deleted tax rate.
   */
  async deleteTaxRate(id: string): Promise<TaxRate> {
    return this.taxRepository.delete(id);
  }

  /**
   * Retrieves all configured tax rates.
   * @returns List of all tax rates.
   */
  async findAll(): Promise<TaxRate[]> {
    return this.taxRepository.findAll();
  }

  /**
   * Retrieves a single tax rate by ID.
   * @param id - The ID of the tax rate.
   * @returns The tax rate.
   * @throws NotFoundException if the tax rate does not exist.
   */
  async findOne(id: string): Promise<TaxRate> {
    const rate = await this.taxRepository.findById(id);
    if (!rate) throw new NotFoundException(`Tax rate "${id}" not found`);
    return rate;
  }

  /**
   * Returns the applicable tax rate for a given country and optional region.
   * Falls back to the default rate (10%) if no matching rule is found.
   * @param country - The country code or name to look up.
   * @param region - Optional region or state to narrow the lookup.
   * @returns The applicable tax rate as a Decimal.
   */
  async getRateForCountry(country: string, region?: string): Promise<Decimal> {
    const taxRate = await this.taxRepository.findByCountry(country, region);
    return taxRate ? (taxRate.rate as unknown as Decimal) : DEFAULT_TAX_RATE;
  }
}
