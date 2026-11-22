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
    adjustmentReason: null,
    refType: null,
    refId: null,
    actorId: 'admin1',
    note: 'Manual restock',
    createdAt: fixedDate,
    ...overrides,
  };
}

describe('InventoryService', () => {
  const tx = { variant: { count: jest.fn() }, stockLocation: { count: jest.fn() } };
  let ledger: { receive: jest.Mock; adjustAt: jest.Mock; availableAt: jest.Mock };
  let repository: {
    findReturnRequestLocation: jest.Mock;
    findMovements: jest.Mock;
    defaultLocationId: jest.Mock;
    findActiveLocation: jest.Mock;
  };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: InventoryService;

  beforeEach(() => {
    tx.variant.count.mockReset().mockResolvedValue(1);
    tx.stockLocation.count.mockReset().mockResolvedValue(1);
    ledger = { receive: jest.fn().mockResolvedValue(movement()), adjustAt: jest.fn(), availableAt: jest.fn() };
    repository = {
      findReturnRequestLocation: jest.fn().mockResolvedValue({ stockLocationId: null }),
      findMovements: jest.fn(),
      defaultLocationId: jest.fn().mockResolvedValue('store_main'),
      findActiveLocation: jest.fn().mockResolvedValue(null),
    };
    audit = createAuditServiceMock();
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    service = new InventoryService(ledger as never, repository as never, prisma as never, audit as never);
  });

  describe('restockVariant', () => {
    it('receives the units as a RECEIPT on the default note', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 50 }, 'admin1');

      expect(ledger.receive).toHaveBeenCalledWith(
        tx,
        'var1',
        50,
        'RECEIPT',
        { actorId: 'admin1', note: 'Manual restock' },
        undefined,
      );
    });

    it('keeps the reason given', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 20, reason: 'Received shipment' }, 'admin1');

      expect(ledger.receive).toHaveBeenCalledWith(
        tx,
        'var1',
        20,
        'RECEIPT',
        { actorId: 'admin1', note: 'Received shipment' },
        undefined,
      );
    });

    it('records goods of a return request as RETURN_RESTOCK referencing the request', async () => {
      await service.restockVariant({ variantId: 'var1', quantity: 1, returnRequestId: 'rr1' }, 'admin1');

      expect(repository.findReturnRequestLocation).toHaveBeenCalledWith(tx, 'rr1');
      expect(ledger.receive).toHaveBeenCalledWith(
        tx,
        'var1',
        1,
        'RETURN_RESTOCK',
        { actorId: 'admin1', note: 'Returned goods restocked', refType: 'ReturnRequest', refId: 'rr1' },
        undefined,
      );
    });

    it('restocks returned goods at the location their order was fulfilled from', async () => {
      repository.findReturnRequestLocation.mockResolvedValue({ stockLocationId: 'loc_branch' });

      await service.restockVariant({ variantId: 'var1', quantity: 1, returnRequestId: 'rr1' }, 'admin1');

      expect(ledger.receive).toHaveBeenCalledWith(tx, 'var1', 1, 'RETURN_RESTOCK', expect.anything(), 'loc_branch');
    });

    it('receives at the location given, over the order location', async () => {
      repository.findReturnRequestLocation.mockResolvedValue({ stockLocationId: 'loc_branch' });

      await service.restockVariant(
        { variantId: 'var1', quantity: 1, returnRequestId: 'rr1', locationId: 'loc_other' },
        'admin1',
      );

      expect(ledger.receive).toHaveBeenCalledWith(tx, 'var1', 1, 'RETURN_RESTOCK', expect.anything(), 'loc_other');
    });

    it('rejects an unknown location without moving stock', async () => {
      tx.stockLocation.count.mockResolvedValue(0);

      await expect(
        service.restockVariant({ variantId: 'var1', quantity: 1, locationId: 'nope' }, 'admin1'),
      ).rejects.toThrow(new NotFoundException('Stock location "nope" not found'));
      expect(ledger.receive).not.toHaveBeenCalled();
    });

    it('rejects an unknown variant or return request without moving stock', async () => {
      tx.variant.count.mockResolvedValue(0);
      await expect(service.restockVariant({ variantId: 'nope', quantity: 1 }, 'admin1')).rejects.toThrow(
        new NotFoundException('Variant "nope" not found'),
      );
      tx.variant.count.mockResolvedValue(1);
      repository.findReturnRequestLocation.mockResolvedValue(null);
      await expect(
        service.restockVariant({ variantId: 'var1', quantity: 1, returnRequestId: 'rr-x' }, 'admin1'),
      ).rejects.toThrow(new NotFoundException('Return request "rr-x" not found'));
      expect(ledger.receive).not.toHaveBeenCalled();
    });
  });

  describe('adjustVariantStock', () => {
    it('moves on-hand stock at the default location by the signed delta with its reason and note', async () => {
      ledger.adjustAt.mockResolvedValue(movement({ reason: 'ADJUSTMENT', onHandDelta: -3 }));

      await service.adjustVariantStock(
        { variantId: 'var1', delta: -3, reason: 'DAMAGED', note: ' Damaged in storage ' },
        'admin1',
      );

      expect(ledger.adjustAt).toHaveBeenCalledWith(tx, 'var1', 'store_main', -3, {
        actorId: 'admin1',
        adjustmentReason: 'DAMAGED',
        note: 'Damaged in storage',
      });
    });

    it('adjusts at the location given when it is an active location', async () => {
      repository.findActiveLocation.mockResolvedValue({ id: 'branch_2' });
      ledger.adjustAt.mockResolvedValue(movement({ reason: 'ADJUSTMENT', onHandDelta: 2, locationId: 'branch_2' }));

      await service.adjustVariantStock({ variantId: 'var1', locationId: 'branch_2', delta: 2, reason: 'FOUND' }, 'a1');

      expect(repository.findActiveLocation).toHaveBeenCalledWith(tx, 'branch_2');
      expect(ledger.adjustAt).toHaveBeenCalledWith(tx, 'var1', 'branch_2', 2, {
        actorId: 'a1',
        adjustmentReason: 'FOUND',
        note: undefined,
      });
    });

    it('reports an unknown or inactive location as not found', async () => {
      await expect(
        service.adjustVariantStock({ variantId: 'var1', locationId: 'gone', delta: -1, reason: 'LOST' }, 'admin1'),
      ).rejects.toThrow(new NotFoundException('Stock location "gone" not found or inactive'));
      expect(ledger.adjustAt).not.toHaveBeenCalled();
    });

    it('refuses a reason that does not fit the change before touching stock', async () => {
      await expect(
        service.adjustVariantStock({ variantId: 'var1', delta: 4, reason: 'DAMAGED' }, 'admin1'),
      ).rejects.toThrow(new BadRequestException('DAMAGED can only remove stock: send a negative delta'));
      await expect(
        service.adjustVariantStock({ variantId: 'var1', delta: -1, reason: 'STOCK_TAKE' }, 'admin1'),
      ).rejects.toThrow(new BadRequestException('STOCK_TAKE cannot be given by hand'));
      await expect(
        service.adjustVariantStock({ variantId: 'var1', delta: -1, reason: 'OTHER', note: ' ' }, 'admin1'),
      ).rejects.toThrow(new BadRequestException('A note is required when the reason is OTHER'));
      expect(tx.variant.count).not.toHaveBeenCalled();
      expect(ledger.adjustAt).not.toHaveBeenCalled();
    });

    it('refuses to remove units that are not available, and audits nothing', async () => {
      ledger.adjustAt.mockResolvedValue(null);
      ledger.availableAt.mockResolvedValue(7);

      await expect(
        service.adjustVariantStock({ variantId: 'var1', delta: -10, reason: 'LOST' }, 'admin1'),
      ).rejects.toThrow(new BadRequestException('Cannot remove 10 units from variant "var1": only 7 available'));
      expect(ledger.availableAt).toHaveBeenCalledWith(tx, 'var1', 'store_main');
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('reports a missing variant as not found', async () => {
      tx.variant.count.mockResolvedValue(0);

      await expect(
        service.adjustVariantStock({ variantId: 'nope', delta: -1, reason: 'LOST' }, 'admin1'),
      ).rejects.toThrow(NotFoundException);
      expect(ledger.adjustAt).not.toHaveBeenCalled();
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
        () => service.adjustVariantStock({ variantId: 'var1', delta: -3, reason: 'DAMAGED', note: 'Torn' }, 'admin1'),
        movement({ id: 'mv2', reason: 'ADJUSTMENT', adjustmentReason: 'DAMAGED', onHandDelta: -3, note: 'Torn' }),
        {
          entity: 'Variant',
          entityId: 'var1',
          details: expect.objectContaining({
            stockMovementId: 'mv2',
            kind: 'ADJUSTMENT',
            onHandDelta: -3,
            adjustmentReason: 'DAMAGED',
          }),
        },
      ],
    ])('%s audits the stock change on the transaction that moved the stock', async (_name, act, moved, expected) => {
      ledger.receive.mockResolvedValue(moved);
      ledger.adjustAt.mockResolvedValue(moved);

      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({ action: 'STOCK_ADJUSTMENT', userId: 'admin1', ...expected }, tx);
    });
  });
});
