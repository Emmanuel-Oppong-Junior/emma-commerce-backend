import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { TaxService } from './tax.service';
import { TaxRepository } from './tax.repository';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { Decimal } from '@prisma/client/runtime/client';

const vat = {
  id: 'tax1',
  name: 'VAT',
  rate: new Prisma.Decimal('0.15'),
  isActive: true,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
};

describe('TaxService', () => {
  let repository: jest.Mocked<
    Pick<TaxRepository, 'create' | 'update' | 'delete' | 'findById' | 'getTotalActiveRate' | 'repriceTaxableVariants'>
  >;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: TaxService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation(async (data) => ({ ...vat, ...data })),
      update: jest.fn().mockImplementation(async (id, data) => ({ ...vat, id, ...data })),
      delete: jest.fn().mockResolvedValue(vat),
      findById: jest.fn().mockResolvedValue(vat),
      getTotalActiveRate: jest.fn().mockResolvedValue(new Prisma.Decimal('0.15')),
      repriceTaxableVariants: jest.fn().mockResolvedValue(undefined),
    };
    audit = createAuditServiceMock();
    service = new TaxService(repository as never, audit as never);
  });

  it.each<[string, () => Promise<unknown>, object]>([
    [
      'create',
      () => service.create({ name: 'VAT', rate: new Decimal('0.15') }, 'admin1'),
      { action: 'CREATE', details: { after: { name: 'VAT', rate: '0.15', isActive: true } } },
    ],
    [
      'update',
      () => service.update('tax1', { rate: new Decimal('0.2') }, 'admin1'),
      { action: 'UPDATE', details: { changes: { rate: { from: '0.15', to: '0.2' } } } },
    ],
    [
      'delete',
      () => service.delete('tax1', 'admin1'),
      { action: 'DELETE', details: { before: { name: 'VAT', rate: '0.15', isActive: true } } },
    ],
  ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
    await act();

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      { entity: 'Tax', entityId: 'tax1', userId: 'admin1', ...expected },
      AUDIT_TX,
    );
  });

  it.each<[string, () => Promise<unknown>]>([
    ['create', () => service.create({ name: 'VAT', rate: new Decimal('0.15') }, 'admin1')],
    ['update', () => service.update('tax1', { rate: new Decimal('0.2') }, 'admin1')],
    ['delete', () => service.delete('tax1', 'admin1')],
  ])('%s reprices taxable products from the rate read on the audit transaction', async (_name, act) => {
    await act();

    expect(repository.getTotalActiveRate).toHaveBeenCalledWith(AUDIT_TX);
    expect(repository.repriceTaxableVariants).toHaveBeenCalledWith(new Prisma.Decimal('0.15'), AUDIT_TX);
  });

  it('fails the tax change without an audit entry when the reprice fails', async () => {
    const failure = new Error('reprice failed');
    repository.repriceTaxableVariants.mockRejectedValue(failure);

    await expect(service.create({ name: 'VAT', rate: new Decimal('0.15') }, 'admin1')).rejects.toBe(failure);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('writes the tax change on the audit transaction', async () => {
    await service.update('tax1', { isActive: false }, 'admin1');

    expect(repository.update).toHaveBeenCalledWith('tax1', { isActive: false }, AUDIT_TX);
  });

  it('rejects an update of an unknown tax without writing or repricing', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.update('missing', { rate: new Decimal('0.2') }, 'admin1')).rejects.toThrow(
      new NotFoundException('Tax "missing" not found'),
    );
    expect(repository.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(repository.repriceTaxableVariants).not.toHaveBeenCalled();
  });
});
