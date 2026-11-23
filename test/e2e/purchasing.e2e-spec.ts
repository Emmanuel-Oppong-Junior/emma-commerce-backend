import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { SerialUnitsRepository } from '../../src/inventory/serials/serial-units.repository';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';

type Body = {
  data?: Record<string, any>;
  errors?: { message: string; path?: string[]; extensions?: { code?: string; reason?: string } }[];
};

const PO_FIELDS =
  'id reference status locationId supplierId sentAt totalCost { amount } receivedCost { amount } ' +
  'lines { variantId quantityOrdered quantityReceived quantityOutstanding unitCost lineCost { amount } } ' +
  'receipts { id lines { variantId quantity unitCost lotId movementId } cost { amount } }';

// P4-E.1 on real Postgres: suppliers, purchase orders through their status machine, deliveries received into stock
// (lots and serials included) with RECEIPT movements, and the weighted-average cost with its history, hidden from
// staff without inventory.cost.view.
describe('Purchasing (P4-E.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken: string;
  let clerkToken: string;
  let supportToken: string;
  let mainId: string;
  let branchId: string;
  let supplierId: string;
  let seq = 0;

  const gql = async (query: string, token = managerToken, variables?: Record<string, unknown>): Promise<Body> =>
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

  const newVariant = async (tracking: { trackLots?: boolean; trackSerials?: boolean } = {}): Promise<string> => {
    seq += 1;
    const id = `po_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `po_prod_${seq}`,
        name: `Purchased item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        ...tracking,
        variants: { create: { id, sku: `PO-${seq}`, price: 20, basePrice: 20, lowStockThreshold: 0 } },
      },
    });
    return id;
  };

  const createSupplier = (name: string, token = managerToken) =>
    gql(
      'mutation($input: CreateSupplierInput!) { createSupplier(input: $input) { id name isActive currency } }',
      token,
      {
        input: { name, contactName: 'Ama', phone: '+233200000001', email: 'orders@supplier.test' },
      },
    );

  const createPo = async (
    lines: [string, number, string][],
    options: { token?: string; locationId?: string; supplier?: string } = {},
  ) =>
    gql(
      `mutation($input: CreatePurchaseOrderInput!) { createPurchaseOrder(input: $input) { ${PO_FIELDS} } }`,
      options.token ?? managerToken,
      {
        input: {
          supplierId: options.supplier ?? supplierId,
          locationId: options.locationId ?? branchId,
          lines: lines.map(([variantId, quantity, unitCost]) => ({ variantId, quantity, unitCost })),
        },
      },
    );
  const send = (id: string, token = managerToken) =>
    gql(`mutation { sendPurchaseOrder(id: "${id}") { ${PO_FIELDS} } }`, token);
  const receive = (id: string, lines: Record<string, unknown>[], token = clerkToken) =>
    gql(
      'mutation($id: ID!, $input: ReceivePurchaseOrderInput!) { receivePurchaseOrder(id: $id, input: $input) ' +
        '{ id reference status lines { variantId quantityReceived quantityOutstanding } receipts { id lines { variantId quantity lotId } } } }',
      token,
      { id, input: { lines } },
    );
  const sentPo = async (lines: [string, number, string][], locationId?: string): Promise<string> => {
    const created = await createPo(lines, { locationId });
    expect(created.errors).toBeUndefined();
    const id = created.data!.createPurchaseOrder.id as string;
    expect((await send(id)).errors).toBeUndefined();
    return id;
  };

  const levelAt = async (variantId: string, locationId: string) =>
    (await prisma.stockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
      select: { onHand: true, reserved: true },
    })) ?? { onHand: 0, reserved: 0 };
  const costOf = async (variantId: string) =>
    (await prisma.variant.findUniqueOrThrow({ where: { id: variantId } })).costPrice?.toFixed(4) ?? null;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    managerToken = await signInAdmin(app);
    clerkToken = await staffMember('clerk-purchasing@test.local', 'INVENTORY_CLERK');
    supportToken = await staffMember('support-purchasing@test.local', 'SUPPORT');
    mainId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    const branch = await gql('mutation { createStockLocation(input: { name: "Tema warehouse" }) { id } }');
    branchId = branch.data!.createStockLocation.id as string;
    const supplier = await createSupplier('Accra Wholesale Ltd');
    supplierId = supplier.data!.createSupplier.id as string;
  });

  afterAll(() => app.close());

  describe('suppliers', () => {
    it('creates suppliers with unique names ignoring case, searches and filters them', async () => {
      const created = await createSupplier('Kumasi Traders');
      const duplicate = await createSupplier('  kumasi   TRADERS ');
      const search = await gql('{ suppliers(search: "kumasi") { totalCount nodes { name } } }');
      const one = await gql(`{ supplier(id: "${created.data!.createSupplier.id}") { name email currency } }`);

      expect(created.data!.createSupplier).toMatchObject({ name: 'Kumasi Traders', isActive: true, currency: 'GHS' });
      expect(codeOf(duplicate)).toBe('CONFLICT');
      expect(search.data!.suppliers).toEqual({ totalCount: 1, nodes: [{ name: 'Kumasi Traders' }] });
      expect(one.data!.supplier).toEqual({ name: 'Kumasi Traders', email: 'orders@supplier.test', currency: 'GHS' });
    });

    it('refuses a currency other than the store currency', async () => {
      const body = await gql('mutation { createSupplier(input: { name: "Lagos Imports", currency: NGN }) { id } }');

      expect(codeOf(body)).toBe('BAD_REQUEST');
    });

    it('deletes an unused supplier but only deactivates one a purchase order refers to', async () => {
      const unused = (await createSupplier('Unused Co')).data!.createSupplier.id as string;
      const used = (await createSupplier('Used Co')).data!.createSupplier.id as string;
      await createPo([[await newVariant(), 1, '1.00']], { supplier: used });

      const deleted = await gql(`mutation { deleteSupplier(id: "${unused}") { id } }`);
      const refused = await gql(`mutation { deleteSupplier(id: "${used}") { id } }`);
      const deactivated = await gql(
        `mutation { updateSupplier(id: "${used}", input: { isActive: false, notes: "Stopped trading" }) { isActive notes } }`,
      );
      const inactiveOnly = await gql('{ suppliers(isActive: false) { nodes { name } } }');
      const newPoForInactive = await createPo([[await newVariant(), 1, '1.00']], { supplier: used });

      expect(deleted.errors).toBeUndefined();
      expect(await prisma.auditLog.count({ where: { entity: 'Supplier', entityId: unused, action: 'DELETE' } })).toBe(
        1,
      );
      expect(codeOf(refused)).toBe('CONFLICT');
      expect(deactivated.data!.updateSupplier).toEqual({ isActive: false, notes: 'Stopped trading' });
      expect(inactiveOnly.data!.suppliers.nodes).toEqual([{ name: 'Used Co' }]);
      expect(codeOf(newPoForInactive)).toBe('BAD_REQUEST');
      const audits = await prisma.auditLog.findMany({ where: { entity: 'Supplier', entityId: used } });
      expect(audits.map((a) => a.action).sort()).toEqual(['CREATE', 'UPDATE']);
    });
  });

  describe('purchase orders', () => {
    it('edits a draft, then freezes its lines once sent', async () => {
      const [a, b] = [await newVariant(), await newVariant()];
      const created = await createPo([[a, 5, '2.50']]);
      const id = created.data!.createPurchaseOrder.id as string;

      const edited = await gql(
        `mutation($input: UpdatePurchaseOrderInput!) { updatePurchaseOrder(id: "${id}", input: $input) { ${PO_FIELDS} } }`,
        managerToken,
        {
          input: {
            lines: [
              { variantId: a, quantity: 6, unitCost: '2.5' },
              { variantId: b, quantity: 2, unitCost: '10.1234' },
            ],
          },
        },
      );
      const sent = await send(id);
      const frozen = await gql(
        `mutation { updatePurchaseOrder(id: "${id}", input: { lines: [{ variantId: "${a}", quantity: 1, unitCost: "1" }] }) { id } }`,
      );
      const noteAfterSend = await gql(
        `mutation { updatePurchaseOrder(id: "${id}", input: { note: "Truck on Monday" }) { note } }`,
      );
      const sentTwice = await send(id);

      expect(created.data!.createPurchaseOrder).toMatchObject({
        status: 'DRAFT',
        reference: expect.stringMatching(/^PO-\d{5,}$/),
      });
      expect(edited.data!.updatePurchaseOrder.lines).toEqual([
        {
          variantId: a,
          quantityOrdered: 6,
          quantityReceived: 0,
          quantityOutstanding: 6,
          unitCost: '2.5',
          lineCost: { amount: '15.00' },
        },
        {
          variantId: b,
          quantityOrdered: 2,
          quantityReceived: 0,
          quantityOutstanding: 2,
          unitCost: '10.1234',
          lineCost: { amount: '20.25' },
        },
      ]);
      expect(edited.data!.updatePurchaseOrder.totalCost).toEqual({ amount: '35.25' });
      expect(sent.data!.sendPurchaseOrder).toMatchObject({ status: 'SENT', sentAt: expect.any(String) });
      expect(codeOf(frozen)).toBe('CONFLICT');
      expect(noteAfterSend.data!.updatePurchaseOrder).toEqual({ note: 'Truck on Monday' });
      expect(codeOf(sentTwice)).toBe('CONFLICT');
      const audits = await prisma.auditLog.findMany({
        where: { entity: 'PurchaseOrder', entityId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((a) => a.action)).toEqual(['CREATE', 'UPDATE', 'STATUS_CHANGE', 'UPDATE']);
      expect(audits[1].details).toMatchObject({
        lines: { from: [{ variantId: a, quantity: 5, unitCost: '2.5000' }], to: expect.any(Array) },
      });
    });

    it('receives a partial delivery then the rest, into the order location through the ledger', async () => {
      const [a, b] = [await newVariant(), await newVariant()];
      const id = await sentPo([
        [a, 10, '3.00'],
        [b, 4, '7.50'],
      ]);

      const first = await receive(id, [{ variantId: a, quantity: 6 }]);
      const firstLevels = [await levelAt(a, branchId), await levelAt(a, mainId)];
      const second = await receive(id, [
        { variantId: a, quantity: 4 },
        { variantId: b, quantity: 4 },
      ]);
      const afterFull = await receive(id, [{ variantId: a, quantity: 1 }]);

      expect(first.data!.receivePurchaseOrder).toMatchObject({
        status: 'PARTIALLY_RECEIVED',
        lines: [
          { variantId: a, quantityReceived: 6, quantityOutstanding: 4 },
          { variantId: b, quantityReceived: 0, quantityOutstanding: 4 },
        ],
      });
      expect(firstLevels).toEqual([
        { onHand: 6, reserved: 0 },
        { onHand: 0, reserved: 0 },
      ]);
      expect(second.data!.receivePurchaseOrder.status).toBe('RECEIVED');
      expect(second.data!.receivePurchaseOrder.receipts).toHaveLength(2);
      expect(await levelAt(a, branchId)).toEqual({ onHand: 10, reserved: 0 });
      expect(await levelAt(b, branchId)).toEqual({ onHand: 4, reserved: 0 });
      expect(codeOf(afterFull)).toBe('CONFLICT');
      const movements = await prisma.stockMovement.findMany({
        where: { refType: 'PurchaseOrder', refId: id },
        orderBy: [{ createdAt: 'asc' }, { variantId: 'asc' }],
        select: { variantId: true, locationId: true, onHandDelta: true, reason: true, unitCost: true },
      });
      expect(movements.map((m) => ({ ...m, unitCost: m.unitCost?.toFixed(2) }))).toEqual([
        { variantId: a, locationId: branchId, onHandDelta: 6, reason: 'RECEIPT', unitCost: '3.00' },
        { variantId: a, locationId: branchId, onHandDelta: 4, reason: 'RECEIPT', unitCost: '3.00' },
        { variantId: b, locationId: branchId, onHandDelta: 4, reason: 'RECEIPT', unitCost: '7.50' },
      ]);
      const view = await gql(`{ purchaseOrder(id: "${id}") { receivedCost { amount } receipts { cost { amount } } } }`);
      expect(view.data!.purchaseOrder).toEqual({
        receivedCost: { amount: '60.00' },
        receipts: [{ cost: { amount: '18.00' } }, { cost: { amount: '42.00' } }],
      });
      const audits = await prisma.auditLog.findMany({
        where: { entity: 'PurchaseOrder', entityId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((a) => [a.action, (a.details as { to?: string }).to ?? null])).toEqual([
        ['CREATE', null],
        ['STATUS_CHANGE', 'SENT'],
        ['STATUS_CHANGE', 'PARTIALLY_RECEIVED'],
        ['STATUS_CHANGE', 'RECEIVED'],
      ]);
      expect(audits[2].details).toMatchObject({ lines: [{ variantId: a, quantity: 6, unitCost: '3.0000' }] });
    });

    it('refuses over-receipt and units of a variant not ordered', async () => {
      const a = await newVariant();
      const id = await sentPo([[a, 3, '1.00']]);

      const over = await receive(id, [{ variantId: a, quantity: 4 }]);
      const stranger = await receive(id, [{ variantId: await newVariant(), quantity: 1 }]);
      const draft = (await createPo([[a, 1, '1.00']])).data!.createPurchaseOrder.id as string;
      const fromDraft = await receive(draft, [{ variantId: a, quantity: 1 }]);

      expect(codeOf(over)).toBe('BAD_REQUEST');
      expect(codeOf(stranger)).toBe('BAD_REQUEST');
      expect(codeOf(fromDraft)).toBe('CONFLICT');
      expect(await levelAt(a, branchId)).toEqual({ onHand: 0, reserved: 0 });
    });

    it('never lets two concurrent receipts take a line past what was ordered', async () => {
      const a = await newVariant();
      const id = await sentPo([[a, 5, '2.00']]);

      const results = await Promise.all([
        receive(id, [{ variantId: a, quantity: 3 }]),
        receive(id, [{ variantId: a, quantity: 3 }]),
      ]);

      expect(results.map(codeOf).sort()).toEqual(['BAD_REQUEST', undefined].sort());
      expect(await levelAt(a, branchId)).toEqual({ onHand: 3, reserved: 0 });
      const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: id } });
      expect(line.quantityReceived).toBe(3);
    });

    it('cancels before anything arrived, and closes short after a partial delivery', async () => {
      const a = await newVariant();
      const draft = (await createPo([[a, 2, '1.00']])).data!.createPurchaseOrder.id as string;
      const sent = await sentPo([[a, 2, '1.00']]);
      const partial = await sentPo([[a, 5, '1.00']]);
      await receive(partial, [{ variantId: a, quantity: 2 }]);

      const cancelledDraft = await gql(
        `mutation { cancelPurchaseOrder(id: "${draft}", input: { reason: "Duplicate" }) { status cancelReason } }`,
      );
      const cancelledSent = await gql(`mutation { cancelPurchaseOrder(id: "${sent}") { status } }`);
      const cancelPartial = await gql(`mutation { cancelPurchaseOrder(id: "${partial}") { status } }`);
      const closeCancelled = await gql(
        `mutation { closePurchaseOrder(id: "${sent}", input: { reason: "Late" }) { status } }`,
      );
      const closed = await gql(
        `mutation { closePurchaseOrder(id: "${partial}", input: { reason: "Supplier out of stock" }) { status closeReason lines { quantityOutstanding } } }`,
      );
      const receiveClosed = await receive(partial, [{ variantId: a, quantity: 1 }]);

      expect(cancelledDraft.data!.cancelPurchaseOrder).toEqual({ status: 'CANCELLED', cancelReason: 'Duplicate' });
      expect(cancelledSent.data!.cancelPurchaseOrder).toEqual({ status: 'CANCELLED' });
      expect(codeOf(cancelPartial)).toBe('CONFLICT');
      expect(codeOf(closeCancelled)).toBe('CONFLICT');
      expect(closed.data!.closePurchaseOrder).toEqual({
        status: 'CLOSED',
        closeReason: 'Supplier out of stock',
        lines: [{ quantityOutstanding: 3 }],
      });
      expect(codeOf(receiveClosed)).toBe('CONFLICT');
      const statusAudits = await prisma.auditLog.findMany({
        where: { entity: 'PurchaseOrder', entityId: { in: [draft, partial] }, action: 'STATUS_CHANGE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(statusAudits.map((a) => a.details)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'DRAFT', to: 'CANCELLED', reason: 'Duplicate' }),
          expect.objectContaining({
            from: 'PARTIALLY_RECEIVED',
            to: 'CLOSED',
            reason: 'Supplier out of stock',
            shortfall: [{ variantId: a, outstanding: 3 }],
          }),
        ]),
      );
      expect(await levelAt(a, branchId)).toEqual({ onHand: 2, reserved: 0 });
    });

    it('receives a lot-tracked line into the lot named, and requires the lot', async () => {
      const a = await newVariant({ trackLots: true });
      const id = await sentPo([[a, 5, '4.00']]);
      const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

      const noLot = await receive(id, [{ variantId: a, quantity: 2 }]);
      const received = await receive(id, [{ variantId: a, quantity: 2, lot: { lotNumber: 'B-77', expiresAt } }]);
      const untracked = await newVariant();
      const untrackedWithLot = await receive(await sentPo([[untracked, 1, '1.00']]), [
        { variantId: untracked, quantity: 1, lot: { lotNumber: 'X', expiresAt } },
      ]);

      expect(codeOf(noLot)).toBe('BAD_REQUEST');
      expect(codeOf(untrackedWithLot)).toBe('BAD_REQUEST');
      const lot = await prisma.lot.findUniqueOrThrow({
        where: { variantId_lotNumber: { variantId: a, lotNumber: 'B-77' } },
      });
      expect(received.data!.receivePurchaseOrder.receipts[0].lines).toEqual([
        { variantId: a, quantity: 2, lotId: lot.id },
      ]);
      const lotStock = await prisma.lotStock.findFirstOrThrow({ where: { lotId: lot.id, locationId: branchId } });
      expect(lotStock.onHand).toBe(2);
      const movement = await prisma.stockMovement.findFirstOrThrow({ where: { refType: 'PurchaseOrder', refId: id } });
      expect(movement).toMatchObject({ lotId: lot.id, reason: 'RECEIPT' });
    });

    it('receives a serial-tracked line under new serials, and requires one per unit', async () => {
      const a = await newVariant({ trackSerials: true });
      const id = await sentPo([[a, 3, '150.00']]);

      const missing = await receive(id, [{ variantId: a, quantity: 2 }]);
      const miscounted = await receive(id, [{ variantId: a, quantity: 2, serials: ['SN-1'] }]);
      const received = await receive(id, [{ variantId: a, quantity: 2, serials: ['SN-1', 'SN-2'] }]);
      const known = await receive(id, [{ variantId: a, quantity: 1, serials: ['SN-2'] }]);

      expect(codeOf(missing)).toBe('BAD_REQUEST');
      expect(codeOf(miscounted)).toBe('BAD_REQUEST');
      expect(received.data!.receivePurchaseOrder.status).toBe('PARTIALLY_RECEIVED');
      expect(codeOf(known)).toBe('CONFLICT');
      const units = await prisma.serialUnit.findMany({ where: { variantId: a }, orderBy: { serial: 'asc' } });
      expect(units.map((u) => [u.serial, u.status, u.locationId])).toEqual([
        ['SN-1', 'IN_STOCK', branchId],
        ['SN-2', 'IN_STOCK', branchId],
      ]);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entity: 'PurchaseOrder',
          entityId: id,
          action: 'STATUS_CHANGE',
          details: { path: ['to'], equals: 'PARTIALLY_RECEIVED' },
        },
      });
      expect(audit.details).toMatchObject({ lines: [{ variantId: a, quantity: 2, serialCount: 2 }] });
    });

    it('lists purchase orders newest first with filters', async () => {
      const a = await newVariant();
      const first = (await createPo([[a, 1, '1.00']])).data!.createPurchaseOrder.id as string;
      const second = await sentPo([[a, 1, '1.00']]);

      const byVariant = await gql(`{ purchaseOrders(variantId: "${a}") { totalCount nodes { id } } }`);
      const sentOnly = await gql(`{ purchaseOrders(variantId: "${a}", status: SENT) { nodes { id } } }`);
      const bySupplierPage = await gql(
        `{ purchaseOrders(supplierId: "${supplierId}", locationId: "${branchId}", first: 1) { hasNextPage nodes { supplier { name } } } }`,
      );
      const future = await gql(
        `{ purchaseOrders(variantId: "${a}", createdFrom: "${new Date(Date.now() + 3600_000).toISOString()}") { totalCount } }`,
      );

      expect(byVariant.data!.purchaseOrders).toEqual({ totalCount: 2, nodes: [{ id: second }, { id: first }] });
      expect(sentOnly.data!.purchaseOrders.nodes).toEqual([{ id: second }]);
      expect(bySupplierPage.data!.purchaseOrders).toEqual({
        hasNextPage: true,
        nodes: [{ supplier: { name: 'Accra Wholesale Ltd' } }],
      });
      expect(future.data!.purchaseOrders.totalCount).toBe(0);
    });
  });

  describe('weighted-average cost', () => {
    it('sets the cost from the first receipt and averages the next by units on hand, with history', async () => {
      const a = await newVariant();
      const firstPo = await sentPo([[a, 3, '1.00']]);
      const secondPo = await sentPo([[a, 4, '2.3333']]);

      await receive(firstPo, [{ variantId: a, quantity: 3 }]);
      const afterFirst = await costOf(a);
      await receive(secondPo, [{ variantId: a, quantity: 4 }]);

      // (3 × 1.0000 + 4 × 2.3333) / 7 = 1.76188... -> 1.7619
      expect(afterFirst).toBe('1.0000');
      expect(await costOf(a)).toBe('1.7619');
      const history = await gql(
        `{ variantCostHistory(variantId: "${a}") { totalCount nodes { oldValue newValue source refType currency } } }`,
      );
      expect(history.data!.variantCostHistory).toEqual({
        totalCount: 2,
        nodes: [
          {
            oldValue: '1',
            newValue: '1.7619',
            source: 'PURCHASE_ORDER',
            refType: 'PurchaseOrderReceipt',
            currency: 'GHS',
          },
          { oldValue: null, newValue: '1', source: 'PURCHASE_ORDER', refType: 'PurchaseOrderReceipt', currency: 'GHS' },
        ],
      });
      const variant = await gql(`{ variant(variantId: "${a}") { costPrice } }`);
      expect(variant.data!.variant).toEqual({ costPrice: '1.7619' });
    });

    it('counts stock at every location but leaves cost alone on other stock-adding paths', async () => {
      const a = await newVariant();
      await gql(
        `mutation { restockVariant(input: { variantId: "${a}", quantity: 6, locationId: "${mainId}" }) { id } }`,
      );
      const first = await sentPo([[a, 2, '5.00']]);
      await receive(first, [{ variantId: a, quantity: 2 }]);
      const afterUnknownStock = await costOf(a);
      await gql(`mutation { restockVariant(input: { variantId: "${a}", quantity: 2 }) { id } }`);
      const afterRestock = await costOf(a);
      const second = await sentPo([[a, 10, '8.00']]);
      await receive(second, [{ variantId: a, quantity: 10 }]);

      // Old cost unknown: the receipt sets it. Then (10 on hand × 5 + 10 × 8) / 20 = 6.5
      expect(afterUnknownStock).toBe('5.0000');
      expect(afterRestock).toBe('5.0000');
      expect(await costOf(a)).toBe('6.5000');
    });

    it('sets a cost by hand, also correcting one purchase orders set, and later receipts average from it', async () => {
      const fresh = await newVariant();
      const bought = await newVariant();
      await receive(await sentPo([[bought, 1, '3.00']]), [{ variantId: bought, quantity: 1 }]);
      const set = (variantId: string, cost: string, token = managerToken) =>
        gql(
          `mutation { setVariantCost(input: { variantId: "${variantId}", cost: "${cost}", reason: "Old invoice" }) { oldValue newValue source reason } }`,
          token,
        );

      const manual = await set(fresh, '4.2');
      const corrected = await set(bought, '2.50');
      const tooPrecise = await set(fresh, '1.00001');
      const byClerk = await set(fresh, '5', clerkToken);

      expect(manual.data!.setVariantCost).toEqual({
        oldValue: null,
        newValue: '4.2',
        source: 'MANUAL',
        reason: 'Old invoice',
      });
      expect(await costOf(fresh)).toBe('4.2000');
      expect(corrected.data!.setVariantCost).toMatchObject({ oldValue: '3', newValue: '2.5', source: 'MANUAL' });
      await receive(await sentPo([[bought, 1, '4.50']]), [{ variantId: bought, quantity: 1 }]);
      // (1 on hand × 2.50 + 1 × 4.50) / 2 = 3.5
      expect(await costOf(bought)).toBe('3.5000');
      expect(codeOf(tooPrecise)).toBe('BAD_USER_INPUT');
      expect(codeOf(byClerk)).toBe('FORBIDDEN');
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Variant', entityId: fresh } });
      expect(audit.details).toMatchObject({ costPrice: { from: null, to: '4.2000' }, reason: 'Old invoice' });
    });

    it('keeps cost history append-only', async () => {
      const [row] = await prisma.costChange.findMany({ take: 1 });

      await expect(prisma.costChange.update({ where: { id: row.id }, data: { reason: 'x' } })).rejects.toThrow(
        /append-only/,
      );
      await expect(prisma.costChange.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    });
  });

  describe('cost visibility and permissions', () => {
    it('lets a clerk read and receive purchase orders but hides every cost from them', async () => {
      const a = await newVariant();
      const id = await sentPo([[a, 2, '6.00']]);

      const withoutCosts = await gql(
        `{ purchaseOrder(id: "${id}") { reference lines { variantId quantityOrdered } } }`,
        clerkToken,
      );
      const withCosts = await gql(
        `{ purchaseOrder(id: "${id}") { lines { quantityOrdered unitCost } totalCost { amount } } }`,
        clerkToken,
      );
      const received = await receive(id, [{ variantId: a, quantity: 2 }], clerkToken);
      const variantCost = await gql(`{ variant(variantId: "${a}") { id costPrice } }`, clerkToken);
      const history = await gql(`{ variantCostHistory(variantId: "${a}") { totalCount } }`, clerkToken);
      const movementCost = await gql(`{ stockMovements(variantId: "${a}") { nodes { reason unitCost } } }`, clerkToken);

      expect(withoutCosts.errors).toBeUndefined();
      expect(withoutCosts.data!.purchaseOrder.lines).toEqual([{ variantId: a, quantityOrdered: 2 }]);
      expect(withCosts.data!.purchaseOrder).toEqual({
        lines: [{ quantityOrdered: 2, unitCost: null }],
        totalCost: null,
      });
      expect(new Set(withCosts.errors!.map((e) => e.extensions?.code))).toEqual(new Set(['FORBIDDEN']));
      expect(received.data!.receivePurchaseOrder.status).toBe('RECEIVED');
      expect(variantCost.data!.variant).toEqual({ id: a, costPrice: null });
      expect(codeOf(variantCost)).toBe('FORBIDDEN');
      expect(codeOf(history)).toBe('FORBIDDEN');
      expect(movementCost.data!.stockMovements.nodes).toEqual([{ reason: 'RECEIPT', unitCost: null }]);
    });

    it('shows cost values in the expiring-stock report to managers only', async () => {
      const a = await newVariant({ trackLots: true });
      const id = await sentPo([[a, 3, '2.50']]);
      const expiresAt = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
      await receive(id, [{ variantId: a, quantity: 3, lot: { lotNumber: 'EXP-1', expiresAt } }]);
      const query = `{ expiringStock(withinDays: 10) { variantId unitCost costValue { amount } value { amount } } }`;

      const asManager = await gql(query);
      const asClerk = await gql(query, clerkToken);

      expect(asManager.data!.expiringStock.find((l: { variantId: string }) => l.variantId === a)).toEqual({
        variantId: a,
        unitCost: '2.5',
        costValue: { amount: '7.50' },
        value: { amount: '60.00' },
      });
      expect(asClerk.data!.expiringStock.find((l: { variantId: string }) => l.variantId === a)).toEqual({
        variantId: a,
        unitCost: null,
        costValue: null,
        value: { amount: '60.00' },
      });
    });

    it('refuses staff without the purchasing permissions', async () => {
      const a = await newVariant();
      const id = await sentPo([[a, 1, '1.00']]);

      const results = await Promise.all([
        createPo([[a, 1, '1.00']], { token: clerkToken }),
        send(id, clerkToken),
        createSupplier('Clerk Co', clerkToken),
        gql('{ purchaseOrders { totalCount } }', supportToken),
        gql('{ suppliers { totalCount } }', supportToken),
        receive(id, [{ variantId: a, quantity: 1 }], supportToken),
      ]);

      expect(results.map(codeOf)).toEqual([
        'FORBIDDEN',
        'FORBIDDEN',
        'FORBIDDEN',
        'FORBIDDEN',
        'FORBIDDEN',
        'FORBIDDEN',
      ]);
    });
  });

  it('cannot delete a location a purchase order refers to', async () => {
    const popUp = (await gql('mutation { createStockLocation(input: { name: "Pop-up" }) { id } }')).data!
      .createStockLocation.id as string;
    await createPo([[await newVariant(), 1, '1.00']], { locationId: popUp });

    expect(codeOf(await gql(`mutation { deleteStockLocation(id: "${popUp}") { id } }`))).toBe('CONFLICT');
  });

  it('leaves every stock level reconciled with its ledger', async () => {
    const task = new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
      app.get(SerialUnitsRepository),
    );

    await expect(task.reconcile()).resolves.toEqual([]);
  });
});
