import { Injectable } from '@nestjs/common';
import { Prisma, SearchSynonym } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type Db = Prisma.TransactionClient;

@Injectable()
export class SearchSynonymsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<SearchSynonym[]> {
    return this.prisma.searchSynonym.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  findById(id: string): Promise<SearchSynonym | null> {
    return this.prisma.searchSynonym.findUnique({ where: { id } });
  }

  count(): Promise<number> {
    return this.prisma.searchSynonym.count();
  }

  create(tx: Db, data: Prisma.SearchSynonymCreateInput): Promise<SearchSynonym> {
    return tx.searchSynonym.create({ data });
  }

  update(tx: Db, id: string, data: Prisma.SearchSynonymUpdateInput): Promise<SearchSynonym> {
    return tx.searchSynonym.update({ where: { id }, data });
  }

  delete(tx: Db, id: string): Promise<SearchSynonym> {
    return tx.searchSynonym.delete({ where: { id } });
  }
}
