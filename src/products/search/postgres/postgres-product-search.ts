import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AttributeFacet,
  FacetCount,
  ProductFacets,
  ProductSearch,
  ProductSearchFilters,
  ProductSearchPage,
  ProductSearchRequest,
} from '../product-search.port';
import { decodeCursor, encodeCursor, SearchCursor, TextMatchMode } from './search-cursor';
import {
  existsQuery,
  facetQuery,
  filterConditions,
  FUZZY_WORD_SIMILARITY,
  pageQuery,
  sortKey,
  textMatch,
} from './product-search-sql';

interface FacetRow {
  totalCount: number;
  inStockCount: number;
  price: { min: string | null; max: string | null } | null;
  brands: FacetCount[];
  categories: FacetCount[];
  attributes: (Omit<AttributeFacet, 'values'> & { values: AttributeFacet['values'] | null })[];
}

interface PageRow {
  total: number;
  rows: { id: string; k: number | string }[];
}

/** ADR-0010's Postgres adapter: full-text search over Product.searchVector, trigram name matching as the fallback. */
@Injectable()
export class PostgresProductSearch extends ProductSearch {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async search(request: ProductSearchRequest): Promise<ProductSearchPage> {
    const { filters, sort, first } = request;
    const cursor = request.after ? this.cursor(request) : undefined;
    const now = new Date();
    const conditions = filterConditions(filters, now);
    const mode = filters.text ? (cursor?.mode ?? (await this.matchMode(filters, conditions))) : undefined;
    const match = filters.text && mode ? textMatch(filters.text, mode) : undefined;
    if (match) conditions.push(match.condition);
    const query = pageQuery({
      conditions,
      key: sortKey(sort.key, match?.score),
      direction: sort.direction,
      cursor,
      limit: first + 1,
    });
    const [page] = await this.run<PageRow>(query, mode === 'FUZZY');
    const rows = page.rows.slice(0, first);
    return {
      items: rows.map((row) => ({
        id: row.id,
        cursor: encodeCursor({ sort: sort.key, direction: sort.direction, mode, key: row.k, id: row.id }),
      })),
      hasNextPage: page.rows.length > first,
      totalCount: page.total,
    };
  }

  async facets(filters: ProductSearchFilters): Promise<ProductFacets> {
    const now = new Date();
    const mode = filters.text ? await this.matchMode(filters, filterConditions(filters, now)) : undefined;
    const text = filters.text && mode ? textMatch(filters.text, mode).condition : undefined;
    const [row] = await this.run<FacetRow>(facetQuery(filters, now, text), mode === 'FUZZY');
    return {
      totalCount: row.totalCount,
      inStockCount: row.inStockCount,
      price:
        row.price?.min && row.price.max
          ? { min: new Prisma.Decimal(row.price.min), max: new Prisma.Decimal(row.price.max) }
          : null,
      brands: row.brands,
      categories: row.categories,
      attributes: row.attributes.map((facet) => ({ ...facet, values: facet.values ?? [] })),
    };
  }

  private cursor({ after, sort }: ProductSearchRequest): SearchCursor {
    const cursor = decodeCursor(after!, sort.key, sort.direction);
    if (!cursor) throw new BadRequestException(`Invalid cursor "${after}" for this sort; start from the first page`);
    return cursor;
  }

  /** Full-text when it finds anything under the filters; otherwise names similar to the text (typos, partial words). */
  private async matchMode(filters: ProductSearchFilters, conditions: Prisma.Sql[]): Promise<TextMatchMode> {
    const [{ found }] = await this.prisma.$queryRaw<{ found: boolean }[]>(
      existsQuery([...conditions, textMatch(filters.text!, 'FTS').condition]),
    );
    return found ? 'FTS' : 'FUZZY';
  }

  /** The <% operator reads its threshold from a setting, so a fuzzy query sets it for its own transaction only. */
  private async run<T>(query: Prisma.Sql, fuzzy: boolean): Promise<T[]> {
    if (!fuzzy) return this.prisma.$queryRaw<T[]>(query);
    const [, rows] = await this.prisma.$transaction([
      this.prisma
        .$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(FUZZY_WORD_SIMILARITY)}, true)`,
      this.prisma.$queryRaw<T[]>(query),
    ]);
    return rows;
  }
}
