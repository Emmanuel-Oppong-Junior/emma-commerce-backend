import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { StockMovement } from '../generated/prisma/client';
import { createAuditServiceMock } from '../../test/helpers/audit.helper';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: 'mv1',
    variantId: 'var1',
    locationId: 'store_main',
    onHandDelta: 50,
    reservedDelta: 0,
    reason: 'RECEIPT',
    refType: null,
    refId: null,
    actorId: 'admin1',
    note: 'Manual restock',
    createdAt: fixedDate,
    ...overrides,
  };
}

describe('InventoryService', () => {
  const tx = { variant: { count: jest.fn() } };
  let ledger: { receive: jest.Mock; adjust: jest.Mock; available: jest.Mock };
  let repository: { returnRequestExists: jest.Mock; findMovements: jest.Mock };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: InventoryService;

  beforeEach(() => {
    tx.variant.count.mockReset().mockResolvedValue(1);
    ledger = { receive: jest.fn().mockResolvedValue(movement()), adjust: jest.fn(), available: jest.fn() };
    repository = { returnRequestExists: jest.fn().mockResolvedValue(true), findMovements: jest.fn() };
    audit = createAuditServiceMock();
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    service = new InventoryService(ledger as never, repository as never, prisma as never, audit as never);
  });

  describe('restockVariant', () => {
    it('receives the units as a RECEIPT on the default note', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 50 }, 'admin1');

      expect(ledger.receive).toHaveBeenCalledWith(tx, 'var1', 50, 'RECEIPT', {
        actorId: 'admin1',
        note: 'Manual restock',
      });
    });

    it('keeps the reason given', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 20, reason: 'Received shipment' }, 'admin1');

      expect(ledger.receive).toHaveBeenCalledWith(tx, 'var1', 20, 'RECEIPT', {
        actorId: 'admin1',
        note: 'Received shipment',
      });
    });

    it('records goods of a return request as RETURN_RESTOCK referencing the request', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 1, returnRequestId: 'rr1' }, 'admin1');

      expect(repository.returnRequestExists).toHaveBeenCalledWith(tx, 'rr1');
      expect(ledger.receive).toHaveBeenCalledWith(tx, 'var1', 1, 'RETURN_RESTOCK', {
        actorId: 'admin1',
        note: 'Returned goods restocked',
        refType: 'ReturnRequest',
        refId: 'rr1',
      });
    });

    it('rejects an unknown variant or return request without moving stock', async () => {
      tx.variant.count.mockResolvedValue(0);
      await expect(service.restockVariant({ variantId: 'nope', quantity: 1 }, 'admin1')).rejects.toThrow(
        new NotFoundException('Variant "nope" not found'),
      );
      tx.variant.count.mockResolvedValue(1);
      repository.returnRequestExists.mockResolvedValue(false);
      await expect(
        service.restockVariant({ variantId: 'var1', quantity: 1, returnRequestId: 'rr-x' }, 'admin1'),
      ).rejects.toThrow(new NotFoundException('Return request "rr-x" not found'));
      expect(ledger.receive).not.toHaveBeenCalled();
    });
  });

  describe('adjustVariantStock', () => {
    it('moves on-hand stock by the signed delta with the reason as its note', async () => {
      ledger.adjust.mockResolvedValue(movement({ reason: 'ADJUSTMENT', onHandDelta: -3 }));

      await service.adjustVariantStock({ variantId: 'var1', delta: -3, reason: 'Damaged in storage' }, 'admin1');

      expect(ledger.adjust).toHaveBeenCalledWith(tx, 'var1', -3, { actorId: 'admin1', note: 'Damaged in storage' });
    });

    it('refuses to remove units that are not available, and audits nothing', async () => {
      ledger.adjust.mockResolvedValue(null);
      ledger.available.mockResolvedValue(7);

      await expect(
        service.adjustVariantStock({ variantId: 'var1', delta: -10, reason: 'Lost' }, 'admin1'),
      ).rejects.toThrow(new BadRequestException('Cannot remove 10 units from variant "var1": only 7 available'));
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('reports a missing variant as not found', async () => {
      tx.variant.count.mockResolvedValue(0);

      await expect(
        service.adjustVariantStock({ variantId: 'nope', delta: -1, reason: 'Lost' }, 'admin1'),
      ).rejects.toThrow(NotFoundException);
      expect(ledger.adjust).not.toHaveBeenCalled();
    });
  });

  describe('getMovements', () => {
    it('reads one extra row to know whether another page follows', async () => {
      const rows = [movement({ id: 'a' }), movement({ id: 'b' }), movement({ id: 'c' })];
      repository.findMovements.mockResolvedValue([rows, 7]);

      const page = await service.getMovements({ variantId: 'var1' }, 2, 'z');

      expect(repository.findMovements).toHaveBeenCalledWith({ variantId: 'var1' }, { take: 3, after: 'z' });
      expect(page).toEqual({ nodes: rows.slice(0, 2), totalCount: 7, hasNextPage: true });
    });
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, StockMovement, object]>([
      [
        'restockVariant',
        () => service.restockVariant({ variantId: 'var1', quantity: 50 }, 'admin1'),
        movement(),
        {
          entity: 'Variant',
          entityId: 'var1',
          details: {
            stockMovementId: 'mv1',
            kind: 'RECEIPT',
            locationId: 'store_main',
            onHandDelta: 50,
            reason: 'Manual restock',
          },
        },
      ],
      [
        'adjustVariantStock',
        () => service.adjustVariantStock({ variantId: 'var1', delta: -3, reason: 'Damaged' }, 'admin1'),
        movement({ id: 'mv2', reason: 'ADJUSTMENT', onHandDelta: -3, note: 'Damaged' }),
        {
          entity: 'Variant',
          entityId: 'var1',
          details: expect.objectContaining({ stockMovementId: 'mv2', kind: 'ADJUSTMENT', onHandDelta: -3 }),
        },
      ],
    ])('%s audits the stock change on the transaction that moved the stock', async (_name, act, moved, expected) => {
      ledger.receive.mockResolvedValue(moved);
      ledger.adjust.mockResolvedValue(moved);

      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({ action: 'STOCK_ADJUSTMENT', userId: 'admin1', ...expected }, tx);
    });
  });
});
