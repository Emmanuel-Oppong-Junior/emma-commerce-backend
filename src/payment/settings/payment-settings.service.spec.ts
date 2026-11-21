import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AUDIT_TX } from '../../../test/helpers/audit.helper';
import { PaymentSettingsService } from './payment-settings.service';
import { StorePaymentSettings } from './payment-settings.repository';
import { providerSecretContext, sealProviderSecret } from './provider-secret-crypto';
import { OnlinePaymentMethod, PAYMENT_METHOD_UNAVAILABLE } from './payment-methods';

const KEY_HEX = randomBytes(32).toString('hex');
const DB_SECRET = 'sk_live_db0secret0key9z8y';
const ENV_SECRET = 'sk_test_env0secret0key1234';

const store = (overrides: Partial<StorePaymentSettings> = {}): StorePaymentSettings => ({
  id: 'store1',
  cardPaymentsEnabled: true,
  mobileMoneyPaymentsEnabled: true,
  cashOnDeliveryEnabled: true,
  cardPaymentProvider: 'PAYSTACK',
  mobileMoneyPaymentProvider: 'PAYSTACK',
  paymentProviderConfigs: [],
  ...overrides,
});

const dbConfig = (overrides: Record<string, unknown> = {}) => ({
  id: 'cfg1',
  storeId: 'store1',
  provider: 'PAYSTACK' as const,
  mode: 'LIVE' as const,
  encryptedSecretKey: sealProviderSecret(
    Buffer.from(KEY_HEX, 'hex'),
    DB_SECRET,
    providerSecretContext('store1', 'PAYSTACK'),
  ),
  secretKeyLast4: 'z8y',
  publicKey: 'pk_live_pub1',
  callbackUrl: null,
  updatedById: 'owner1',
  createdAt: new Date(0),
  updatedAt: new Date(1),
  ...overrides,
});

