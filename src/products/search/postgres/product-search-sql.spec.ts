import { Decimal } from '@prisma/client/runtime/client';
import { Prisma } from '../../../generated/prisma/client';
import { ProductSearchFilters } from '../product-search.port';
import {
  FACET_ATTRIBUTES_LIMIT,
  FACET_VALUES_LIMIT,
  facetQuery,
  filterConditions,
  fuzzyWords,
  pageQuery,
  sortKey,
  textMatch,
  tsQuery,
} from './product-search-sql';

const NOW = new Date('2026-11-24T12:00:00Z');
const flat = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ');
const all = (conditions: Prisma.Sql[]) => Prisma.join(conditions, ' AND ');

describe('product search SQL', () => {
  describe('filterConditions', () => {
    it('limits a public search to active, PUBLISHED products and ignores isActive/status', () => {
      const conditions = filterConditions({ visibility: 'PUBLIC', isActive: false, status: 'DRAFT' }, NOW);
      expect(conditions.map(flat)).toEqual([`p."isActive" AND p."status" = 'PUBLISHED'`]);
      expect(all(conditions).values).toEqual([]);
    });

    it('lets staff narrow by isActive and status, or see everything', () => {
      expect(filterConditions({ visibility: 'ADMIN' }, NOW)).toEqual([]);
      const conditions = filterConditions({ visibility: 'ADMIN', isActive: false, status: 'ARCHIVED' }, NOW);
      expect(all(conditions).values).toEqual([false, 'ARCHIVED']);
    });

    it('adds each filter as its own condition with its value bound, so combined filters never overwrite', () => {
      const filters: ProductSearchFilters = {
        visibility: 'PUBLIC',
        categoryId: 'cat',
        categoryName: 'Food',
        subcategoryId: 'sub',
        subCategoryName: 'Sauces',
        brandId: 'brand',
        brandName: 'Acme',
        tagId: 'tag',
        tagName: 'hot',
        productTypeId: 'type',
        createdAfter: NOW,
      };
      const conditions = filterConditions(filters, NOW);
      expect(conditions).toHaveLength(11);
      expect([...all(conditions).values].sort()).toEqual(
        ['cat', 'Food', 'sub', 'Sauces', 'brand', 'Acme', 'tag', 'hot', 'type', NOW].sort(),
      );
      const sql = flat(all(conditions));
      expect(sql).toContain('FROM "SubCategory" x WHERE x."id" = p."subcategoryId"');
      expect(sql).toContain('FROM "Category" x WHERE x."id" = p."categoryId"');
      expect(sql).toContain('pt."B" = ?');
      expect(sql).toContain('lower(t."name") = lower(?)');
    });

    it('puts both price bounds on the same active variant', () => {
      const [condition, ...rest] = filterConditions(
        { visibility: 'ADMIN', priceMin: new Decimal(10), priceMax: new Decimal('49.5') },
        NOW,
      );
      expect(rest).toEqual([]);
      expect(flat(condition)).toBe(
        'EXISTS (SELECT 1 FROM "Variant" v WHERE v."productId" = p."id" AND v."isActive" AND v."price" >= ?::numeric AND v."price" <= ?::numeric)',
      );
      expect(condition.values).toEqual(['10.00', '49.50']);
    });

    it('with inStock true, asks one variant to be in the price range and sellable', () => {
      const conditions = filterConditions({ visibility: 'ADMIN', priceMax: new Decimal(50), inStock: true }, NOW);
      expect(conditions).toHaveLength(1);
      const sql = flat(conditions[0]);
      expect(sql).toMatch(/^EXISTS \(SELECT 1 FROM "Variant" v .* v."price" <= \?::numeric AND EXISTS \(/);
      expect(sql).toContain('sl."onHand" - sl."reserved" - COALESCE(');
      expect(sql).toContain('l."isActive"');
    });

    it('with inStock false, keeps the price range and excludes products with a sellable variant', () => {
      const conditions = filterConditions({ visibility: 'ADMIN', priceMin: new Decimal(5), inStock: false }, NOW);
      expect(conditions).toHaveLength(2);
      expect(flat(conditions[1])).toMatch(/^NOT EXISTS \(SELECT 1 FROM "Variant" v/);
    });

    it('subtracts the units of lots expired by now from what can be sold', () => {
      const [condition] = filterConditions({ visibility: 'ADMIN', inStock: true }, NOW);
      expect(condition.values).toContain(NOW);
      expect(flat(condition)).toContain('lt."expiresAt" <= ?');
    });
  });

  describe('attribute filters', () => {
    it('ANDs the attributes and ORs the values of one, on the product or an active variant, ignoring case', () => {
      const conditions = filterConditions(
        {
          visibility: 'ADMIN',
          attributes: [
            { key: 'colour', values: ['Red', 'Blue'] },
            { key: 'material', values: ['Cotton'] },
          ],
        },
        NOW,
      );
      expect(conditions).toHaveLength(2);
      expect(flat(conditions[0])).toBe(
        '(lower(p."attributes" ->> ?) IN (lower(?),lower(?)) OR EXISTS (SELECT 1 FROM "Variant" v WHERE v."productId" = p."id" AND v."isActive" AND lower(v."optionValues" ->> ?) IN (lower(?),lower(?))))',
      );
      expect(conditions[0].values).toEqual(['colour', 'Red', 'Blue', 'colour', 'Red', 'Blue']);
      expect(conditions[1].values).toEqual(['material', 'Cotton', 'material', 'Cotton']);
    });
  });

  describe('facetQuery', () => {
    const filters: ProductSearchFilters = {
      visibility: 'PUBLIC',
      brandName: 'Acme',
      categoryId: 'cat',
      priceMax: new Decimal(50),
      inStock: true,
      tagName: 'hot',
      attributes: [{ key: 'colour', values: ['Red'] }],
    };

    it('applies only the unfaceted filters and the text to base, the others as flags', () => {
      const sql = flat(
        facetQuery(filters, NOW, Prisma.sql`p."searchVector" @@ websearch_to_tsquery('simple', ${'x'})`),
      );
      const baseWhere = sql.slice(sql.indexOf('FROM "Product" p WHERE'), sql.indexOf('), attribute_values'));
      expect(baseWhere).toContain(`p."isActive" AND p."status" = 'PUBLISHED'`);
      expect(baseWhere).toContain('lower(t."name") = lower(?)');
      expect(baseWhere).toContain('p."searchVector" @@');
      expect(baseWhere).not.toContain('p."categoryId" = ?');
      expect(sql).toContain('AS "f_brand"');
      expect(sql).toContain('AS "f_a0"');
    });

    it('counts each facet without its own flag', () => {
      const sql = flat(facetQuery(filters, NOW));
      expect(sql).toContain(
        'JOIN "Brand" br ON br."id" = b."brandId" WHERE b."f_category" AND b."f_price" AND b."f_stock" AND b."f_a0"',
      );
      expect(sql).toContain(
        'JOIN "Category" c ON c."id" = b."categoryId" WHERE b."f_brand" AND b."f_price" AND b."f_stock" AND b."f_a0"',
      );
      expect(sql).toContain('WHERE b."f_brand" AND b."f_category" AND b."f_stock_any" AND b."f_a0"');
      expect(sql).toContain('WHERE b."f_brand" AND b."f_category" AND b."f_price" AND b."f_sellable" AND b."f_a0"');
      expect(sql).toContain('(av."key" = ? OR b."f_a0")');
    });

    it('bounds every facet list', () => {
      const query = facetQuery({ visibility: 'PUBLIC' }, NOW);
      expect(query.values.filter((value) => value === FACET_VALUES_LIMIT).length).toBeGreaterThanOrEqual(3);
      expect(query.values).toContain(FACET_ATTRIBUTES_LIMIT);
    });
  });

  describe('text match', () => {
    it('only ever hands the text to websearch_to_tsquery, as a bound parameter', () => {
      const text = "men's shoes' : & | ! ( ) < * \\";
      const query = tsQuery(text);
      expect(query.sql).toBe(`websearch_to_tsquery('simple', ?)`);
      expect(query.values).toEqual([text]);
      const { condition, score } = textMatch(text, 'FTS');
      expect(flat(condition)).toBe(`p."searchVector" @@ websearch_to_tsquery('simple', ?)`);
      expect(flat(score)).toBe(`ts_rank(p."searchVector", websearch_to_tsquery('simple', ?))::float8`);
      expect(`${condition.sql} ${score.sql}`).not.toMatch(/(^|[^_])to_tsquery/);
    });

    it('fuzzy: every word must be similar to part of the name, relevance is the mean similarity', () => {
      const { condition, score } = textMatch('Samsnug  Galxy samsnug', 'FUZZY');
      expect(flat(condition)).toBe('? <% p."name" AND ? <% p."name"');
      expect(condition.values).toEqual(['samsnug', 'galxy']);
      expect(flat(score)).toBe('((word_similarity(?, p."name") + word_similarity(?, p."name")) / ?)::float8');
      expect(score.values).toEqual(['samsnug', 'galxy', 2]);
    });

    it('fuzzyWords keeps words of two characters or more, at most eight, else the text itself', () => {
      expect(fuzzyWords("Men's  shoes!")).toEqual(['men', 'shoes']);
      expect(fuzzyWords('a b')).toEqual(['a b']);
      expect(fuzzyWords('one two three four five six seven eight nine')).toHaveLength(8);
    });
  });

  describe('ordering and paging', () => {
    it('needs a text match to sort by relevance', () => {
      expect(() => sortKey('RELEVANCE', undefined)).toThrow('RELEVANCE sort needs a text match');
      expect(sortKey('NAME', undefined).sql).toBe('p."name"');
    });

    it('always breaks ties by id, after the cursor key in the sort direction', () => {
      const query = pageQuery({
        conditions: [Prisma.sql`p."isActive"`],
        key: sortKey('CREATED_AT', undefined),
        direction: 'DESC',
        cursor: { sort: 'CREATED_AT', direction: 'DESC', key: '2026-01-01T00:00:00', id: 'p9' },
        limit: 11,
      });
      const sql = flat(query);
      expect(sql).toContain('ORDER BY m."k" DESC, m."id" LIMIT ?');
      expect(sql).toContain('WHERE (m."k" < ?::timestamp(3) OR (m."k" = ?::timestamp(3) AND m."id" > ?))');
      expect(query.values).toEqual(['2026-01-01T00:00:00', '2026-01-01T00:00:00', 'p9', 11]);
    });

    it('counts every match, not only those after the cursor', () => {
      const sql = flat(pageQuery({ conditions: [], key: sortKey('NAME', undefined), direction: 'ASC', limit: 3 }));
      expect(sql).toContain('SELECT (SELECT count(*) FROM matched)::int AS "total"');
      expect(sql).toContain('ORDER BY m."k" ASC, m."id" LIMIT ?');
      expect(sql).not.toContain('m."k" >');
    });
  });
});
