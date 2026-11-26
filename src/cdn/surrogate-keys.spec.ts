import {
  CATALOGUE_CHANGE_REASONS,
  MAX_SURROGATE_KEYS,
  boundSurrogateKeys,
  objectKey,
  purgeKeysFor,
} from './surrogate-keys';

describe('surrogate keys', () => {
  describe('objectKey', () => {
    it('is <prefix>:<id> for an object with a usable id', () => {
      expect(objectKey('Product', 'ck1')).toBe('product:ck1');
      expect(objectKey('ProductType', 'product_type_general')).toBe('product-type:product_type_general');
      expect(objectKey('SubCategory', 'sub-1')).toBe('subcategory:sub-1');
    });

    it('falls back to the family key when the id is missing or would break the header', () => {
      expect(objectKey('Product', undefined)).toBe('products');
      expect(objectKey('Category', 'a b')).toBe('categories');
      expect(objectKey('Brand', 'a,b')).toBe('brands');
      expect(objectKey('Banner', 'x'.repeat(65))).toBe('banners');
      expect(objectKey('Tag', 42)).toBe('tags');
    });
  });

  describe('boundSurrogateKeys', () => {
    it('puts catalogue first, then the keys sorted and deduplicated', () => {
      expect(boundSurrogateKeys(['product:b', 'catalogue', 'brand:a', 'product:b', 'products'])).toEqual([
        'catalogue',
        'brand:a',
        'product:b',
        'products',
      ]);
    });

    it('is just catalogue for a response that shows no tagged object', () => {
      expect(boundSurrogateKeys([])).toEqual(['catalogue']);
    });

    it('keeps entity keys up to the limit', () => {
      const keys = Array.from({ length: MAX_SURROGATE_KEYS - 1 }, (_, i) => `product:p${i}`);
      expect(boundSurrogateKeys(keys)).toHaveLength(MAX_SURROGATE_KEYS);
    });

    it('collapses entity keys into their family keys above the limit', () => {
      const keys = [
        ...Array.from({ length: MAX_SURROGATE_KEYS }, (_, i) => `product:p${i}`),
        'brand:b1',
        'subcategory:s1',
        'category:c1',
        'homepage',
      ];
      expect(boundSurrogateKeys(keys)).toEqual(['catalogue', 'brands', 'categories', 'homepage', 'products']);
    });
  });

  describe('purgeKeysFor', () => {
    it('purges the products, their family and slug resolution for a product change', () => {
      expect(purgeKeysFor('product', ['p1', 'p2']).sort()).toEqual(['product:p1', 'product:p2', 'products', 'slugs']);
    });

    it('purges the products and their family when stock crosses in or out of availability', () => {
      expect(purgeKeysFor('stock', ['p1']).sort()).toEqual(['product:p1', 'products']);
    });

    it.each([
      ['category', ['category:c1', 'categories', 'slugs']],
      ['subcategory', ['subcategory:c1', 'categories', 'slugs']],
      ['brand', ['brand:c1', 'brands', 'slugs']],
      ['tag', ['tag:c1', 'tags', 'products']],
      ['product-type', ['product-type:c1', 'product-types', 'products']],
      ['collection', ['collection:c1', 'collections', 'slugs']],
      ['banner', ['banner:c1', 'banners']],
    ] as const)('purges the entity, its family and dependants for a %s change', (reason, keys) => {
      expect(purgeKeysFor(reason, ['c1']).sort()).toEqual([...keys].sort());
    });

    it('purges the homepage layout and slug resolution by their own keys', () => {
      expect(purgeKeysFor('homepage', null)).toEqual(['homepage']);
      expect(purgeKeysFor('redirect', null)).toEqual(['slugs']);
    });

    it.each(['store', 'store-feature', 'promotion', 'stock-location'] as const)(
      'purges everything for a store-wide %s change',
      (reason) => {
        expect(purgeKeysFor(reason, null)).toEqual(['catalogue']);
      },
    );

    it('purges everything when too many entities changed to list them (detail pages have no family key)', () => {
      for (const reason of CATALOGUE_CHANGE_REASONS.filter((r) => r !== 'homepage' && r !== 'redirect')) {
        expect(purgeKeysFor(reason, null)).toEqual(['catalogue']);
      }
    });

    it('purges the family key for an id it cannot put in a header', () => {
      expect(purgeKeysFor('product', ['bad id']).sort()).toEqual(['products', 'slugs']);
    });
  });
});
