import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

describe('Partial updates leave omitted flags unchanged (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const admin = (query: string) => gqlRequest(app, query, undefined, adminToken).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('updateProduct with only a name keeps the product active, taxable and at its price', async () => {
    await prisma.product.update({ where: { id: 'seed_prod1' }, data: { isActive: true, isTaxable: true } });
    await prisma.variant.update({ where: { id: 'seed_var1' }, data: { basePrice: '100.00', price: '115.00' } });

    const res = await admin(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop Renamed" }) { name } }`,
    );

    expect(res.body.errors).toBeUndefined();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' } });
    expect(product).toMatchObject({ name: 'Laptop Renamed', isActive: true, isTaxable: true });
    const variant = await prisma.variant.findUniqueOrThrow({ where: { id: 'seed_var1' } });
    expect(variant.price?.toFixed(2)).toBe('115.00');
  });

  it('updateProduct still applies flags that are sent', async () => {
    const res = await admin(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { isActive: false }) { isActive } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateProduct.isActive).toBe(false);
  });

  it('updateDiscount with only a name keeps the discount active', async () => {
    const discount = await prisma.discount.create({
      data: {
        name: 'Ten off',
        type: 'PERCENTAGE',
        value: 10,
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 86_400_000),
        isActive: true,
      },
    });

    const res = await admin(
      `mutation { updateDiscount(updateDiscountInput: { id: "${discount.id}", name: "Ten percent off" }) { name } }`,
    );

    expect(res.body.errors).toBeUndefined();
    const updated = await prisma.discount.findUniqueOrThrow({ where: { id: discount.id } });
    expect(updated).toMatchObject({ name: 'Ten percent off', isActive: true });
  });
});
