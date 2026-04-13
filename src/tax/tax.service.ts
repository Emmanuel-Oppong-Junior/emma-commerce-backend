import { Injectable, NotFoundException } from '@nestjs/common';
import { Tax } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxRepository } from './tax.repository';
import { CreateTaxInput } from './dto/create-tax-rate.input';
import { UpdateTaxInput } from './dto/update-tax-rate.input';

@Injectable()
export class TaxService {
  constructor(
    private readonly taxRepository: TaxRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(input: CreateTaxInput): Promise<Tax> {
    const tax = await this.taxRepository.create({
      name: input.name,
      rate: input.rate,
      isActive: input.isActive ?? true,
    });
    await this.recomputeAllTaxableProductPrices();
    return tax;
  }

  async update(id: string, input: UpdateTaxInput): Promise<Tax> {
    const tax = await this.taxRepository.update(id, input);
    await this.recomputeAllTaxableProductPrices();
    return tax;
  }

  async delete(id: string): Promise<Tax> {
    const tax = await this.taxRepository.delete(id);
    await this.recomputeAllTaxableProductPrices();
    return tax;
  }

  async findAll(): Promise<Tax[]> {
    return this.taxRepository.findAll();
  }

  async findOne(id: string): Promise<Tax> {
    const tax = await this.taxRepository.findById(id);
    if (!tax) throw new NotFoundException(`Tax "${id}" not found`);
    return tax;
  }

  async getTotalActiveRate(): Promise<number> {
    return this.taxRepository.getTotalActiveRate();
  }

  /**
   * Recalculates price for all taxable products using current active tax rates.
   * price = basePrice * (1 + sum of all active tax rates)
   */
  private async recomputeAllTaxableProductPrices(): Promise<void> {
    const totalRate = await this.taxRepository.getTotalActiveRate();
    const multiplier = 1 + totalRate;
    await this.prisma.$executeRaw`
      UPDATE "Product"
      SET "price" = ROUND(CAST("basePrice" AS NUMERIC) * ${multiplier}, 2)
      WHERE "isTaxable" = true AND "basePrice" IS NOT NULL
    `;
  }
}
