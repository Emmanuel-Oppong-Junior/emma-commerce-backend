import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { DisputeNotice, DisputeStage } from './dispute-notice';
import { DisputesService } from './disputes.service';

describe('DisputesService', () => {
  const tx = { tx: true };
  const repository = {
    runTransaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
    findAttemptByReference: jest.fn(),
    findAttempt: jest.fn(),
    lockByProviderId: jest.fn(),
    lockById: jest.fn(),
    create: jest.fn(),
    transition: jest.fn(),
    update: jest.fn(),
    addNote: jest.fn(),
    findById: jest.fn(),
    findForAttempt: jest.fn(),
  };
  const entries: unknown[] = [];
  const auditService = {
    record: jest.fn(async (change: (t: unknown) => Promise<unknown>, entry: (r: unknown) => unknown) => {
      const result = await change(tx);
      entries.push(entry(result));
      return result;
    }),
  };
  const outbox = { record: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const service = new DisputesService(repository as never, auditService as never, outbox as never, logger as never);

  const attempt = {
    id: 'pay-1',
    orderId: 'order-1',
    provider: 'PAYSTACK',
    status: 'CAPTURED',
    amount: new Prisma.Decimal(100),
    currency: 'GHS',
  };
  const dispute = (overrides: Record<string, unknown> = {}) => ({
    id: 'dsp-1',
    attemptId: 'pay-1',
    orderId: 'order-1',
    source: 'PROVIDER',
    status: 'AWAITING_EVIDENCE',
    amount: new Prisma.Decimal(100),
    currency: 'GHS',
    providerDisputeId: '9001',
    evidenceDueAt: null,
    ...overrides,
  });
  const notice = (overrides: Partial<DisputeNotice> = {}): DisputeNotice => ({
    stage: DisputeStage.OPENED,
    providerDisputeId: '9001',
    reference: 'ref-1',
    amount: '100.00',
    currency: 'GHS',
    category: 'chargeback',
    status: 'AWAITING_EVIDENCE',
    providerStatus: 'awaiting-merchant-feedback',
    evidenceDueAt: '2026-12-05T18:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    entries.length = 0;
    repository.findAttemptByReference.mockResolvedValue(attempt);
    repository.findAttempt.mockResolvedValue(attempt);
    repository.transition.mockResolvedValue(true);
  });

  describe('applyProviderNotice', () => {
    it('creates an unknown dispute in the notice status with its opening history row and the opened event', async () => {
      repository.lockByProviderId.mockResolvedValue(null);
      repository.create.mockResolvedValue(dispute());

      await service.applyProviderNotice('PAYSTACK', notice(), 'evt-1');

      expect(repository.create).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          attemptId: 'pay-1',
          orderId: 'order-1',
          providerDisputeId: '9001',
          status: 'AWAITING_EVIDENCE',
        }),
        {
          source: 'PROVIDER',
          providerStatus: 'awaiting-merchant-feedback',
          webhookEventId: 'evt-1',
          from: null,
          to: 'AWAITING_EVIDENCE',
        },
      );
      expect(outbox.record).toHaveBeenCalledWith(tx, {
        type: 'payment.dispute_opened.v1',
        aggregateId: 'dsp-1',
        payload: { disputeId: 'dsp-1', paymentId: 'pay-1', orderId: 'order-1', source: 'PROVIDER' },
      });
      expect(repository.transition).not.toHaveBeenCalled();
    });

    it('opens a dispute first seen at its resolution as OPEN, then resolves it', async () => {
      repository.lockByProviderId.mockResolvedValue(null);
      repository.create.mockResolvedValue(dispute({ status: 'OPEN' }));

      await service.applyProviderNotice('PAYSTACK', notice({ stage: DisputeStage.RESOLVED, status: 'WON' }), 'evt-1');

      expect(repository.create).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ status: 'OPEN' }),
        expect.anything(),
      );
      expect(repository.transition).toHaveBeenCalledWith(
        tx,
        'dsp-1',
        expect.objectContaining({ from: 'OPEN', to: 'WON' }),
        expect.any(Date),
      );
    });

    it('changes nothing for a repeated notice and ignores a late one the table does not allow', async () => {
      repository.lockByProviderId.mockResolvedValue(dispute({ evidenceDueAt: new Date('2026-12-05T18:00:00.000Z') }));
      await service.applyProviderNotice('PAYSTACK', notice(), 'evt-2');

      repository.lockByProviderId.mockResolvedValue(dispute({ status: 'WON' }));
      await service.applyProviderNotice(
        'PAYSTACK',
        notice({ stage: DisputeStage.REMINDED, evidenceDueAt: null }),
        'evt-3',
      );

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(repository.transition).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Late dispute notice ignored'), 'Disputes');
    });

    it('keeps the status of an unmapped provider status, with a warning to set it by hand', async () => {
      repository.lockByProviderId.mockResolvedValue(dispute());

      await service.applyProviderNotice('PAYSTACK', notice({ status: null, providerStatus: 'archived' }), 'evt-4');

      expect(repository.transition).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('provider status: archived'), 'Disputes');
    });

    it('throws NOT_FOUND for a reference that is not ours, so the job retries', async () => {
      repository.findAttemptByReference.mockResolvedValue(null);

      await expect(service.applyProviderNotice('PAYSTACK', notice(), 'evt-5')).rejects.toThrow(NotFoundException);
    });
  });

  describe('staff changes (audit trail)', () => {
    it('records a dispute by hand with an audit row and the opened event', async () => {
      repository.create.mockResolvedValue(dispute({ source: 'STAFF', status: 'OPEN' }));
      repository.findById.mockResolvedValue({ ...dispute({ source: 'STAFF', status: 'OPEN' }), notes: [], events: [] });

      await service.recordDispute({ paymentId: 'pay-1', amount: new Prisma.Decimal(40) }, 'staff-1');

      expect(repository.create).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          source: 'STAFF',
          createdById: 'staff-1',
          amount: new Prisma.Decimal(40),
          currency: 'GHS',
        }),
        { from: null, to: 'OPEN', source: 'STAFF', actorId: 'staff-1' },
      );
      expect(entries).toEqual([
        expect.objectContaining({ entity: 'Dispute', entityId: 'dsp-1', action: 'CREATE', userId: 'staff-1' }),
      ]);
      expect(outbox.record).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an amount above the captured amount', { amount: new Prisma.Decimal('100.01') }, BadRequestException],
      ['a payment that captured nothing', { status: 'PENDING' }, ConflictException],
      ['a cash-on-delivery payment', { provider: 'CASH_ON_DELIVERY' }, BadRequestException],
    ])('refuses %s', async (_label, change, error) => {
      const { amount, ...attemptChange } = change as { amount?: Prisma.Decimal };
      repository.findAttempt.mockResolvedValue({ ...attempt, ...attemptChange });

      await expect(
        service.recordDispute({ paymentId: 'pay-1', amount: amount ?? new Prisma.Decimal(10) }, 'staff-1'),
      ).rejects.toThrow(error);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('moves a dispute through the table with an audit row, and refuses a move it does not allow', async () => {
      repository.lockById.mockResolvedValue(dispute({ status: 'OPEN' }));
      repository.findById.mockResolvedValue({ ...dispute({ status: 'UNDER_REVIEW' }), notes: [], events: [] });

      await service.updateStatus('dsp-1', 'UNDER_REVIEW', 'Evidence sent', 'staff-1');

      expect(repository.transition).toHaveBeenCalledWith(
        tx,
        'dsp-1',
        { from: 'OPEN', to: 'UNDER_REVIEW', source: 'STAFF', actorId: 'staff-1', note: 'Evidence sent' },
        null,
      );
      expect(entries).toEqual([
        expect.objectContaining({
          action: 'STATUS_CHANGE',
          details: { from: 'OPEN', to: 'UNDER_REVIEW', note: 'Evidence sent' },
        }),
      ]);

      repository.lockById.mockResolvedValue(dispute({ status: 'WON' }));
      await expect(service.updateStatus('dsp-1', 'LOST', null, 'staff-1')).rejects.toThrow(ConflictException);
    });

    it('appends an evidence note with an audit row', async () => {
      repository.lockById.mockResolvedValue(dispute());
      repository.addNote.mockResolvedValue({ id: 'note-1' });
      repository.findById.mockResolvedValue({ ...dispute(), notes: [], events: [] });

      await service.addNote('dsp-1', 'Signed delivery note', 'staff-1');

      expect(repository.addNote).toHaveBeenCalledWith(tx, 'dsp-1', 'staff-1', 'Signed delivery note');
      expect(entries).toEqual([expect.objectContaining({ action: 'UPDATE', details: { noteAdded: 'note-1' } })]);
    });
  });
  describe('assertNewRefundAllowed', () => {
    const ledger = {
      attempt: { ...attempt, provider: 'PAYSTACK' as const, status: 'CAPTURED' as const, reference: 'ref-1' },
      refunds: [{ id: 'rf-1', amount: new Prisma.Decimal(30), status: 'PROCESSED' as const, idempotencyKey: 'k' }],
    };

    it('reads the disputes on the caller transaction and refuses while one is unresolved', async () => {
      repository.findForAttempt.mockResolvedValue([{ id: 'dsp-1', status: 'OPEN', amount: new Prisma.Decimal(100) }]);

      await expect(
        service.assertNewRefundAllowed(tx as never, ledger as never, new Prisma.Decimal(10)),
      ).rejects.toMatchObject({ response: { extensions: { reason: 'PAYMENT_DISPUTED' } } });
      expect(repository.findForAttempt).toHaveBeenCalledWith(tx, 'pay-1');
    });

    it('counts a lost chargeback and the earlier refunds against what is left', async () => {
      repository.findForAttempt.mockResolvedValue([{ id: 'dsp-1', status: 'LOST', amount: new Prisma.Decimal(60) }]);

      await expect(
        service.assertNewRefundAllowed(tx as never, ledger as never, new Prisma.Decimal(10)),
      ).resolves.toBeUndefined();
      await expect(
        service.assertNewRefundAllowed(tx as never, ledger as never, new Prisma.Decimal('10.01')),
      ).rejects.toThrow(ConflictException);
    });
  });
});
