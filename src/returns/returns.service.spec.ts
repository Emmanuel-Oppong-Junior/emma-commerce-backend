import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, ReturnReason, ReturnResolution, ReturnStatus } from '../generated/prisma/client';
import { ReturnsService } from './returns.service';
import { ReturnsRepository } from './returns.repository';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { CloudinaryService } from '../commons/cloudinary.service';
import { OutboxService } from '../outbox/outbox.service';
import { InventoryService } from '../inventory/inventory.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { StockLedgerRepository } from '../inventory/stock-ledger.repository';
import { StockLocationsService } from '../inventory/locations/stock-locations.service';
import { OrdersRepository } from '../order/order.repository';
import { RefundsService } from './refunds.service';
import { RefundRepository } from './refund.repository';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';

const at = new Date('2026-12-10T10:00:00Z');
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function returnLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line1',
    returnRequestId: 'rr1',
    orderItemId: 'oi1',
    quantity: 2,
    reason: ReturnReason.DAMAGED,
    note: null,
    photoPublicIds: [] as string[],
    exchangeVariantId: null as string | null,
    receivedQuantity: null as number | null,
    restockQuantity: null as number | null,
    writeOffQuantity: null as number | null,
    createdAt: at,
    orderItem: { productName: 'Kettle', sku: 'KET-1', productId: 'p1', variantId: 'v1' },
    ...overrides,
  };
}

function returnRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rr1',
    orderId: 'o1',
    userId: 'u1',
    reason: null as string | null,
    status: ReturnStatus.REQUESTED as ReturnStatus,
    resolution: ReturnResolution.REFUND as ReturnResolution,
    refundAmount: null as Prisma.Decimal | null,
    staffNote: 'internal' as string | null,
    rejectionReason: null,
    policyOverrideReason: null,
    createdById: null,
    replacementOrderId: null,
    createdAt: at,
    updatedAt: at,
    lines: [returnLine()],
    events: [],
    ...overrides,
  };
}

const orderLine = (overrides: Record<string, unknown> = {}) => ({
  id: 'oi1',
  productId: 'p1',
  variantId: 'v1',
  productName: 'Kettle',
  unitListPrice: new Prisma.Decimal(100),
  productType: { name: 'General', returnable: true, returnWindowDays: null },
  units: { deliveries: [{ deliveredAt: daysAgo(2), quantity: 2 }], refundedOutsideReturns: 0, claimedByReturns: 0 },
  ...overrides,
});

