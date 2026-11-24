import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

// P6-S.1: product filters, full-text search, trigram fallback and keyset pagination through the search port.

interface Fixture {
  id: string;
  name: string;
  description?: string;
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
  tagIds?: string[];
  status?: 'DRAFT' | 'PUBLISHED';
  trackLots?: boolean;
  createdAt?: Date;
  variants: { id: string; price: number; onHand?: number; reserved?: number; atClosedShop?: boolean }[];
}

const PAGE = 'edges { cursor node { id name } } pageInfo { hasNextPage hasPreviousPage totalCount pageSize }';

describe('Product search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let defaultLocationId: string;
  let inactiveLocationId: string;

  const products = async (args: string, token?: string) => {
    const res = await gqlRequest(app, `{ products(${args}) { ${PAGE} } }`, undefined, token).expect(200);
    return res.body as {
      data: { products: { edges: { cursor: string; node: { id: string; name: string } }[]; pageInfo: never } } | null;
      errors?: { message: string; extensions: { code: string } }[];
    };
  };
  const ids = async (args: string) => {
    const body = await products(args);
    expect(body.errors).toBeUndefined();
    return body.data!.products.edges.map((edge) => edge.node.id);
  };
  const filtered = (filter: string) => ids(`paginationArgs: { first: 100 }, filterArgs: { ${filter} }`);

  const createProduct = async (fixture: Fixture) => {
    await prisma.product.create({
      data: {
        id: fixture.id,
        name: fixture.name,
        description: fixture.description,
        isActive: true,
        status: fixture.status ?? 'PUBLISHED',
        categoryId: fixture.categoryId,
        subcategoryId: fixture.subcategoryId,
        brandId: fixture.brandId,
        trackLots: fixture.trackLots ?? false,
        ...(fixture.createdAt && { createdAt: fixture.createdAt, updatedAt: fixture.createdAt }),
        tags: fixture.tagIds ? { connect: fixture.tagIds.map((id) => ({ id })) } : undefined,
      },
    });
    for (const variant of fixture.variants) {
      await prisma.variant.create({
        data: {
          id: variant.id,
          productId: fixture.id,
          sku: variant.id.toUpperCase(),
          optionsKey: variant.id,
          price: variant.price,
          basePrice: variant.price,
        },
      });
      if (variant.onHand !== undefined) {
        await prisma.stockLevel.create({
          data: {
            variantId: variant.id,
            locationId: variant.atClosedShop ? inactiveLocationId : defaultLocationId,
            onHand: variant.onHand,
            reserved: variant.reserved ?? 0,
          },
        });
      }
    }
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    // seedMinimal's published Laptop and Phone stay out of the way: these tests look only at the products below.
    await prisma.product.updateMany({ where: { id: { startsWith: 'seed_' } }, data: { isActive: false } });
    const defaultLocation = await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } });
    defaultLocationId = defaultLocation.id;
    inactiveLocationId = (
      await prisma.stockLocation.create({
        data: { storeId: defaultLocation.storeId, name: 'Closed shop', isActive: false },
      })
    ).id;

    await prisma.category.createMany({
      data: [
        { id: 's_cat_phones', name: 'Phones' },
        { id: 's_cat_fashion', name: 'Fashion' },
        { id: 's_cat_food', name: 'Food' },
      ],
    });
    await prisma.subCategory.createMany({
      data: [
        { id: 's_sub_smart', name: 'Smartphones', categoryId: 's_cat_phones' },
        { id: 's_sub_cases', name: 'Cases', categoryId: 's_cat_phones' },
        { id: 's_sub_scarves', name: 'Scarves', categoryId: 's_cat_fashion' },
        { id: 's_sub_shoes', name: 'Shoes', categoryId: 's_cat_fashion' },
      ],
    });
    await prisma.brand.createMany({
      data: [
        { id: 's_brand_samsung', name: 'Samsung' },
        { id: 's_brand_apple', name: 'Apple' },
        { id: 's_brand_kente', name: 'Bonwire Weavers' },
      ],
    });
    await prisma.tag.createMany({
      data: [
        { id: 's_tag_android', name: 'android' },
        { id: 's_tag_ios', name: 'ios' },
        { id: 's_tag_gift', name: 'gift' },
        { id: 's_tag_tie', name: 'tie-breaker' },
      ],
    });

    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    await createProduct({
      id: 's_galaxy',
      name: 'Samsung Galaxy S24',
      description: 'Android flagship phone',
      categoryId: 's_cat_phones',
      subcategoryId: 's_sub_smart',
      brandId: 's_brand_samsung',
      tagIds: ['s_tag_android', 's_tag_gift'],
      createdAt: lastWeek,
      variants: [{ id: 's_v_galaxy', price: 5000, onHand: 10 }],
    });
    await createProduct({
      id: 's_case',
      name: 'Galaxy Phone Case',
      categoryId: 's_cat_phones',
      subcategoryId: 's_sub_cases',
      brandId: 's_brand_samsung',
      createdAt: lastWeek,
      variants: [{ id: 's_v_case', price: 80, onHand: 40 }],
    });
    await createProduct({
      id: 's_iphone',
      name: 'Apple iPhone 15',
      categoryId: 's_cat_phones',
      subcategoryId: 's_sub_smart',
      brandId: 's_brand_apple',
      tagIds: ['s_tag_ios'],
      createdAt: lastWeek,
      variants: [{ id: 's_v_iphone', price: 9000, onHand: 0 }],
    });
    await createProduct({
      id: 's_kente',
      name: 'Kente Cloth Scarf',
      description: 'Handwoven in Bonwire',
      categoryId: 's_cat_fashion',
      subcategoryId: 's_sub_scarves',
      brandId: 's_brand_kente',
      tagIds: ['s_tag_gift'],
      // Every unit is reserved by open orders.
      variants: [{ id: 's_v_kente', price: 300, onHand: 5, reserved: 5 }],
    });
    await createProduct({
      id: 's_hat',
      name: 'Wool Hat',
      description: 'Pairs well with a scarf',
      categoryId: 's_cat_fashion',
      variants: [{ id: 's_v_hat', price: 120, onHand: 2 }],
    });
    await createProduct({
      id: 's_shoes',
      name: "Men's Running Shoes",
      description: 'Built for rock & roll comfort',
      categoryId: 's_cat_fashion',
      subcategoryId: 's_sub_shoes',
      // Stock only at a location that no longer serves customers.
      variants: [{ id: 's_v_shoes', price: 450, onHand: 8, atClosedShop: true }],
    });
    await createProduct({
      id: 's_shito',
      name: 'Shito Pepper Sauce',
      categoryId: 's_cat_food',
      trackLots: true,
      variants: [{ id: 's_v_shito', price: 25, onHand: 4 }],
    });
    await createProduct({
      id: 's_gari',
      name: 'Gari Premium',
      categoryId: 's_cat_food',
      // The cheap pack is sold out; only the dear one is in stock.
      variants: [
        { id: 's_v_gari_small', price: 20, onHand: 0 },
        { id: 's_v_gari_large', price: 80, onHand: 3 },
      ],
    });
    await createProduct({
      id: 's_draft',
      name: 'Samsung Galaxy Tab Draft',
      status: 'DRAFT',
      brandId: 's_brand_samsung',
      variants: [{ id: 's_v_draft', price: 3000, onHand: 3 }],
    });
    // Shito's only units are in a lot that expired yesterday: on hand, never sellable.
    const lot = await prisma.lot.create({
      data: { variantId: 's_v_shito', lotNumber: 'L-OLD', expiresAt: new Date(Date.now() - 86_400_000) },
    });
    await prisma.lotStock.create({ data: { lotId: lot.id, locationId: defaultLocationId, onHand: 4 } });

    const sameMoment = new Date('2026-01-01T00:00:00.000Z');
    for (const n of [1, 2, 3, 4, 5]) {
      await createProduct({
        id: `s_tie_${n}`,
        name: 'Tie Product',
        tagIds: ['s_tag_tie'],
        createdAt: sameMoment,
        variants: [{ id: `s_v_tie_${n}`, price: 10, onHand: 1 }],
      });
    }
  });

  afterAll(() => app.close());

  describe('filters', () => {
    it.each<[string, string, string[]]>([
      ['categoryId', 'categoryId: "s_cat_food"', ['s_gari', 's_shito']],
      ['categoryName, ignoring case', 'categoryName: "fashion"', ['s_hat', 's_kente', 's_shoes']],
      ['subcategoryId', 'subcategoryId: "s_sub_smart"', ['s_galaxy', 's_iphone']],
      ['subCategoryName (the sub-category, not the category)', 'subCategoryName: "Cases"', ['s_case']],
      ['brand name', 'brand: "samsung"', ['s_case', 's_galaxy']],
      ['brandId', 'brandId: "s_brand_apple"', ['s_iphone']],
      ['tagId', 'tagId: "s_tag_gift"', ['s_galaxy', 's_kente']],
      ['tagName', 'tagName: "ANDROID"', ['s_galaxy']],
      [
        'tagId and tagName together (both required, neither replaces the other)',
        'tagId: "s_tag_gift", tagName: "android"',
        ['s_galaxy'],
      ],
      ['tagId and tagName of tags no product shares', 'tagId: "s_tag_ios", tagName: "android"', []],
      ['priceMin', 'priceMin: "5000"', ['s_galaxy', 's_iphone']],
      ['priceMax', 'priceMax: "25"', ['s_gari', 's_shito', 's_tie_1', 's_tie_2', 's_tie_3', 's_tie_4', 's_tie_5']],
      ['priceMin and priceMax together', 'priceMin: "100", priceMax: "450"', ['s_hat', 's_kente', 's_shoes']],
      [
        'productTypeId',
        'productTypeId: "product_type_general", categoryId: "s_cat_phones"',
        ['s_case', 's_galaxy', 's_iphone'],
      ],
      [
        'createdAfter',
        `createdAfter: "${new Date(Date.now() - 86_400_000).toISOString()}", categoryId: "s_cat_fashion"`,
        ['s_hat', 's_kente', 's_shoes'],
      ],
    ])('filters by %s', async (_case, filter, expected) => {
      expect((await filtered(filter)).sort()).toEqual(expected);
    });

    it('combines filters of different kinds', async () => {
      expect((await filtered('categoryId: "s_cat_phones", brand: "Samsung", priceMax: "1000"')).sort()).toEqual([
        's_case',
      ]);
    });

    it('refuses a priceMin above priceMax', async () => {
      const body = await products('filterArgs: { priceMin: "500", priceMax: "100" }');
      expect(body.errors?.[0].extensions.code).toBe('BAD_REQUEST');
      expect(body.errors?.[0].message).toContain('priceMin 500.00 is above priceMax 100.00');
    });

    it('inStock true lists only products a customer can buy now (best serving location, expired lots and reservations left out)', async () => {
      expect((await filtered('inStock: true, priceMin: "11"')).sort()).toEqual([
        's_case',
        's_galaxy',
        's_gari',
        's_hat',
      ]);
    });

    it('inStock false lists the products none of whose variants can be bought', async () => {
      expect((await filtered('inStock: false')).sort()).toEqual(['s_iphone', 's_kente', 's_shito', 's_shoes']);
    });

    it('with inStock true and a price range, the same variant must be in stock and in range', async () => {
      expect(await filtered('priceMax: "50", categoryId: "s_cat_food"')).toEqual(expect.arrayContaining(['s_gari']));
      expect(await filtered('priceMax: "50", categoryId: "s_cat_food", inStock: true')).toEqual([]);
      expect(await filtered('priceMin: "50", categoryId: "s_cat_food", inStock: true')).toEqual(['s_gari']);
    });

    it('agrees with Product.inStock and Variant.available', async () => {
      const res = await gqlRequest(
        app,
        `{ products(paginationArgs: { first: 100 }) { edges { node { id inStock variants { available } } } } }`,
      ).expect(200);
      const nodes = res.body.data.products.edges.map(
        (edge: { node: { id: string; inStock: boolean; variants: { available: number }[] } }) => edge.node,
      );
      const inStock = await filtered('inStock: true');
      for (const node of nodes) {
        expect(node.inStock).toBe(inStock.includes(node.id));
        expect(node.variants.some((variant: { available: number }) => variant.available > 0)).toBe(node.inStock);
      }
    });

    it('never shows a draft product publicly, whatever the filter says', async () => {
      expect(await filtered('status: DRAFT, isActive: true, search: "samsung"')).not.toContain('s_draft');
    });

    it('lets staff search drafts through adminProducts', async () => {
      const token = await signInAdmin(app);
      const res = await gqlRequest(
        app,
        `{ adminProducts(filterArgs: { status: DRAFT, search: "galaxy tab" }) { edges { node { id } } } }`,
        undefined,
        token,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.adminProducts.edges.map((edge: { node: { id: string } }) => edge.node.id)).toEqual([
        's_draft',
      ]);
    });
  });

  describe('full-text search', () => {
    it.each([
      "'",
      ':',
      '&',
      '|',
      '!',
      '(',
      ')',
      '<',
      '*',
      "shoes' : & | ! ( ) < *",
      '!!!',
      '(((',
      'a & | b',
      '"unclosed',
    ])('never fails on %p', async (text) => {
      const body = await products(`filterArgs: { search: ${JSON.stringify(text)} }`);
      expect(body.errors).toBeUndefined();
    });

    it('treats punctuation-only text as no search', async () => {
      const all = await ids('paginationArgs: { first: 100 }');
      expect(await ids('paginationArgs: { first: 100 }, filterArgs: { search: "!!! ***" }')).toEqual(all);
    });

    it.each<[string, string, string[]]>([
      ['an apostrophe', "men's shoes", ['s_shoes']],
      ['an ampersand phrase in the description', '"rock & roll"', ['s_shoes']],
      ['a brand name', 'apple', ['s_iphone']],
      ['a category name', 'food', ['s_gari', 's_shito']],
      ['a sub-category name', 'scarves', ['s_kente']],
      ['a tag name', 'android', ['s_galaxy']],
      ['web-search exclusion', 'galaxy -case', ['s_galaxy']],
      ['web-search OR', 'gari OR shito', ['s_gari', 's_shito']],
    ])('matches %s', async (_case, text, expected) => {
      expect((await filtered(`search: ${JSON.stringify(text)}`)).sort()).toEqual(expected);
    });

    it('ranks by relevance: a name match before a brand match, and before a description match', async () => {
      expect(await filtered('search: "samsung"')).toEqual(['s_galaxy', 's_case']);
      expect(await filtered('search: "scarf"')).toEqual(['s_kente', 's_hat']);
    });

    it('falls back to names similar to the text when full-text finds nothing (typos)', async () => {
      expect(await filtered('search: "samsnug"')).toContain('s_galaxy');
      expect(await filtered('search: "iphnoe"')).toEqual(['s_iphone']);
      expect(await filtered('search: "zzqqxx"')).toEqual([]);
    });

    it('applies the filters to a search', async () => {
      expect(await filtered('search: "galaxy", subCategoryName: "Smartphones"')).toEqual(['s_galaxy']);
    });

    it('can sort a search by another field', async () => {
      expect(await ids('filterArgs: { search: "samsung" }, sortArgs: { sortBy: NAME, sortOrder: ASC }')).toEqual([
        's_case',
        's_galaxy',
      ]);
    });
  });

  describe('pagination', () => {
    const walk = async (args: string, first: number) => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const body = await products(
          `paginationArgs: { first: ${first}${after ? `, after: "${after}"` : ''} }, ${args}`,
        );
        expect(body.errors).toBeUndefined();
        const { edges, pageInfo } = body.data!.products as unknown as {
          edges: { cursor: string; node: { id: string } }[];
          pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; totalCount: number };
        };
        expect(pageInfo.hasPreviousPage).toBe(page > 0);
        seen.push(...edges.map((edge) => edge.node.id));
        if (!pageInfo.hasNextPage) return { seen, totalCount: pageInfo.totalCount };
        after = edges[edges.length - 1].cursor;
      }
      throw new Error('pagination did not end');
    };

    it.each(['NAME', 'CREATED_AT', 'UPDATED_AT'])(
      'pages through ties on %s without repeating or skipping',
      async (sortBy) => {
        for (const order of ['ASC', 'DESC']) {
          const { seen, totalCount } = await walk(
            `filterArgs: { tagName: "tie-breaker" }, sortArgs: { sortBy: ${sortBy}, sortOrder: ${order} }`,
            2,
          );
          expect(totalCount).toBe(5);
          expect(seen).toEqual(['s_tie_1', 's_tie_2', 's_tie_3', 's_tie_4', 's_tie_5']);
        }
      },
    );

    it('pages through a relevance-ranked search', async () => {
      const { seen, totalCount } = await walk('filterArgs: { search: "galaxy OR samsung OR scarf OR gari" }', 1);
      expect(totalCount).toBe(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('pages through a typo search', async () => {
      const { seen } = await walk('filterArgs: { search: "samsnug galxy" }', 1);
      expect(seen).toContain('s_galaxy');
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('refuses a cursor that is not one, or belongs to another sort', async () => {
      const first = await products('paginationArgs: { first: 1 }, sortArgs: { sortBy: NAME }');
      const cursor = first.data!.products.edges[0].cursor;
      for (const args of [
        'paginationArgs: { first: 1, after: "not-a-cursor" }',
        `paginationArgs: { first: 1, after: "${cursor}" }, sortArgs: { sortBy: CREATED_AT }`,
      ]) {
        const body = await products(args);
        expect(body.errors?.[0].extensions.code).toBe('BAD_REQUEST');
      }
    });
  });
});
