import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SubCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSubCategoryInput } from './dto/create-sub-category.input';

@Injectable()
export class SubCategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateSubCategoryInput): Promise<SubCategory> {
    try {
      return await this.prisma.subCategory.create({
        data: {
          name: data.name,
          description: data.description,
          image: data.image,
          category: { connect: { id: data.categoryId } },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A subcategory with this name already exists in this category');
      }
      throw e;
    }
  }

  async findAll(): Promise<(SubCategory & { category: unknown })[]> {
    return this.prisma.subCategory.findMany({
      include: { category: true },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string): Promise<SubCategory | null> {
    return this.prisma.subCategory.findUnique({ where: { id } });
  }

  async findFirst(where: Prisma.SubCategoryWhereInput): Promise<SubCategory | null> {
    return this.prisma.subCategory.findFirst({ where });
  }

  async update(id: string, data: Prisma.SubCategoryUpdateInput): Promise<SubCategory> {
    try {
      return await this.prisma.subCategory.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('SubCategory not found');
      }
      throw e;
    }
  }

  async delete(id: string): Promise<SubCategory> {
    try {
      return await this.prisma.subCategory.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('SubCategory not found');
      }
      throw e;
    }
  }

  async countProducts(subcategoryId: string): Promise<number> {
    return this.prisma.product.count({ where: { subcategoryId } });
  }
}
