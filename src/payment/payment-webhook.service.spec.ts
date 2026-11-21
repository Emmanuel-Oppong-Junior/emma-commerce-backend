import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PAYSTACK_WEBHOOK_JOB, PaymentWebhookService } from './payment-webhook.service';
import { runWithCorrelation } from '../commons/correlation';
import { providerRegistryWith } from '../../test/helpers/payment-providers.helper';

const SECRET = 'sk_test_webhook_secret';

const sign = (raw: Buffer) => createHmac('sha512', SECRET).update(raw).digest('hex');
const signed = (raw: Buffer) => ({ 'x-paystack-signature': sign(raw) });
const body = (event: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify({ event, data }));

describe('PaymentWebhookService', () => {
  const storedEvent = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt1',
    provider: 'PAYSTACK',
    event: 'charge.success',
    reference: 'ref1',
    processedAt: null,
    ...overrides,
  });
  const webhookEvents = {
    record: jest.fn(),
    findById: jest.fn(),
    markProcessed: jest.fn(),
    recordFailure: jest.fn(),
  };
  const paymentService = { verifyPayment: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const queue = { add: jest.fn() };
  const metrics = { recordWebhookFailure: jest.fn() };
  const service = new PaymentWebhookService(
    webhookEvents as never,
    paymentService as never,
    providerRegistryWith({}, { secretKey: SECRET }),
    logger as never,
    queue as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    webhookEvents.record.mockResolvedValue({ created: true, event: storedEvent() });
    paymentService.verifyPayment.mockResolvedValue({ id: 'pay1' });
    queue.add.mockResolvedValue({ id: 'evt1' });
  });

  it('tags the processing job with the delivery request id', async () => {
    const raw = body('charge.success', { id: 42, reference: 'ref1' });

    await runWithCorrelation({ requestId: 'req-1' }, () => service.handlePaystackWebhook(raw, signed(raw)));

    expect(queue.add).toHaveBeenCalledWith(
      PAYSTACK_WEBHOOK_JOB,
      { webhookEventId: 'evt1', meta: { requestId: 'req-1' } },
      { jobId: 'evt1' },
    );
  });

  it('stores a signed charge event, then queues its processing under the stored id without settling inline', async () => {
    const raw = body('charge.success', { id: 42, reference: 'ref1', customer: { email: 'buyer@example.com' } });

    await service.handlePaystackWebhook(raw, signed(raw));

    expect(webhookEvents.record).toHaveBeenCalledWith({
      provider: 'PAYSTACK',
      event: 'charge.success',
      eventKey: 'charge.success:id:42',
      reference: 'ref1',
      payload: { event: 'charge.success', data: { id: 42, reference: 'ref1' } },
    });
    expect(queue.add).toHaveBeenCalledWith(PAYSTACK_WEBHOOK_JOB, { webhookEventId: 'evt1' }, { jobId: 'evt1' });
    expect(webhookEvents.record.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong signature', 'deadbeef'],
    ['no signature', undefined],
  ])('rejects %s with 401 and stores nothing', async (_label, signature) => {
    const raw = body('charge.success', { reference: 'ref1' });

    await expect(service.handlePaystackWebhook(raw, { 'x-paystack-signature': signature })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(webhookEvents.record).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(metrics.recordWebhookFailure).toHaveBeenCalledWith('invalid_signature');
  });

  it('rejects a request without a raw body', async () => {
    await expect(service.handlePaystackWebhook(undefined, { 'x-paystack-signature': 'sig' })).rejects.toThrow(
      BadRequestException,
    );
    expect(webhookEvents.record).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate of a processed event without queueing it again', async () => {
    webhookEvents.record.mockResolvedValue({ created: false, event: storedEvent({ processedAt: new Date() }) });
    const raw = body('charge.success', { reference: 'ref1' });

    await service.handlePaystackWebhook(raw, signed(raw));

    expect(queue.add).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it('queues a redelivered event that was stored but never processed under the same job id', async () => {
    webhookEvents.record.mockResolvedValue({ created: false, event: storedEvent() });
    const raw = body('charge.success', { reference: 'ref1' });

    await service.handlePaystackWebhook(raw, signed(raw));

    expect(queue.add).toHaveBeenCalledWith(PAYSTACK_WEBHOOK_JOB, { webhookEventId: 'evt1' }, { jobId: 'evt1' });
  });

  it('stores and acknowledges an event it does not handle, without contacting Paystack', async () => {
    webhookEvents.record.mockResolvedValue({
      created: true,
      event: storedEvent({ event: 'refund.processed', reference: 'ref1' }),
    });
    const raw = body('refund.processed', { id: 7, reference: 'ref1' });

    await service.handlePaystackWebhook(raw, signed(raw));

    expect(webhookEvents.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'refund.processed' }));
    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 0);
  });

  it('answers once the event is stored even when queueing fails, leaving it for the payment sweep', async () => {
    queue.add.mockRejectedValue(new Error('Redis connection lost'));
    const raw = body('charge.success', { reference: 'ref1' });

    await expect(service.handlePaystackWebhook(raw, signed(raw))).resolves.toBeUndefined();

    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('the payment sweep will process it'),
      'Redis connection lost',
      'PaymentWebhook',
    );
  });

  describe('processStoredEvent (the worker job)', () => {
    it('settles the stored reference once and marks the event processed', async () => {
      webhookEvents.findById.mockResolvedValue({ ...storedEvent(), attempts: 0 });

      await service.processStoredEvent('evt1');

      expect(webhookEvents.findById).toHaveBeenCalledWith('evt1');
      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(1);
      expect(paymentService.verifyPayment).toHaveBeenCalledWith('ref1');
      expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 1);
    });

    it('records the failed attempt and throws so the queue retries with backoff', async () => {
      webhookEvents.findById.mockResolvedValue({ ...storedEvent(), attempts: 0 });
      paymentService.verifyPayment.mockRejectedValue(new NotFoundException('Payment with reference "ref1" not found'));

      await expect(service.processStoredEvent('evt1')).rejects.toThrow(
        'Webhook processing failed | event: charge.success | reference: ref1 | id: evt1 | Payment with reference "ref1" not found',
      );
      expect(webhookEvents.recordFailure).toHaveBeenCalledWith('evt1', 1, 'Payment with reference "ref1" not found');
      expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
      expect(metrics.recordWebhookFailure).toHaveBeenCalledWith('settlement_failed');
    });

    it('does nothing for an event already processed (by the sweep or a redelivery)', async () => {
      webhookEvents.findById.mockResolvedValue({ ...storedEvent({ processedAt: new Date() }), attempts: 1 });

      await service.processStoredEvent('evt1');

      expect(paymentService.verifyPayment).not.toHaveBeenCalled();
      expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
    });

    it('skips, with a warning, an event that no longer exists', async () => {
      webhookEvents.findById.mockResolvedValue(null);

      await expect(service.processStoredEvent('gone')).resolves.toBeUndefined();

      expect(paymentService.verifyPayment).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('id: gone'), 'PaymentWebhook');
    });
  });

  describe('reprocessStoredEvent', () => {
    const stored = (overrides: Record<string, unknown> = {}) =>
      ({ ...storedEvent(), attempts: 3, ...overrides }) as never;

    it('settles the reference once and counts one attempt', async () => {
      await expect(service.reprocessStoredEvent(stored())).resolves.toBe('processed');

      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(1);
      expect(paymentService.verifyPayment).toHaveBeenCalledWith('ref1');
      expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 1);
    });

    it('records one failed attempt without retrying in process', async () => {
      paymentService.verifyPayment.mockRejectedValue(new NotFoundException('Payment with reference "ref1" not found'));

      await expect(service.reprocessStoredEvent(stored())).resolves.toBe('failed');

      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(1);
      expect(webhookEvents.recordFailure).toHaveBeenCalledWith('evt1', 1, 'Payment with reference "ref1" not found');
      expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
    });

    it('marks a non-settling event processed without verifying', async () => {
      await expect(service.reprocessStoredEvent(stored({ event: 'transfer.success' }))).resolves.toBe('skipped');

      expect(paymentService.verifyPayment).not.toHaveBeenCalled();
      expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 0);
    });
  });
});
