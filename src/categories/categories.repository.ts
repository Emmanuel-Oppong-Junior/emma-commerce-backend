import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.CategoryCreateInput): Promise<Category> {
    try {
      return await this.prisma.category.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A category with this name already exists');
      }
      throw e;
    }
  }

  async findAll(queryOption: Prisma.CategoryFindManyArgs): Promise<Category[]> {
    return this.prisma.category.findMany(queryOption);
  }

  async findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  async findFirst(where: Prisma.CategoryWhereInput): Promise<Category | null> {
    return this.prisma.category.findFirst({ where });
  }

  async update(id: string, data: Prisma.CategoryUpdateInput): Promise<Category> {
    try {
      return await this.prisma.category.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Category not found');
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Category> {
    try {
      return await this.prisma.category.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Category not found');
      }
      throw e;
    }
  }

  async countProducts(categoryId: string): Promise<number> {
    return this.prisma.product.count({ where: { categoryId } });
  }
}
