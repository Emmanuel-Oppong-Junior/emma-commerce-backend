import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentDto } from './create-payment.dto';

const errorsFor = (body: Record<string, unknown>) =>
  validate(plainToInstance(CreatePaymentDto, { orderId: 'order1', paymentMethod: 'CARD', ...body }));

describe('CreatePaymentDto', () => {
  it('accepts a request without a currency', async () => {
    await expect(errorsFor({})).resolves.toEqual([]);
  });

  it.each(['CARD', 'MOBILE_MONEY'])('accepts the online method %s', async (paymentMethod) => {
    await expect(errorsFor({ paymentMethod })).resolves.toEqual([]);
  });

  it.each(['card', 'CASH_ON_DELIVERY', undefined])('rejects paymentMethod %s', async (paymentMethod) => {
    const errors = await errorsFor({ paymentMethod });

    expect(errors.map((e) => e.property)).toEqual(['paymentMethod']);
  });

  it('accepts GHS', async () => {
    await expect(errorsFor({ currency: 'GHS' })).resolves.toEqual([]);
  });

  it('leaves the currency check to PaymentService, which knows the store currency', async () => {
    await expect(errorsFor({ currency: 'USD' })).resolves.toEqual([]);
  });

  it('rejects a currency that is not a string', async () => {
    const errors = await errorsFor({ currency: 5 });

    expect(errors.map((e) => e.property)).toEqual(['currency']);
  });

  it('accepts an idempotency key', async () => {
    await expect(errorsFor({ idempotencyKey: 'checkout-1' })).resolves.toEqual([]);
  });

  it.each(['', 'x'.repeat(256)])('rejects an empty or overlong idempotency key', async (idempotencyKey) => {
    const errors = await errorsFor({ idempotencyKey });

    expect(errors.map((e) => e.property)).toEqual(['idempotencyKey']);
  });
});
