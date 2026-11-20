import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

describe('Tax changes reprice taxable products atomically (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let vatId: string;

  const admin = (query: string) => gqlRequest(app, query, undefined, adminToken).expect(200);
  const DEFAULT_VARIANT: Record<string, string> = {
    seed_prod1: 'seed_var1',
    seed_prod2: 'seed_var2',
    seed_prod_draft: 'seed_var_draft',
  };
  const priceOf = async (productId: string) =>
    (await prisma.variant.findUniqueOrThrow({ where: { id: DEFAULT_VARIANT[productId] } })).price?.toFixed(2) ?? null;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    await prisma.product.update({ where: { id: 'seed_prod1' }, data: { isTaxable: true } });
    await prisma.variant.update({ where: { id: 'seed_var1' }, data: { basePrice: '10.10', price: '10.10' } });
    await prisma.product.update({ where: { id: 'seed_prod2' }, data: { isTaxable: false } });
    await prisma.variant.update({ where: { id: 'seed_var2' }, data: { basePrice: '20.00', price: '20.00' } });
    await prisma.product.update({ where: { id: 'seed_prod_draft' }, data: { isTaxable: true } });
    await prisma.variant.update({ where: { id: 'seed_var_draft' }, data: { basePrice: null, price: '299.99' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('createTax reprices taxable products with numeric rounding and leaves the others', async () => {
    const res = await admin(`mutation { createTax(input: { name: "VAT", rate: "0.15" }) { id rate } }`);

    expect(res.body.errors).toBeUndefined();
    vatId = res.body.data.createTax.id;
    expect(res.body.data.createTax.rate).toBe('0.15');
    expect(await priceOf('seed_prod1')).toBe('11.62');
    expect(await priceOf('seed_prod2')).toBe('20.00');
    expect(await priceOf('seed_prod_draft')).toBe('299.99');
    expect(await prisma.auditLog.count({ where: { entity: 'Tax', entityId: vatId, action: 'CREATE' } })).toBe(1);
  });

  it('updateTax reprices taxable products at the new rate', async () => {
    const res = await admin(`mutation { updateTax(id: "${vatId}", input: { rate: "0.2" }) { rate } }`);

    expect(res.body.errors).toBeUndefined();
    expect(await priceOf('seed_prod1')).toBe('12.12');
    expect(await priceOf('seed_prod2')).toBe('20.00');
  });

  it('deleteTax reprices taxable products from the remaining active taxes', async () => {
    const levy = await admin(`mutation { createTax(input: { name: "NHIL", rate: "0.025" }) { id } }`);
    expect(levy.body.errors).toBeUndefined();
    expect(await priceOf('seed_prod1')).toBe('12.37');

    const res = await admin(`mutation { deleteTax(id: "${vatId}") { id } }`);

    expect(res.body.errors).toBeUndefined();
    expect(await priceOf('seed_prod1')).toBe('10.35');
    expect(await priceOf('seed_prod2')).toBe('20.00');
  });

  it('a reprice that fails rolls back the tax change and its audit entry', async () => {
    // basePrice × 1.05 overflows the Decimal(14, 2) price column, so the reprice UPDATE fails in Postgres.
    await prisma.product.create({
      data: {
        id: 'tax_overflow',
        name: 'Overflow',
        isTaxable: true,
        categoryId: 'seed_cat',
        variants: { create: { sku: 'TAX-OVERFLOW', basePrice: '999999999999.99', price: '999999999999.99' } },
      },
    });
    const auditRowsBefore = await prisma.auditLog.count({ where: { entity: 'Tax' } });

    const res = await gqlRequest(
      app,
      `mutation { createTax(input: { name: "GETFund", rate: "0.025" }) { id } }`,
      undefined,
      adminToken,
    );

    expect(res.body.errors).toBeDefined();
    expect(await prisma.tax.count({ where: { name: 'GETFund' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: 'Tax' } })).toBe(auditRowsBefore);
    expect(await priceOf('seed_prod1')).toBe('10.35');
    await prisma.product.delete({ where: { id: 'tax_overflow' } });
  });

  it('updateProduct without isTaxable keeps the product taxed at the current rate', async () => {
    const res = await admin(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop Renamed" }) { name } }`,
    );

    expect(res.body.errors).toBeUndefined();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } });
    expect(product.isTaxable).toBe(true);
    expect(await priceOf('seed_prod1')).toBe('10.35');
  });

  it('updateVariant with a new basePrice prices it the same way the tax reprice does', async () => {
    const res = await admin(
      `mutation { updateVariant(input: { id: "seed_var1", basePrice: "1.40" }) { price { amount currency } } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(await priceOf('seed_prod1')).toBe('1.44');
    expect(res.body.data.updateVariant.price).toEqual({ amount: '1.44', currency: 'GHS' });
  });
});