describe('ReturnsService', () => {
  let service: ReturnsService;
  let status: ReturnStatus;
  const audit = createAuditServiceMock();
  const tx = {
    // The replacement order's row lock reads PLACED; every other lock is the return request's.
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('').includes('FROM "Order"') ? [{ status: 'PLACED' }] : [{ status }],
    ),
    returnRequest: { updateMany: jest.fn(async () => ({ count: 1 })) },
    orderStatusEvent: { create: jest.fn() },
    returnStatusEvent: { create: jest.fn() },
    order: { findUniqueOrThrow: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    order: { findUniqueOrThrow: jest.fn(async () => ({ stockLocationId: 'loc_branch' })) },
    paymentAttempt: { findFirst: jest.fn() },
  };
  const repository = {
    lockOrder: jest.fn(),
    storeWindowDays: jest.fn(async () => 14),
    returnableLines: jest.fn(async () => [orderLine()]),
    findVariants: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    findMany: jest.fn(),
    setReceived: jest.fn(),
    setDisposition: jest.fn(),
  };
  const outbox = { record: jest.fn() };
  const refunds = { refundReturnLines: jest.fn(), openForReturn: jest.fn(), send: jest.fn() };
  const refundRepository = { findByReturnRequest: jest.fn() };
  const inventory = { restockReturn: jest.fn() };
  const ledger = { reserve: jest.fn(async () => true), consumeOrder: jest.fn() };
  const ledgerRepository = { defaultLocationId: jest.fn(async () => 'loc_default') };
  const stockLocations = { candidatesFor: jest.fn(async () => ['loc_branch']), lockFulfilmentLocation: jest.fn() };
  const orders = { createReplacement: jest.fn(), lockSellableVariant: jest.fn(async () => true) };

  beforeEach(async () => {
    jest.clearAllMocks();
    status = ReturnStatus.REQUESTED;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: ReturnsRepository, useValue: repository },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: CloudinaryService, useValue: { urlFor: (id: string) => `https://img/${id}` } },
        { provide: OutboxService, useValue: outbox },
        { provide: RefundsService, useValue: refunds },
        { provide: RefundRepository, useValue: refundRepository },
        { provide: InventoryService, useValue: inventory },
        { provide: StockLedgerService, useValue: ledger },
        { provide: StockLedgerRepository, useValue: ledgerRepository },
        { provide: StockLocationsService, useValue: stockLocations },
        { provide: OrdersRepository, useValue: orders },
      ],
    }).compile();
    service = module.get(ReturnsService);
  });

  const request = (lines = [{ orderItemId: 'oi1', quantity: 1, reason: ReturnReason.DAMAGED }]) => ({
    orderId: 'o1',
    resolution: ReturnResolution.REFUND,
    lines,
  });

  describe('requestReturn', () => {
    beforeEach(() => {
      repository.lockOrder.mockResolvedValue({ id: 'o1', userId: 'u1', deleted: false });
      repository.create.mockResolvedValue(returnRequest());
    });

    it('creates the request under the order lock and shows it without staff notes', async () => {
      const created = await service.requestReturn('u1', request());

      expect(repository.lockOrder).toHaveBeenCalledWith(tx, 'o1');
      expect(repository.create).toHaveBeenCalledWith(tx, {
        orderId: 'o1',
        userId: 'u1',
        resolution: ReturnResolution.REFUND,
        lines: [
          {
            orderItemId: 'oi1',
            quantity: 1,
            reason: ReturnReason.DAMAGED,
            note: null,
            photoPublicIds: [],
            exchangeVariantId: null,
          },
        ],
        actorId: 'u1',
      });
      expect(created).not.toHaveProperty('staffNote');
      expect(created.lines[0]).not.toHaveProperty('restockQuantity');
    });

    it("refuses another customer's order as NOT_FOUND", async () => {
      await expect(service.requestReturn('u2', request())).rejects.toThrow(NotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses units delivered outside the window with BAD_REQUEST and its reason', async () => {
      repository.returnableLines.mockResolvedValueOnce([
        orderLine({
          units: {
            deliveries: [{ deliveredAt: daysAgo(20), quantity: 2 }],
            refundedOutsideReturns: 0,
            claimedByReturns: 0,
          },
        }),
      ]);

      const error = await service.requestReturn('u1', request()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'OUTSIDE_RETURN_WINDOW' },
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses more units than are left with CONFLICT', async () => {
      repository.returnableLines.mockResolvedValueOnce([
        orderLine({
          units: {
            deliveries: [{ deliveredAt: daysAgo(1), quantity: 2 }],
            refundedOutsideReturns: 0,
            claimedByReturns: 2,
          },
        }),
      ]);

      await expect(service.requestReturn('u1', request())).rejects.toThrow(ConflictException);
    });

    it('refuses an exchange for a variant at another price', async () => {
      repository.findVariants.mockResolvedValueOnce([
        {
          id: 'v2',
          productId: 'p1',
          sku: 'KET-2',
          price: new Prisma.Decimal(110),
          isActive: true,
          product: { name: 'Kettle', isActive: true, status: 'PUBLISHED' },
        },
      ]);

      const error = await service
        .requestReturn('u1', {
          ...request([
            { orderItemId: 'oi1', quantity: 1, reason: ReturnReason.SIZE_FIT, exchangeVariantId: 'v2' } as never,
          ]),
          resolution: ReturnResolution.EXCHANGE,
        })
        .catch((caught: unknown) => caught);

      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'EXCHANGE_NOT_ALLOWED' },
      });
    });
  });

  describe('acceptReturnOutsidePolicy', () => {
    it('creates an APPROVED return past the window for the order customer, audited with the reason', async () => {
      repository.lockOrder.mockResolvedValue({ id: 'o1', userId: 'u1', deleted: false });
      repository.returnableLines.mockResolvedValueOnce([
        orderLine({
          productType: { name: 'Groceries', returnable: false, returnWindowDays: null },
          units: {
            deliveries: [{ deliveredAt: daysAgo(60), quantity: 2 }],
            refundedOutsideReturns: 0,
            claimedByReturns: 0,
          },
        }),
      ]);
      repository.create.mockResolvedValue(
        returnRequest({ status: ReturnStatus.APPROVED, policyOverrideReason: 'Faulty batch' }),
      );

      await service.acceptReturnOutsidePolicy({ ...request(), overrideReason: 'Faulty batch' }, 'staff1');

      expect(repository.create).toHaveBeenCalledWith(
        AUDIT_TX,
        expect.objectContaining({
          userId: 'u1',
          createdById: 'staff1',
          policyOverrideReason: 'Faulty batch',
          approved: true,
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'ReturnRequest',
          action: 'CREATE',
          userId: 'staff1',
          details: expect.objectContaining({ policyOverrideReason: 'Faulty batch' }),
        }),
        AUDIT_TX,
      );
      expect(outbox.record).toHaveBeenCalledWith(
        AUDIT_TX,
        expect.objectContaining({ type: 'return.status_changed.v1' }),
      );
    });
  });

  describe('approve, reject and cancel', () => {
    it('approves with the history event, audit row and customer event in one transaction', async () => {
      repository.findById.mockResolvedValue(returnRequest());

      await service.approveReturn('rr1', ' looks fine ', 'staff1');

      expect(tx.returnRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'rr1', status: ReturnStatus.REQUESTED },
        data: { staffNote: 'looks fine', status: ReturnStatus.APPROVED },
      });
      expect(tx.returnStatusEvent.create).toHaveBeenCalledWith({
        data: { returnRequestId: 'rr1', from: 'REQUESTED', to: 'APPROVED', actorId: 'staff1', note: 'looks fine' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'ReturnRequest',
          entityId: 'rr1',
          action: 'STATUS_CHANGE',
          userId: 'staff1',
          details: { orderId: 'o1', from: 'REQUESTED', to: 'APPROVED' },
        },
        tx,
      );
      expect(outbox.record).toHaveBeenCalledWith(tx, {
        type: 'return.status_changed.v1',
        aggregateId: 'rr1',
        payload: { returnRequestId: 'rr1', orderId: 'o1', status: 'APPROVED' },
      });
    });

    it('fails with CONFLICT and audits nothing when another request moved it first', async () => {
      repository.findById.mockResolvedValue(returnRequest());
      status = ReturnStatus.REJECTED;

      await expect(service.approveReturn('rr1', undefined, 'staff1')).rejects.toThrow(ConflictException);
      expect(audit.log).not.toHaveBeenCalled();
      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('refuses to approve a legacy whole-order request', async () => {
      repository.findById.mockResolvedValue(returnRequest({ lines: [], reason: 'Broken' }));

      await expect(service.approveReturn('rr1', undefined, 'staff1')).rejects.toThrow(/legacy whole-order request/);
    });

    it('rejects an approved return with the reason the customer sees', async () => {
      repository.findById.mockResolvedValue(returnRequest({ status: ReturnStatus.APPROVED }));
      status = ReturnStatus.APPROVED;

      await service.rejectReturn('rr1', 'Nothing arrived', undefined, 'staff1');

      expect(tx.returnRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'rr1', status: ReturnStatus.APPROVED },
        data: { rejectionReason: 'Nothing arrived', status: ReturnStatus.REJECTED },
      });
    });

    it('lets a customer cancel only their own return, before it is received', async () => {
      repository.findById.mockResolvedValue(returnRequest());
      await expect(service.cancelReturn('u2', 'rr1')).rejects.toThrow(NotFoundException);

      repository.findById.mockResolvedValue(returnRequest({ status: ReturnStatus.RECEIVED }));
      await expect(service.cancelReturn('u1', 'rr1')).rejects.toThrow(ConflictException);

      repository.findById.mockResolvedValue(returnRequest());
      await service.cancelReturn('u1', 'rr1');
      expect(tx.returnStatusEvent.create).toHaveBeenCalledWith({
        data: { returnRequestId: 'rr1', from: 'REQUESTED', to: 'CANCELLED', actorId: 'u1', note: null },
      });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('receive and inspect', () => {
    it('records the units received per line', async () => {
      repository.findById.mockResolvedValue(returnRequest({ status: ReturnStatus.APPROVED }));
      status = ReturnStatus.APPROVED;

      await service.receiveReturn('rr1', [{ returnLineId: 'line1', receivedQuantity: 1 }], undefined, 'staff1');

      expect(repository.setReceived).toHaveBeenCalledWith(tx, 'line1', 1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ to: 'RECEIVED', lines: [{ returnLineId: 'line1', receivedQuantity: 1 }] }),
        }),
        tx,
      );
    });

    it('refuses a receipt above the line quantity before writing anything', async () => {
      repository.findById.mockResolvedValue(returnRequest({ status: ReturnStatus.APPROVED }));

      await expect(
        service.receiveReturn('rr1', [{ returnLineId: 'line1', receivedQuantity: 3 }], undefined, 'staff1'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("restocks units at the order's location and writes the others off without moving stock", async () => {
      repository.findById.mockResolvedValue(
        returnRequest({ status: ReturnStatus.RECEIVED, lines: [returnLine({ receivedQuantity: 2 })] }),
      );
      status = ReturnStatus.RECEIVED;
      inventory.restockReturn.mockResolvedValue({ movements: [{ id: 'mv1', locationId: 'loc_branch' }], serials: [] });

      await service.inspectReturn(
        'rr1',
        [{ returnLineId: 'line1', restockQuantity: 1, writeOffQuantity: 1, lot: { lotNumber: 'L1' } }],
        undefined,
        'staff1',
      );

      expect(repository.setDisposition).toHaveBeenCalledWith(tx, 'line1', 1, 1);
      expect(inventory.restockReturn).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          variantId: 'v1',
          quantity: 1,
          returnRequestId: 'rr1',
          orderId: 'o1',
          locationId: 'loc_branch',
          lot: { lotNumber: 'L1' },
        }),
        'staff1',
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            to: 'INSPECTED',
            movements: [{ returnLineId: 'line1', stockMovementIds: ['mv1'], locationId: 'loc_branch', serials: [] }],
          }),
        }),
        tx,
      );
      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('restocks nothing for a line written off in full', async () => {
      repository.findById.mockResolvedValue(
        returnRequest({ status: ReturnStatus.RECEIVED, lines: [returnLine({ receivedQuantity: 2 })] }),
      );
      status = ReturnStatus.RECEIVED;

      await service.inspectReturn(
        'rr1',
        [{ returnLineId: 'line1', restockQuantity: 0, writeOffQuantity: 2 }],
        undefined,
        'staff1',
      );

      expect(inventory.restockReturn).not.toHaveBeenCalled();
    });
  });

  describe('refundReturn', () => {
    it('refunds an inspected item-level return through RefundsService', async () => {
      const inspected = returnRequest({ status: ReturnStatus.INSPECTED, lines: [returnLine({ receivedQuantity: 1 })] });
      repository.findById.mockResolvedValue(inspected);

      await service.refundReturn('rr1', { refundShipping: true, staffNote: ' ok ' }, 'staff1');

      expect(refunds.refundReturnLines).toHaveBeenCalledWith(inspected, { shipping: true, note: 'ok' }, 'staff1');
    });

    it('refuses an item-level return that was not inspected yet', async () => {
      repository.findById.mockResolvedValue(returnRequest({ status: ReturnStatus.APPROVED }));

      await expect(service.refundReturn('rr1', { refundShipping: false }, 'staff1')).rejects.toThrow(ConflictException);
      expect(refunds.refundReturnLines).not.toHaveBeenCalled();
    });

    it('opens and sends the approved amount of a legacy request on its paying attempt', async () => {
      const legacy = returnRequest({ lines: [], status: ReturnStatus.APPROVED, refundAmount: new Prisma.Decimal(50) });
      repository.findById.mockResolvedValue(legacy);
      prisma.paymentAttempt.findFirst.mockResolvedValue({ id: 'att1', reference: 'ref1' });
      refunds.openForReturn.mockResolvedValue({ id: 'rf1' });

      await service.refundReturn('rr1', { refundShipping: false }, 'staff1');

      expect(refunds.openForReturn).toHaveBeenCalledWith(expect.objectContaining({ id: 'rr1' }), 'att1', 'staff1');
      expect(refunds.send).toHaveBeenCalledWith('rf1', 'staff1');
    });

    it('resends the existing refund of a REFUND_PENDING legacy request', async () => {
      repository.findById.mockResolvedValue(returnRequest({ lines: [], status: ReturnStatus.REFUND_PENDING }));
      refundRepository.findByReturnRequest.mockResolvedValue({ id: 'rf1' });

      await service.refundReturn('rr1', { refundShipping: false }, 'staff1');

      expect(refunds.openForReturn).not.toHaveBeenCalled();
      expect(refunds.send).toHaveBeenCalledWith('rf1', 'staff1');
    });
  });

  describe('exchangeReturn', () => {
    const exchange = () =>
      returnRequest({
        status: ReturnStatus.INSPECTED,
        resolution: ReturnResolution.EXCHANGE,
        lines: [returnLine({ receivedQuantity: 2, exchangeVariantId: 'v2' })],
      });
    const variant = {
      id: 'v2',
      productId: 'p1',
      sku: 'KET-2',
      optionValues: { colour: 'Red' },
      price: new Prisma.Decimal(100),
      isActive: true,
      product: { name: 'Kettle', isActive: true, status: 'PUBLISHED' },
    };

    beforeEach(() => {
      status = ReturnStatus.INSPECTED;
      repository.findById.mockResolvedValue(exchange());
      repository.lockOrder.mockResolvedValue({
        id: 'o1',
        userId: 'u1',
        shippingZoneId: 'zone1',
        pickupLocationId: null,
      });
      repository.findVariants.mockResolvedValue([variant]);
      stockLocations.lockFulfilmentLocation.mockResolvedValue({ locationId: 'loc_branch' });
      orders.createReplacement.mockResolvedValue({ id: 'o2', items: [{ id: 'oi9', variantId: 'v2', quantity: 2 }] });
    });

    it('places a paid replacement order with its stock reserved and sold, then moves the return to EXCHANGED', async () => {
      await service.exchangeReturn('rr1', undefined, 'staff1');

      expect(stockLocations.candidatesFor).toHaveBeenCalledWith({ shippingZoneId: 'zone1' }, tx);
      expect(stockLocations.lockFulfilmentLocation).toHaveBeenCalledWith(
        tx,
        ['loc_branch'],
        [{ orderItemId: 'oi1', variantId: 'v2', quantity: 2 }],
      );
      expect(ledger.reserve).toHaveBeenCalledWith(
        tx,
        { variantId: 'v2', quantity: 2, orderId: 'o2', orderItemId: 'oi9', expiresAt: null, locationId: 'loc_branch' },
        'staff1',
      );
      expect(ledger.consumeOrder).toHaveBeenCalledWith(tx, 'o2', 'staff1');
      expect(tx.returnRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'rr1', status: ReturnStatus.INSPECTED },
        data: { replacementOrderId: 'o2', status: ReturnStatus.EXCHANGED },
      });
      expect(outbox.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: 'order.placed.v1', aggregateId: 'o2' }),
      );
    });

    it('refuses with EXCHANGE_OUT_OF_STOCK when no serving location holds every unit', async () => {
      stockLocations.lockFulfilmentLocation.mockResolvedValue({ locationId: null, shortVariantId: 'v2' });

      const error = await service.exchangeReturn('rr1', undefined, 'staff1').catch((caught: unknown) => caught);

      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'EXCHANGE_OUT_OF_STOCK' },
      });
      expect(orders.createReplacement).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses a return that asked for a refund', async () => {
      repository.findById.mockResolvedValue({ ...exchange(), resolution: ReturnResolution.REFUND });

      await expect(service.exchangeReturn('rr1', undefined, 'staff1')).rejects.toThrow(/asks for a refund/);
    });
  });
});
