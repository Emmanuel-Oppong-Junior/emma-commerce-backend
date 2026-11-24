import { Prisma, ReturnReason, ReturnResolution, ReturnStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReturnsRepository } from './returns.repository';

const at = new Date('2026-12-01T00:00:00Z');

describe('ReturnsRepository', () => {
  const db = {
    returnRequest: {
      create: jest.fn(async () => ({ id: 'rr1' })),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'rr1', lines: [] })),
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    returnLine: { create: jest.fn() },
    orderItem: { findMany: jest.fn() },
  };
  const repository = new ReturnsRepository(db as unknown as PrismaService);
  const tx = db as unknown as Prisma.TransactionClient;

  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    const line = {
      orderItemId: 'oi1',
      quantity: 1,
      reason: ReturnReason.DAMAGED,
      note: null,
      photoPublicIds: [],
      exchangeVariantId: null,
    };

    it('writes a REQUESTED request with its first event, then each line on its own insert', async () => {
      await repository.create(tx, {
        orderId: 'o1',
        userId: 'u1',
        resolution: ReturnResolution.REFUND,
        lines: [line, { ...line, orderItemId: 'oi2' }],
        actorId: 'u1',
      });

      expect(db.returnRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: ReturnStatus.REQUESTED,
          createdById: null,
          policyOverrideReason: null,
          events: { create: [{ from: null, to: ReturnStatus.REQUESTED, actorId: 'u1' }] },
        }),
      });
      expect(db.returnLine.create).toHaveBeenNthCalledWith(1, { data: { ...line, returnRequestId: 'rr1' } });
      expect(db.returnLine.create).toHaveBeenNthCalledWith(2, {
        data: { ...line, orderItemId: 'oi2', returnRequestId: 'rr1' },
      });
    });

    it('writes an approved staff return with both events, the override reason on the approval', async () => {
      await repository.create(tx, {
        orderId: 'o1',
        userId: 'u1',
        resolution: ReturnResolution.REFUND,
        lines: [line],
        actorId: 'staff1',
        createdById: 'staff1',
        policyOverrideReason: 'Faulty batch',
        approved: true,
      });

      expect(db.returnRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: ReturnStatus.APPROVED,
          createdById: 'staff1',
          events: {
            create: [
              { from: null, to: ReturnStatus.REQUESTED, actorId: 'staff1' },
              { from: ReturnStatus.REQUESTED, to: ReturnStatus.APPROVED, actorId: 'staff1', note: 'Faulty batch' },
            ],
          },
        }),
      });
    });
  });

  it('pages newest first after a cursor, with the filters', async () => {
    await repository.findMany(
      { status: ReturnStatus.APPROVED, userId: 'u1', createdFrom: at },
      { take: 11, after: 'rr9' },
    );

    expect(db.returnRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: ReturnStatus.APPROVED,
          orderId: undefined,
          userId: 'u1',
          createdAt: { gte: at, lt: undefined },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 11,
        cursor: { id: 'rr9' },
        skip: 1,
      }),
    );
  });

  it('sums each line: delivered per shipment, refunded outside returns, received or requested under live returns', async () => {
    db.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi1',
        productId: 'p1',
        variantId: 'v1',
        productName: 'Kettle',
        unitListPrice: new Prisma.Decimal(100),
        product: { productType: { name: 'General', returnable: true, returnWindowDays: null } },
        shipmentItems: [
          { quantity: 2, shipment: { deliveredAt: at } },
          { quantity: 1, shipment: { deliveredAt: null } },
        ],
        refundLines: [{ quantity: 1 }],
        returnLines: [
          { quantity: 2, receivedQuantity: 1 },
          { quantity: 1, receivedQuantity: null },
        ],
      },
    ]);

    const [line] = await repository.returnableLines(tx, 'o1');

    expect(line.units).toEqual({
      deliveries: [
        { deliveredAt: at, quantity: 2 },
        { deliveredAt: null, quantity: 1 },
      ],
      refundedOutsideReturns: 1,
      claimedByReturns: 2,
    });
  });
});
