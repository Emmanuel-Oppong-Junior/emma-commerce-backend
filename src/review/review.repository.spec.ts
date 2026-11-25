import { Test, TestingModule } from '@nestjs/testing';
import { ReviewRepository } from './review.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ReviewSort } from './dto/review-list.args';

describe('ReviewRepository', () => {
  let repository: ReviewRepository;
  const prisma = {
    product: { count: jest.fn() },
    review: { findMany: jest.fn(), groupBy: jest.fn() },
    orderItem: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const tx = prisma as unknown as Prisma.TransactionClient;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReviewRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();
    repository = module.get(ReviewRepository);
  });

  it('treats only active, PUBLISHED products as public', async () => {
    prisma.product.count.mockResolvedValue(1);

    await expect(repository.isPublicProduct('prod1')).resolves.toBe(true);
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { id: 'prod1', isActive: true, status: 'PUBLISHED' },
    });
  });

  it('reports whether the product row was locked', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]).mockResolvedValueOnce([]);

    await expect(repository.lockProduct(tx, 'prod1')).resolves.toBe(true);
    await expect(repository.lockProduct(tx, 'gone')).resolves.toBe(false);
  });

  it('sums delivered shipment units and non-failed refund units per order line', async () => {
    const orderedAt = new Date('2026-11-01');
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'item1',
        quantity: 3,
        order: { status: 'IN_FULFILMENT', createdAt: orderedAt },
        shipmentItems: [{ quantity: 1 }, { quantity: 1 }],
        refundLines: [{ quantity: 1 }],
      },
    ]);

    await expect(repository.purchasedLines(tx, 'user1', 'prod1')).resolves.toEqual([
      {
        orderItemId: 'item1',
        orderStatus: 'IN_FULFILMENT',
        orderedAt,
        quantity: 3,
        deliveredUnits: 2,
        refundedUnits: 1,
      },
    ]);
    const where = prisma.orderItem.findMany.mock.calls[0][0];
    expect(where.where).toEqual({ productId: 'prod1', order: { userId: 'user1' } });
    expect(where.select.shipmentItems.where).toEqual({ shipment: { status: 'DELIVERED' } });
    expect(where.select.refundLines.where).toEqual({ refund: { status: { not: 'FAILED' } } });
  });

  it('recomputes the stored rating from the published reviews only', async () => {
    prisma.review.groupBy.mockResolvedValue([
      { score: 5, _count: { _all: 2 } },
      { score: 2, _count: { _all: 1 } },
    ]);

    await repository.refreshRating(tx, 'prod1');

    expect(prisma.review.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'prod1', status: 'PUBLISHED' } }),
    );
    const [, count, average, c1, c2, c3, c4, c5, id] = prisma.$executeRaw.mock.calls[0];
    expect({ count, average, c1, c2, c3, c4, c5, id }).toEqual({
      count: 3,
      average: '4.00',
      c1: 0,
      c2: 1,
      c3: 0,
      c4: 0,
      c5: 2,
      id: 'prod1',
    });
  });

  it('pages published reviews by the chosen sort with the last id as cursor', async () => {
    prisma.review.findMany.mockResolvedValue([]);

    await repository.findPublished('prod1', ReviewSort.LOWEST, 10, 'rev9');
    await repository.findPublished('prod1', ReviewSort.NEWEST, 10);

    expect(prisma.review.findMany).toHaveBeenNthCalledWith(1, {
      where: { productId: 'prod1', status: 'PUBLISHED' },
      orderBy: [{ score: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      skip: 1,
      cursor: { id: 'rev9' },
    });
    expect(prisma.review.findMany).toHaveBeenNthCalledWith(2, {
      where: { productId: 'prod1', status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
  });
});
