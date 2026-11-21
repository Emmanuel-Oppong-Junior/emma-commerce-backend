import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException } from '@nestjs/common';
import { PaymentProvider, PaymentStatus, Prisma, Refund, RefundStatus } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { PaystackRequestRejected } from '../payment/paystack.client';
import { providerRegistryWith } from '../../test/helpers/payment-providers.helper';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { RefundLedger } from './refund-cap';
import { RefundRepository } from './refund.repository';
import { RefundsService } from './refunds.service';

const refund = {
  id: 'refund1',
  attemptId: 'attempt1',
  returnRequestId: 'return1',
  amount: new Prisma.Decimal('40.50'),
  currency: 'GHS',
  status: RefundStatus.PENDING,
  providerRef: null,
  failureReason: null,
  idempotencyKey: 'return:return1',
} as unknown as Refund;

const ledger: RefundLedger = {
  attempt: {
    id: 'attempt1',
    status: PaymentStatus.CAPTURED,
    provider: PaymentProvider.PAYSTACK,
    reference: 'txn_123',
    amount: new Prisma.Decimal(100),
    currency: 'GHS',
  },
  refunds: [refund],
};

describe('RefundsService', () => {
  const repository = {
    findAll: jest.fn(),
    openForReturn: jest.fn(),
    claimForSending: jest.fn(),
    recordProcessed: jest.fn(),
    recordRejected: jest.fn(),
    noteUnknownOutcome: jest.fn(),
  };
  const paystack = { createRefund: jest.fn() };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: RefundsService;

  beforeEach(() => {
    jest.clearAllMocks();
    auditService = createAuditServiceMock();
    service = new RefundsService(
      repository as unknown as RefundRepository,
      providerRegistryWith(paystack),
      auditService as unknown as AuditService,
      logger as unknown as LoggerService,
    );
    repository.claimForSending.mockImplementation(async (_id, check, onClaimed) => {
      check(ledger, refund);
      await onClaimed(AUDIT_TX, refund);
      return { refund, ledger };
    });
    repository.recordProcessed.mockImplementation(async (id, providerRef, onRecorded) => {
      const recorded = {
        refund: { ...refund, status: RefundStatus.PROCESSED, providerRef },
        returnRequest: { id: 'return1', orderId: 'order1', status: 'REFUNDED' },
      };
      await onRecorded(AUDIT_TX, recorded);
      return recorded;
    });
    repository.recordRejected.mockImplementation(async (id, failureReason, onRecorded) => {
      const failed = { ...refund, status: RefundStatus.FAILED, failureReason };
      await onRecorded(AUDIT_TX, failed);
      return failed;
    });
  });

  it('claims the refund, calls Paystack once in subunits, and records the provider refund id with audit rows', async () => {
    paystack.createRefund.mockResolvedValue({ id: '3018284', status: 'pending' });

    const result = await service.send('refund1', 'admin1');

    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(paystack.createRefund).toHaveBeenCalledWith({ transaction: 'txn_123', amount: 4050 });
    expect(repository.recordProcessed).toHaveBeenCalledWith('refund1', '3018284', expect.any(Function));
    expect(result.returnRequest?.status).toBe('REFUNDED');
    expect(auditService.log.mock.calls).toEqual([
      [
        {
          entity: 'Refund',
          entityId: 'refund1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: {
            from: 'PENDING',
            to: 'SENDING',
            attemptId: 'attempt1',
            returnRequestId: 'return1',
            amount: '40.5',
            currency: 'GHS',
          },
        },
        AUDIT_TX,
      ],
      [
        {
          entity: 'Refund',
          entityId: 'refund1',
          action: 'REFUND',
          userId: 'admin1',
          details: {
            from: 'SENDING',
            to: 'PROCESSED',
            amount: '40.5',
            currency: 'GHS',
            providerReference: 'txn_123',
            providerRefundId: '3018284',
          },
        },
        AUDIT_TX,
      ],
      [
        {
          entity: 'ReturnRequest',
          entityId: 'return1',
          action: 'REFUND',
          userId: 'admin1',
          details: {
            orderId: 'order1',
            from: 'REFUND_PENDING',
            to: 'REFUNDED',
            amount: '40.5',
            providerReference: 'txn_123',
            providerRefundId: '3018284',
          },
        },
        AUDIT_TX,
      ],
    ]);
  });

  it('never calls Paystack when the claim fails', async () => {
    repository.claimForSending.mockRejectedValue(new ConflictException('Refund "refund1" is SENDING'));

    await expect(service.send('refund1', 'admin1')).rejects.toThrow(ConflictException);
    expect(paystack.createRefund).not.toHaveBeenCalled();
  });

  it('never calls Paystack when the cap check refuses the claim', async () => {
    repository.claimForSending.mockImplementation(async (_id, check) => {
      check({ ...ledger, attempt: { ...ledger.attempt, amount: new Prisma.Decimal(40) } }, refund);
    });

    await expect(service.send('refund1', 'admin1')).rejects.toThrow(BadRequestException);
    expect(paystack.createRefund).not.toHaveBeenCalled();
  });

  it('marks a refund Paystack refused as FAILED, audited, and reports that nothing was refunded', async () => {
    paystack.createRefund.mockRejectedValue(
      new PaystackRequestRejected('Paystack refund failed with HTTP 400: Transaction has been fully reversed'),
    );

    await expect(service.send('refund1', 'admin1')).rejects.toThrow(
      'Paystack refused refund "refund1": Paystack refund failed with HTTP 400: Transaction has been fully reversed. Nothing was refunded; it can be sent again.',
    );
    expect(repository.recordRejected).toHaveBeenCalledWith(
      'refund1',
      'Paystack refund failed with HTTP 400: Transaction has been fully reversed',
      expect.any(Function),
    );
    expect(auditService.log).toHaveBeenLastCalledWith(
      {
        entity: 'Refund',
        entityId: 'refund1',
        action: 'STATUS_CHANGE',
        userId: 'admin1',
        details: {
          from: 'SENDING',
          to: 'FAILED',
          reason: 'Paystack refund failed with HTTP 400: Transaction has been fully reversed',
        },
      },
      AUDIT_TX,
    );
    expect(repository.recordProcessed).not.toHaveBeenCalled();
  });

  it.each([
    ['a timeout', new GatewayTimeoutException('Paystack refund did not answer within 8000 ms')],
    ['a 5xx or unreadable answer', new BadGatewayException('Paystack refund failed with HTTP 502')],
  ])('leaves the refund SENDING after %s, because Paystack may have created it', async (_case, error) => {
    paystack.createRefund.mockRejectedValue(error);

    await expect(service.send('refund1', 'admin1')).rejects.toBe(error);
    expect(repository.noteUnknownOutcome).toHaveBeenCalledWith('refund1', `Outcome unknown: ${error.message}`);
    expect(repository.recordRejected).not.toHaveBeenCalled();
    expect(repository.recordProcessed).not.toHaveBeenCalled();
  });

  it('processPendingRefund sends the refund and returns it', async () => {
    paystack.createRefund.mockResolvedValue({ id: '77', status: 'pending' });

    await expect(service.processPendingRefund('refund1', 'admin1')).resolves.toMatchObject({
      id: 'refund1',
      status: 'PROCESSED',
      providerRef: '77',
    });
  });
});
