import { Test, TestingModule } from '@nestjs/testing';
import { StoreService } from './store.service';
import { StoreRepository } from './store.repository';
import { AuditService } from '../commons/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Store } from '../generated/prisma/client';

const fixedDate = new Date('2026-11-18T00:00:00.000Z');
const store: Store = {
  id: 'store',
  singleton: true,
  legalName: 'My Store',
  tradingName: 'My Store',
  tin: null,
  vatRegistered: false,
  pricesIncludeTax: true,
  currency: 'GHS',
  supportEmail: null,
  supportPhone: null,
  nextOrderNumber: 10001,
  cardPaymentsEnabled: true,
  mobileMoneyPaymentsEnabled: true,
  cashOnDeliveryEnabled: true,
  cardPaymentProvider: 'PAYSTACK',
  mobileMoneyPaymentProvider: 'PAYSTACK',
  codMaxOpenOrdersPerPhone: 2,
  codMaxOrderTotal: new Prisma.Decimal(2000),
  returnWindowDays: 14,
  abandonedCartReminderDelayHours: 4,
  loyaltyEnabled: true,
  loyaltyEarnPointsPerCedi: 1,
  loyaltyRedeemPointsPerCedi: 100,
  loyaltyMinRedeemPoints: 500,
  loyaltyMaxRedeemPercent: 50,
  loyaltyPointsExpiryMonths: 12,
  createdAt: fixedDate,
  updatedAt: fixedDate,
};

describe('StoreService', () => {
  const tx = { store: { findFirst: jest.fn(), update: jest.fn() }, auditLog: { create: jest.fn() } };
  const prisma = { ...tx, $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
  let service: StoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [StoreService, StoreRepository, AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(StoreService);
  });

  it('reads the one store row', async () => {
    tx.store.findFirst.mockResolvedValue(store);

    await expect(service.getSettings()).resolves.toBe(store);
    expect(tx.store.findFirst).toHaveBeenCalledWith({ where: { singleton: true } });
  });

  it('reports a missing store row as a deployment error, not as a missing record', async () => {
    tx.store.findFirst.mockResolvedValue(null);

    await expect(service.getSettings()).rejects.toThrow('No Store row exists; apply the database migrations');
    await expect(service.getCurrency()).rejects.toThrow('No Store row exists; apply the database migrations');
  });

  it('returns the store currency', async () => {
    tx.store.findFirst.mockResolvedValue({ currency: 'GHS' });

    await expect(service.getCurrency()).resolves.toBe('GHS');
  });

  it('updates the settings and audits the changed fields on the same transaction', async () => {
    const updated = { ...store, tradingName: 'Emma Mart', tin: 'P0012345678', updatedAt: new Date() };
    tx.store.findFirst.mockResolvedValue(store);
    tx.store.update.mockResolvedValue(updated);

    const result = await service.updateSettings({ tradingName: 'Emma Mart', tin: 'P0012345678' }, 'super1');

    expect(result).toBe(updated);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.store.update).toHaveBeenCalledWith({
      where: { singleton: true },
      data: { tradingName: 'Emma Mart', tin: 'P0012345678' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        entity: 'Store',
        entityId: 'store',
        action: 'UPDATE',
        userId: 'super1',
        details: {
          changes: {
            tradingName: { from: 'My Store', to: 'Emma Mart' },
            tin: { from: null, to: 'P0012345678' },
          },
        },
      },
    });
  });

  it('writes nothing to the audit log when the update fails', async () => {
    tx.store.findFirst.mockResolvedValue(store);
    tx.store.update.mockRejectedValue(new Error('db down'));

    await expect(service.updateSettings({ vatRegistered: true }, 'super1')).rejects.toThrow('db down');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
