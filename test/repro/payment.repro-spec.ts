import { PaymentService } from '../../src/payment/payment.service';

jest.mock('paystack-api', () => jest.fn(() => ({ transaction: {} })));

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
    findByReference: jest.fn().mockResolvedValue(payment),
    findOrderById: jest.fn().mockResolvedValue(order),
    findByOrderId: jest.fn().mockResolvedValue(payment),
    findOrderWithUser: jest.fn().mockResolvedValue({ ...order, user: { email: 'customer@test.local' } }),
    updatePaymentWithStatus: jest.fn().mockResolvedValue({ ...payment, status: 'COMPLETED' }),
    updateOrderStatus: jest.fn(),
    delete: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'payment-2' }),
  };
  const service = new PaymentService(
    repository as never,
    { get: () => 'sk_test_placeholder' } as never,
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
  );
  const paystack = {
    transaction: {
      verify: jest.fn().mockResolvedValue({ status: true, data: { reference: payment.transactionId, ...verified } }),
      initialize: jest.fn().mockResolvedValue({
        status: true,
        data: { reference: 'ref-2', authorization_url: 'https://checkout.test/x', access_code: 'code' },
      }),
    },
  };
  (service as unknown as { paystack: unknown }).paystack = paystack;
  return { service, repository, paystack };
}

describe('Payments (audit repro: PAY-01, PAY-02, PAY-03, PAY-05)', () => {
  it('PAY-01: re-verifying a successful reference does not move a DELIVERED order back to PROCESSING', async () => {
    const payment = { id: 'payment-1', orderId: 'order-1', amount: 500, currency: 'GHS', status: 'COMPLETED', transactionId: 'ref-1' };
    const order = { id: 'order-1', userId: 'user-1', status: 'DELIVERED', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, repository } = buildPaymentService(payment, order);

    await service.verifyPaymentAsUser('ref-1', 'user-1').catch(() => undefined);

    expect(repository.updateOrderStatus).not.toHaveBeenCalledWith('order-1', 'PROCESSING');
  });

  it('PAY-05: a Paystack success for a smaller amount than the order total does not complete the payment', async () => {
    const payment = { id: 'payment-1', orderId: 'order-1', amount: 500, currency: 'GHS', status: 'PENDING', transactionId: 'ref-1' };
    const order = { id: 'order-1', userId: 'user-1', status: 'PENDING', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, repository } = buildPaymentService(payment, order, { status: 'success', amount: 100, currency: 'GHS' });

    await service.verifyPaymentAsUser('ref-1', 'user-1').catch(() => undefined);

    expect(repository.updatePaymentWithStatus).not.toHaveBeenCalledWith('payment-1', 'COMPLETED', expect.anything());
    expect(repository.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('PAY-02: payment cannot be started for a CANCELLED order', async () => {
    const order = { id: 'order-1', userId: 'user-1', status: 'CANCELLED', totalAmount: 500, paymentMethod: 'ONLINE' };
    const { service, paystack } = buildPaymentService({}, order);
    (service as unknown as { paymentRepository: { findByOrderId: jest.Mock } }).paymentRepository.findByOrderId.mockResolvedValue(null);

    await expect(
      service.initiatePayment('user-1', { orderId: 'order-1', paymentMethod: 'card', currency: 'GHS' }),
    ).rejects.toThrow();
    expect(paystack.transaction.initialize).not.toHaveBeenCalled();
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
