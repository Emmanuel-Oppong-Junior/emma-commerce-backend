import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { createPromotion } from '../helpers/promotion.helper';

// P8-C: SEO slugs and redirects, collections, banners, homepage sections and path redirects.

type GqlBody = {
  data: Record<string, any> | null;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const IMAGE = 'https://res.cloudinary.com/demo/image/upload/hero.jpg';

describe('Storefront content and SEO (P8-C, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;
  let supportToken: string;

  const gql = async (query: string, token?: string, variables?: Record<string, unknown>): Promise<GqlBody> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body as GqlBody;
  const ok = async (query: string, token?: string, variables?: Record<string, unknown>) => {
    const body = await gql(query, token, variables);
    expect(body.errors).toBeUndefined();
    return body.data!;
  };
  const admin = (query: string, variables?: Record<string, unknown>) => ok(query, adminToken, variables);
  const errorOf = async (query: string, token?: string, variables?: Record<string, unknown>) => {
    const body = await gql(query, token, variables);
    expect(body.errors).toBeDefined();
    return body.errors![0];
  };
  const auditRows = (entity: string) =>
    prisma.auditLog.findMany({
      where: { entity },
      orderBy: { createdAt: 'asc' },
      select: { action: true, userId: true },
    });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    customerToken = await signInUser(app);
    const store = await prisma.store.findFirstOrThrow();
    const email = 'content-support@test.local';
    ({ accessToken: supportToken } = await signUpUser(app, { email, password: 'Staff@12345', name: 'Support' }));
    const support = await prisma.user.findUniqueOrThrow({ where: { email } });
    const role = await prisma.staffRole.findUniqueOrThrow({ where: { key: 'SUPPORT' } });
    await prisma.storeMembership.create({ data: { userId: support.id, storeId: store.id, roleId: role.id } });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('slugs', () => {
    it('gives every row a slug from its name, including rows inserted without the app', async () => {
      const [category, brand, product] = await Promise.all([
        prisma.category.findUniqueOrThrow({ where: { id: 'seed_cat' } }),
        prisma.brand.findUniqueOrThrow({ where: { id: 'seed_brand' } }),
        prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } }),
      ]);
      expect([category.slug, brand.slug, product.slug]).toEqual(['electronics', 'test-brand', 'laptop']);
    });

    it('makes a slug on create, with a suffix on a clash, and looks products up by slug among published ones', async () => {
      const create = (name: string, extra = '') =>
        admin(`mutation { createProduct(createProductInput: {
          name: "${name}", status: PUBLISHED, isActive: true, variants: [{ basePrice: "10.00", quantity: 1 }] ${extra}
        }) { id slug } }`);
      const first = (await create('Crème Brûlée & Co.')).createProduct;
      const second = (await create('Creme Brulee and Co')).createProduct;
      expect([first.slug, second.slug]).toEqual(['creme-brulee-and-co', 'creme-brulee-and-co-2']);

      const found = await ok(`{ productBySlug(slug: "creme-brulee-and-co-2") { id name metaTitle } }`);
      expect(found.productBySlug).toEqual({ id: second.id, name: 'Creme Brulee and Co', metaTitle: null });
      expect((await ok(`{ productBySlug(slug: "unreleased-tablet") { id } }`)).productBySlug).toBeNull();
    });

    it('refuses a taken, malformed or null slug', async () => {
      const taken = await errorOf(
        `mutation { updateProduct(productId: "seed_prod2", updateProductInput: { slug: "laptop" }) { id } }`,
        adminToken,
      );
      expect(taken.extensions.code).toBe('CONFLICT');
      expect(taken.message).toBe('Slug "laptop" is already used by another product');

      const malformed = await errorOf(
        `mutation { updateCategory(id: "seed_cat", input: { slug: "Big Screens" }) { id } }`,
        adminToken,
      );
      expect(malformed.extensions.code).toBe('BAD_USER_INPUT');

      const nulled = await errorOf(
        `mutation { updateBrand(id: "seed_brand", input: { slug: null }) { id } }`,
        adminToken,
      );
      expect(nulled.extensions.code).toBe('BAD_REQUEST');
    });

    it('keeps old slugs as redirects to the current one, however many renames, with SEO fields set by staff', async () => {
      await admin(`mutation { updateProduct(productId: "seed_prod1", updateProductInput: {
        slug: "laptop-pro", metaTitle: "Laptop Pro", metaDescription: "Fast", ogImageUrl: "${IMAGE}"
      }) { slug } }`);
      await admin(
        `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { slug: "laptop-pro-2026" }) { slug } }`,
      );

      const resolve = (slug: string) =>
        ok(`{ resolveSlug(type: PRODUCT, slug: "${slug}") { type id slug redirected } }`).then((d) => d.resolveSlug);
      const current = { type: 'PRODUCT', id: 'seed_prod1', slug: 'laptop-pro-2026' };
      expect(await resolve('laptop')).toEqual({ ...current, redirected: true });
      expect(await resolve('laptop-pro')).toEqual({ ...current, redirected: true });
      expect(await resolve('laptop-pro-2026')).toEqual({ ...current, redirected: false });
      expect(await resolve('no-such-slug')).toBeNull();
      expect((await ok(`{ productBySlug(slug: "laptop") { id } }`)).productBySlug).toBeNull();
      const product = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } });
      expect(product).toMatchObject({ metaTitle: 'Laptop Pro', metaDescription: 'Fast', ogImageUrl: IMAGE });
    });

    it('gives an old slug to a new owner, dropping its redirect, and hides drafts behind redirects', async () => {
      await admin(
        `mutation { updateProduct(productId: "seed_prod2", updateProductInput: { slug: "laptop" }) { slug } }`,
      );
      expect((await ok(`{ resolveSlug(type: PRODUCT, slug: "laptop") { id redirected } }`)).resolveSlug).toEqual({
        id: 'seed_prod2',
        redirected: false,
      });
      expect(await prisma.slugRedirect.count({ where: { fromSlug: 'laptop' } })).toBe(0);

      await prisma.product.update({ where: { id: 'seed_prod_draft' }, data: { slug: 'tablet-2026' } });
      expect((await ok(`{ resolveSlug(type: PRODUCT, slug: "unreleased-tablet") { id } }`)).resolveSlug).toBeNull();
    });

    it('looks categories, sub-categories and brands up by slug, following renames with resolveSlug', async () => {
      const sub = await admin(`mutation { createSubCategory(input: { name: "Smart Phones", categoryId: "seed_cat" }) {
        id slug } }`);
      expect(sub.createSubCategory.slug).toBe('smart-phones');
      await admin(`mutation { updateCategory(id: "seed_cat", input: { slug: "electronics-and-gadgets" }) { slug } }`);
      await admin(`mutation { createBrand(input: { name: "Acme", slug: "acme-official" }) { slug } }`);

      const data = await ok(`{
        categoryBySlug(slug: "electronics-and-gadgets") { id }
        subCategoryBySlug(slug: "smart-phones") { id }
        brandBySlug(slug: "acme-official") { name }
        old: categoryBySlug(slug: "electronics") { id }
        resolveSlug(type: CATEGORY, slug: "electronics") { slug redirected }
      }`);
      expect(data).toEqual({
        categoryBySlug: { id: 'seed_cat' },
        subCategoryBySlug: { id: sub.createSubCategory.id },
        brandBySlug: { name: 'Acme' },
        old: null,
        resolveSlug: { slug: 'electronics-and-gadgets', redirected: true },
      });
    });
  });

  describe('collections', () => {
    let manualId: string;

    it('lists a manual collection in the staff order, published products only, page by page', async () => {
      const created = await admin(`mutation { createCollection(input: {
        name: "Staff Picks", type: MANUAL, productIds: ["seed_prod2", "seed_prod_draft", "seed_prod1"]
      }) { id slug type productIds } }`);
      manualId = created.createCollection.id;
      expect(created.createCollection).toMatchObject({
        slug: 'staff-picks',
        type: 'MANUAL',
        productIds: ['seed_prod2', 'seed_prod_draft', 'seed_prod1'],
      });

      const page = (after?: string) =>
        ok(`{ collection(slug: "staff-picks") { name products(paginationArgs: { first: 1 ${after ? `, after: "${after}"` : ''} }) {
          edges { cursor node { id } } pageInfo { hasNextPage totalCount } } } }`).then((d) => d.collection.products);
      const first = await page();
      expect(first.edges.map((e: { node: { id: string } }) => e.node.id)).toEqual(['seed_prod2']);
      expect(first.pageInfo).toEqual({ hasNextPage: true, totalCount: 2 });
      const second = await page(first.edges[0].cursor);
      expect(second.edges.map((e: { node: { id: string } }) => e.node.id)).toEqual(['seed_prod1']);
      expect(second.pageInfo.hasNextPage).toBe(false);

      await admin(
        `mutation { setCollectionProducts(id: "${manualId}", productIds: ["seed_prod1", "seed_prod2"]) { id } }`,
      );
      const reordered = await ok(`{ collection(slug: "staff-picks") { products { edges { node { id } } } } }`);
      expect(reordered.collection.products.edges.map((e: { node: { id: string } }) => e.node.id)).toEqual([
        'seed_prod1',
        'seed_prod2',
      ]);
    });

    it('shows a manual collection’s product ids to staff only', async () => {
      const error = await errorOf(`{ collection(slug: "staff-picks") { productIds } }`, customerToken);
      expect(error.extensions.code).toBe('FORBIDDEN');
    });

    it('finds the products matching a rule-based collection, on sale and in stock, page by page', async () => {
      await createPromotion(prisma, { type: 'PERCENT', value: 10, targetIds: ['seed_prod2'] });
      await createPromotion(prisma, { type: 'PERCENT', value: 50, targetIds: ['seed_prod1'], requiresCoupon: true });
      await admin(`mutation { createCollection(input: {
        name: "Deals", type: RULE, rules: { categoryId: "seed_cat", onSale: true, inStock: true }
      }) { id rules { categoryId onSale inStock priceMin } } }`);

      const deals = await ok(
        `{ collection(slug: "deals") { rules { onSale } products { edges { node { id } } pageInfo { totalCount } } } }`,
      );
      expect(deals.collection.rules).toEqual({ onSale: true });
      expect(deals.collection.products.edges.map((e: { node: { id: string } }) => e.node.id)).toEqual(['seed_prod2']);

      await admin(`mutation { createCollection(input: {
        name: "Everything Electronic", type: RULE, rules: { brandId: "seed_brand", priceMin: "100.00" }
      }) { id } }`);
      const byName = await ok(`{ collection(slug: "everything-electronic") {
        products(paginationArgs: { first: 1 }, sortArgs: { sortBy: NAME, sortOrder: ASC }) {
          edges { cursor node { name } } pageInfo { hasNextPage totalCount } } } }`);
      expect(byName.collection.products.edges[0].node.name).toBe('Laptop');
      expect(byName.collection.products.pageInfo).toEqual({ hasNextPage: true, totalCount: 2 });
    });

    it('refuses rules that cannot make a collection', async () => {
      const none = await errorOf(
        `mutation { createCollection(input: { name: "Empty", type: RULE, rules: {} }) { id } }`,
        adminToken,
      );
      expect(none.message).toBe('A rule-based collection needs at least one rule');
      const range = await errorOf(
        `mutation { createCollection(input: { name: "Bad", type: RULE, rules: { priceMin: "50.00", priceMax: "10.00" } }) { id } }`,
        adminToken,
      );
      expect(range.message).toBe('priceMin 50.00 is above priceMax 10.00');
      const unknown = await errorOf(
        `mutation { createCollection(input: { name: "Ghost", type: RULE, rules: { brandId: "nope" } }) { id } }`,
        adminToken,
      );
      expect(unknown.extensions.code).toBe('NOT_FOUND');
    });

    it('shows a collection to customers only inside its schedule, and staff always', async () => {
      const startsAt = new Date(Date.now() + DAY_MS).toISOString();
      await admin(`mutation { createCollection(input: {
        name: "Next Week", type: MANUAL, productIds: ["seed_prod1"], startsAt: "${startsAt}"
      }) { id } }`);
      const data = await ok(`{ collection(slug: "next-week") { id } collections { slug } }`);
      expect(data.collection).toBeNull();
      expect(data.collections.map((c: { slug: string }) => c.slug)).not.toContain('next-week');
      const staff = await admin(`{ adminCollections { slug } }`);
      expect(staff.adminCollections.map((c: { slug: string }) => c.slug)).toContain('next-week');
    });

    it('lets Support read collections but only content managers change them, audited', async () => {
      expect((await ok(`{ adminCollections { id } }`, supportToken)).adminCollections.length).toBeGreaterThan(0);
      const denied = await errorOf(
        `mutation { updateCollection(id: "${manualId}", input: { name: "Mine" }) { id } }`,
        supportToken,
      );
      expect(denied.extensions.code).toBe('FORBIDDEN');
      const customer = await errorOf(`{ adminCollections { id } }`, customerToken);
      expect(customer.extensions.code).toBe('FORBIDDEN');

      await admin(`mutation { updateCollection(id: "${manualId}", input: { slug: "our-picks" }) { slug } }`);
      expect(
        (await ok(`{ resolveSlug(type: COLLECTION, slug: "staff-picks") { slug redirected } }`)).resolveSlug,
      ).toEqual({ slug: 'our-picks', redirected: true });
      await admin(`mutation { deleteCollection(id: "${manualId}") { id } }`);
      expect(await prisma.slugRedirect.count({ where: { entityType: 'COLLECTION' } })).toBe(0);
      expect((await auditRows('Collection')).map((row) => row.action)).toEqual([
        'CREATE',
        'UPDATE',
        'CREATE',
        'CREATE',
        'CREATE',
        'UPDATE',
        'DELETE',
      ]);
    });
  });

  describe('banners', () => {
    const fields = 'id title position link { type targetId slug path url }';

    it('shows the live banners of a placement by position, with links only to visible pages', async () => {
      const create = (input: string) =>
        admin(`mutation { createBanner(input: { imageUrl: "${IMAGE}", ${input} }) { ${fields} } }`);
      await create(`title: "Second", placement: "HOME_HERO", position: 2, link: { type: PATH, path: "/sale/" }`);
      await create(
        `title: "First", placement: "HOME_HERO", position: 1, link: { type: PRODUCT, targetId: "seed_prod2" }`,
      );
      await create(
        `title: "Draft link", placement: "HOME_HERO", position: 3, link: { type: PRODUCT, targetId: "seed_prod_draft" }`,
      );
      await create(`title: "Off", placement: "HOME_HERO", position: 0, isActive: false`);
      await create(
        `title: "Later", placement: "HOME_HERO", position: 0, startsAt: "${new Date(Date.now() + DAY_MS).toISOString()}"`,
      );
      await create(
        `title: "Over", placement: "HOME_HERO", position: 0, endsAt: "${new Date(Date.now() - 1000).toISOString()}", startsAt: "${new Date(Date.now() - DAY_MS).toISOString()}"`,
      );
      await create(
        `title: "Elsewhere", placement: "CATEGORY_TOP", link: { type: URL, url: "https://brand.example/launch" }`,
      );

      const live = (await ok(`{ banners(placement: "HOME_HERO") { ${fields} } }`)).banners;
      expect(live.map((b: { title: string; link: unknown }) => [b.title, b.link])).toEqual([
        ['First', { type: 'PRODUCT', targetId: 'seed_prod2', slug: 'laptop', path: null, url: null }],
        ['Second', { type: 'PATH', targetId: null, slug: null, path: '/sale', url: null }],
        ['Draft link', null],
      ]);
      const staff = (await admin(`{ adminBanners(placement: "HOME_HERO") { title link { slug } } }`)).adminBanners;
      expect(staff).toHaveLength(6);
      expect(staff.find((b: { title: string }) => b.title === 'Draft link').link).toEqual({ slug: 'tablet-2026' });
    });

    it('refuses links that leave the store unsafely or name nothing', async () => {
      const refused = async (link: string) =>
        errorOf(
          `mutation { createBanner(input: { title: "X", imageUrl: "${IMAGE}", placement: "HOME_HERO", link: ${link} }) { id } }`,
          adminToken,
        );
      expect((await refused(`{ type: URL, url: "http://brand.example" }`)).message).toBe(
        'url "http://brand.example" must be an absolute https URL',
      );
      expect((await refused(`{ type: PATH, path: "//evil.example" }`)).extensions.code).toBe('BAD_REQUEST');
      expect((await refused(`{ type: CATEGORY, targetId: "nope" }`)).extensions.code).toBe('NOT_FOUND');
      const placement = await errorOf(
        `mutation { createBanner(input: { title: "X", imageUrl: "${IMAGE}", placement: "home hero" }) { id } }`,
        adminToken,
      );
      expect(placement.extensions.code).toBe('BAD_USER_INPUT');
    });

    it('drops the link of a banner whose category is deleted, and audits every change', async () => {
      const category = await prisma.category.create({ data: { name: 'Seasonal' } });
      const banner = (
        await admin(`mutation { createBanner(input: { title: "Season", imageUrl: "${IMAGE}", placement: "CATEGORY_TOP",
          link: { type: CATEGORY, targetId: "${category.id}" } }) { id link { slug } } }`)
      ).createBanner;
      expect(banner.link).toEqual({ slug: 'seasonal' });
      await admin(`mutation { removeCategory(id: "${category.id}") { id } }`);
      expect((await ok(`{ banners(placement: "CATEGORY_TOP") { title link { type } } }`)).banners).toEqual([
        { title: 'Elsewhere', link: { type: 'URL' } },
        { title: 'Season', link: null },
      ]);

      await admin(`mutation { updateBanner(id: "${banner.id}", input: { title: "Season 2", link: null }) { id } }`);
      await admin(`mutation { deleteBanner(id: "${banner.id}") { id } }`);
      const denied = await errorOf(`mutation { deleteBanner(id: "${banner.id}") { id } }`, supportToken);
      expect(denied.extensions.code).toBe('FORBIDDEN');
      const rows = await auditRows('Banner');
      expect(rows.slice(-3).map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
      expect(rows.every((row) => row.userId === 'seed_admin')).toBe(true);
    });
  });

  describe('homepage', () => {
    it('resolves the live sections in order, showing only what customers may see', async () => {
      const collection = await admin(`mutation { createCollection(input: {
        name: "Home Picks", type: MANUAL, productIds: ["seed_prod_draft", "seed_prod2", "seed_prod_inactive"]
      }) { id } }`);
      const hidden = await admin(`mutation { createCollection(input: {
        name: "Hidden Picks", type: MANUAL, productIds: ["seed_prod1"], isActive: false
      }) { id } }`);
      const section = (input: string) =>
        admin(`mutation { createHomepageSection(input: { ${input} }) { id config {
        collectionId productLimit categoryIds bannerPlacement bannerLimit text } } }`);
      const carousel = await section(
        `type: PRODUCT_CAROUSEL, title: "Picks", position: 1, config: { collectionId: "${collection.createCollection.id}" }`,
      );
      expect(carousel.createHomepageSection.config).toMatchObject({ productLimit: 12, categoryIds: null });
      await section(`type: RICH_TEXT, position: 0, config: { text: "**Free delivery** in [Accra](/delivery)" }`);
      await section(`type: CATEGORY_GRID, position: 2, config: { categoryIds: ["seed_cat"] }`);
      await section(`type: BANNER_STRIP, position: 3, config: { bannerPlacement: "HOME_HERO", bannerLimit: 1 }`);
      await section(`type: BRAND_STRIP, position: 4, config: { brandIds: ["seed_brand"] }`);
      await section(`type: PRODUCT_CAROUSEL, position: 5, config: { collectionId: "${hidden.createCollection.id}" }`);
      await section(`type: BANNER_STRIP, position: 6, config: { bannerPlacement: "NOWHERE" }`);
      await section(`type: RICH_TEXT, position: 7, isActive: false, config: { text: "Off" }`);

      const home = (
        await ok(
          `{ homepage { type title text products { id slug } categories { slug } brands { slug } banners { title } } }`,
        )
      ).homepage;
      expect(home).toEqual([
        {
          type: 'RICH_TEXT',
          title: null,
          text: '**Free delivery** in [Accra](/delivery)',
          products: [],
          categories: [],
          brands: [],
          banners: [],
        },
        {
          type: 'PRODUCT_CAROUSEL',
          title: 'Picks',
          text: null,
          products: [{ id: 'seed_prod2', slug: 'laptop' }],
          categories: [],
          brands: [],
          banners: [],
        },
        {
          type: 'CATEGORY_GRID',
          title: null,
          text: null,
          products: [],
          categories: [{ slug: 'electronics-and-gadgets' }],
          brands: [],
          banners: [],
        },
        {
          type: 'BANNER_STRIP',
          title: null,
          text: null,
          products: [],
          categories: [],
          brands: [],
          banners: [{ title: 'First' }],
        },
        {
          type: 'BRAND_STRIP',
          title: null,
          text: null,
          products: [],
          categories: [],
          brands: [{ slug: 'test-brand' }],
          banners: [],
        },
      ]);
      expect((await admin(`{ homepageSections { id } }`)).homepageSections).toHaveLength(8);
    });

    it('refuses a config that does not fit the type, rich text with HTML, and unknown ids', async () => {
      const refused = (input: string) =>
        errorOf(`mutation { createHomepageSection(input: { ${input} }) { id } }`, adminToken);
      expect((await refused(`type: CATEGORY_GRID, config: { brandIds: ["seed_brand"] }`)).message).toBe(
        'A CATEGORY_GRID section takes categoryIds, not brandIds',
      );
      expect((await refused(`type: RICH_TEXT, config: { text: "<script>alert(1)</script>" }`)).message).toBe(
        'text must not contain HTML; use markdown',
      );
      expect((await refused(`type: RICH_TEXT, config: { text: "[x](javascript:void)" }`)).extensions.code).toBe(
        'BAD_REQUEST',
      );
      expect((await refused(`type: BRAND_STRIP, config: { brandIds: ["nope"] }`)).extensions.code).toBe('NOT_FOUND');
    });

    it('updates and deletes sections with an audit row each, for content managers only', async () => {
      const [first] = (await admin(`{ homepageSections { id type } }`)).homepageSections;
      await admin(
        `mutation { updateHomepageSection(id: "${first.id}", input: { title: "Welcome", config: { text: "Hello" } }) { id } }`,
      );
      await admin(`mutation { deleteHomepageSection(id: "${first.id}") { id } }`);
      const denied = await errorOf(
        `mutation { createHomepageSection(input: { type: RICH_TEXT, config: { text: "x" } }) { id } }`,
        customerToken,
      );
      expect(denied.extensions.code).toBe('FORBIDDEN');
      expect((await auditRows('HomepageSection')).slice(-2).map((row) => row.action)).toEqual(['UPDATE', 'DELETE']);
    });
  });

  describe('path redirects', () => {
    it('follows a chain of redirects, temporary when any hop is, and refuses loops and duplicates', async () => {
      const create = (from: string, to: string, status = '') =>
        gql(
          `mutation { createPathRedirect(input: { fromPath: "${from}", toPath: "${to}" ${status} }) { id fromPath toPath statusCode } }`,
          adminToken,
        );
      const first = await create('/old-sale/', '/summer-sale');
      expect(first.data!.createPathRedirect).toMatchObject({
        fromPath: '/old-sale',
        toPath: '/summer-sale',
        statusCode: 301,
      });
      await create('/summer-sale', '/sale?season=summer', ', statusCode: 302');

      const resolve = (path: string) =>
        ok(`{ resolvePath(path: "${path}") { toPath statusCode } }`).then((d) => d.resolvePath);
      expect(await resolve('/old-sale?utm=mail')).toEqual({ toPath: '/sale?season=summer', statusCode: 302 });
      expect(await resolve('/nowhere')).toBeNull();

      const loop = await create('/sale', '/old-sale');
      expect(loop.errors![0].extensions).toMatchObject({ code: 'CONFLICT', reason: 'REDIRECT_LOOP' });
      const duplicate = await create('/old-sale', '/elsewhere');
      expect(duplicate.errors![0].extensions.code).toBe('CONFLICT');
      const external = await create('/x', 'https://evil.example');
      expect(external.errors![0].extensions.code).toBe('BAD_REQUEST');

      await admin(`mutation { deletePathRedirect(id: "${first.data!.createPathRedirect.id}") { id } }`);
      expect(await resolve('/old-sale')).toBeNull();
      expect((await ok(`{ pathRedirects { fromPath } }`, supportToken)).pathRedirects).toEqual([
        { fromPath: '/summer-sale' },
      ]);
      expect((await auditRows('PathRedirect')).map((row) => row.action)).toEqual(['CREATE', 'CREATE', 'DELETE']);
    });
  });
});
