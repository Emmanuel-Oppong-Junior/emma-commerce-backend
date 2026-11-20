import { Job } from 'bullmq';
import { PaymentWebhookProcessor } from './payment-webhook.processor';
import { PAYSTACK_WEBHOOK_JOB } from './payment-webhook.service';

describe('PaymentWebhookProcessor', () => {
  const webhooks = { processStoredEvent: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const processor = new PaymentWebhookProcessor(webhooks as never, logger as never);
  const job = (name = PAYSTACK_WEBHOOK_JOB) => ({ name, data: { webhookEventId: 'evt1' } }) as Job;

  beforeEach(() => jest.clearAllMocks());

  it('processes the stored event the job names', async () => {
    webhooks.processStoredEvent.mockResolvedValue(undefined);

    await processor.process(job());

    expect(webhooks.processStoredEvent).toHaveBeenCalledWith('evt1');
  });

  it('propagates a processing failure so the queue retries with backoff', async () => {
    webhooks.processStoredEvent.mockRejectedValue(new Error('Webhook processing failed'));

    await expect(processor.process(job())).rejects.toThrow('Webhook processing failed');
  });

  it('fails a job with an unknown name without processing anything', async () => {
    await expect(processor.process(job('paystack.webhook.v0'))).rejects.toThrow(
      'Unknown webhook job "paystack.webhook.v0"',
    );
    expect(webhooks.processStoredEvent).not.toHaveBeenCalled();
  });
});
