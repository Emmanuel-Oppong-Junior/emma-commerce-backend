import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException } from '@nestjs/common';
import {
  PaymentProvider,
  PaymentStatus,
  Prisma,
  Refund,
  RefundMethod,
  RefundReason,
  RefundStatus,
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { PaystackRequestRejected } from '../payment/paystack.client';
import { ProviderCredentialsRejected } from '../payment/providers/payment-provider.port';
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
    openForOrder: jest.fn(),
    openForReturnLines: jest.fn(),
    openForCancelledOrder: jest.fn(),
    findByReturnRequest: jest.fn(),
    claimForSending: jest.fn(),
    recordProcessed: jest.fn(),
    recordRejected: jest.fn(),
    noteUnknownOutcome: jest.fn(),
  };
  const paystack = { createRefund: jest.fn() };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const disputes = { assertRefundAllowed: jest.fn() };
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
      disputes as never,
    );
    repository.claimForSending.mockImplementation(async (_id, check, onClaimed) => {
      check(ledger, refund);
      await onClaimed(AUDIT_TX, refund);
      return { refund, ledger };
    });
    repository.recordProcessed.mockImplementation(async (id, providerRef, actorId, onRecorded) => {
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
    expect(repository.recordProcessed).toHaveBeenCalledWith('refund1', '3018284', 'admin1', expect.any(Function));
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

  it('neither claims nor calls Paystack when the payment is disputed', async () => {
    disputes.assertRefundAllowed.mockRejectedValueOnce(
      new ConflictException({
        message: 'Payment "pay1" has an unresolved dispute',
        extensions: { reason: 'PAYMENT_DISPUTED' },
      }),
    );

    await expect(service.send('refund1', 'admin1')).rejects.toThrow(ConflictException);
    expect(disputes.assertRefundAllowed).toHaveBeenCalledWith('refund1');
    expect(repository.claimForSending).not.toHaveBeenCalled();
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

  it('marks the refund FAILED but answers 503 when Paystack rejects the store credentials', async () => {
    const error = new ProviderCredentialsRejected('Paystack refund failed with HTTP 401: Invalid key');
    paystack.createRefund.mockRejectedValue(error);

    await expect(service.send('refund1', 'admin1')).rejects.toBe(error);
    expect(repository.recordRejected).toHaveBeenCalledWith(
      'refund1',
      "Paystack rejected the store's credentials; nothing was refunded",
      expect.any(Function),
    );
    expect(repository.noteUnknownOutcome).not.toHaveBeenCalled();
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

  describe('refundOrder', () => {
    const params = {
      orderId: 'order1',
      idempotencyKey: 'key-0001',
      lines: [{ orderItemId: 'item1', quantity: 1 }],
      shipping: false,
      amount: null,
      reason: RefundReason.DAMAGED,
      note: '  box crushed ',
    };
    const plan = {
      amount: new Prisma.Decimal('40.50'),
      taxAmount: null,
      shippingAmount: new Prisma.Decimal(0),
      lines: [],
    };
    const opened = (overrides: Partial<Refund> = {}) =>
      ({
        ...refund,
        returnRequestId: null,
        idempotencyKey: 'staff:key-0001',
        method: RefundMethod.PROVIDER,
        ...overrides,
      }) as Refund;
    const openWith = (result: Refund, replayed = false, checkLedger: RefundLedger = ledger) =>
      repository.openForOrder.mockImplementation(async (_request, check, onOpened) => {
        if (!replayed) {
          check(checkLedger, plan, result.method);
          await onOpened(AUDIT_TX, result);
        }
        return { refund: result, replayed };
      });

    it('records the refund under a namespaced key with the trimmed note, then sends it through the provider', async () => {
      openWith(opened());
      paystack.createRefund.mockResolvedValue({ id: '88', status: 'pending' });

      const result = await service.refundOrder(params, 'admin1');

      expect(repository.openForOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order1',
          idempotencyKey: 'staff:key-0001',
          note: 'box crushed',
          createdById: 'admin1',
          parts: { lines: params.lines, shipping: false, amount: null },
        }),
        expect.any(Function),
        expect.any(Function),
      );
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'PROCESSED', providerRef: '88' });
      expect(auditService.log.mock.calls[0][0]).toMatchObject({ entity: 'Refund', action: 'CREATE', userId: 'admin1' });
    });

    it('returns the refund a repeated key recorded without sending anything', async () => {
      openWith(opened({ status: RefundStatus.PROCESSED }), true);

      await expect(service.refundOrder(params, 'admin1')).resolves.toMatchObject({ status: 'PROCESSED' });
      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(repository.claimForSending).not.toHaveBeenCalled();
    });

    it('records a cash-on-delivery refund as cash handed back, without a provider call', async () => {
      const codLedger: RefundLedger = {
        ...ledger,
        attempt: { ...ledger.attempt, provider: PaymentProvider.CASH_ON_DELIVERY, reference: null },
        refunds: [],
      };
      openWith(opened({ method: RefundMethod.CASH, status: RefundStatus.PROCESSED }), false, codLedger);

      await expect(service.refundOrder(params, 'admin1')).resolves.toMatchObject({ method: 'CASH' });
      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(auditService.log.mock.calls[0][0]).toMatchObject({ action: 'REFUND' });
    });

    it('refuses a missing note for OTHER and a system reason before writing anything', async () => {
      await expect(service.refundOrder({ ...params, reason: RefundReason.OTHER, note: ' ' }, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.refundOrder({ ...params, reason: RefundReason.RETURN }, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.openForOrder).not.toHaveBeenCalled();
    });
  });
  describe('refundReturnLines', () => {
    const inspected = { id: 'return1', orderId: 'order1', status: 'INSPECTED' } as never;
    const plan = { amount: new Prisma.Decimal('40.50') };
    const openWith = (opened: Refund, openLedger: RefundLedger = ledger) =>
      repository.openForReturnLines.mockImplementation(async (_request, check, onOpened) => {
        check(openLedger, plan, opened.method);
        await onOpened(AUDIT_TX, opened, inspected);
        return opened;
      });

    it('records the refund of the units received, audits the return and the refund, then sends it', async () => {
      openWith({ ...refund, method: RefundMethod.PROVIDER, shippingAmount: new Prisma.Decimal(0) } as Refund);
      paystack.createRefund.mockResolvedValue({ id: '9', status: 'pending' });

      await service.refundReturnLines(inspected, { shipping: false, note: null }, 'admin1');

      expect(repository.openForReturnLines).toHaveBeenCalledWith(
        { returnRequestId: 'return1', shipping: false, actorId: 'admin1', note: null },
        expect.any(Function),
        expect.any(Function),
      );
      expect(auditService.log.mock.calls.slice(0, 2).map(([entry]) => [entry.entity, entry.action])).toEqual([
        ['ReturnRequest', 'STATUS_CHANGE'],
        ['Refund', 'CREATE'],
      ]);
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    });

    it('records a cash-on-delivery return refund as cash handed back, without a provider call', async () => {
      const codLedger: RefundLedger = {
        ...ledger,
        attempt: { ...ledger.attempt, provider: PaymentProvider.CASH_ON_DELIVERY, reference: null },
        refunds: [],
      };
      openWith(
        {
          ...refund,
          method: RefundMethod.CASH,
          status: RefundStatus.PROCESSED,
          shippingAmount: new Prisma.Decimal(0),
        } as Refund,
        codLedger,
      );

      await expect(
        service.refundReturnLines(inspected, { shipping: false, note: null }, 'admin1'),
      ).resolves.toMatchObject({
        method: 'CASH',
      });
      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(auditService.log.mock.calls[0][0]).toMatchObject({ action: 'REFUND', details: { to: 'REFUNDED' } });
    });

    it('resends the existing refund of a REFUND_PENDING return instead of opening another', async () => {
      repository.findByReturnRequest.mockResolvedValue(refund);
      paystack.createRefund.mockResolvedValue({ id: '9', status: 'pending' });

      await service.refundReturnLines(
        { ...(inspected as object), status: 'REFUND_PENDING' } as never,
        { shipping: false, note: null },
        'admin1',
      );

      expect(repository.openForReturnLines).not.toHaveBeenCalled();
      expect(repository.claimForSending).toHaveBeenCalledWith('refund1', expect.any(Function), expect.any(Function));
    });
  });

  it('records a cancelled paid order refund as PENDING with an audit row, on the cancel transaction', async () => {
    repository.openForCancelledOrder.mockImplementation(async (_tx, _orderId, onOpened) => {
      const pending = { ...refund, reason: RefundReason.ORDER_CANCELLED, returnRequestId: null } as Refund;
      await onOpened(AUDIT_TX, pending);
      return pending;
    });

    await service.openCancellationRefund(AUDIT_TX, 'order1', 'user1');

    expect(repository.openForCancelledOrder).toHaveBeenCalledWith(AUDIT_TX, 'order1', expect.any(Function));
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'Refund',
        action: 'CREATE',
        userId: 'user1',
        details: expect.objectContaining({ reason: 'ORDER_CANCELLED' }),
      }),
      AUDIT_TX,
    );
    expect(paystack.createRefund).not.toHaveBeenCalled();
  });
});
