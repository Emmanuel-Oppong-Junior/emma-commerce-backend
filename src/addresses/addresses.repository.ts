import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Address, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AddressesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Omit<Address, 'id' | 'createdAt' | 'updatedAt'>): Promise<Address> {
    try {
      return await this.prisma.address.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Address already exists');
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Address | null> {
    return this.prisma.address.findUnique({ where: { id } });
  }

  async findByUser(userId: string): Promise<Address[]> {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(): Promise<Address[]> {
    return this.prisma.address.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async update(
    id: string,
    data: Partial<Omit<Address, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Address> {
    try {
      return await this.prisma.address.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Address "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<Address> {
    try {
      return await this.prisma.address.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Address "${id}" not found`);
      }
      throw e;
    }
  }

  async countByUser(userId: string): Promise<number> {
    return this.prisma.address.count({ where: { userId } });
  }
}
