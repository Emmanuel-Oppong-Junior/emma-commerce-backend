import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tax } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TaxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.TaxCreateInput, db: Prisma.TransactionClient = this.prisma): Promise<Tax> {
    try {
      return await db.tax.create({ data });
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

  async getTotalActiveRate(db: Prisma.TransactionClient = this.prisma): Promise<Prisma.Decimal> {
    const taxes = await db.tax.findMany({ where: { isActive: true } });
    return taxes.reduce((sum, t) => sum.plus(t.rate), new Prisma.Decimal(0));
  }

  /** Sets price = basePrice × (1 + totalRate) on every taxable product; the rounding matches `taxInclusivePrice`. */
  async repriceTaxableProducts(totalRate: Prisma.Decimal, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    // Bound as a Decimal and cast to numeric so the multiply and ROUND stay exact decimal arithmetic, never float8.
    await db.$executeRaw`
      UPDATE "Product"
      SET "price" = ROUND("basePrice" * ${totalRate.plus(1)}::numeric, 2)
      WHERE "isTaxable" = true AND "basePrice" IS NOT NULL
    `;
  }

  async update(id: string, data: Prisma.TaxUpdateInput, db: Prisma.TransactionClient = this.prisma): Promise<Tax> {
    try {
      return await db.tax.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<Tax> {
    try {
      return await db.tax.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tax "${id}" not found`);
      }
      throw e;
    }
  }
}
