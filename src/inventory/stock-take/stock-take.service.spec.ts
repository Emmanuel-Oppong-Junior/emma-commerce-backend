import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StockTake, StockTakeStatus } from '../../generated/prisma/client';
import { createAuditServiceMock } from '../../../test/helpers/audit.helper';
import { StockTakeService } from './stock-take.service';

const tx = { tx: true } as never;

function session(status: StockTakeStatus, overrides: Partial<StockTake> = {}): StockTake {
  return {
    id: 'st1',
    locationId: 'store_main',
    status,
    categoryId: null,
    note: null,
    openedById: 'clerk1',
    openedAt: new Date('2026-11-22T08:00:00Z'),
    submittedById: null,
    submittedAt: null,
    approvedById: null,
    approvedAt: null,
    cancelledById: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date('2026-11-22T08:00:00Z'),
    updatedAt: new Date('2026-11-22T08:00:00Z'),
    ...overrides,
  };
}

describe('StockTakeService', () => {
  let repository: Record<string, jest.Mock>;
  let ledgerRepository: Record<string, jest.Mock>;
  let ledger: { adjustAt: jest.Mock; availableAt: jest.Mock };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: StockTakeService;

  beforeEach(() => {
    repository = {
      findOpenAt: jest.fn().mockResolvedValue(null),
      categoryExists: jest.fn().mockResolvedValue(true),
      existingVariantIds: jest.fn(),
      expectedStock: jest.fn().mockResolvedValue([
        { variantId: 'v1', expected: 10 },
        { variantId: 'v2', expected: 4 },
      ]),
      create: jest.fn().mockResolvedValue(session('OPEN')),
      lockSession: jest.fn().mockResolvedValue({ status: 'OPEN', locationId: 'store_main' }),
      findLineVariantIds: jest.fn().mockResolvedValue(['v1', 'v2']),
      recordCount: jest.fn(),
      linesOf: jest.fn().mockResolvedValue([]),
      transition: jest.fn().mockResolvedValue(true),
      find: jest.fn().mockResolvedValue(session('SUBMITTED')),
      countedLines: jest.fn().mockResolvedValue([]),
      setLineMovement: jest.fn(),
    };
    ledgerRepository = {
      defaultLocationId: jest.fn().mockResolvedValue('store_main'),
      findActiveLocation: jest.fn().mockResolvedValue(null),
    };
    ledger = {
      adjustAt: jest.fn().mockImplementation(async (_tx, variantId: string) => ({ id: `mv-${variantId}` })),
      availableAt: jest.fn(),
    };
    audit = createAuditServiceMock();
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    service = new StockTakeService(
      repository as never,
      ledgerRepository as never,
      ledger as never,
      prisma as never,
      audit as never,
      { trackedVariantIds: jest.fn().mockResolvedValue([]) } as never,
    );
  });

  describe('open', () => {
    it('snapshots the expected quantity of every variant in scope at the default location', async () => {
      await service.open({ categoryId: 'cat1', note: ' Monthly ' }, 'clerk1');

      expect(repository.expectedStock).toHaveBeenCalledWith(tx, 'store_main', {
        categoryId: 'cat1',
        variantIds: undefined,
      });
      expect(repository.create).toHaveBeenCalledWith(
        tx,
        { locationId: 'store_main', categoryId: 'cat1', note: 'Monthly', openedById: 'clerk1' },
        [
          { variantId: 'v1', expected: 10 },
          { variantId: 'v2', expected: 4 },
        ],
      );
    });

    it('refuses a category and variants together, and a second open session at the location', async () => {
      await expect(service.open({ categoryId: 'c', variantIds: ['v1'] }, 'clerk1')).rejects.toThrow(
        BadRequestException,
      );
      repository.findOpenAt.mockResolvedValue({ id: 'st0' });
      await expect(service.open({}, 'clerk1')).rejects.toMatchObject({
        response: { extensions: { reason: 'STOCK_TAKE_ALREADY_OPEN' } },
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('reports unknown variants, an unknown category and an empty scope', async () => {
      repository.existingVariantIds.mockResolvedValue(['v1']);
      await expect(service.open({ variantIds: ['v1', 'v9', 'v1'] }, 'clerk1')).rejects.toThrow(
        new NotFoundException('Variants not found: v9'),
      );
      repository.categoryExists.mockResolvedValue(false);
      await expect(service.open({ categoryId: 'nope' }, 'clerk1')).rejects.toThrow(
        new NotFoundException('Category "nope" not found'),
      );
      repository.expectedStock.mockResolvedValue([]);
      await expect(service.open({}, 'clerk1')).rejects.toThrow(
        new BadRequestException('There are no variants to count in this scope'),
      );
    });

    it('counts at an active location given, and refuses an unknown one', async () => {
      await expect(service.open({ locationId: 'gone' }, 'clerk1')).rejects.toThrow(NotFoundException);
      ledgerRepository.findActiveLocation.mockResolvedValue({ id: 'branch_2' });

      await service.open({ locationId: 'branch_2' }, 'clerk1');

      expect(repository.expectedStock).toHaveBeenCalledWith(tx, 'branch_2', expect.anything());
    });
  });

  describe('recordCounts', () => {
    it('reads the expected quantity with the count and stores the variance against it', async () => {
      repository.expectedStock.mockResolvedValue([
        { variantId: 'v1', expected: 8 },
        { variantId: 'v2', expected: 4 },
      ]);

      await service.recordCounts(
        {
          stockTakeId: 'st1',
          counts: [
            { variantId: 'v1', countedQuantity: 7 },
            { variantId: 'v2', countedQuantity: 4 },
          ],
        },
        'clerk1',
      );

      expect(repository.lockSession).toHaveBeenCalledWith(tx, 'st1', 'share');
      expect(repository.expectedStock).toHaveBeenCalledWith(tx, 'store_main', { variantIds: ['v1', 'v2'] });
      expect(repository.recordCount).toHaveBeenCalledWith(
        tx,
        'st1',
        { variantId: 'v1', countedQuantity: 7, expectedQuantity: 8, variance: -1 },
        'clerk1',
      );
      expect(repository.recordCount).toHaveBeenCalledWith(
        tx,
        'st1',
        { variantId: 'v2', countedQuantity: 4, expectedQuantity: 4, variance: 0 },
        'clerk1',
      );
    });

    it('refuses counts once the session is no longer OPEN, a variant twice, or one not in the session', async () => {
      const counts = (...ids: string[]) => ids.map((variantId) => ({ variantId, countedQuantity: 1 }));
      await expect(service.recordCounts({ stockTakeId: 'st1', counts: counts('v1', 'v1') }, 'c')).rejects.toThrow(
        new BadRequestException('Variant "v1" is counted twice'),
      );
      repository.findLineVariantIds.mockResolvedValue(['v1']);
      await expect(service.recordCounts({ stockTakeId: 'st1', counts: counts('v1', 'v7') }, 'c')).rejects.toThrow(
        new BadRequestException('Not in this stock-take: v7'),
      );
      repository.lockSession.mockResolvedValue({ status: 'SUBMITTED', locationId: 'store_main' });
      await expect(service.recordCounts({ stockTakeId: 'st1', counts: counts('v1') }, 'c')).rejects.toThrow(
        new ConflictException('Stock-take "st1" is SUBMITTED: counts are closed'),
      );
      repository.lockSession.mockResolvedValue(null);
      await expect(service.recordCounts({ stockTakeId: 'st1', counts: counts('v1') }, 'c')).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.recordCount).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    it('refuses to submit before anything is counted', async () => {
      await expect(service.submit('st1', 'clerk1')).rejects.toThrow(
        new BadRequestException('Count at least one variant before submitting'),
      );
      expect(repository.transition).not.toHaveBeenCalled();
    });

    it('moves an OPEN session with counts to SUBMITTED, conditionally', async () => {
      repository.countedLines.mockResolvedValue([{ variantId: 'v1', variance: 0 }]);

      await service.submit('st1', 'clerk1');

      expect(repository.transition).toHaveBeenCalledWith(tx, 'st1', ['OPEN'], 'SUBMITTED', {
        submittedById: 'clerk1',
        submittedAt: expect.any(Date),
      });
    });
  });

  describe('approve', () => {
    it('claims the session, then posts each non-zero variance as a STOCK_TAKE adjustment referencing it', async () => {
      repository.countedLines.mockResolvedValue([
        { variantId: 'v2', variance: 3 },
        { variantId: 'v1', variance: -2 },
        { variantId: 'v3', variance: 0 },
      ]);

      await service.approve('st1', 'manager1');

      expect(repository.transition).toHaveBeenCalledWith(tx, 'st1', ['SUBMITTED'], 'APPROVED', {
        approvedById: 'manager1',
        approvedAt: expect.any(Date),
      });
      expect(ledger.adjustAt.mock.calls).toEqual([
        [
          tx,
          'v1',
          'store_main',
          -2,
          {
            actorId: 'manager1',
            adjustmentReason: 'STOCK_TAKE',
            refType: 'StockTake',
            refId: 'st1',
            note: 'Stock-take st1',
          },
        ],
        [
          tx,
          'v2',
          'store_main',
          3,
          {
            actorId: 'manager1',
            adjustmentReason: 'STOCK_TAKE',
            refType: 'StockTake',
            refId: 'st1',
            note: 'Stock-take st1',
          },
        ],
      ]);
      expect(repository.setLineMovement).toHaveBeenCalledWith(tx, 'st1', 'v1', 'mv-v1');
    });

    it('posts nothing when another approver got there first', async () => {
      repository.transition.mockResolvedValue(false);
      repository.find.mockResolvedValue(session('APPROVED'));

      await expect(service.approve('st1', 'manager1')).rejects.toThrow(
        new ConflictException('Stock-take "st1" cannot move from APPROVED to APPROVED'),
      );
      expect(ledger.adjustAt).not.toHaveBeenCalled();
    });

    it('fails the whole approval when a shortage would eat into reserved units', async () => {
      repository.countedLines.mockResolvedValue([{ variantId: 'v1', variance: -5 }]);
      ledger.adjustAt.mockResolvedValue(null);
      ledger.availableAt.mockResolvedValue(2);

      await expect(service.approve('st1', 'manager1')).rejects.toMatchObject({
        response: { extensions: { reason: 'STOCK_TAKE_BELOW_RESERVED' } },
      });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('cancels an OPEN or SUBMITTED session with its reason, and refuses an approved one', async () => {
      await service.cancel('st1', 'manager1', ' Wrong location ');

      expect(repository.transition).toHaveBeenCalledWith(tx, 'st1', ['OPEN', 'SUBMITTED'], 'CANCELLED', {
        cancelledById: 'manager1',
        cancelledAt: expect.any(Date),
        cancelReason: 'Wrong location',
      });

      repository.lockSession.mockResolvedValue({ status: 'APPROVED', locationId: 'store_main' });
      await expect(service.cancel('st1', 'manager1')).rejects.toThrow(ConflictException);
    });
  });

  describe('audit trail', () => {
    beforeEach(() => {
      repository.countedLines.mockResolvedValue([{ variantId: 'v1', variance: -1 }]);
    });

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'openStockTake',
        () => service.open({ variantIds: ['v1', 'v2'] }, 'clerk1'),
        { action: 'CREATE', userId: 'clerk1', details: { locationId: 'store_main', scope: 'VARIANTS', lineCount: 2 } },
      ],
      [
        'recordStockTakeCounts',
        () => service.recordCounts({ stockTakeId: 'st1', counts: [{ variantId: 'v1', countedQuantity: 3 }] }, 'clerk1'),
        { action: 'UPDATE', userId: 'clerk1', details: { counts: [{ variantId: 'v1', countedQuantity: 3 }] } },
      ],
      [
        'submitStockTake',
        () => service.submit('st1', 'clerk1'),
        { action: 'STATUS_CHANGE', userId: 'clerk1', details: { from: 'OPEN', to: 'SUBMITTED', countedLines: 1 } },
      ],
      [
        'approveStockTake',
        () => service.approve('st1', 'manager1'),
        {
          action: 'STATUS_CHANGE',
          userId: 'manager1',
          details: {
            from: 'SUBMITTED',
            to: 'APPROVED',
            posted: [{ variantId: 'v1', variance: -1, movementId: 'mv-v1' }],
          },
        },
      ],
      [
        'cancelStockTake',
        () => service.cancel('st1', 'manager1', 'Recount next week'),
        {
          action: 'STATUS_CHANGE',
          userId: 'manager1',
          details: { from: 'OPEN', to: 'CANCELLED', reason: 'Recount next week' },
        },
      ],
    ])('%s writes its audit entry on the transaction that made the change', async (_name, act, expected) => {
      repository.existingVariantIds.mockResolvedValue(['v1', 'v2']);

      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({ entity: 'StockTake', entityId: 'st1', ...expected }, tx);
    });
  });
});
