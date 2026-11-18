import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Brand, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BrandRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.BrandCreateInput): Promise<Brand> {
    try {
      return await this.prisma.brand.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A brand with this name already exists');
      }
      throw e;
    }
  }

  async update(id: string, data: Prisma.BrandUpdateInput): Promise<Brand> {
    try {
      return await this.prisma.brand.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Brand with ID ${id} not found`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Brand | null> {
    return this.prisma.brand.findUnique({ where: { id } });
  }

  async findMany(queryOptions: Prisma.BrandFindManyArgs = {}): Promise<Brand[]> {
    return this.prisma.brand.findMany(queryOptions);
  }

  async delete(id: string): Promise<Brand> {
    try {
      return await this.prisma.brand.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Brand with ID ${id} not found`);
      }
      throw e;
    }
  }
}
