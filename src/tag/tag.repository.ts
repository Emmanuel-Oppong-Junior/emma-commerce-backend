import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tag } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TagRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(name: string): Promise<Tag> {
    try {
      return await this.prisma.tag.create({ data: { name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Tag name "${name}" is already in use`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { id } });
  }

  async findByName(name: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { name } });
  }

  async findAll(): Promise<Tag[]> {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  async update(id: string, name: string): Promise<Tag> {
    try {
      return await this.prisma.tag.update({ where: { id }, data: { name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tag "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Tag> {
    try {
      return await this.prisma.tag.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Tag "${id}" not found`);
      }
      throw e;
    }
  }

  async connectProducts(tagId: string, productIds: string[]): Promise<Tag> {
    return this.prisma.tag.update({
      where: { id: tagId },
      data: { products: { connect: productIds.map((id) => ({ id })) } },
    });
  }

  async disconnectProducts(tagId: string, productIds: string[]): Promise<Tag> {
    return this.prisma.tag.update({
      where: { id: tagId },
      data: { products: { disconnect: productIds.map((id) => ({ id })) } },
    });
  }
}
