import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

const TYPE_FIELDS =
  'id key name isSystem attributes { id key label dataType unit isRequired allowedValues isVariantAxis isFilterable position }';

describe('Product types and attribute definitions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken: string;
  let customerToken: string;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const createPhoneType = () =>
    gql(
      `mutation($input: CreateProductTypeInput!) { createProductType(input: $input) { ${TYPE_FIELDS} } }`,
      managerToken,
      {
        input: {
          key: 'phone',
          name: 'Phone',
          attributes: [
            {
              key: 'storage',
              label: 'Storage',
              dataType: 'NUMBER',
              unit: 'GB',
              isVariantAxis: true,
              isFilterable: true,
            },
            { key: 'colour', label: 'Colour', dataType: 'TEXT', isVariantAxis: true, position: 1 },
            { key: 'warranty_months', label: 'Warranty', dataType: 'NUMBER', unit: 'months', position: 2 },
          ],
        },
      },
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  afterEach(async () => {
    await prisma.product.updateMany({ data: { productTypeId: 'product_type_general' } });
    await prisma.productType.deleteMany({ where: { isSystem: false } });
  });

  afterAll(() => app.close());

  it('serves the seeded General and Apparel system types publicly, attributes in order', async () => {
    const res = await gql(`{ productTypes { ${TYPE_FIELDS} } }`);

    expect(res.body.errors).toBeUndefined();
    const byKey = Object.fromEntries(res.body.data.productTypes.map((t: { key: string }) => [t.key, t]));
    expect(byKey.general).toMatchObject({ id: 'product_type_general', isSystem: true, attributes: [] });
    expect(
      byKey.apparel.attributes.map((a: { key: string; isVariantAxis: boolean }) => [a.key, a.isVariantAxis]),
    ).toEqual([
      ['size', true],
      ['colour', true],
    ]);
  });

  it('gives every existing product the General type and exposes it on Product', async () => {
    const res = await gql('{ product(productId: "seed_prod1") { productTypeId productType { key } attributes } }');

    expect(res.body.data.product).toEqual({
      productTypeId: 'product_type_general',
      productType: { key: 'general' },
      attributes: {},
    });
  });

  it('lets catalog.taxonomy.write holders create a type, audited, and refuses customers', async () => {
    const denied = await gql(
      'mutation { createProductType(input: { key: "nope", name: "Nope" }) { id } }',
      customerToken,
    );
    const res = await createPhoneType();

    expect(denied.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(res.body.errors).toBeUndefined();
    const created = res.body.data.createProductType;
    expect(created).toMatchObject({ key: 'phone', isSystem: false });
    expect(created.attributes.map((a: { key: string }) => a.key)).toEqual(['storage', 'colour', 'warranty_months']);
    const audit = await prisma.auditLog.findFirst({ where: { entity: 'ProductType', entityId: created.id } });
    expect(audit).toMatchObject({ action: 'CREATE', userId: 'seed_admin' });
  });

  it('refuses a duplicate type key with CONFLICT', async () => {
    await createPhoneType();

    const res = await createPhoneType();

    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
  });

  it('keeps system types read-only', async () => {
    const rename = await gql(
      'mutation { updateProductType(id: "product_type_apparel", input: { name: "Clothes" }) { id } }',
      managerToken,
    );
    const remove = await gql('mutation { deleteProductType(id: "product_type_general") { id } }', managerToken);
    const relabel = await gql(
      'mutation { updateAttributeDefinition(attributeId: "attribute_apparel_size", input: { label: "Sz" }) { id } }',
      managerToken,
    );

    for (const res of [rename, remove, relabel]) expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(await prisma.productType.findUnique({ where: { id: 'product_type_apparel' } })).toMatchObject({
      name: 'Apparel',
    });
  });

  it('protects the values of products using a type: only optional additions and safe edits', async () => {
    const type = (await createPhoneType()).body.data.createProductType;
    const storage = type.attributes.find((a: { key: string }) => a.key === 'storage');
    await prisma.product.update({ where: { id: 'seed_prod2' }, data: { productTypeId: type.id } });

    const addRequired = await gql(
      `mutation { addAttributeDefinition(productTypeId: "${type.id}", input: { key: "ram", label: "RAM", dataType: NUMBER, isRequired: true }) { id } }`,
      managerToken,
    );
    const addOptional = await gql(
      `mutation { addAttributeDefinition(productTypeId: "${type.id}", input: { key: "ram", label: "RAM", dataType: NUMBER, unit: "GB" }) { attributes { key } } }`,
      managerToken,
    );
    const changeUnit = await gql(
      `mutation { updateAttributeDefinition(attributeId: "${storage.id}", input: { unit: "TB" }) { id } }`,
      managerToken,
    );
    const relabel = await gql(
      `mutation { updateAttributeDefinition(attributeId: "${storage.id}", input: { label: "Capacity" }) { attributes { key label } } }`,
      managerToken,
    );
    const remove = await gql(
      `mutation { removeAttributeDefinition(attributeId: "${storage.id}") { id } }`,
      managerToken,
    );
    const deleteType = await gql(`mutation { deleteProductType(id: "${type.id}") { id } }`, managerToken);

    expect(addRequired.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(addOptional.body.data.addAttributeDefinition.attributes.map((a: { key: string }) => a.key)).toContain('ram');
    expect(changeUnit.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(relabel.body.data.updateAttributeDefinition.attributes).toContainEqual({
      key: 'storage',
      label: 'Capacity',
    });
    expect(remove.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(deleteType.body.errors[0].extensions.code).toBe('CONFLICT');
  });

  it('deletes an unused custom type with its attributes', async () => {
    const type = (await createPhoneType()).body.data.createProductType;

    const res = await gql(`mutation { deleteProductType(id: "${type.id}") { key } }`, managerToken);

    expect(res.body.data.deleteProductType).toEqual({ key: 'phone' });
    expect(await prisma.attributeDefinition.count({ where: { productTypeId: type.id } })).toBe(0);
  });

  it('rejects a malformed attribute key as BAD_USER_INPUT', async () => {
    const res = await gql(
      'mutation { createProductType(input: { key: "phone", name: "Phone", attributes: [{ key: "Screen Size", label: "Screen", dataType: NUMBER }] }) { id } }',
      managerToken,
    );

    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});
