import { Injectable, NotFoundException } from '@nestjs/common';
import { Tax } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxRepository } from './tax.repository';
import { CreateTaxInput } from './dto/create-tax-rate.input';
import { UpdateTaxInput } from './dto/update-tax-rate.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

const AUDITED_TAX_FIELDS = ['name', 'rate', 'isActive'] as const satisfies readonly (keyof Tax)[];

@Injectable()
export class TaxService {
  constructor(
    private readonly taxRepository: TaxRepository,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateTaxInput, actorId: string): Promise<Tax> {
    const tax = await this.auditService.record(
      (tx) => this.taxRepository.create({ name: input.name, rate: input.rate, isActive: input.isActive ?? true }, tx),
      (created) => ({
        entity: 'Tax',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(created, AUDITED_TAX_FIELDS) },
      }),
    );
    await this.recomputeAllTaxableProductPrices();
    return tax;
  }

  async update(id: string, input: UpdateTaxInput, actorId: string): Promise<Tax> {
    const existing = await this.findOne(id);
    const tax = await this.auditService.record(
      (tx) => this.taxRepository.update(id, input, tx),
      (updated) => ({
        entity: 'Tax',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_TAX_FIELDS) },
      }),
    );
    await this.recomputeAllTaxableProductPrices();
    return tax;
  }

  async delete(id: string, actorId: string): Promise<Tax> {
    const tax = await this.auditService.record(
      (tx) => this.taxRepository.delete(id, tx),
      (deleted) => ({
        entity: 'Tax',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_TAX_FIELDS) },
      }),
    );
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
