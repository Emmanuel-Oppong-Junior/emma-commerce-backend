import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentDto } from './create-payment.dto';

const errorsFor = (body: Record<string, unknown>) =>
  validate(plainToInstance(CreatePaymentDto, { orderId: 'order1', paymentMethod: 'card', ...body }));

describe('CreatePaymentDto', () => {
  it('accepts a request without a currency', async () => {
    await expect(errorsFor({})).resolves.toEqual([]);
  });

  it('accepts GHS', async () => {
    await expect(errorsFor({ currency: 'GHS' })).resolves.toEqual([]);
  });

  it.each(['USD', 'NGN', 'ghs'])('rejects %s so the client cannot choose the charge currency', async (currency) => {
    const errors = await errorsFor({ currency });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('currency');
    expect(Object.values(errors[0].constraints ?? {})).toEqual([
      'currency must be GHS; payments are charged in GHS only',
    ]);
  });

  it('accepts an idempotency key', async () => {
    await expect(errorsFor({ idempotencyKey: 'checkout-1' })).resolves.toEqual([]);
  });

  it.each(['', 'x'.repeat(256)])('rejects an empty or overlong idempotency key', async (idempotencyKey) => {
    const errors = await errorsFor({ idempotencyKey });

    expect(errors.map((e) => e.property)).toEqual(['idempotencyKey']);
  });
});
