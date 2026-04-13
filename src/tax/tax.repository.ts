import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tax } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TaxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.TaxCreateInput): Promise<Tax> {
    try {
      return await this.prisma.tax.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Tax "${data.name}" already exists`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Tax | null> {
    return this.prisma.tax.findUnique({ where: { id } });
  }

  async findAll(): Promise<Tax[]> {
    return this.prisma.tax.findMany({ orderBy: { name: 'asc' } });
  }

  async getTotalActiveRate(): Promise<number> {
    const taxes = await this.prisma.tax.findMany({ where: { isActive: true } });
    return taxes.reduce((sum, t) => sum + Number(t.rate), 0);
  }

  async update(id: string, data: Prisma.TaxUpdateInput): Promise<Tax> {
    try {
      return await this.prisma.tax.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Tax> {
    try {
      return await this.prisma.tax.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax "${id}" not found`);
      }
      throw e;
    }
  }
}
