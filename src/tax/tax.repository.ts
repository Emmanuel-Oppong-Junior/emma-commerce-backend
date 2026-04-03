import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaxRate } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TaxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.TaxRateCreateInput): Promise<TaxRate> {
    try {
      return await this.prisma.taxRate.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          `Tax rate for country "${data.country}" region "${data.region ?? 'N/A'}" already exists`,
        );
      }
      throw e;
    }
  }

  async findById(id: string): Promise<TaxRate | null> {
    return this.prisma.taxRate.findUnique({ where: { id } });
  }

  async findAll(): Promise<TaxRate[]> {
    return this.prisma.taxRate.findMany({ orderBy: [{ country: 'asc' }, { region: 'asc' }] });
  }

  async findByCountry(country: string, region?: string): Promise<TaxRate | null> {
    // Try exact match first (country + region), then country-only fallback
    const exact = await this.prisma.taxRate.findFirst({
      where: { country, region: region ?? null, isActive: true },
    });
    if (exact) return exact;
    if (region) {
      return this.prisma.taxRate.findFirst({ where: { country, region: null, isActive: true } });
    }
    return null;
  }

  async update(id: string, data: Prisma.TaxRateUpdateInput): Promise<TaxRate> {
    try {
      return await this.prisma.taxRate.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax rate "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<TaxRate> {
    try {
      return await this.prisma.taxRate.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax rate "${id}" not found`);
      }
      throw e;
    }
  }
}
