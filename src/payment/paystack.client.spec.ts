import { BadGatewayException, GatewayTimeoutException } from '@nestjs/common';
import { PAYSTACK_TIMEOUT_MS, PaystackClient } from './paystack.client';

const jsonResponse = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('PaystackClient', () => {
  const config = { getOrThrow: jest.fn(() => 'sk_test_client_secret') };
  let fetchMock: jest.SpyInstance;
  let client: PaystackClient;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    client = new PaystackClient(config as never);
  });

  afterEach(() => fetchMock.mockRestore());

  describe('initializeTransaction', () => {
    const request = { email: 'buyer@example.com', amount: 10000, currency: 'GHS', reference: 'ref1' };

    it('posts the request with the secret key and a timeout, and returns the checkout', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'Authorization URL created',
          data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'ref1' },
        }),
      );

      await expect(client.initializeTransaction(request)).resolves.toEqual({
        authorization_url: 'https://checkout.paystack.com/abc',
        access_code: 'abc',
        reference: 'ref1',
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.paystack.co/transaction/initialize');
      expect(init).toMatchObject({
        method: 'POST',
        body: JSON.stringify(request),
        headers: { Authorization: 'Bearer sk_test_client_secret', 'Content-Type': 'application/json' },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(PAYSTACK_TIMEOUT_MS);
      timeout.mockRestore();
    });

    it('rejects a success envelope without an authorization URL', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: true, data: { reference: 'ref1' } }));

      await expect(client.initializeTransaction(request)).rejects.toThrow(BadGatewayException);
    });
  });

  describe('verifyTransaction', () => {
    it('gets the transaction by URL-encoded reference and returns its data', async () => {
      const data = { reference: 'ref/1', status: 'success', amount: 10000, currency: 'GHS' };
      fetchMock.mockResolvedValue(jsonResponse(200, { status: true, message: 'Verification successful', data }));

      await expect(client.verifyTransaction('ref/1')).resolves.toEqual(data);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.paystack.co/transaction/verify/ref%2F1');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    });

    it('maps a timeout to 504', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      await expect(client.verifyTransaction('ref1')).rejects.toThrow(GatewayTimeoutException);
    });

    it('maps a network failure to 502', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.verifyTransaction('ref1')).rejects.toThrow(BadGatewayException);
    });

    it.each([
      ['a 5xx answer', jsonResponse(503, 'Service Unavailable')],
      ['a 4xx answer', jsonResponse(400, { status: false, message: 'Transaction reference not found' })],
      ['a 200 with status false', jsonResponse(200, { status: false, message: 'Invalid key' })],
      ['a 200 that is not JSON', jsonResponse(200, '<html>proxy</html>')],
      ['a success without data', jsonResponse(200, { status: true, data: null })],
    ])('maps %s to 502', async (_label, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(client.verifyTransaction('ref1')).rejects.toThrow(BadGatewayException);
    });

    it('includes the HTTP status and Paystack message in the error', async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { status: false, message: 'Transaction reference not found' }));

      await expect(client.verifyTransaction('ref1')).rejects.toThrow(
        'Paystack verify failed with HTTP 400: Transaction reference not found',
      );
    });
  });

  describe('listTransactions', () => {
    const request = {
      from: new Date('2026-11-17T00:00:00.000Z'),
      to: new Date('2026-11-18T00:00:00.000Z'),
      status: 'success' as const,
      page: 2,
      perPage: 100,
    };

    it('gets one page with the documented filters and keeps only the compared fields', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'Transactions retrieved',
          data: [
            {
              id: 1,
              reference: 'ref1',
              status: 'success',
              amount: 10000,
              currency: 'GHS',
              customer: { email: 'buyer@example.com' },
              authorization: { last4: '4081' },
            },
          ],
          meta: { total: 101, skipped: 100, perPage: 100, page: 2, pageCount: 2 },
        }),
      );

      await expect(client.listTransactions(request)).resolves.toEqual({
        transactions: [{ reference: 'ref1', status: 'success', amount: 10000, currency: 'GHS' }],
        pageCount: 2,
      });
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(`${url.origin}${url.pathname}`).toBe('https://api.paystack.co/transaction');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        from: '2026-11-17T00:00:00.000Z',
        to: '2026-11-18T00:00:00.000Z',
        status: 'success',
        perPage: '100',
        page: '2',
      });
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'GET',
        headers: { Authorization: 'Bearer sk_test_client_secret' },
      });
    });

    it.each([
      ['no data array', { status: true, data: {}, meta: { pageCount: 1 } }],
      ['no page count', { status: true, data: [] }],
      [
        'a transaction without an amount',
        { status: true, data: [{ reference: 'r', status: 'success', currency: 'GHS' }], meta: { pageCount: 1 } },
      ],
      ['a failed envelope', { status: false, message: 'Invalid key' }],
    ])('maps %s to 502', async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));

      await expect(client.listTransactions(request)).rejects.toThrow(BadGatewayException);
    });
  });

  it('refuses to start without a secret key', () => {
    const missing = {
      getOrThrow: () => {
        throw new Error('Configuration key "PAYSTACK_SECRET_KEY" does not exist');
      },
    };

    expect(() => new PaystackClient(missing as never)).toThrow('PAYSTACK_SECRET_KEY');
  });
});