describe('PaymentSettingsService', () => {
  const repository = {
    find: jest.fn(),
    upsertProviderConfig: jest.fn(),
    deleteProviderConfig: jest.fn(),
    updateMethods: jest.fn(),
  };
  const audit = {
    record: jest.fn(async (change: (tx: unknown) => Promise<unknown>, entry: (result: unknown) => unknown) => {
      const result = await change(AUDIT_TX);
      audit.entries.push(entry(result));
      return result;
    }),
    entries: [] as unknown[],
  };
  const build = (env: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = { PAYMENT_CONFIG_ENCRYPTION_KEY: KEY_HEX, ...env };
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => {
        if (values[key] === undefined) throw new Error(`${key} missing`);
        return values[key];
      },
    };
    return new PaymentSettingsService(repository as never, audit as never, config as never);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    audit.entries = [];
    repository.find.mockResolvedValue(store());
  });

  it('refuses to start without PAYMENT_CONFIG_ENCRYPTION_KEY', () => {
    expect(() => build({ PAYMENT_CONFIG_ENCRYPTION_KEY: undefined })).toThrow('PAYMENT_CONFIG_ENCRYPTION_KEY');
  });

  describe('Paystack credentials', () => {
    it('prefers the store config over the environment', async () => {
      repository.find.mockResolvedValue(
        store({ paymentProviderConfigs: [dbConfig({ callbackUrl: 'https://db.test/cb' })] }),
      );
      const service = build({ PAYSTACK_SECRET_KEY: ENV_SECRET, PAYSTACK_CALLBACK_URL: 'https://env.test/cb' });

      await expect(service.paystackCredentials()).resolves.toEqual({
        secretKey: DB_SECRET,
        callbackUrl: 'https://db.test/cb',
      });
    });

    it('falls back to PAYSTACK_CALLBACK_URL when the store config has no callback URL', async () => {
      repository.find.mockResolvedValue(store({ paymentProviderConfigs: [dbConfig()] }));
      const service = build({ PAYSTACK_CALLBACK_URL: 'https://env.test/cb' });

      await expect(service.paystackCredentials()).resolves.toEqual({
        secretKey: DB_SECRET,
        callbackUrl: 'https://env.test/cb',
      });
    });

    it('uses the environment while the store has no config', async () => {
      const service = build({ PAYSTACK_SECRET_KEY: ENV_SECRET });
      await expect(service.paystackCredentials()).resolves.toEqual({ secretKey: ENV_SECRET, callbackUrl: undefined });
    });

    it('has none without either, and refuses with 503 when they are required', async () => {
      const service = build();
      await expect(service.paystackCredentials()).resolves.toBeNull();
      await expect(service.requirePaystackCredentials()).rejects.toThrow(ServiceUnavailableException);
    });

    it('fails loudly when the stored secret was encrypted with another key', async () => {
      repository.find.mockResolvedValue(store({ paymentProviderConfigs: [dbConfig()] }));
      const service = build({ PAYMENT_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('hex') });

      await expect(service.paystackCredentials()).rejects.toThrow(
        'cannot be decrypted with PAYMENT_CONFIG_ENCRYPTION_KEY',
      );
    });
  });

  describe('methods on offer', () => {
    it('refuses every online method while Paystack has no credentials, but keeps cash on delivery', async () => {
      const service = build();

      await expect(service.assertOrderPaymentMethod('ONLINE')).rejects.toMatchObject({
        response: { extensions: { reason: PAYMENT_METHOD_UNAVAILABLE } },
      });
      await expect(service.assertOrderPaymentMethod('CASH_ON_DELIVERY')).resolves.toBeUndefined();
      await expect(service.publicPaymentMethods()).resolves.toEqual({ online: [], cashOnDelivery: true });
    });

    it('refuses a switched-off method', async () => {
      repository.find.mockResolvedValue(store({ mobileMoneyPaymentsEnabled: false, cashOnDeliveryEnabled: false }));
      const service = build({ PAYSTACK_SECRET_KEY: ENV_SECRET });

      await expect(service.onlineProviderFor(OnlinePaymentMethod.CARD)).resolves.toBe('PAYSTACK');
      await expect(service.onlineProviderFor(OnlinePaymentMethod.MOBILE_MONEY)).rejects.toThrow(
        'Mobile money payment is not available at this store',
      );
      await expect(service.assertOrderPaymentMethod('CASH_ON_DELIVERY')).rejects.toThrow(
        'Cash on delivery is not available at this store',
      );
    });

    it('gives customers the public key, never the secret', async () => {
      repository.find.mockResolvedValue(store({ paymentProviderConfigs: [dbConfig()] }));
      const methods = await build().publicPaymentMethods();

      expect(methods.online[0]).toEqual({ method: 'CARD', provider: 'PAYSTACK', publicKey: 'pk_live_pub1' });
      expect(JSON.stringify(methods)).not.toContain(DB_SECRET);
    });
  });

  describe('setPaystackConfig', () => {
    beforeEach(() => {
      repository.upsertProviderConfig.mockImplementation(async (_tx, storeId, provider, data) => ({
        id: 'cfg1',
        storeId,
        provider,
        createdAt: new Date(0),
        updatedAt: new Date(1),
        ...data,
      }));
    });

    it('stores the secret encrypted with its last 4 and mode, and audits without it', async () => {
      const service = build();
      await service.setPaystackConfig(
        { secretKey: DB_SECRET, publicKey: 'pk_live_pub1', callbackUrl: 'https://shop.test/paid' },
        'owner1',
      );

      const [, storeId, provider, written] = repository.upsertProviderConfig.mock.calls[0];
      expect({ storeId, provider }).toEqual({ storeId: 'store1', provider: 'PAYSTACK' });
      expect(written).toMatchObject({ mode: 'LIVE', secretKeyLast4: '9z8y', updatedById: 'owner1' });
      expect(JSON.stringify(written)).not.toContain(DB_SECRET);
      expect(audit.entries).toEqual([
        {
          entity: 'PaymentProviderConfig',
          entityId: 'cfg1',
          action: 'CREATE',
          userId: 'owner1',
          details: {
            provider: 'PAYSTACK',
            secretKeyReplaced: true,
            after: { mode: 'LIVE', publicKey: 'pk_live_pub1', callbackUrl: 'https://shop.test/paid' },
          },
        },
      ]);
      expect(JSON.stringify(audit.entries)).not.toContain('9z8y');
    });

    it('decrypts what it stored', async () => {
      const service = build();
      await service.setPaystackConfig({ secretKey: DB_SECRET }, 'owner1');
      const written = repository.upsertProviderConfig.mock.calls[0][3];
      repository.find.mockResolvedValue(store({ paymentProviderConfigs: [dbConfig(written)] }));

      await expect(service.paystackCredentials()).resolves.toMatchObject({ secretKey: DB_SECRET });
    });

    it('refuses a public key of the other mode and writes nothing', async () => {
      await expect(
        build().setPaystackConfig({ secretKey: DB_SECRET, publicKey: 'pk_test_pub1' }, 'owner1'),
      ).rejects.toThrow('publicKey is a TEST key but secretKey is a LIVE key');
      expect(repository.upsertProviderConfig).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it('shows the source, mode and last 4 of the environment key', async () => {
      const { paystack } = await build({ PAYSTACK_SECRET_KEY: ENV_SECRET }).getSettings();
      expect(paystack).toEqual({
        configured: true,
        source: 'ENVIRONMENT',
        mode: 'TEST',
        secretKeyLast4: '1234',
        publicKey: null,
        callbackUrl: null,
        updatedAt: null,
        updatedById: null,
      });
    });

    it('shows NONE when nothing is configured', async () => {
      const { paystack } = await build().getSettings();
      expect(paystack).toMatchObject({ configured: false, source: 'NONE', secretKeyLast4: null });
    });
  });

  it('refuses to remove a config that does not exist', async () => {
    await expect(build().removePaystackConfig('owner1')).rejects.toThrow(NotFoundException);
    expect(repository.deleteProviderConfig).not.toHaveBeenCalled();
  });

  it('audits method changes field by field', async () => {
    repository.updateMethods.mockResolvedValue(store({ cashOnDeliveryEnabled: false }));
    const view = await build().updatePaymentMethods({ cashOnDeliveryEnabled: false }, 'owner1');

    expect(view.methods.cashOnDeliveryEnabled).toBe(false);
    expect(audit.entries).toEqual([
      {
        entity: 'Store',
        entityId: 'store1',
        action: 'UPDATE',
        userId: 'owner1',
        details: { changes: { cashOnDeliveryEnabled: { from: true, to: false } } },
      },
    ]);
  });
});
