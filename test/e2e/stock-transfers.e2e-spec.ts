import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';

type Body = { data?: Record<string, any>; errors?: { message: string; extensions?: { code?: string } }[] };

const TRANSFER_FIELDS =
  'id status fromLocationId toLocationId dispatchedAt receivedAt lines { variantId quantity receivedQuantity variance varianceNote }';

// P4-A.2 on real Postgres: stock moves between locations in two audited steps, dispatch then receipt, each claimed
// once; in transit it is at neither location; a shortfall is a recorded variance.
describe('Stock transfers (P4-A.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let clerkToken: string;
  let supportToken: string;
  let mainId: string;
  let branchId: string;
  let seq = 0;

  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>): Promise<Body> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body as Body;
  const codeOf = (body: Body) => body.errors?.[0]?.extensions?.code;

  const staffMember = async (email: string, roleKey: string): Promise<string> => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: email.split('@')[0] });
    const [user, store, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email } }),
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return accessToken;
  };

  const newVariant = async (stock: Record<string, number>): Promise<string> => {
    seq += 1;
    const id = `xfer_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `xfer_prod_${seq}`,
        name: `Transfer item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `XFER-${seq}`, price: 10, basePrice: 10, lowStockThreshold: 0 } },
      },
    });
    for (const [locationId, quantity] of Object.entries(stock)) {
      const body = await gql(
        `mutation { restockVariant(input: { variantId: "${id}", quantity: ${quantity}, locationId: "${locationId}" }) { id } }`,
      );
      expect(body.errors).toBeUndefined();
    }
    return id;
  };

  const create = async (lines: [string, number][], token = clerkToken, from = mainId, to = branchId) =>
    gql(
      `mutation($input: CreateStockTransferInput!) { createStockTransfer(input: $input) { ${TRANSFER_FIELDS} } }`,
      token,
      {
        input: {
          fromLocationId: from,
          toLocationId: to,
          lines: lines.map(([variantId, quantity]) => ({ variantId, quantity })),
        },
      },
    );
  const dispatch = (id: string, token = clerkToken) =>
    gql(`mutation { dispatchStockTransfer(id: "${id}") { ${TRANSFER_FIELDS} } }`, token);
  const receive = (id: string, lines?: { variantId: string; receivedQuantity: number; note?: string }[]) =>
    gql(
      `mutation($input: ReceiveStockTransferInput) { receiveStockTransfer(id: "${id}", input: $input) { ${TRANSFER_FIELDS} } }`,
      clerkToken,
      { input: lines ? { lines } : null },
    );

  const levelAt = async (variantId: string, locationId: string) => {
    const level = await prisma.stockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
      select: { onHand: true, reserved: true },
    });
    return level ?? { onHand: 0, reserved: 0 };
  };
  const inTransit = async (variantId: string) => {
    const body = await gql(`{ stockInTransit(variantIds: ["${variantId}"]) { variantId quantity } }`);
    return body.data!.stockInTransit as { variantId: string; quantity: number }[];
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    clerkToken = await staffMember('clerk-transfers@test.local', 'INVENTORY_CLERK');
    supportToken = await staffMember('support-transfers@test.local', 'SUPPORT');
    mainId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    const created = await gql(
      'mutation { createStockLocation(input: { name: "Kumasi branch", type: BRANCH }) { id } }',
    );
    branchId = created.data!.createStockLocation.id as string;
  });

  afterAll(() => app.close());

  it('dispatches from the source into transit and receives everything at the destination', async () => {
    const variantId = await newVariant({ [mainId]: 10 });

    const created = await create([[variantId, 4]]);
    const transferId = created.data!.createStockTransfer.id as string;
    const draftLevels = await levelAt(variantId, mainId);
    const dispatched = await dispatch(transferId);
    const whileInTransit = [await levelAt(variantId, mainId), await levelAt(variantId, branchId)];
    const transitBefore = await inTransit(variantId);
    const received = await receive(transferId);

    expect(created.data!.createStockTransfer).toMatchObject({ status: 'DRAFT', dispatchedAt: null });
    expect(draftLevels).toEqual({ onHand: 10, reserved: 0 });
    expect(dispatched.data!.dispatchStockTransfer).toMatchObject({ status: 'DISPATCHED' });
    expect(whileInTransit).toEqual([
      { onHand: 6, reserved: 0 },
      { onHand: 0, reserved: 0 },
    ]);
    expect(transitBefore).toEqual([{ variantId, quantity: 4 }]);
    expect(received.data!.receiveStockTransfer).toMatchObject({
      status: 'RECEIVED',
      lines: [{ variantId, quantity: 4, receivedQuantity: 4, variance: 0, varianceNote: null }],
    });
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 4, reserved: 0 });
    expect(await inTransit(variantId)).toEqual([]);
    const movements = await prisma.stockMovement.findMany({
      where: { variantId, refType: 'StockTransfer', refId: transferId },
      orderBy: { createdAt: 'asc' },
      select: { locationId: true, onHandDelta: true, reservedDelta: true, reason: true },
    });
    expect(movements).toEqual([
      { locationId: mainId, onHandDelta: -4, reservedDelta: 0, reason: 'TRANSFER' },
      { locationId: branchId, onHandDelta: 4, reservedDelta: 0, reason: 'TRANSFER' },
    ]);
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'StockTransfer', entityId: transferId },
      select: { action: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['CREATE', 'STATUS_CHANGE', 'STATUS_CHANGE']);
  });

  it('records a shortfall as a variance with its note, adding only what arrived', async () => {
    const shortVariant = await newVariant({ [mainId]: 10 });
    const fullVariant = await newVariant({ [mainId]: 10 });
    const created = await create([
      [shortVariant, 5],
      [fullVariant, 2],
    ]);
    const transferId = created.data!.createStockTransfer.id as string;
    await dispatch(transferId);

    const noNote = await receive(transferId, [{ variantId: shortVariant, receivedQuantity: 3 }]);
    const received = await receive(transferId, [{ variantId: shortVariant, receivedQuantity: 3, note: 'Two broken' }]);

    expect(codeOf(noNote)).toBe('BAD_REQUEST');
    expect(received.data!.receiveStockTransfer.status).toBe('PARTIALLY_RECEIVED');
    expect(received.data!.receiveStockTransfer.lines).toEqual(
      expect.arrayContaining([
        { variantId: shortVariant, quantity: 5, receivedQuantity: 3, variance: 2, varianceNote: 'Two broken' },
        { variantId: fullVariant, quantity: 2, receivedQuantity: 2, variance: 0, varianceNote: null },
      ]),
    );
    expect(await levelAt(shortVariant, mainId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await levelAt(shortVariant, branchId)).toEqual({ onHand: 3, reserved: 0 });
    expect(await inTransit(shortVariant)).toEqual([]);
  });

  it('lets one of two concurrent receipts win; the other gets CONFLICT and nothing is added twice', async () => {
    const variantId = await newVariant({ [mainId]: 6 });
    const transferId = (await create([[variantId, 3]])).data!.createStockTransfer.id as string;
    await dispatch(transferId);

    const results = await Promise.all([receive(transferId), receive(transferId)]);

    expect(results.map(codeOf).sort()).toEqual(['CONFLICT', undefined].sort());
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      await prisma.stockMovement.count({ where: { variantId, locationId: branchId, refType: 'StockTransfer' } }),
    ).toBe(1);
  });

  it('lets one of two concurrent dispatches win, and never dispatches units reserved for orders', async () => {
    const variantId = await newVariant({ [mainId]: 6 });
    const transferId = (await create([[variantId, 5]])).data!.createStockTransfer.id as string;
    await prisma.stockLevel.update({
      where: { variantId_locationId: { variantId, locationId: mainId } },
      data: { reserved: 1 },
    });
    await prisma.stockMovement.create({
      data: { variantId, locationId: mainId, onHandDelta: 0, reservedDelta: 1, reason: 'RESERVE', note: 'Fixture' },
    });

    const results = await Promise.all([dispatch(transferId), dispatch(transferId)]);
    const tooMuch = (await create([[variantId, 1]])).data!.createStockTransfer.id as string;
    const refused = await dispatch(tooMuch);
    await prisma.stockLevel.update({
      where: { variantId_locationId: { variantId, locationId: mainId } },
      data: { reserved: 0 },
    });
    await prisma.stockMovement.create({
      data: { variantId, locationId: mainId, onHandDelta: 0, reservedDelta: -1, reason: 'RELEASE', note: 'Fixture' },
    });

    expect(results.map(codeOf).sort()).toEqual(['CONFLICT', undefined].sort());
    expect(await levelAt(variantId, mainId)).toEqual({ onHand: 1, reserved: 0 });
    expect(codeOf(refused)).toBe('BAD_REQUEST');
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: tooMuch } })).status).toBe('DRAFT');
  });

  it('cancels a draft without moving stock, and refuses to cancel once dispatched', async () => {
    const variantId = await newVariant({ [mainId]: 5 });
    const draft = (await create([[variantId, 2]])).data!.createStockTransfer.id as string;
    const sent = (await create([[variantId, 2]])).data!.createStockTransfer.id as string;
    await dispatch(sent);

    const cancelled = await gql(
      `mutation { cancelStockTransfer(id: "${draft}", input: { reason: "Wrong branch" }) { status cancelledAt } }`,
      clerkToken,
    );
    const late = await gql(`mutation { cancelStockTransfer(id: "${sent}") { status } }`, clerkToken);
    const dispatchCancelled = await dispatch(draft);

    expect(cancelled.data!.cancelStockTransfer).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
    expect(codeOf(late)).toBe('CONFLICT');
    expect(codeOf(dispatchCancelled)).toBe('CONFLICT');
    expect(await levelAt(variantId, mainId)).toEqual({ onHand: 3, reserved: 0 });
  });

  it('refuses invalid drafts', async () => {
    const variantId = await newVariant({ [mainId]: 5 });
    const inactive = await gql('mutation { createStockLocation(input: { name: "Closed", isActive: false }) { id } }');

    const sameLocation = await create([[variantId, 1]], clerkToken, mainId, mainId);
    const toInactive = await create([[variantId, 1]], clerkToken, mainId, inactive.data!.createStockLocation.id);
    const unknownVariant = await create([['nope', 1]]);
    const zero = await create([[variantId, 0]]);

    expect([codeOf(sameLocation), codeOf(toInactive), codeOf(unknownVariant), codeOf(zero)]).toEqual([
      'BAD_REQUEST',
      'BAD_REQUEST',
      'NOT_FOUND',
      'BAD_USER_INPUT',
    ]);
  });

  it('refuses staff without inventory.transfer or inventory.view', async () => {
    const variantId = await newVariant({ [mainId]: 5 });
    const transferId = (await create([[variantId, 1]])).data!.createStockTransfer.id as string;

    const results = await Promise.all([
      create([[variantId, 1]], supportToken),
      dispatch(transferId, supportToken),
      gql(`mutation { cancelStockTransfer(id: "${transferId}") { id } }`, supportToken),
      gql('{ stockTransfers { totalCount } }', supportToken),
    ]);

    expect(results.map(codeOf)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
  });

  it('lists transfers newest first with filters', async () => {
    const variantId = await newVariant({ [mainId]: 5 });
    const first = (await create([[variantId, 1]])).data!.createStockTransfer.id as string;
    const second = (await create([[variantId, 2]])).data!.createStockTransfer.id as string;
    await dispatch(second);

    const byVariant = await gql(`{ stockTransfers(variantId: "${variantId}") { totalCount nodes { id } } }`);
    const dispatchedOnly = await gql(
      `{ stockTransfers(variantId: "${variantId}", status: DISPATCHED) { totalCount nodes { id } } }`,
    );
    const atBranch = await gql(`{ stockTransfers(locationId: "${branchId}", first: 1) { hasNextPage nodes { id } } }`);
    const one = await gql(`{ stockTransfer(id: "${first}") { id status } }`);

    expect(byVariant.data!.stockTransfers).toEqual({ totalCount: 2, nodes: [{ id: second }, { id: first }] });
    expect(dispatchedOnly.data!.stockTransfers).toEqual({ totalCount: 1, nodes: [{ id: second }] });
    expect(atBranch.data!.stockTransfers.hasNextPage).toBe(true);
    expect(one.data!.stockTransfer).toEqual({ id: first, status: 'DRAFT' });
  });

  it('cannot delete a location a transfer refers to', async () => {
    const fresh = await gql('mutation { createStockLocation(input: { name: "Pop-up" }) { id } }');
    const freshId = fresh.data!.createStockLocation.id as string;
    const variantId = await newVariant({ [mainId]: 1 });
    await create([[variantId, 1]], clerkToken, mainId, freshId);

    const deleted = await gql(`mutation { deleteStockLocation(id: "${freshId}") { id } }`);

    expect(codeOf(deleted)).toBe('CONFLICT');
  });

  it('leaves every stock level reconciled with its ledger', async () => {
    const task = new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
    );

    await expect(task.reconcile()).resolves.toEqual([]);
  });
});
