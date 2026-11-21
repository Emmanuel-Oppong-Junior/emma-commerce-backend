import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { providerRegistryWith, TEST_PAYSTACK_SECRET } from '../../../test/helpers/payment-providers.helper';
import { PaystackRequestRejected } from '../paystack.client';
import { PaymentProvider, ProviderCapabilities, ProviderRequestRejected } from './payment-provider.port';
import { OnlinePaymentMethod } from '../settings/payment-methods';

const paystackClient = {
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  createRefund: jest.fn(),
  listTransactions: jest.fn(),
};
const registry = providerRegistryWith(paystackClient, { callbackUrl: 'https://shop.test/paid' });

const sign = (raw: Buffer, secret = TEST_PAYSTACK_SECRET) => createHmac('sha512', secret).update(raw).digest('hex');
const checkout = {
  method: OnlinePaymentMethod.CARD,
  email: 'buyer@example.com',
  amount: new Prisma.Decimal('125.50'),
  currency: 'GHS',
  reference: 'r1',
};
const listRequest = { from: new Date(0), to: new Date(1), status: 'success' as const, page: 1, perPage: 10 };

/** Every adapter: an operation its capabilities rule out is refused before anything is sent. */
describe.each([
  ['PAYSTACK', registry.get('PAYSTACK')],
  ['CASH_ON_DELIVERY', registry.get('CASH_ON_DELIVERY')],
] as const)('PaymentProvider contract: %s', (name, provider: PaymentProvider) => {
  beforeEach(() => jest.clearAllMocks());

  it('is registered under its own name with a label', () => {
    expect(provider.name).toBe(name);
    expect(provider.label).not.toBe('');
  });

  const refusedWhenUnsupported: [keyof ProviderCapabilities, () => Promise<unknown>][] = [
    ['onlineCheckout', () => provider.initialize(checkout)],
    ['refunds', () => provider.refund({ reference: 'r1', amount: new Prisma.Decimal(1) })],
    ['webhooks', () => provider.parseWebhook(Buffer.from('{}'), {})],
    ['transactionList', () => provider.listTransactions(listRequest)],
  ];
  it.each(refusedWhenUnsupported)('refuses %s when it lacks the capability', async (capability, call) => {
    if (provider.capabilities[capability]) return;
    await expect(call()).rejects.toThrow(BadRequestException);
    Object.values(paystackClient).forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });

  it('never settles a payment from an event it cannot receive', () => {
    if (provider.capabilities.webhooks) return;
    expect(provider.settlesPayment('charge.success')).toBe(false);
  });
});

describe('PaystackAdapter', () => {
  const paystack = registry.get('PAYSTACK');

  beforeEach(() => jest.clearAllMocks());

  it('supports checkout, refunds, webhooks and the transaction list', () => {
    expect(paystack.capabilities).toEqual({
      onlineCheckout: true,
      refunds: true,
      webhooks: true,
      transactionList: true,
    });
  });

  it('opens a checkout in pesewas with the callback URL and keeps only the reference and access code', async () => {
    paystackClient.initializeTransaction.mockResolvedValue({
      authorization_url: 'https://checkout.paystack.com/x',
      access_code: 'ac',
      reference: 'r1',
    });

    await expect(paystack.initialize(checkout)).resolves.toEqual({
      authorizationUrl: 'https://checkout.paystack.com/x',
      details: { reference: 'r1', access_code: 'ac' },
    });
    expect(paystackClient.initializeTransaction).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      amount: 12550,
      currency: 'GHS',
      reference: 'r1',
      callback_url: 'https://shop.test/paid',
      channels: ['card'],
    });
  });

  it('verifies a reference and drops customer and card data from the stored details', async () => {
    paystackClient.verifyTransaction.mockResolvedValue({
      reference: 'r1',
      status: 'success',
      amount: 12550,
      currency: 'GHS',
      channel: 'card',
      customer: { email: 'buyer@example.com' },
      authorization: { authorization_code: 'AUTH_x' },
    });

    const { verification, details } = await paystack.verify('r1');

    expect(verification).toEqual({ reference: 'r1', status: 'success', amount: 12550, currency: 'GHS' });
    expect(details).toEqual({
      reference: 'r1',
      status: 'success',
      amount: 12550,
      currency: 'GHS',
      channel: 'card',
      paid_at: null,
      gateway_response: null,
    });
  });

  it('refuses a verification answered for another reference', async () => {
    paystackClient.verifyTransaction.mockResolvedValue({ reference: 'other', status: 'success' });

    await expect(paystack.verify('r1')).rejects.toThrow(BadGatewayException);
  });

  it('sends a refund in pesewas and returns the provider refund id', async () => {
    paystackClient.createRefund.mockResolvedValue({ id: '991', status: 'pending' });

    await expect(paystack.refund({ reference: 'r1', amount: new Prisma.Decimal('40.50') })).resolves.toBe('991');
    expect(paystackClient.createRefund).toHaveBeenCalledWith({ transaction: 'r1', amount: 4050 });
  });

  it('surfaces a Paystack refusal as the port refusal', async () => {
    paystackClient.createRefund.mockRejectedValue(new PaystackRequestRejected('Transaction already refunded'));

    await expect(paystack.refund({ reference: 'r1', amount: new Prisma.Decimal(1) })).rejects.toBeInstanceOf(
      ProviderRequestRejected,
    );
  });

  it('accepts a webhook signed over the raw body with the secret key', async () => {
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 5, reference: 'r1' } }));

    await expect(paystack.parseWebhook(raw, { 'x-paystack-signature': sign(raw) })).resolves.toEqual({
      event: 'charge.success',
      eventKey: 'charge.success:id:5',
      reference: 'r1',
      payload: { event: 'charge.success', data: { id: 5, reference: 'r1' } },
    });
  });

  it.each([
    ['another secret', (raw: Buffer) => ({ 'x-paystack-signature': sign(raw, 'sk_test_other') })],
    ['no signature', () => ({})],
    ['a repeated header', (raw: Buffer) => ({ 'x-paystack-signature': [sign(raw), sign(raw)] })],
  ])('rejects a webhook signed with %s as unauthorized', async (_label, headers) => {
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'r1' } }));

    await expect(paystack.parseWebhook(raw, headers(raw))).rejects.toMatchObject({ status: 401 });
  });

  it('settles payments on charge events only', () => {
    expect(paystack.settlesPayment('charge.success')).toBe(true);
    expect(paystack.settlesPayment('charge.failed')).toBe(true);
    expect(paystack.settlesPayment('refund.processed')).toBe(false);
  });

  it('lists transactions through the client', async () => {
    const page = { transactions: [{ reference: 'r1', status: 'success', amount: 100, currency: 'GHS' }], pageCount: 1 };
    paystackClient.listTransactions.mockResolvedValue(page);

    await expect(paystack.listTransactions(listRequest)).resolves.toBe(page);
    expect(paystackClient.listTransactions).toHaveBeenCalledWith(listRequest);
  });
});

describe('PaymentProviderRegistry', () => {
  it('resolves each provider an attempt can name to its adapter', () => {
    expect(registry.get('PAYSTACK').label).toBe('Paystack');
    expect(registry.get('CASH_ON_DELIVERY').capabilities.onlineCheckout).toBe(false);
  });

  it('fails loudly for a provider without an adapter', () => {
    expect(() => registry.get('FLUTTERWAVE' as never)).toThrow('No payment provider adapter for "FLUTTERWAVE"');
  });
});
