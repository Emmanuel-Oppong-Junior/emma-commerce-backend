import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentWebhookService } from './payment-webhook.service';

describe('PaymentController', () => {
  let controller: PaymentController;
  const webhookService = { handlePaystackWebhook: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: {} },
        { provide: PaymentWebhookService, useValue: webhookService },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('hands the webhook the raw request bytes, not the parsed body', async () => {
    const rawBody = Buffer.from('{"event":"charge.success","data":{}}');

    const headers = { 'x-paystack-signature': 'sig' };

    await controller.paymentWebhookHandler({ rawBody, body: { parsed: true }, headers } as never);

    expect(webhookService.handlePaystackWebhook).toHaveBeenCalledWith(rawBody, headers);
  });
});
