import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CashService } from './cash.service';

const d = (value: string) => new Prisma.Decimal(value);
const tx = { tx: true };
const receivedAt = new Date('2025-11-22T18:00:00Z');

function build() {
  const repository = {
    runTransaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
    findRemittingRider: jest.fn().mockResolvedValue({ isActive: true, isStaff: true, hasCollections: true }),
    lockCollections: jest.fn().mockResolvedValue([
      { id: 'c1', riderId: 'r1', remittanceId: null, amount: d('250.50') },
      { id: 'c2', riderId: 'r1', remittanceId: null, amount: d('99.50') },
    ]),
    createRemittance: jest.fn().mockResolvedValue({ id: 'rem1', currency: 'GHS' }),
    linkCollections: jest.fn().mockResolvedValue(2),
    findRemittance: jest.fn(),
    findRiderCashRows: jest.fn().mockResolvedValue([]),
    findUncollectedDeliveries: jest.fn().mockResolvedValue({ count: 0, total: d('0'), orders: [] }),
  };
  repository.findRemittance.mockImplementation(async () => {
    const [data] = repository.createRemittance.mock.calls[repository.createRemittance.mock.calls.length - 1].slice(1);
    return { id: 'rem1', ...data, collections: [] };
  });
  const storeRepository = { findCurrency: jest.fn().mockResolvedValue('GHS') };
  const auditService = { log: jest.fn() };
  const outbox = { record: jest.fn() };
  const metrics = { recordCodRemittanceDiscrepancy: jest.fn() };
  const logger = { log: jest.fn() };
  const service = new CashService(
    repository as never,
    storeRepository as never,
    auditService as never,
    outbox as never,
    metrics as never,
    logger as never,
  );
  return { service, repository, auditService, outbox, metrics };
}

const params = { riderId: 'r1', amount: d('350'), collectionIds: ['c1', 'c2'], receivedAt };

describe('CashService.recordRemittance', () => {
  it('records a matching remittance, links its collections and audits it, with no discrepancy event or metric', async () => {
    const { service, repository, auditService, outbox, metrics } = build();

    const remittance = await service.recordRemittance(params, 'cashier1');

    expect(repository.lockCollections).toHaveBeenCalledWith(tx, ['c1', 'c2']);
    expect(repository.createRemittance).toHaveBeenCalledWith(tx, {
      riderId: 'r1',
      receivedById: 'cashier1',
      amount: d('350'),
      expectedAmount: d('350'),
      discrepancy: d('0'),
      currency: 'GHS',
      note: null,
      receivedAt,
    });
    expect(repository.linkCollections).toHaveBeenCalledWith(tx, 'rem1', 'r1', ['c1', 'c2']);
    expect(auditService.log).toHaveBeenCalledWith(
      {
        entity: 'CashRemittance',
        entityId: 'rem1',
        action: 'CREATE',
        userId: 'cashier1',
        details: {
          riderId: 'r1',
          amount: '350.00',
          expectedAmount: '350.00',
          discrepancy: '0.00',
          currency: 'GHS',
          collectionIds: ['c1', 'c2'],
          receivedAt: '2025-11-22T18:00:00.000Z',
        },
      },
      tx,
    );
    expect(outbox.record).not.toHaveBeenCalled();
    expect(metrics.recordCodRemittanceDiscrepancy).not.toHaveBeenCalled();
    expect(remittance.id).toBe('rem1');
  });

  it('records a short remittance with its note, a discrepancy event and the SHORT metric', async () => {
    const { service, repository, auditService, outbox, metrics } = build();

    await service.recordRemittance({ ...params, amount: d('330'), note: ' Lost on the way ' }, 'cashier1');

    expect(repository.createRemittance).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ discrepancy: d('-20'), note: 'Lost on the way' }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ discrepancy: '-20.00', note: 'Lost on the way' }),
      }),
      tx,
    );
    expect(outbox.record).toHaveBeenCalledWith(tx, {
      type: 'cod.remittance_discrepancy.v1',
      aggregateId: 'rem1',
      payload: { remittanceId: 'rem1', riderId: 'r1', kind: 'SHORT' },
    });
    expect(metrics.recordCodRemittanceDiscrepancy).toHaveBeenCalledWith('SHORT');
  });

  it('refuses a discrepancy without a note before writing anything', async () => {
    const { service, repository, auditService, metrics } = build();

    await expect(service.recordRemittance({ ...params, amount: d('360') }, 'cashier1')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.createRemittance).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
    expect(metrics.recordCodRemittanceDiscrepancy).not.toHaveBeenCalled();
  });

  it('refuses a rider who is neither staff nor ever collected cash', async () => {
    const { service, repository } = build();
    repository.findRemittingRider.mockResolvedValue({ isActive: true, isStaff: false, hasCollections: false });

    await expect(service.recordRemittance(params, 'cashier1')).rejects.toThrow(BadRequestException);
    expect(repository.lockCollections).not.toHaveBeenCalled();
  });

  it('refuses with CONFLICT, rolling back, when a collection is no longer linkable', async () => {
    const { service, repository, auditService, metrics } = build();
    repository.linkCollections.mockResolvedValue(1);

    await expect(service.recordRemittance(params, 'cashier1')).rejects.toThrow(ConflictException);
    expect(auditService.log).not.toHaveBeenCalled();
    expect(metrics.recordCodRemittanceDiscrepancy).not.toHaveBeenCalled();
  });

  it('records an adjusting entry (cash, no collections) as all over, with its note', async () => {
    const { service, repository, outbox } = build();
    repository.lockCollections.mockResolvedValue([]);
    repository.linkCollections.mockResolvedValue(0);

    await service.recordRemittance(
      { riderId: 'r1', amount: d('20'), collectionIds: [], note: 'Rest of Monday' },
      'cashier1',
    );

    expect(repository.createRemittance).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ expectedAmount: d('0'), discrepancy: d('20'), note: 'Rest of Monday' }),
    );
    expect(outbox.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ payload: expect.objectContaining({ kind: 'OVER' }) }),
    );
  });
});

describe('CashService.report', () => {
  it('refuses a reversed range and otherwise combines the rider rows with the uncollected deliveries', async () => {
    const { service, repository } = build();
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-12-01T00:00:00Z');

    await expect(service.report({ from: to, to: from, first: 20 })).rejects.toThrow(BadRequestException);
    const report = await service.report({ from, to, first: 20, riderId: 'r1' });

    expect(repository.findRiderCashRows).toHaveBeenCalledWith(from, to, 'r1');
    expect(repository.findUncollectedDeliveries).toHaveBeenCalledWith(from, to);
    expect(report).toMatchObject({ from, to, riders: [], uncollectedDeliveries: { count: 0, orders: [] } });
  });
});
