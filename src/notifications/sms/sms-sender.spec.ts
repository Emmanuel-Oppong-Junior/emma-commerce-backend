import { HubtelSmsProvider } from './hubtel-sms.provider';
import { SMS_NOT_CONFIGURED, SmsSender, smsProviderFrom } from './sms-sender';

const configOf = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as never;

describe('smsProviderFrom', () => {
  it('is Hubtel when its credentials are set', () => {
    const provider = smsProviderFrom(
      configOf({ HUBTEL_CLIENT_ID: 'id', HUBTEL_CLIENT_SECRET: 'pass', HUBTEL_SENDER_ID: 'Shop' }),
    );
    expect(provider).toBeInstanceOf(HubtelSmsProvider);
  });

  it('is null without credentials', () => {
    expect(smsProviderFrom(configOf({}))).toBeNull();
  });
});

describe('SmsSender', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('sends through the provider and logs only the masked number and message id', async () => {
    const provider = { send: jest.fn().mockResolvedValue({ messageId: 'msg-1' }) };
    const sender = new SmsSender(provider, logger as never, configOf({ NODE_ENV: 'production' }));

    await sender.send('+233244123456', '123456 is your code', 'phone_otp');

    expect(provider.send).toHaveBeenCalledWith('+233244123456', '123456 is your code');
    const logged = JSON.stringify(logger.log.mock.calls);
    expect(logged).toContain('***456');
    expect(logged).toContain('msg-1');
    expect(logged).not.toContain('244123456');
    expect(logged).not.toContain('123456 is');
    expect(sender.canSend).toBe(true);
  });

  it.each(['development', 'test'])(
    'skips the send without a provider in %s, logging the masked number',
    async (env) => {
      const sender = new SmsSender(null, logger as never, configOf({ NODE_ENV: env }));

      await sender.send('+233244123456', '123456 is your code', 'phone_otp');

      expect(sender.canSend).toBe(true);
      const warned = JSON.stringify(logger.warn.mock.calls);
      expect(warned).toContain('***456');
      expect(warned).not.toContain('244123456');
      expect(warned).not.toContain('123456 is');
    },
  );

  it('fails without a provider in production, so the job is retried and kept as failed', async () => {
    const sender = new SmsSender(null, logger as never, configOf({ NODE_ENV: 'production' }));

    expect(sender.canSend).toBe(false);
    await expect(sender.send('+233244123456', 'text', 'phone_otp')).rejects.toThrow(SMS_NOT_CONFIGURED);
  });
});
