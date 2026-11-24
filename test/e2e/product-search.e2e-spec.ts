import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

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
  productTypeId?: string;
  attributes?: Record<string, string>;
  variants: {
    id: string;
    price: number;
    onHand?: number;
    reserved?: number;
    atClosedShop?: boolean;
    optionValues?: Record<string, string>;
  }[];
}

const PAGE = 'edges { cursor node { id name } } pageInfo { hasNextPage hasPreviousPage totalCount pageSize }';

describe('Product search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let defaultLocationId: string;
  let inactiveLocationId: string;
  let adminTokenPromise: Promise<string> | undefined;
  // One sign-in per suite: a second one within the same TOTP step would be refused as a replay.
  const adminToken = () => (adminTokenPromise ??= signInAdmin(app));

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
        ...(fixture.productTypeId && { productTypeId: fixture.productTypeId }),
        ...(fixture.attributes && { attributes: fixture.attributes }),
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
          ...(variant.optionValues && { optionValues: variant.optionValues }),
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
      const token = await adminToken();
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

  // Runs last: its products would change the exact lists above.
  describe('facets and attribute filters (P6-S.2)', () => {
    const FACETS = `totalCount inStockCount price { min { amount } max { amount } }
      brands { id name count } categories { id name count } attributes { key label values { value count } }`;
    const facets = async (filter: string) => {
      const res = await gqlRequest(app, `{ productFacets(filterArgs: { ${filter} }) { ${FACETS} } }`).expect(200);
      expect(res.body.errors).toBeUndefined();
      return res.body.data.productFacets;
    };
    const values = (result: { attributes: { key: string; values: unknown[] }[] }, key: string) =>
      result.attributes.find((facet) => facet.key === key)?.values;

    beforeAll(async () => {
      await prisma.productType.create({
        data: {
          id: 's_type_wear',
          key: 'search_wear',
          name: 'Search wear',
          attributes: {
            create: [
              { key: 'material', label: 'Material', dataType: 'TEXT', isFilterable: true, position: 0 },
              {
                key: 'colour',
                label: 'Colour',
                dataType: 'TEXT',
                isVariantAxis: true,
                isFilterable: true,
                position: 1,
              },
              { key: 'size', label: 'Size', dataType: 'TEXT', isVariantAxis: true, position: 2 },
            ],
          },
        },
      });
      await prisma.brand.createMany({
        data: [
          { id: 's_brand_kofi', name: 'Kofi Wear' },
          { id: 's_brand_ama', name: 'Ama Styles' },
        ],
      });
      await prisma.tag.create({ data: { id: 's_tag_facet', name: 'facet' } });
      const wear = { productTypeId: 's_type_wear', categoryId: 's_cat_fashion', tagIds: ['s_tag_facet'] };
      await createProduct({
        ...wear,
        id: 's_f_tee',
        name: 'Facet Tee',
        brandId: 's_brand_kofi',
        attributes: { material: 'Cotton' },
        variants: [
          { id: 's_v_tee_red', price: 50, onHand: 3, optionValues: { colour: 'Red', size: 'M' } },
          { id: 's_v_tee_blue', price: 70, onHand: 0, optionValues: { colour: 'Blue', size: 'M' } },
        ],
      });
      await createProduct({
        ...wear,
        id: 's_f_shirt',
        name: 'Facet Shirt',
        brandId: 's_brand_kofi',
        attributes: { material: 'Linen' },
        variants: [{ id: 's_v_shirt_blue', price: 90, onHand: 2, optionValues: { colour: 'Blue', size: 'L' } }],
      });
      await createProduct({
        ...wear,
        id: 's_f_dress',
        name: 'Facet Dress',
        brandId: 's_brand_ama',
        attributes: { material: 'cotton' },
        variants: [{ id: 's_v_dress_green', price: 200, onHand: 0, optionValues: { colour: 'Green', size: 'S' } }],
      });
    });

    it('counts brands, categories, filterable attributes (product and variant axis), price and stock', async () => {
      const result = await facets('tagName: "facet"');
      expect(result).toEqual({
        totalCount: 3,
        inStockCount: 2,
        price: { min: { amount: '50.00' }, max: { amount: '200.00' } },
        brands: [
          { id: 's_brand_kofi', name: 'Kofi Wear', count: 2 },
          { id: 's_brand_ama', name: 'Ama Styles', count: 1 },
        ],
        categories: [{ id: 's_cat_fashion', name: 'Fashion', count: 3 }],
        attributes: [
          {
            key: 'material',
            label: 'Material',
            values: [
              { value: 'Cotton', count: 2 },
              { value: 'Linen', count: 1 },
            ],
          },
          {
            key: 'colour',
            label: 'Colour',
            values: [
              { value: 'Blue', count: 2 },
              { value: 'Green', count: 1 },
              { value: 'Red', count: 1 },
            ],
          },
        ],
      });
    });

    it('counts each facet without its own filter, and the rest with every filter', async () => {
      const result = await facets('tagName: "facet", attributes: [{ key: "colour", values: ["blue"] }]');
      expect(result.totalCount).toBe(2);
      expect(values(result, 'colour')).toEqual([
        { value: 'Blue', count: 2 },
        { value: 'Green', count: 1 },
        { value: 'Red', count: 1 },
      ]);
      expect(values(result, 'material')).toEqual([
        { value: 'Cotton', count: 1 },
        { value: 'Linen', count: 1 },
      ]);
      expect(result.brands).toEqual([{ id: 's_brand_kofi', name: 'Kofi Wear', count: 2 }]);

      const byBrand = await facets('tagName: "facet", brandId: "s_brand_ama"');
      expect(byBrand.totalCount).toBe(1);
      expect(byBrand.brands.map((brand: { count: number }) => brand.count)).toEqual([2, 1]);
    });

    it('drops the price bounds from the price facet, and keeps only sellable variants with inStock', async () => {
      const capped = await facets('tagName: "facet", priceMax: "80"');
      expect(capped.totalCount).toBe(1);
      expect(capped.price).toEqual({ min: { amount: '50.00' }, max: { amount: '200.00' } });

      const inStock = await facets('tagName: "facet", inStock: true');
      expect(inStock.totalCount).toBe(2);
      expect(inStock.inStockCount).toBe(2);
      expect(inStock.price).toEqual({ min: { amount: '50.00' }, max: { amount: '90.00' } });
    });

    it.each<[string, string[]]>([
      ['attributes: [{ key: "colour", values: ["Red", "Green"] }]', ['s_f_dress', 's_f_tee']],
      ['attributes: [{ key: "colour", values: ["Red", "Green"] }, { key: "material", values: ["linen"] }]', []],
      ['attributes: [{ key: "material", values: ["COTTON"] }, { key: "colour", values: ["Green"] }]', ['s_f_dress']],
      ['attributes: [{ key: "size", values: ["L"] }]', ['s_f_shirt']],
    ])('filters by attributes, AND across keys and OR within one: %s', async (filter, expected) => {
      expect((await filtered(`tagName: "facet", ${filter}`)).sort()).toEqual(expected);
    });

    it('agrees with the products the same filters return', async () => {
      for (const filter of [
        'tagName: "facet"',
        'tagName: "facet", inStock: true',
        'tagName: "facet", attributes: [{ key: "colour", values: ["Blue"] }]',
        'search: "facet tee"',
        'search: "facet", brand: "Kofi Wear"',
      ]) {
        const result = await facets(filter);
        expect(result.totalCount).toBe((await filtered(filter)).length);
      }
    });

    it('refuses the same attribute filtered twice, and an invalid key', async () => {
      for (const filter of [
        'attributes: [{ key: "colour", values: ["Red"] }, { key: "colour", values: ["Blue"] }]',
        'attributes: [{ key: "Colour!", values: ["Red"] }]',
        'attributes: [{ key: "colour", values: [] }]',
      ]) {
        const res = await gqlRequest(app, `{ productFacets(filterArgs: { ${filter} }) { totalCount } }`).expect(200);
        expect(['BAD_REQUEST', 'BAD_USER_INPUT']).toContain(res.body.errors?.[0].extensions.code);
      }
    });

    it('stays within the query cost limit with every facet field', async () => {
      const res = await gqlRequest(
        app,
        `{ productFacets { ${FACETS} } products(paginationArgs: { first: 24 }) { ${PAGE} } }`,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();
    });
  });

  describe('suggestions (P6-S.4)', () => {
    const SUGGEST = 'products { id name } brands { id name } categories { id name }';
    const suggest = async (prefix: string, first?: number) => {
      const args = `prefix: ${JSON.stringify(prefix)}${first ? `, first: ${first}` : ''}`;
      const res = await gqlRequest(app, `{ searchSuggestions(${args}) { ${SUGGEST} } }`).expect(200);
      expect(res.body.errors).toBeUndefined();
      return res.body.data.searchSuggestions as Record<'products' | 'brands' | 'categories', { id: string }[]>;
    };
    const idsOf = (list: { id: string }[]) => list.map((item) => item.id);

    it('suggests published products by name, names starting with the prefix first', async () => {
      const result = await suggest('gal');
      // "Gari Premium" may follow as a similar name; names containing "gal" come first, those starting with it first.
      expect(idsOf(result.products).slice(0, 2)).toEqual(['s_case', 's_galaxy']);
    });

    it('suggests brands and categories that have published products', async () => {
      expect(idsOf((await suggest('sams')).brands)).toEqual(['s_brand_samsung']);
      expect(idsOf((await suggest('fash')).categories)).toEqual(['s_cat_fashion']);
      expect(idsOf((await suggest('Bonwire')).brands)).toEqual(['s_brand_kente']);
    });

    it('allows typos', async () => {
      const result = await suggest('samsnug');
      expect(idsOf(result.products)).toContain('s_galaxy');
      expect(idsOf(result.brands)).toEqual(['s_brand_samsung']);
    });

    it('never suggests a draft product, and caps each list', async () => {
      expect(idsOf((await suggest('galaxy tab')).products)).not.toContain('s_draft');
      expect((await suggest('facet', 1)).products).toHaveLength(1);
    });

    it('suggests nothing for under two letters or digits, and treats LIKE wildcards literally', async () => {
      expect(await suggest('g')).toEqual({ products: [], brands: [], categories: [] });
      expect(await suggest('%%')).toEqual({ products: [], brands: [], categories: [] });
      expect((await suggest('%_zq')).products).toEqual([]);
    });

    it('refuses more than 10 of each kind', async () => {
      const res = await gqlRequest(app, `{ searchSuggestions(prefix: "ga", first: 11) { products { id } } }`).expect(
        200,
      );
      expect(res.body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
    });
  });

  describe('synonyms (P6-S.4)', () => {
    const SYNONYM = 'id kind term synonyms';
    const mutate = async (operation: string, token?: string) =>
      (
        await gqlRequest(
          app,
          `mutation { ${operation} { ${SYNONYM} } }`,
          undefined,
          token ?? (await adminToken()),
        ).expect(200)
      ).body as {
        data: Record<string, { id: string; kind: string; term: string | null; synonyms: string[] }> | null;
        errors?: { extensions: { code: string }; message: string }[];
      };

    it('needs catalog.taxonomy.write to change synonyms', async () => {
      const create = 'createSearchSynonym(input: { kind: TWO_WAY, synonyms: ["handset", "phone"] })';
      const anonymous = await gqlRequest(app, `mutation { ${create} { id } }`).expect(200);
      expect(anonymous.body.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
      const customer = await mutate(create, await signInUser(app));
      expect(customer.errors?.[0].extensions.code).toBe('FORBIDDEN');
    });

    it('expands a search two ways once staff add a group, and stops when they remove it', async () => {
      expect(await filtered('search: "handset"')).toEqual([]);

      const created = await mutate('createSearchSynonym(input: { kind: TWO_WAY, synonyms: [" Handset ", "PHONE"] })');
      expect(created.errors).toBeUndefined();
      const synonym = created.data!.createSearchSynonym;
      expect(synonym).toEqual(expect.objectContaining({ kind: 'TWO_WAY', term: null, synonyms: ['handset', 'phone'] }));
      expect((await filtered('search: "handset"')).sort()).toEqual(['s_case', 's_galaxy']);

      const updated = await mutate(
        `updateSearchSynonym(id: "${synonym.id}", input: { kind: TWO_WAY, synonyms: ["handset", "case"] })`,
      );
      expect(updated.data!.updateSearchSynonym.synonyms).toEqual(['handset', 'case']);
      expect(await filtered('search: "handset"')).toEqual(['s_case']);

      const facets = await gqlRequest(
        app,
        `{ productFacets(filterArgs: { search: "handset" }) { totalCount } }`,
      ).expect(200);
      expect(facets.body.data.productFacets.totalCount).toBe(1);

      expect((await mutate(`deleteSearchSynonym(id: "${synonym.id}")`)).errors).toBeUndefined();
      expect(await filtered('search: "handset"')).toEqual([]);

      const audit = await prisma.auditLog.findMany({
        where: { entity: 'SearchSynonym', entityId: synonym.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    });

    it('expands a one-way term from its own side only', async () => {
      const created = await mutate('createSearchSynonym(input: { kind: ONE_WAY, term: "gari", synonyms: ["shito"] })');
      expect(created.errors).toBeUndefined();
      expect((await filtered('search: "gari"')).sort()).toEqual(['s_gari', 's_shito']);
      expect(await filtered('search: "shito"')).toEqual(['s_shito']);

      const res = await gqlRequest(app, `{ searchSynonyms { ${SYNONYM} } }`, undefined, await adminToken()).expect(200);
      expect(res.body.data.searchSynonyms).toEqual([
        expect.objectContaining({ kind: 'ONE_WAY', term: 'gari', synonyms: ['shito'] }),
      ]);
    });

    it.each([
      ['search syntax in a term', 'kind: TWO_WAY, synonyms: ["\\"phone\\"", "mobile"]', 'only letters'],
      ['a one-way group without its term', 'kind: ONE_WAY, synonyms: ["mobile"]', 'needs the term'],
      ['a two-way group of one', 'kind: TWO_WAY, synonyms: ["mobile"]', 'takes 2-20 synonyms'],
    ])('refuses %s', async (_case, input, message) => {
      const body = await mutate(`createSearchSynonym(input: { ${input} })`);
      expect(body.errors?.[0].extensions.code).toBe('BAD_REQUEST');
      expect(body.errors?.[0].message).toContain(message);
    });
  });
});
