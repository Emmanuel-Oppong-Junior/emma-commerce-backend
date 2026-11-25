import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { LoyaltyService } from './loyalty.service';

const SETTINGS = {
  loyaltyEarnPointsPerCedi: 1,
  loyaltyRedeemPointsPerCedi: 100,
  loyaltyMinRedeemPoints: 500,
  loyaltyMaxRedeemPercent: 50,
  loyaltyPointsExpiryMonths: 12,
  referralReferrerPoints: 500,
  referralNewCustomerPoints: 500,
};

function build(user: { storeMemberships: { id: string }[] } | null = { storeMemberships: [] }) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user && { id: 'u1', ...user }) },
    loyaltyAccount: { findUnique: jest.fn().mockResolvedValue({ debt: 0 }) },
    loyaltyLot: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: 0 } }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    loyaltyTransaction: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  };
  const ledger = {
    adjust: jest.fn(),
    settings: jest
      .fn()
      .mockResolvedValueOnce(SETTINGS)
      .mockResolvedValue({ ...SETTINGS, loyaltyMinRedeemPoints: 1_000 }),
  };
  const audit = createAuditServiceMock();
  const features = { isEnabled: jest.fn().mockResolvedValue(true) };
  const service = new LoyaltyService(prisma as never, ledger as never, audit as never, features as never);
  return { service, ledger, audit };
}

describe('LoyaltyService (P6-L.1)', () => {
  it('adjusts points through the ledger and audits it in the same transaction', async () => {
    const { service, ledger, audit } = build();

    await service.adjust({ userId: 'u1', points: -250, reason: 'Duplicate credit' }, 'staff1');

    expect(ledger.adjust).toHaveBeenCalledWith(AUDIT_TX, 'u1', -250, 'Duplicate credit', 'staff1', expect.any(Date));
    expect(audit.log).toHaveBeenCalledWith(
      {
        entity: 'LoyaltyAccount',
        entityId: 'u1',
        action: 'UPDATE',
        userId: 'staff1',
        details: { points: -250, reason: 'Duplicate credit' },
      },
      AUDIT_TX,
    );
  });

  it('refuses staff accounts and unknown users', async () => {
    await expect(
      build({ storeMemberships: [{ id: 'm1' }] }).service.adjust({ userId: 'u1', points: 10, reason: 'x y z' }, 's'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(null).service.adjust({ userId: 'u1', points: 10, reason: 'x y z' }, 's')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('audits a settings change with the fields before and after', async () => {
    const { service, audit } = build();
    const tx = { store: { update: jest.fn().mockResolvedValue({ id: 'store1' }) } };
    audit.record.mockImplementationOnce(async (change, entry) => {
      const result = await change(tx as never);
      await audit.log(entry(result), tx as never);
      return result;
    });

    const after = await service.updateSettings({ minimumRedeemPoints: 1_000 }, 'owner1');

    expect(after.minimumRedeemPoints).toBe(1_000);
    expect(tx.store.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loyaltyMinRedeemPoints: 1_000 }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      {
        entity: 'Store',
        entityId: 'store1',
        action: 'UPDATE',
        userId: 'owner1',
        details: { changes: { loyaltyMinRedeemPoints: { from: 500, to: 1_000 } } },
      },
      tx,
    );
  });
});
