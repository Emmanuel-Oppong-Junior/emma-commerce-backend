import { PaymentService } from '../../src/payment/payment.service';
import { providerRegistryWith } from '../helpers/payment-providers.helper';

interface PaystackVerifyData {
  status: string;
  amount: number;
  currency: string;
}

function buildPaymentService(
  payment: Record<string, unknown>,
  order: Record<string, unknown>,
  verified: PaystackVerifyData = { status: 'success', amount: 50000, currency: 'GHS' },
) {
  const repository = {
    findByReference: jest.fn().mockResolvedValue({ provider: 'PAYSTACK', ...payment }),
    findOrderById: jest.fn().mockResolvedValue(order),
    findByOrderId: jest.fn().mockResolvedValue(payment),
    findOrderWithUser: jest.fn().mockResolvedValue({ ...order, user: { email: 'customer@test.local' } }),
    updatePaymentWithStatus: jest.fn().mockResolvedValue({ ...payment, status: 'CAPTURED' }),
    updateOrderStatus: jest.fn(),
    delete: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'payment-2' }),
  };
  const paystack = {
    verifyTransaction: jest.fn().mockResolvedValue({ reference: payment.transactionId, ...verified }),
    initializeTransaction: jest.fn().mockResolvedValue({
      reference: 'ref-2',
      authorization_url: 'https://checkout.test/x',
      access_code: 'code',
    }),
  };
  const service = new PaymentService(
    repository as never,
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { log: jest.fn() } as never,
    providerRegistryWith(paystack),
    { getCurrency: jest.fn().mockResolvedValue('GHS') } as never,
  );
  return { service, repository, paystack };
}

describe('Payments (audit repro: PAY-01, PAY-02, PAY-03, PAY-05)', () => {
  it('PAY-01: re-verifying a successful reference does not move a DELIVERED order back to PROCESSING', async () => {
    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      amount: 500,
      currency: 'GHS',
      status: 'CAPTURED',
      transactionId: 'ref-1',
    };
    const order = { id: 'order-1', userId: 'user-1', status: 'COMPLETED', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, repository } = buildPaymentService(payment, order);

    await service.verifyPaymentAsUser('ref-1', 'user-1').catch(() => undefined);

    expect(repository.updateOrderStatus).not.toHaveBeenCalledWith('order-1', 'CONFIRMED');
  });

  it('PAY-05: a Paystack success for a smaller amount than the order total does not complete the payment', async () => {
    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      amount: 500,
      currency: 'GHS',
      status: 'PENDING',
      transactionId: 'ref-1',
    };
    const order = { id: 'order-1', userId: 'user-1', status: 'PENDING', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, repository } = buildPaymentService(payment, order, {
      status: 'success',
      amount: 100,
      currency: 'GHS',
    });

    await service.verifyPaymentAsUser('ref-1', 'user-1').catch(() => undefined);

    expect(repository.updatePaymentWithStatus).not.toHaveBeenCalledWith('payment-1', 'CAPTURED', expect.anything());
    expect(repository.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('PAY-02: payment cannot be started for a CANCELLED order', async () => {
    const order = { id: 'order-1', userId: 'user-1', status: 'CANCELLED', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, paystack } = buildPaymentService({}, order);
    (
      service as unknown as { paymentRepository: { findByOrderId: jest.Mock } }
    ).paymentRepository.findByOrderId.mockResolvedValue(null);

    await expect(
      service.initiatePayment('user-1', { orderId: 'order-1', paymentMethod: 'card', currency: 'GHS' }),
    ).rejects.toThrow();
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it('PAY-03: retrying payment keeps the earlier PENDING attempt so a late success on its reference can still be matched', async () => {
    const payment = { id: 'payment-1', orderId: 'order-1', status: 'PENDING', transactionId: 'ref-1' };
    const order = { id: 'order-1', userId: 'user-1', status: 'PENDING', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, repository } = buildPaymentService(payment, order);

    await service
      .initiatePayment('user-1', { orderId: 'order-1', paymentMethod: 'card', currency: 'GHS' })
      .catch(() => undefined);

    expect(repository.delete).not.toHaveBeenCalled();
  });
});
