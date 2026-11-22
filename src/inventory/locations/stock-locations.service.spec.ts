import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StockLocationsService } from './stock-locations.service';
import { createAuditServiceMock } from '../../../test/helpers/audit.helper';

const tx = { tx: true };

function location(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, type: 'WAREHOUSE', isActive: true, isDefault: false, ...overrides };
}

describe('StockLocationsService', () => {
  let repository: Record<string, jest.Mock>;
  let ledgerRepository: { defaultLocationId: jest.Mock };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: StockLocationsService;

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      findByIds: jest.fn(),
      update: jest.fn().mockImplementation(async (_tx, id, data) => location(id, data)),
      clearDefault: jest.fn(),
      hasHistory: jest.fn().mockResolvedValue(false),
      delete: jest.fn(),
      targetExists: jest.fn().mockResolvedValue(true),
      fulfilmentList: jest.fn().mockResolvedValue([]),
      replaceFulfilmentList: jest.fn(),
      fulfilmentLocations: jest.fn().mockResolvedValue([]),
      lockLevels: jest.fn().mockResolvedValue([]),
    };
    ledgerRepository = { defaultLocationId: jest.fn().mockResolvedValue('main') };
    audit = createAuditServiceMock();
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    service = new StockLocationsService(
      repository as never,
      ledgerRepository as never,
      prisma as never,
      audit as never,
    );
  });

  describe('update', () => {
    it('refuses to deactivate the default location', async () => {
      repository.findById.mockResolvedValue(location('main', { isDefault: true }));

      await expect(service.update('main', { isActive: false }, 'admin')).rejects.toThrow(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('refuses to unset the default directly', async () => {
      repository.findById.mockResolvedValue(location('main', { isDefault: true }));

      await expect(service.update('main', { isDefault: false }, 'admin')).rejects.toThrow(BadRequestException);
    });

    it('refuses to make an inactive location the default', async () => {
      repository.findById.mockResolvedValue(location('b', { isActive: false }));

      await expect(service.update('b', { isDefault: true }, 'admin')).rejects.toThrow(BadRequestException);
      expect(repository.clearDefault).not.toHaveBeenCalled();
    });

    it('moves the default flag, taking it off the old default first, and audits the change', async () => {
      repository.findById.mockResolvedValue(location('b'));

      await service.update('b', { isDefault: true }, 'admin');

      expect(repository.clearDefault).toHaveBeenCalledWith(tx);
      expect(repository.update).toHaveBeenCalledWith(tx, 'b', expect.objectContaining({ isDefault: true }));
      expect(repository.clearDefault.mock.invocationCallOrder[0]).toBeLessThan(
        repository.update.mock.invocationCallOrder[0],
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'StockLocation', entityId: 'b', action: 'UPDATE', userId: 'admin' }),
        tx,
      );
    });

    it('deactivates a location that is not the default', async () => {
      repository.findById.mockResolvedValue(location('b'));

      await expect(service.update('b', { isActive: false }, 'admin')).resolves.toMatchObject({ isActive: false });
    });
  });

  describe('delete', () => {
    it('refuses the default location', async () => {
      repository.findById.mockResolvedValue(location('main', { isDefault: true }));

      await expect(service.delete('main', 'admin')).rejects.toThrow(ConflictException);
    });

    it('refuses a location with stock history', async () => {
      repository.findById.mockResolvedValue(location('b'));
      repository.hasHistory.mockResolvedValue(true);

      await expect(service.delete('b', 'admin')).rejects.toThrow(/deactivate it instead/);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('deletes an unused location and audits it', async () => {
      repository.findById.mockResolvedValue(location('b'));

      await service.delete('b', 'admin');

      expect(repository.delete).toHaveBeenCalledWith(tx, 'b');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE', entityId: 'b' }), tx);
    });

    it('reports an unknown location', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.delete('x', 'admin')).rejects.toThrow(NotFoundException);
    });
  });

  describe('setFulfilmentLocations', () => {
    it('refuses duplicates', async () => {
      await expect(service.setFulfilmentLocations({ shippingZoneId: 'z' }, ['a', 'a'], 'admin')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses an unknown location', async () => {
      repository.findByIds.mockResolvedValue([location('a')]);

      await expect(service.setFulfilmentLocations({ shippingZoneId: 'z' }, ['a', 'b'], 'admin')).rejects.toThrow(
        new NotFoundException('Stock location "b" not found'),
      );
      expect(repository.replaceFulfilmentList).not.toHaveBeenCalled();
    });

    it('refuses an unknown pickup point', async () => {
      repository.targetExists.mockResolvedValue(false);

      await expect(service.setFulfilmentLocations({ pickupLocationId: 'p' }, [], 'admin')).rejects.toThrow(
        new NotFoundException('Pickup location "p" not found'),
      );
    });

    it('replaces the list in order and audits before and after', async () => {
      repository.findByIds.mockResolvedValue([location('a'), location('b')]);
      repository.fulfilmentList.mockResolvedValue([{ locationId: 'a', isActive: true }]);

      await service.setFulfilmentLocations({ shippingZoneId: 'z' }, ['b', 'a'], 'admin');

      expect(repository.replaceFulfilmentList).toHaveBeenCalledWith(tx, { shippingZoneId: 'z' }, ['b', 'a']);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'ShippingZone',
          entityId: 'z',
          details: { fulfilmentLocations: { from: ['a'], to: ['b', 'a'] } },
        }),
        tx,
      );
    });
  });

  describe('candidatesFor', () => {
    it('is the default when the zone has no list', async () => {
      await expect(service.candidatesFor({ shippingZoneId: 'z' })).resolves.toEqual(['main']);
    });

    it('is the active listed locations in priority order', async () => {
      repository.fulfilmentList.mockResolvedValue([
        { locationId: 'b', isActive: true },
        { locationId: 'c', isActive: false },
        { locationId: 'main', isActive: true },
      ]);

      await expect(service.candidatesFor({ pickupLocationId: 'p' })).resolves.toEqual(['b', 'main']);
    });
  });

  describe('lockFulfilmentLocation', () => {
    const lines = [
      { variantId: 'v2', quantity: 1 },
      { variantId: 'v1', quantity: 2 },
    ];

    it('locks the lines’ levels at the candidates and picks the first that fills every line', async () => {
      repository.lockLevels.mockResolvedValue([
        { locationId: 'a', variantId: 'v1', onHand: 5, reserved: 0 },
        { locationId: 'b', variantId: 'v1', onHand: 5, reserved: 0 },
        { locationId: 'b', variantId: 'v2', onHand: 5, reserved: 0 },
      ]);

      await expect(service.lockFulfilmentLocation(tx as never, ['a', 'b'], lines)).resolves.toEqual({
        locationId: 'b',
      });
      expect(repository.lockLevels).toHaveBeenCalledWith(tx, ['v1', 'v2'], ['a', 'b']);
    });

    it('names the variant no candidate holds enough of', async () => {
      repository.lockLevels.mockResolvedValue([{ locationId: 'a', variantId: 'v1', onHand: 5, reserved: 0 }]);

      await expect(service.lockFulfilmentLocation(tx as never, ['a'], lines)).resolves.toEqual({
        locationId: null,
        shortVariantId: 'v2',
      });
    });
  });
});
