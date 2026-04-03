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

  async createTaxRate(input: CreateTaxRateInput): Promise<TaxRate> {
    return this.taxRepository.create({
      country: input.country,
      region: input.region,
      rate: input.rate,
      isActive: input.isActive ?? true,
    });
  }

  async updateTaxRate(id: string, input: UpdateTaxRateInput): Promise<TaxRate> {
    return this.taxRepository.update(id, input);
  }

  async deleteTaxRate(id: string): Promise<TaxRate> {
    return this.taxRepository.delete(id);
  }

  async findAll(): Promise<TaxRate[]> {
    return this.taxRepository.findAll();
  }

  async findOne(id: string): Promise<TaxRate> {
    const rate = await this.taxRepository.findById(id);
    if (!rate) throw new NotFoundException(`Tax rate "${id}" not found`);
    return rate;
  }

  async getRateForCountry(country: string, region?: string): Promise<Decimal> {
    const taxRate = await this.taxRepository.findByCountry(country, region);
    return taxRate ? (taxRate.rate as unknown as Decimal) : DEFAULT_TAX_RATE;
  }
}
