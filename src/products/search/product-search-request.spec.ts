import { Decimal } from '@prisma/client/runtime/client';
import { ProductSortField } from '../enums/product-sort-field.enum';
import { SortOrder } from '../../commons/enums/sort-order.enum';
import { ProductStatusEnum } from '../enums/product.enum';
import {
  MAX_PAGE_SIZE,
  searchFiltersProblem,
  searchText,
  toSearchFilters,
  toSearchRequest,
  toSearchSort,
} from './product-search-request';

describe('product search request', () => {
  describe('searchText', () => {
    it.each([undefined, '', '   ', '!!!', "' : & | ! ( ) < *"])('treats %p as no search', (raw) => {
      expect(searchText(raw)).toBeUndefined();
    });

    it('trims text that has a letter or digit, keeping its punctuation', () => {
      expect(searchText("  men's shoes!  ")).toBe("men's shoes!");
      expect(searchText('ɔdɔ')).toBe('ɔdɔ');
      expect(searchText(' 24 ')).toBe('24');
    });
  });

  describe('toSearchFilters', () => {
    it('keeps every filter in its own field, so none replaces another', () => {
      const filters = toSearchFilters(
        {
          categoryId: 'c',
          categoryName: 'Food',
          subcategoryId: 's',
          subCategoryName: 'Sauces',
          brand: 'Acme',
          brandId: 'b',
          tagId: 't',
          tagName: 'hot',
          productTypeId: 'pt',
          priceMin: new Decimal(1),
          priceMax: new Decimal(9),
          inStock: true,
          createdAfter: '2026-01-01T00:00:00.000Z',
          search: ' pepper ',
        },
        'PUBLIC',
      );

      expect(filters).toEqual({
        visibility: 'PUBLIC',
        text: 'pepper',
        categoryId: 'c',
        categoryName: 'Food',
        subcategoryId: 's',
        subCategoryName: 'Sauces',
        brandId: 'b',
        brandName: 'Acme',
        tagId: 't',
        tagName: 'hot',
        productTypeId: 'pt',
        createdAfter: new Date('2026-01-01T00:00:00.000Z'),
        priceMin: new Decimal(1),
        priceMax: new Decimal(9),
        inStock: true,
      });
    });

    it('drops isActive and status from a public search, keeps them for staff', () => {
      const filter = { isActive: false, status: ProductStatusEnum.DRAFT };
      expect(toSearchFilters(filter, 'PUBLIC')).not.toHaveProperty('isActive');
      expect(toSearchFilters(filter, 'PUBLIC')).not.toHaveProperty('status');
      expect(toSearchFilters(filter, 'ADMIN')).toEqual(expect.objectContaining({ isActive: false, status: 'DRAFT' }));
    });

    it('passes attribute filters on, without repeated values', () => {
      expect(
        toSearchFilters({ attributes: [{ key: 'colour', values: ['Red', 'Red', 'Blue'] }] }, 'PUBLIC').attributes,
      ).toEqual([{ key: 'colour', values: ['Red', 'Blue'] }]);
    });

    it('keeps inStock false (it filters for products nobody can buy)', () => {
      expect(toSearchFilters({ inStock: false }, 'PUBLIC').inStock).toBe(false);
    });
  });

  describe('searchFiltersProblem', () => {
    it('refuses a minimum price above the maximum', () => {
      expect(
        searchFiltersProblem({ visibility: 'PUBLIC', priceMin: new Decimal('10.5'), priceMax: new Decimal(10) }),
      ).toBe('priceMin 10.50 is above priceMax 10.00');
    });

    it('refuses an attribute filtered twice', () => {
      expect(
        searchFiltersProblem({
          visibility: 'PUBLIC',
          attributes: [
            { key: 'colour', values: ['Red'] },
            { key: 'colour', values: ['Blue'] },
          ],
        }),
      ).toBe('Attribute "colour" is filtered twice; put all its values in one filter');
    });

    it('accepts equal bounds and a single bound', () => {
      expect(
        searchFiltersProblem({ visibility: 'PUBLIC', priceMin: new Decimal(10), priceMax: new Decimal(10) }),
      ).toBeNull();
      expect(searchFiltersProblem({ visibility: 'PUBLIC', priceMin: new Decimal(10) })).toBeNull();
    });
  });

  describe('toSearchSort', () => {
    const withText = { visibility: 'PUBLIC' as const, text: 'rice' };
    const withoutText = { visibility: 'PUBLIC' as const };

    it('defaults to relevance for a text search and to newest first otherwise', () => {
      expect(toSearchSort({}, withText)).toEqual({ key: 'RELEVANCE', direction: 'DESC' });
      expect(toSearchSort({}, withoutText)).toEqual({ key: 'CREATED_AT', direction: 'DESC' });
    });

    it('lists the best match first whatever sortOrder says, and newest first without text', () => {
      const sort = { sortBy: ProductSortField.RELEVANCE, sortOrder: SortOrder.ASC };
      expect(toSearchSort(sort, withText)).toEqual({ key: 'RELEVANCE', direction: 'DESC' });
      expect(toSearchSort(sort, withoutText)).toEqual({ key: 'CREATED_AT', direction: 'DESC' });
    });

    it('uses the requested field and direction, descending by default', () => {
      expect(toSearchSort({ sortBy: ProductSortField.NAME, sortOrder: SortOrder.ASC }, withText)).toEqual({
        key: 'NAME',
        direction: 'ASC',
      });
      expect(toSearchSort({ sortBy: ProductSortField.UPDATED_AT }, withoutText)).toEqual({
        key: 'UPDATED_AT',
        direction: 'DESC',
      });
    });
  });

  describe('toSearchRequest', () => {
    it('caps the page size and passes the cursor on', () => {
      const request = toSearchRequest('PUBLIC', { first: 500, after: 'abc' }, {}, {});
      expect(request.first).toBe(MAX_PAGE_SIZE);
      expect(request.after).toBe('abc');
    });

    it('ignores an empty cursor', () => {
      expect(toSearchRequest('PUBLIC', { first: 5, after: '' }, {}, {}).after).toBeUndefined();
    });
  });
});
