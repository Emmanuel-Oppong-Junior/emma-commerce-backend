import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CodRiskService } from './cod-risk.service';

const PHONE = '+233244123456';
const verifiedUser = { phoneNumber: PHONE, phoneVerifiedAt: new Date(), phoneVerifiedNumber: PHONE };
const address = { phone: null, ghanaPostGps: 'GA-183-8164', street: '1 Main St', city: 'Accra' };

function setup(user: object = verifiedUser) {
  const repository = {
    findSettings: jest.fn().mockResolvedValue({
      storeId: 'store1',
      storeOffersCod: true,
      maxOpenOrdersPerPhone: 2,
      maxOrderTotal: new Prisma.Decimal(2000),
    }),
    findUserPhone: jest.fn().mockResolvedValue(user),
    lockPhone: jest.fn(),
    isBlacklisted: jest.fn().mockResolvedValue(false),
    zoneCodEnabled: jest.fn().mockResolvedValue(true),
    countOpenCodOrders: jest.fn().mockResolvedValue(0),
    updateSettings: jest.fn(),
  };
  const audit = {
    record: jest.fn(async (change: (tx: unknown) => Promise<unknown>, entry: (result: unknown) => unknown) => {
      const result = await change('tx');
      audit.entries.push(entry(result));
      return result;
    }),
    entries: [] as unknown[],
  };
  const metrics = { recordCodGateRefusal: jest.fn() };
  const logger = { warn: jest.fn() };
  const service = new CodRiskService(repository as never, audit as never, metrics as never, logger as never);
  return { service, repository, audit, metrics, logger };
}

const checkout = { grandTotal: new Prisma.Decimal(150), shippingZoneId: 'zone1', address, contactPhone: '0201234567' };

describe('CodRiskService', () => {
  describe('availability', () => {
    it('is available when every gate passes, reading the zone, the blacklist and the open orders', async () => {
      const { service, repository } = setup();

      await expect(service.availability('u1', checkout)).resolves.toEqual({
        available: true,
        reason: null,
        phoneVerified: true,
      });
      expect(repository.zoneCodEnabled).toHaveBeenCalledWith('zone1', undefined);
      expect(repository.countOpenCodOrders).toHaveBeenCalledWith(PHONE, 'u1', undefined);
      expect(repository.isBlacklisted).toHaveBeenCalledWith(
        expect.arrayContaining([
          { kind: 'PHONE', value: PHONE },
          { kind: 'PHONE', value: '+233201234567' },
          { kind: 'GHANA_POST_GPS', value: 'GA1838164' },
        ]),
        undefined,
      );
    });

    it('reports an unverified phone without counting orders', async () => {
      const { service, repository } = setup({ ...verifiedUser, phoneVerifiedNumber: '+233200000000' });

      await expect(service.availability('u1', checkout)).resolves.toEqual({
        available: false,
        reason: 'PHONE_NOT_VERIFIED',
        phoneVerified: false,
      });
      expect(repository.countOpenCodOrders).not.toHaveBeenCalled();
    });

    it('skips the zone gate for pickup', async () => {
      const { service, repository } = setup();
      repository.zoneCodEnabled.mockResolvedValue(false);

      const result = await service.availability('u1', { ...checkout, shippingZoneId: null, address: null });

      expect(result.available).toBe(true);
      expect(repository.zoneCodEnabled).not.toHaveBeenCalled();
    });
  });

  describe('assertCodAllowed', () => {
    it('locks the verified phone, reads on the transaction and returns the phone', async () => {
      const { service, repository, metrics } = setup();

      await expect(service.assertCodAllowed('tx' as never, 'u1', checkout)).resolves.toBe(PHONE);

      expect(repository.lockPhone).toHaveBeenCalledWith('tx', PHONE);
      expect(repository.lockPhone.mock.invocationCallOrder[0]).toBeLessThan(
        repository.countOpenCodOrders.mock.invocationCallOrder[0],
      );
      expect(repository.countOpenCodOrders).toHaveBeenCalledWith(PHONE, 'u1', 'tx');
      expect(metrics.recordCodGateRefusal).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the open-order cap',
        (r: ReturnType<typeof setup>['repository']) => r.countOpenCodOrders.mockResolvedValue(2),
        'OPEN_ORDER_LIMIT',
      ],
      [
        'the blacklist',
        (r: ReturnType<typeof setup>['repository']) => r.isBlacklisted.mockResolvedValue(true),
        'BLOCKED',
      ],
      [
        'the zone',
        (r: ReturnType<typeof setup>['repository']) => r.zoneCodEnabled.mockResolvedValue(false),
        'SHIPPING_ZONE_EXCLUDED',
      ],
    ])('refuses on %s with COD_NOT_AVAILABLE and counts the refusal', async (_case, arrange, gate) => {
      const { service, repository, metrics } = setup();
      arrange(repository);

      const error = await service.assertCodAllowed('tx' as never, 'u1', checkout).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'COD_NOT_AVAILABLE', codReason: gate },
      });
      expect(metrics.recordCodGateRefusal).toHaveBeenCalledWith(gate);
    });

    it('refuses the grand total above the cap', async () => {
      const { service } = setup();
      await expect(
        service.assertCodAllowed('tx' as never, 'u1', { ...checkout, grandTotal: new Prisma.Decimal('2000.01') }),
      ).rejects.toMatchObject({ response: { extensions: { codReason: 'ORDER_TOTAL_ABOVE_CAP' } } });
    });

    it('refuses an unverified phone with PHONE_NOT_VERIFIED, without a lock, and logs no phone', async () => {
      const { service, repository, metrics, logger } = setup({
        phoneNumber: PHONE,
        phoneVerifiedAt: null,
        phoneVerifiedNumber: null,
      });

      await expect(service.assertCodAllowed('tx' as never, 'u1', checkout)).rejects.toMatchObject({
        response: { extensions: { reason: 'PHONE_NOT_VERIFIED' } },
      });
      expect(repository.lockPhone).not.toHaveBeenCalled();
      expect(metrics.recordCodGateRefusal).toHaveBeenCalledWith('PHONE_NOT_VERIFIED');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('244123456');
    });
  });

  describe('updateSettings', () => {
    it('validates before writing', async () => {
      const { service, repository } = setup();
      await expect(service.updateSettings({ maxOpenOrdersPerPhone: 0 }, 'owner')).rejects.toThrow(BadRequestException);
      expect(repository.updateSettings).not.toHaveBeenCalled();
    });

    it('audits the changed limits', async () => {
      const { service, repository, audit } = setup();
      repository.updateSettings.mockResolvedValue({
        storeId: 'store1',
        storeOffersCod: true,
        maxOpenOrdersPerPhone: 3,
        maxOrderTotal: new Prisma.Decimal(2000),
      });

      await service.updateSettings({ maxOpenOrdersPerPhone: 3 }, 'owner');

      expect(audit.entries).toEqual([
        {
          entity: 'Store',
          entityId: 'store1',
          action: 'UPDATE',
          userId: 'owner',
          details: { codRiskSettings: { maxOpenOrdersPerPhone: { from: 2, to: 3 } } },
        },
      ]);
    });
  });
});
