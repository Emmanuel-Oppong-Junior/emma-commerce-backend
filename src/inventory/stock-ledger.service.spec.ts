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
  let lots: Record<string, jest.Mock>;
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
      // One active location: the variant's total available is what the level just changed to.
      activeAvailable: jest.fn(async () => {
        const { results } = repository.applyEffect.mock;
        const after = (await results[results.length - 1].value) as { onHand: number; reserved: number };
        return { available: after.onHand - after.reserved, locationActive: true };
      }),
    };
    outbox = { record: jest.fn() };
    lots = { isTracked: jest.fn().mockResolvedValue(false), findLots: jest.fn().mockResolvedValue([]) };
    service = new StockLedgerService(repository as never, outbox as never, lots as never, { warn: jest.fn() } as never);
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

  describe('transfers', () => {
    it('takes transferred units off available stock at the source as a negative TRANSFER', async () => {
      await service.transferOut(tx, 'var1', 'loc_a', 3, { refType: 'StockTransfer', refId: 't1' });

      expect(repository.ensureLevel).toHaveBeenCalledWith(tx, 'var1', 'loc_a');
      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var1', 'loc_a', {
        onHandDelta: -3,
        reservedDelta: 0,
        reason: 'TRANSFER',
      });
    });

    it('writes nothing when the source has too few units available', async () => {
      repository.applyEffect.mockResolvedValue(null);

      await expect(service.transferOut(tx, 'var1', 'loc_a', 3, {})).resolves.toBeNull();
      expect(repository.insertMovement).not.toHaveBeenCalled();
    });

    it('adds received units at the destination as a positive TRANSFER', async () => {
      await service.transferIn(tx, 'var1', 'loc_b', 3, { refType: 'StockTransfer', refId: 't1' });

      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: 'loc_b',
        onHandDelta: 3,
        reservedDelta: 0,
        reason: 'TRANSFER',
        refType: 'StockTransfer',
        refId: 't1',
      });
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

    it('measures the threshold on the total available across active locations', async () => {
      repository.applyEffect.mockResolvedValue({ onHand: 10, reserved: 5 });
      repository.activeAvailable.mockResolvedValue({ available: 25, locationActive: true });

      await service.reserve(tx, { variantId: 'var1', quantity: 2, orderId: 'o', orderItemId: 'oi', expiresAt: null });

      expect(repository.activeAvailable).toHaveBeenCalledWith(tx, 'var1', LOCATION);
      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('records the event with the summed total when it crosses the threshold', async () => {
      repository.activeAvailable.mockResolvedValue({ available: 4, locationActive: true });

      await service.adjust(tx, 'var1', -3, {});

      expect(outbox.record).toHaveBeenCalledWith(tx, {
        type: 'inventory.low_stock.v1',
        aggregateId: 'var1',
        payload: { variantId: 'var1', locationId: LOCATION, available: 4, movementId: 'mv1' },
      });
    });

    it('ignores a change at an inactive location, whose stock is not in the total', async () => {
      repository.activeAvailable.mockResolvedValue({ available: 4, locationActive: false });

      await service.adjust(tx, 'var1', -3, {}, 'loc_closed');

      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var1', 'loc_closed', expect.anything());
      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('does not look for a threshold when a sale leaves available stock unchanged', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE')]);
      repository.applyEffect.mockResolvedValue({ onHand: 1, reserved: 0 });

      await service.consumeOrder(tx, 'order1');

      expect(repository.findVariantForAlert).not.toHaveBeenCalled();
    });
  });

  describe('lot-tracked variants (P4-C.1)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const lot = (lotId: string, expiresInDays: number, onHand: number) => ({
      lotId,
      expiresAt: new Date(Date.now() + expiresInDays * DAY),
      createdAt: new Date('2026-01-01'),
      onHand,
    });

    beforeEach(() => {
      lots.isTracked.mockResolvedValue(true);
      lots.lockLevel = jest.fn().mockResolvedValue({ onHand: 10, reserved: 0 });
      lots.lockLots = jest.fn().mockResolvedValue([]);
      lots.ensureLotStock = jest.fn();
      lots.applyLotDelta = jest.fn().mockResolvedValue(true);
      lots.orderLotDraws = jest.fn().mockResolvedValue([]);
    });

    it('receives into the lot given: one level update, one movement with the lot', async () => {
      await service.receive(tx, 'var1', 5, 'RECEIPT', { actorId: 'a1' }, LOCATION, [{ lotId: 'lot1', quantity: 5 }]);

      expect(repository.applyEffect).toHaveBeenCalledWith(tx, 'var1', LOCATION, {
        onHandDelta: 5,
        reservedDelta: 0,
        reason: 'RECEIPT',
      });
      expect(lots.ensureLotStock).toHaveBeenCalledWith(tx, 'lot1', LOCATION);
      expect(lots.applyLotDelta).toHaveBeenCalledWith(tx, 'lot1', LOCATION, 5);
      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: LOCATION,
        onHandDelta: 5,
        reservedDelta: 0,
        reason: 'RECEIPT',
        actorId: 'a1',
        lotId: 'lot1',
      });
    });

    it('refuses a receipt without a lot', async () => {
      await expect(service.receive(tx, 'var1', 5, 'RECEIPT', {})).rejects.toThrow(
        'Variant "var1" tracks lots: give the lot number and expiry of the units added',
      );
      expect(repository.applyEffect).not.toHaveBeenCalled();
    });

    it('refuses a lot for an untracked variant', async () => {
      lots.isTracked.mockResolvedValue(false);

      await expect(
        service.receive(tx, 'var1', 5, 'RECEIPT', {}, LOCATION, [{ lotId: 'lot1', quantity: 5 }]),
      ).rejects.toThrow('Variant "var1" does not track lots; leave the lot out');
    });

    it('consumes a sale first expiry first, one SALE movement per lot', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE', 5)]);
      lots.lockLots.mockResolvedValue([lot('late', 60, 10), lot('soon', 5, 3)]);

      await service.consumeOrder(tx, 'order1');

      expect(repository.applyEffect).toHaveBeenCalledTimes(1);
      expect(lots.applyLotDelta).toHaveBeenNthCalledWith(1, tx, 'soon', LOCATION, -3);
      expect(lots.applyLotDelta).toHaveBeenNthCalledWith(2, tx, 'late', LOCATION, -2);
      const moved = repository.insertMovement.mock.calls.map(([, m]) => [m.lotId, m.onHandDelta, m.reservedDelta]);
      expect(moved).toEqual([
        ['soon', -3, -3],
        ['late', -2, -2],
      ]);
    });

    it('draws expired lots for a sale only when nothing fresher is left', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'ACTIVE', 4)]);
      lots.lockLots.mockResolvedValue([lot('expired', -1, 5), lot('fresh', 30, 1)]);

      await service.consumeOrder(tx, 'order1');

      const moved = repository.insertMovement.mock.calls.map(([, m]) => [m.lotId, m.onHandDelta]);
      expect(moved).toEqual([
        ['fresh', -1],
        ['expired', -3],
      ]);
    });

    it('puts a cancelled paid sale back into the lots the order drew from', async () => {
      repository.findReservations.mockResolvedValue([reservation('a', 'CONSUMED', 3)]);
      repository.claimReservation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      lots.orderLotDraws.mockResolvedValue([lot('b', 40, 2), lot('a', 20, 1)]);

      await service.releaseOrder(tx, 'order1', {});

      expect(lots.orderLotDraws).toHaveBeenCalledWith(tx, 'order1', 'var-a');
      const moved = repository.insertMovement.mock.calls.map(([, m]) => [m.reason, m.lotId, m.onHandDelta]);
      expect(moved).toEqual([
        ['RETURN_RESTOCK', 'a', 1],
        ['RETURN_RESTOCK', 'b', 2],
      ]);
    });

    it('ships only unexpired lots on a transfer and keeps what the reservations need', async () => {
      lots.lockLevel.mockResolvedValue({ onHand: 10, reserved: 4 });
      lots.lockLots.mockResolvedValue([lot('expired', -1, 4), lot('fresh', 30, 6)]);

      await expect(service.transferOut(tx, 'var1', LOCATION, 3, {})).resolves.toBeNull();
      await expect(service.transferOut(tx, 'var1', LOCATION, 2, {})).resolves.toMatchObject({ lotId: 'fresh' });
      expect(repository.applyEffect).toHaveBeenCalledTimes(1);
    });

    it('takes a removal from the lot named, refusing when that lot holds too few there', async () => {
      lots.lockLots.mockResolvedValue([lot('l1', 30, 2), lot('l2', 10, 9)]);
      const source = { adjustmentReason: 'DAMAGED' as const };

      await expect(
        service.adjustLots(tx, 'var1', LOCATION, -3, source, [{ lotId: 'l1', quantity: 3 }]),
      ).resolves.toBeNull();
      expect(repository.applyEffect).not.toHaveBeenCalled();

      const movements = await service.adjustLots(tx, 'var1', LOCATION, -2, source, [{ lotId: 'l1', quantity: 2 }]);
      expect(movements).toHaveLength(1);
      expect(lots.applyLotDelta).toHaveBeenCalledWith(tx, 'l1', LOCATION, -2);
    });

    it('refuses, writing nothing, a removal larger than the lots hold', async () => {
      lots.lockLots.mockResolvedValue([lot('l1', 30, 4)]);

      await expect(service.adjustAt(tx, 'var1', LOCATION, -5, { adjustmentReason: 'LOST' })).resolves.toBeNull();
      expect(repository.applyEffect).not.toHaveBeenCalled();
    });

    it('writes off expired lots up to the units not reserved, one EXPIRED movement per lot', async () => {
      lots.lockLevel.mockResolvedValue({ onHand: 9, reserved: 6 });
      lots.lockLots.mockResolvedValue([lot('expired', -1, 5), lot('fresh', 30, 4)]);

      await expect(service.writeOffExpiredLots(tx, 'var1', LOCATION, new Date())).resolves.toEqual({
        writtenOff: 3,
        blocked: 2,
      });
      expect(repository.insertMovement).toHaveBeenCalledWith(tx, {
        variantId: 'var1',
        locationId: LOCATION,
        onHandDelta: -3,
        reservedDelta: 0,
        reason: 'ADJUSTMENT',
        adjustmentReason: 'EXPIRED',
        refType: 'Lot',
        refId: 'expired',
        note: 'Lot expired',
        lotId: 'expired',
      });
    });

    it('leaves expired lots out of the units available at a location', async () => {
      repository.findLevel.mockResolvedValue({ onHand: 10, reserved: 1 });
      lots.findLots.mockResolvedValue([lot('expired', -1, 4), lot('fresh', 30, 6)]);

      await expect(service.available(tx, 'var1', LOCATION)).resolves.toBe(5);
    });
  });
});
