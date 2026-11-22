import { StockLedgerService } from './stock-ledger.service';
import { StockReservationStatus } from '../generated/prisma/client';

const tx = { tx: true } as never;
const LOCATION = 'store_main';

function reservation(id: string, status: StockReservationStatus, quantity = 2) {
  return { id, variantId: `var-${id}`, locationId: LOCATION, orderId: 'order1', quantity, status };
}

describe('StockLedgerService', () => {
  let repository: Record<string, jest.Mock>;
  let outbox: { record: jest.Mock };
  let service: StockLedgerService;

  beforeEach(() => {
    repository = {
      defaultLocationId: jest.fn().mockResolvedValue(LOCATION),
      ensureLevel: jest.fn(),
      applyEffect: jest.fn().mockResolvedValue({ onHand: 100, reserved: 0 }),
      findLevel: jest.fn(),
      insertMovement: jest.fn().mockImplementation(async (_tx, data) => ({ id: 'mv1', ...data })),
      createReservation: jest.fn(),
      findReservations: jest.fn().mockResolvedValue([]),
      claimReservation: jest.fn().mockResolvedValue(true),
      findVariantForAlert: jest.fn().mockResolvedValue({ lowStockThreshold: 5 }),
    };
    outbox = { record: jest.fn() };
    service = new StockLedgerService(repository as never, outbox as never);
  });

  describe('reserve', () => {
    const line = { variantId: 'var1', quantity: 2, orderId: 'order1', orderItemId: 'oi1', expiresAt: null };

    it('holds the units with a conditional update, a RESERVE movement and an ACTIVE reservation', async () => {
      await expect(service.reserve(tx, line, 'user1')).resolves.toBe(true);

      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var1', LOCATION, {
        onHandDelta: 0,
        reservedDelta: 2,
        reason: 'RESERVE',
      });
      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: LOCATION,
        onHandDelta: 0,
        reservedDelta: 2,
        reason: 'RESERVE',
        refType: 'Order',
        refId: 'order1',
        actorId: 'user1',
      });
      expect(repository.createReservation).toHaveBeenCalledWith(tx, { ...line, locationId: LOCATION });
    });

    it('writes nothing when too few units are available', async () => {
      repository.applyEffect.mockResolvedValue(null);

      await expect(service.reserve(tx, line)).resolves.toBe(false);
      expect(repository.insertMovement).not.toHaveBeenCalled();
      expect(repository.createReservation).not.toHaveBeenCalled();
    });
  });

  describe('consumeOrder', () => {
    it('consumes each ACTIVE reservation it wins, as a SALE', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE'), reservation('b', 'ACTIVE', 1)]);
      repository.claimReservation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.consumeOrder(tx, 'order1', 'admin1')).resolves.toBe(1);

      expect(repository.findReservations).toHaveBeenCalledWith(tx, 'order1', ['ACTIVE']);
      expect(repository.claimReservation).toHaveBeenCalledWith(tx, 'a', 'ACTIVE', 'CONSUMED');
      expect(repository.applyEffect).toHaveBeenCalledTimes(1);
      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var-a', LOCATION, {
        onHandDelta: -2,
        reservedDelta: -2,
        reason: 'SALE',
      });
    });

    it('fails loudly if the stock level refuses a consumption it must cover', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE')]);
      repository.applyEffect.mockResolvedValue(null);

      await expect(service.consumeOrder(tx, 'order1')).rejects.toThrow(/refused the SALE of reservation "a"/);
    });
  });

  describe('releaseOrder', () => {
    it('gives back an ACTIVE hold and restocks a CONSUMED reservation, each once', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE'), reservation('b', 'CONSUMED', 3)]);
      repository.claimReservation.mockImplementation(async (_tx, id: string, from: string) =>
        id === 'a' ? from === 'ACTIVE' : from === 'CONSUMED',
      );

      await expect(service.releaseOrder(tx, 'order1', { note: 'Order cancelled' })).resolves.toBe(2);

      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var-a', LOCATION, {
        onHandDelta: 0,
        reservedDelta: -2,
        reason: 'RELEASE',
      });
      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var-b', LOCATION, {
        onHandDelta: 3,
        reservedDelta: 0,
        reason: 'RETURN_RESTOCK',
      });
      expect(repository.insertMovement).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ variantId: 'var-b', refType: 'Order', refId: 'order1', note: 'Order cancelled' }),
      );
    });

    it('moves no stock for a reservation another request released first', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE')]);
      repository.claimReservation.mockResolvedValue(false);

      await expect(service.releaseOrder(tx, 'order1', {})).resolves.toBe(0);
      expect(repository.applyEffect).not.toHaveBeenCalled();
      expect(repository.insertMovement).not.toHaveBeenCalled();
    });
  });

  describe('adjust and receive', () => {
    it('adjusts on-hand stock at the default location, creating its level if needed', async () => {
      await service.adjust(tx, 'var1', -4, { actorId: 'admin1', note: 'Damaged' });

      expect(repository.ensureLevel).toHaveBeenCalledWith(tx, 'var1', LOCATION);
      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var1', LOCATION, {
        onHandDelta: -4,
        reservedDelta: 0,
        reason: 'ADJUSTMENT',
      });
    });

    it('returns null without a movement when an adjustment would eat into reserved units', async () => {
      repository.applyEffect.mockResolvedValue(null);

      await expect(service.adjust(tx, 'var1', -4, {})).resolves.toBeNull();
      expect(repository.insertMovement).not.toHaveBeenCalled();
    });

    it('adjusts at the given location and records the adjustment reason on the movement', async () => {
      await service.adjustAt(tx, 'var1', 'branch_2', -2, {
        actorId: 'a1',
        adjustmentReason: 'EXPIRED',
        note: 'Batch 7',
      });

      expect(repository.defaultLocationId).not.toHaveBeenCalled();
      expect(repository.ensureLevel).toHaveBeenCalledWith(tx, 'var1', 'branch_2');
      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: 'branch_2',
        onHandDelta: -2,
        reservedDelta: 0,
        reason: 'ADJUSTMENT',
        actorId: 'a1',
        adjustmentReason: 'EXPIRED',
        note: 'Batch 7',
      });
    });

    it('reads available stock at a given location', async () => {
      repository.findLevel.mockResolvedValueOnce({ onHand: 9, reserved: 4 }).mockResolvedValueOnce(null);

      await expect(service.availableAt(tx, 'var1', 'branch_2')).resolves.toBe(5);
      await expect(service.availableAt(tx, 'var2', 'branch_2')).resolves.toBe(0);
      expect(repository.findLevel).toHaveBeenCalledWith(tx, 'var1', 'branch_2');
    });

    it('receives stock as the given reason', async () => {
      await service.receive(tx, 'var1', 5, 'RECEIPT', { note: 'Initial stock' });

      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: LOCATION,
        onHandDelta: 5,
        reservedDelta: 0,
        reason: 'RECEIPT',
        note: 'Initial stock',
      });
      expect(outbox.record).not.toHaveBeenCalled();
    });
  });

  describe('low-stock event', () => {
    it('records inventory.low_stock.v1 once when available stock falls to the threshold', async () => {
      repository.applyEffect.mockResolvedValue({ onHand: 10, reserved: 5 });

      await service.reserve(tx, { variantId: 'var1', quantity: 2, orderId: 'o', orderItemId: 'oi', expiresAt: null });

      expect(outbox.record).toHaveBeenCalledWith(tx, {
        type: 'inventory.low_stock.v1',
        aggregateId: 'var1',
        payload: { variantId: 'var1', locationId: LOCATION, available: 5, movementId: 'mv1' },
      });
    });

    it('stays quiet below the threshold once crossed, and when stock goes up', async () => {
      repository.applyEffect.mockResolvedValue({ onHand: 10, reserved: 7 });
      await service.reserve(tx, { variantId: 'var1', quantity: 2, orderId: 'o', orderItemId: 'oi', expiresAt: null });

      repository.applyEffect.mockResolvedValue({ onHand: 4, reserved: 0 });
      await service.receive(tx, 'var1', 1, 'RECEIPT', {});

      expect(outbox.record).not.toHaveBeenCalled();
      expect(repository.findVariantForAlert).toHaveBeenCalledTimes(1);
    });

    it('does not look for a threshold when a sale leaves available stock unchanged', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE')]);
      repository.applyEffect.mockResolvedValue({ onHand: 1, reserved: 0 });

      await service.consumeOrder(tx, 'order1');

      expect(repository.findVariantForAlert).not.toHaveBeenCalled();
    });
  });
});
