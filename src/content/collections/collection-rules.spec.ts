import { Prisma } from '../../generated/prisma/client';
import { ProductSortField } from '../../products/enums/product-sort-field.enum';
import { SortOrder } from '../../commons/enums/sort-order.enum';
import { collectionSearchRequest, ruleFilters, rulesProblem, toCollectionRules } from './collection-rules';

describe('collection rules', () => {
  it('stores only the rules that are set, prices as 2-decimal strings', () => {
    expect(
      toCollectionRules({
        categoryId: 'cat1',
        brandId: null,
        tagId: undefined,
        priceMin: new Prisma.Decimal('10'),
        priceMax: new Prisma.Decimal('99.5'),
        onSale: true,
        inStock: false,
      }),
    ).toEqual({ categoryId: 'cat1', priceMin: '10.00', priceMax: '99.50', onSale: true, inStock: false });
  });

  it('maps every rule to its own public search filter', () => {
    const filters = ruleFilters({
      categoryId: 'cat1',
      subcategoryId: 'sub1',
      brandId: 'brand1',
      tagId: 'tag1',
      productTypeId: 'type1',
      priceMin: '10.00',
      priceMax: '20.00',
      onSale: true,
      inStock: true,
    });
    expect(filters).toEqual({
      visibility: 'PUBLIC',
      categoryId: 'cat1',
      subcategoryId: 'sub1',
      brandId: 'brand1',
      tagId: 'tag1',
      productTypeId: 'type1',
      priceMin: new Prisma.Decimal('10.00'),
      priceMax: new Prisma.Decimal('20.00'),
      onSale: true,
      inStock: true,
    });
  });

  it('needs at least one rule and refuses what the product list refuses', () => {
    expect(rulesProblem({})).toBe('A rule-based collection needs at least one rule');
    expect(rulesProblem({ priceMin: '50.00', priceMax: '10.00' })).toBe('priceMin 50.00 is above priceMax 10.00');
    expect(rulesProblem({ inStock: false })).toBeNull();
  });

  describe('collectionSearchRequest', () => {
    const manual = { id: 'col1', type: 'MANUAL' as const, rules: null };
    const rule = { id: 'col2', type: 'RULE' as const, rules: { brandId: 'brand1', onSale: true } };

    it('lists a manual collection in the staff order by default', () => {
      expect(collectionSearchRequest(manual, { first: 5 }, {})).toEqual({
        filters: { visibility: 'PUBLIC', collectionId: 'col1' },
        sort: { key: 'POSITION', direction: 'ASC' },
        first: 5,
        after: undefined,
      });
    });

    it('sorts a manual collection as asked, and pages on', () => {
      const request = collectionSearchRequest(
        manual,
        { first: 500, after: 'cursor' },
        { sortBy: ProductSortField.NAME, sortOrder: SortOrder.ASC },
      );
      expect(request).toMatchObject({ sort: { key: 'NAME', direction: 'ASC' }, first: 100, after: 'cursor' });
    });

    it('searches a rule collection by its rules, newest first by default', () => {
      expect(collectionSearchRequest(rule, { first: 0 }, {})).toEqual({
        filters: expect.objectContaining({ visibility: 'PUBLIC', brandId: 'brand1', onSale: true }),
        sort: { key: 'CREATED_AT', direction: 'DESC' },
        first: 10,
        after: undefined,
      });
    });
  });
});
