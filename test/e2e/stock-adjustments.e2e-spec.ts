import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, setStock, stockOf } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

const MOVEMENT_FIELDS = 'id variantId locationId onHandDelta reservedDelta reason adjustmentReason note actorId';

// P4-B.1 accept criteria: a manual adjustment is a signed delta with a reason from a fixed list, one ADJUSTMENT
// movement through the ledger, never below what is reserved, and audited.
describe('Stock adjustments with reasons (P4-B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let defaultLocationId: string;
  let seq = 0;

  const adjust = (input: string) =>
    gqlRequest(
      app,
      `mutation { adjustVariantStock(input: { ${input} }) { ${MOVEMENT_FIELDS} } }`,
      undefined,
      adminToken,
    )
      .expect(200)
      .then((res) => res.body);

  const newVariant = async (onHand: number): Promise<string> => {
    seq += 1;
    const id = `adj_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `adj_prod_${seq}`,
        name: `Adjusted item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `ADJ-${seq}`, price: 20, basePrice: 20, lowStockThreshold: 0 } },
      },
    });
    await setStock(prisma, id, onHand);
    return id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    defaultLocationId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
  });

  afterAll(() => app.close());

  it('records one ADJUSTMENT movement with its reason and note at the default location, and audits it', async () => {
    const variantId = await newVariant(10);
    const movementsBefore = await prisma.stockMovement.count({ where: { variantId } });

    const body = await adjust(`variantId: "${variantId}", delta: -3, reason: DAMAGED, note: "Crushed in transit"`);

    expect(body.errors).toBeUndefined();
    expect(body.data.adjustVariantStock).toMatchObject({
      variantId,
      locationId: defaultLocationId,
      onHandDelta: -3,
      reservedDelta: 0,
      reason: 'ADJUSTMENT',
      adjustmentReason: 'DAMAGED',
      note: 'Crushed in transit',
      actorId: 'seed_admin',
    });
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 7, reserved: 0, available: 7 });
    expect(await prisma.stockMovement.count({ where: { variantId } })).toBe(movementsBefore + 1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Variant', entityId: variantId, action: 'STOCK_ADJUSTMENT' },
    });
    expect(audit.userId).toBe('seed_admin');
    expect(audit.details).toMatchObject({
      stockMovementId: body.data.adjustVariantStock.id,
      kind: 'ADJUSTMENT',
      adjustmentReason: 'DAMAGED',
      onHandDelta: -3,
      locationId: defaultLocationId,
    });
  });

  it('adds found stock and takes the location given', async () => {
    const variantId = await newVariant(2);

    const body = await adjust(`variantId: "${variantId}", locationId: "${defaultLocationId}", delta: 4, reason: FOUND`);

    expect(body.errors).toBeUndefined();
    expect(body.data.adjustVariantStock).toMatchObject({ onHandDelta: 4, adjustmentReason: 'FOUND', note: null });
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 6 });
  });

  it('refuses a reason that does not fit the direction, STOCK_TAKE by hand, and OTHER without a note', async () => {
    const variantId = await newVariant(5);

    const cases: [string, string][] = [
      [`delta: 2, reason: EXPIRED`, 'EXPIRED can only remove stock: send a negative delta'],
      [`delta: -2, reason: FOUND`, 'FOUND can only add stock: send a positive delta'],
      [`delta: -1, reason: STOCK_TAKE`, 'STOCK_TAKE cannot be given by hand'],
      [`delta: -1, reason: OTHER, note: "  "`, 'A note is required when the reason is OTHER'],
    ];
    for (const [input, message] of cases) {
      const body = await adjust(`variantId: "${variantId}", ${input}`);
      expect(body.errors?.[0]).toMatchObject({ message, extensions: { code: 'BAD_REQUEST' } });
    }

    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 5 });
    expect(await prisma.stockMovement.count({ where: { variantId, reason: 'ADJUSTMENT' } })).toBe(0);
  });

  it('accepts OTHER with a note', async () => {
    const variantId = await newVariant(5);

    const body = await adjust(`variantId: "${variantId}", delta: -1, reason: OTHER, note: "Given to a charity"`);

    expect(body.errors).toBeUndefined();
    expect(body.data.adjustVariantStock).toMatchObject({ adjustmentReason: 'OTHER', note: 'Given to a charity' });
  });

  it('refuses to go below the units reserved and writes nothing', async () => {
    const variantId = await newVariant(3);
    await prisma.$executeRaw`UPDATE "StockLevel" SET "reserved" = 2 WHERE "variantId" = ${variantId}`;
    await prisma.stockMovement.create({
      data: { variantId, locationId: defaultLocationId, onHandDelta: 0, reservedDelta: 2, reason: 'RESERVE' },
    });
    const movementsBefore = await prisma.stockMovement.count({ where: { variantId } });

    const body = await adjust(`variantId: "${variantId}", delta: -2, reason: LOST`);

    expect(body.errors?.[0]).toMatchObject({
      message: `Cannot remove 2 units from variant "${variantId}": only 1 available`,
      extensions: { code: 'BAD_REQUEST' },
    });
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 3, reserved: 2, available: 1 });
    expect(await prisma.stockMovement.count({ where: { variantId } })).toBe(movementsBefore);
  });

  it('reports an unknown location as not found', async () => {
    const variantId = await newVariant(3);

    const body = await adjust(`variantId: "${variantId}", locationId: "nowhere", delta: -1, reason: LOST`);

    expect(body.errors?.[0]).toMatchObject({
      message: 'Stock location "nowhere" not found or inactive',
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('the database keeps adjustment reasons on adjustments and a note on OTHER', async () => {
    const variantId = await newVariant(3);
    const base = { variantId, locationId: defaultLocationId, onHandDelta: 0 };

    await expect(
      prisma.stockMovement.create({ data: { ...base, reason: 'RECEIPT', adjustmentReason: 'FOUND' } }),
    ).rejects.toThrow(/StockMovement_adjustment_reason_only_on_adjustments/);
    await expect(
      prisma.stockMovement.create({ data: { ...base, reason: 'ADJUSTMENT', adjustmentReason: 'OTHER' } }),
    ).rejects.toThrow(/StockMovement_other_adjustment_note/);
  });
});
