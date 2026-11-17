import { Prisma } from '@prisma/client';
import { AuditService, fieldChanges, fieldValues } from './audit.service';

function buildService() {
  const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
  const prisma = {
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { service: new AuditService(prisma as never), prisma, tx };
}

describe('AuditService', () => {
  describe('log', () => {
    it("writes the entry through the caller's transaction client", async () => {
      const { service, prisma, tx } = buildService();

      await service.log({ entity: 'Order', entityId: 'o1', action: 'DELETE', userId: 'admin1' }, tx as never);

      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: { entity: 'Order', entityId: 'o1', action: 'DELETE', userId: 'admin1', details: Prisma.JsonNull },
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('falls back to the shared client and stores a missing actor as null', async () => {
      const { service, prisma } = buildService();

      await service.log({ entity: 'Order', entityId: 'o1', action: 'UPDATE', details: { carrier: 'DHL' } });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: { entity: 'Order', entityId: 'o1', action: 'UPDATE', userId: null, details: { carrier: 'DHL' } },
      });
    });
  });

  describe('record', () => {
    it('runs the change and writes its audit entry on the same transaction, returning the change result', async () => {
      const { service, prisma, tx } = buildService();
      const change = jest.fn().mockResolvedValue({ id: 'c1', value: 5 });

      const result = await service.record(change, (coupon: { id: string }) => ({
        entity: 'Coupon',
        entityId: coupon.id,
        action: 'CREATE',
        userId: 'admin1',
      }));

      expect(result).toEqual({ id: 'c1', value: 5 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledWith(tx);
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: { entity: 'Coupon', entityId: 'c1', action: 'CREATE', userId: 'admin1', details: Prisma.JsonNull },
      });
    });

    it('fails the transaction when the audit write fails, so the change is rolled back', async () => {
      const { service, prisma, tx } = buildService();
      tx.auditLog.create.mockRejectedValue(new Error('audit insert failed'));

      await expect(
        service.record(jest.fn().mockResolvedValue({ id: 'c1' }), () => ({
          entity: 'Coupon',
          entityId: 'c1',
          action: 'DELETE',
        })),
      ).rejects.toThrow('audit insert failed');
      await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow('audit insert failed');
    });

    it('writes no audit entry when the change fails', async () => {
      const { service, tx } = buildService();

      await expect(
        service.record(jest.fn().mockRejectedValue(new Error('not found')), () => ({
          entity: 'Coupon',
          entityId: 'c1',
          action: 'DELETE',
        })),
      ).rejects.toThrow('not found');
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('fieldChanges', () => {
    it('lists only the fields that changed, with Decimal and Date values as JSON strings', () => {
      const before = { price: new Prisma.Decimal('10.00'), name: 'Mug', endsAt: new Date('2026-01-01T00:00:00Z') };
      const after = { price: new Prisma.Decimal('12.50'), name: 'Mug', endsAt: null as Date | null };

      expect(fieldChanges<Record<string, unknown>>(before, after, ['price', 'name', 'endsAt'])).toEqual({
        price: { from: '10', to: '12.5' },
        endsAt: { from: '2026-01-01T00:00:00.000Z', to: null },
      });
    });
  });

  describe('fieldValues', () => {
    it('picks the given fields as JSON-safe values, turning undefined into null', () => {
      expect(
        fieldValues({ fee: new Prisma.Decimal(15), cities: ['accra'], note: undefined }, ['fee', 'cities', 'note']),
      ).toEqual({
        fee: '15',
        cities: ['accra'],
        note: null,
      });
    });
  });
});
