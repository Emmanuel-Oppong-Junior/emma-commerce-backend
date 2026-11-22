import { HUBTEL_SMS_URL, HubtelSmsProvider } from './hubtel-sms.provider';

const credentials = { clientId: 'client-id', clientSecret: 'client-pass', senderId: 'EmmaShop' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('HubtelSmsProvider', () => {
  it('posts From, To (without +) and Content with Basic auth and returns the message id', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse(201, { messageId: 'msg-1', status: 0, rate: 0.03 }));
    const provider = new HubtelSmsProvider(credentials, fetchFn);

    await expect(provider.send('+233244123456', 'Hello')).resolves.toEqual({ messageId: 'msg-1' });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HUBTEL_SMS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-pass').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({ From: 'EmmaShop', To: '233244123456', Content: 'Hello' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts the PascalCase response fields', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse(200, { MessageId: 'msg-2', Status: 0 }));
    await expect(new HubtelSmsProvider(credentials, fetchFn).send('+233244123456', 'Hi')).resolves.toEqual({
      messageId: 'msg-2',
    });
  });

  it.each([
    ['an HTTP error', jsonResponse(401, { message: 'Unauthorized' }), 'Hubtel SMS refused: HTTP 401'],
    ['a non-zero status', jsonResponse(200, { messageId: 'msg-3', status: 3 }), 'Hubtel SMS not accepted: status 3'],
    ['no message id', jsonResponse(200, { status: 0 }), 'Hubtel SMS answered without a message id'],
    ['a body that is not JSON', new Response('oops', { status: 200 }), 'without a JSON body'],
    ['a JSON body that is not an object', jsonResponse(200, 'ok'), 'unexpected body'],
  ])('fails on %s', async (_case, response, message) => {
    const provider = new HubtelSmsProvider(credentials, jest.fn().mockResolvedValue(response));
    await expect(provider.send('+233244123456', 'Hi')).rejects.toThrow(message);
  });

  it('fails on a timeout or network error without the phone, text or credentials in the message', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const provider = new HubtelSmsProvider(credentials, jest.fn().mockRejectedValue(timeout));

    const error = (await provider.send('+233244123456', 'secret text').catch((caught: unknown) => caught)) as Error;

    expect(error.message).toBe('Hubtel SMS request failed: TimeoutError');
    for (const value of ['244123456', 'secret text', 'client-pass']) expect(error.message).not.toContain(value);
  });

  it('times out with the configured limit', async () => {
    const fetchFn = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)),
        ),
    );
    const provider = new HubtelSmsProvider(credentials, fetchFn as never, 20);
    await expect(provider.send('+233244123456', 'Hi')).rejects.toThrow('Hubtel SMS request failed: TimeoutError');
  });
});
