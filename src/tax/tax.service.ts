import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tax } from '../generated/prisma/client';
import { TaxRepository } from './tax.repository';
import { CreateTaxInput } from './dto/create-tax-rate.input';
import { UpdateTaxInput } from './dto/update-tax-rate.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

const AUDITED_TAX_FIELDS = ['name', 'rate', 'isActive'] as const satisfies readonly (keyof Tax)[];

@Injectable()
export class TaxService {
  constructor(
    private readonly taxRepository: TaxRepository,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateTaxInput, actorId: string): Promise<Tax> {
    return this.auditService.record(
      async (tx) => {
        const created = await this.taxRepository.create(
          { name: input.name, rate: input.rate, isActive: input.isActive ?? true },
          tx,
        );
        await this.repriceTaxableVariants(tx);
        return created;
      },
      (created) => ({
        entity: 'Tax',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(created, AUDITED_TAX_FIELDS) },
      }),
    );
  }

  async update(id: string, input: UpdateTaxInput, actorId: string): Promise<Tax> {
    const existing = await this.findOne(id);
    return this.auditService.record(
      async (tx) => {
        const updated = await this.taxRepository.update(id, input, tx);
        await this.repriceTaxableVariants(tx);
        return updated;
      },
      (updated) => ({
        entity: 'Tax',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_TAX_FIELDS) },
      }),
    );
  }

  async delete(id: string, actorId: string): Promise<Tax> {
    return this.auditService.record(
      async (tx) => {
        const deleted = await this.taxRepository.delete(id, tx);
        await this.repriceTaxableVariants(tx);
        return deleted;
      },
      (deleted) => ({
        entity: 'Tax',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_TAX_FIELDS) },
      }),
    );
  }

  async findAll(): Promise<Tax[]> {
    return this.taxRepository.findAll();
  }

  async findOne(id: string): Promise<Tax> {
    const tax = await this.taxRepository.findById(id);
    if (!tax) throw new NotFoundException(`Tax "${id}" not found`);
    return tax;
  }

  async getTotalActiveRate(): Promise<Prisma.Decimal> {
    return this.taxRepository.getTotalActiveRate();
  }

  /** Runs on the tax change's transaction, so a failed reprice rolls the tax change back. */
  private async repriceTaxableVariants(tx: Prisma.TransactionClient): Promise<void> {
    const totalRate = await this.taxRepository.getTotalActiveRate(tx);
    await this.taxRepository.repriceTaxableVariants(totalRate, tx);
  }
}
