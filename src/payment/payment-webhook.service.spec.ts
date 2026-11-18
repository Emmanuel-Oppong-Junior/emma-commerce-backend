import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PaymentWebhookService, WEBHOOK_RETRY_DELAYS_MS } from './payment-webhook.service';

jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn().mockResolvedValue(undefined) }));

const SECRET = 'sk_test_webhook_secret';

const sign = (raw: Buffer) => createHmac('sha512', SECRET).update(raw).digest('hex');
const body = (event: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify({ event, data }));

describe('PaymentWebhookService', () => {
  const storedEvent = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt1',
    event: 'charge.success',
    reference: 'ref1',
    processedAt: null,
    ...overrides,
  });
  const webhookEvents = { record: jest.fn(), markProcessed: jest.fn(), recordFailure: jest.fn() };
  const paymentService = { verifyPayment: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { getOrThrow: jest.fn(() => SECRET) };
  const service = new PaymentWebhookService(
    webhookEvents as never,
    paymentService as never,
    config as never,
    logger as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    webhookEvents.record.mockResolvedValue({ created: true, event: storedEvent() });
    paymentService.verifyPayment.mockResolvedValue({ id: 'pay1' });
  });

  it('stores a signed charge event and settles its reference once', async () => {
    const raw = body('charge.success', { id: 42, reference: 'ref1', customer: { email: 'buyer@example.com' } });

    await service.handlePaystackWebhook(raw, sign(raw));

    expect(webhookEvents.record).toHaveBeenCalledWith({
      provider: 'PAYSTACK',
      event: 'charge.success',
      eventKey: 'charge.success:id:42',
      reference: 'ref1',
      payload: { event: 'charge.success', data: { id: 42, reference: 'ref1' } },
    });
    expect(paymentService.verifyPayment).toHaveBeenCalledWith('ref1');
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 1);
    expect(webhookEvents.record.mock.invocationCallOrder[0]).toBeLessThan(
      paymentService.verifyPayment.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['a wrong signature', 'deadbeef'],
    ['no signature', undefined],
  ])('rejects %s with 401 and stores nothing', async (_label, signature) => {
    const raw = body('charge.success', { reference: 'ref1' });

    await expect(service.handlePaystackWebhook(raw, signature)).rejects.toThrow(UnauthorizedException);
    expect(webhookEvents.record).not.toHaveBeenCalled();
    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
  });

  it('rejects a request without a raw body', async () => {
    await expect(service.handlePaystackWebhook(undefined, 'sig')).rejects.toThrow(BadRequestException);
    expect(webhookEvents.record).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate of a processed event without processing it again', async () => {
    webhookEvents.record.mockResolvedValue({ created: false, event: storedEvent({ processedAt: new Date() }) });
    const raw = body('charge.success', { reference: 'ref1' });

    await service.handlePaystackWebhook(raw, sign(raw));

    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it('processes a redelivered event that was stored but never processed', async () => {
    webhookEvents.record.mockResolvedValue({ created: false, event: storedEvent() });
    const raw = body('charge.success', { reference: 'ref1' });

    await service.handlePaystackWebhook(raw, sign(raw));

    expect(paymentService.verifyPayment).toHaveBeenCalledWith('ref1');
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 1);
  });

  it('stores and acknowledges an event it does not handle, without contacting Paystack', async () => {
    webhookEvents.record.mockResolvedValue({
      created: true,
      event: storedEvent({ event: 'refund.processed', reference: 'ref1' }),
    });
    const raw = body('refund.processed', { id: 7, reference: 'ref1' });

    await service.handlePaystackWebhook(raw, sign(raw));

    expect(webhookEvents.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'refund.processed' }));
    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 0);
  });

  it('retries a transient processing failure in-process and then succeeds', async () => {
    paymentService.verifyPayment
      .mockRejectedValueOnce(new Error('Paystack verify did not answer'))
      .mockResolvedValue({});
    const raw = body('charge.success', { reference: 'ref1' });

    await service.handlePaystackWebhook(raw, sign(raw));

    expect(paymentService.verifyPayment).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(WEBHOOK_RETRY_DELAYS_MS[0]);
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt1', 2);
    expect(webhookEvents.recordFailure).not.toHaveBeenCalled();
  });

  it('answers 503 after the retries are spent and leaves the stored event unprocessed for redelivery', async () => {
    paymentService.verifyPayment.mockRejectedValue(new NotFoundException('Payment with reference "ref1" not found'));
    const raw = body('charge.success', { reference: 'ref1' });

    await expect(service.handlePaystackWebhook(raw, sign(raw))).rejects.toThrow(ServiceUnavailableException);

    const attempts = WEBHOOK_RETRY_DELAYS_MS.length + 1;
    expect(paymentService.verifyPayment).toHaveBeenCalledTimes(attempts);
    expect(jest.mocked(sleep).mock.calls).toEqual(WEBHOOK_RETRY_DELAYS_MS.map((delay) => [delay]));
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
    expect(webhookEvents.recordFailure).toHaveBeenCalledWith(
      'evt1',
      attempts,
      'Payment with reference "ref1" not found',
    );
  });
});
