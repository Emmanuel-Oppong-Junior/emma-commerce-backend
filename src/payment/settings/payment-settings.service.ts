import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentProvider as ProviderName, PaymentProviderMode } from '../../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import {
  assertOrderPaymentMethodAvailable,
  availablePaymentMethods,
  AvailablePaymentMethods,
  OnlinePaymentMethod,
  onlineProviderFor,
  PaymentMethodSettings,
} from './payment-methods';
import { assertPublicKeyMatches, envPaystackModeOf, lastFour, paystackModeOf } from './paystack-keys';
import {
  openProviderSecret,
  parsePaymentConfigKey,
  providerSecretContext,
  sealProviderSecret,
} from './provider-secret-crypto';
import { PaymentSettingsRepository, StorePaymentSettings } from './payment-settings.repository';

export interface PaystackCredentials {
  secretKey: string;
  callbackUrl?: string;
}

export type CredentialSource = 'DATABASE' | 'ENVIRONMENT' | 'NONE';

/** What staff may read of the Paystack config: never the secret, only its last 4 characters. */
export interface PaystackSettingsView {
  configured: boolean;
  source: CredentialSource;
  mode: PaymentProviderMode | null;
  secretKeyLast4: string | null;
  publicKey: string | null;
  callbackUrl: string | null;
  updatedAt: Date | null;
  updatedById: string | null;
}

export interface PaymentSettingsView {
  methods: PaymentMethodSettings;
  paystack: PaystackSettingsView;
}

/** The public view: what a customer can pay with and the public key a frontend needs to open the provider's popup. */
export interface PublicPaymentMethods {
  online: { method: OnlinePaymentMethod; provider: ProviderName; publicKey: string | null }[];
  cashOnDelivery: boolean;
}

export interface PaystackConfigInput {
  secretKey: string;
  publicKey?: string | null;
  callbackUrl?: string | null;
}

export const PAYSTACK_NOT_CONFIGURED =
  'Online payment is unavailable: Paystack is not configured (setPaystackConfig, or PAYSTACK_SECRET_KEY as a fallback)';

const METHOD_FIELDS = [
  'cardPaymentsEnabled',
  'mobileMoneyPaymentsEnabled',
  'cashOnDeliveryEnabled',
  'cardPaymentProvider',
  'mobileMoneyPaymentProvider',
] as const satisfies readonly (keyof PaymentMethodSettings)[];

const AUDITED_CONFIG_FIELDS = ['mode', 'publicKey', 'callbackUrl'] as const;

/**
 * The store's payment providers and methods (P3-A.2). Read on every payment operation, never cached, so a change made
 * through the API applies at once in every API and worker process. Provider secrets live encrypted in the database;
 * PAYSTACK_SECRET_KEY is the fallback while the store has no Paystack config.
 */
@Injectable()
export class PaymentSettingsService {
  private readonly key: Buffer;
  private readonly envPaystack: PaystackCredentials | null;
  private readonly envCallbackUrl: string | undefined;

  constructor(
    private readonly repository: PaymentSettingsRepository,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.key = parsePaymentConfigKey(configService.getOrThrow<string>('PAYMENT_CONFIG_ENCRYPTION_KEY'));
    this.envCallbackUrl = configService.get<string>('PAYSTACK_CALLBACK_URL');
    const secretKey = configService.get<string>('PAYSTACK_SECRET_KEY');
    this.envPaystack = secretKey ? { secretKey, callbackUrl: this.envCallbackUrl } : null;
  }

  /** The store's Paystack config, else the environment fallback, else null. */
  async paystackCredentials(): Promise<PaystackCredentials | null> {
    return this.credentialsFrom(await this.repository.find());
  }

  async requirePaystackCredentials(): Promise<PaystackCredentials> {
    const credentials = await this.paystackCredentials();
    if (!credentials) throw new ServiceUnavailableException(PAYSTACK_NOT_CONFIGURED);
    return credentials;
  }

  /** checkoutQuote and createOrder: refuses an order payment method the store does not offer (BAD_REQUEST). */
  async assertOrderPaymentMethod(method: PaymentMethod): Promise<void> {
    assertOrderPaymentMethodAvailable(this.available(await this.repository.find()), method);
  }

  /** initiatePayment: the provider serving `method`, or BAD_REQUEST when the store does not offer it. */
  async onlineProviderFor(method: OnlinePaymentMethod): Promise<ProviderName> {
    return onlineProviderFor(this.available(await this.repository.find()), method);
  }

  async publicPaymentMethods(): Promise<PublicPaymentMethods> {
    const settings = await this.repository.find();
    const { online, cashOnDelivery } = this.available(settings);
    return {
      online: online.map((option) => ({
        ...option,
        publicKey: configOf(settings, option.provider)?.publicKey ?? null,
      })),
      cashOnDelivery,
    };
  }

  async getSettings(): Promise<PaymentSettingsView> {
    return this.viewOf(await this.repository.find());
  }

  /** Replaces the store's Paystack config. The secret is encrypted before it is written and never audited or logged. */
  async setPaystackConfig(input: PaystackConfigInput, actorId: string): Promise<PaymentSettingsView> {
    const mode = paystackModeOf(input.secretKey);
    if (input.publicKey) assertPublicKeyMatches(input.publicKey, mode);
    await this.auditService.record(
      async (tx) => {
        const store = await this.repository.find(tx);
        const before = configOf(store, ProviderName.PAYSTACK);
        const after = await this.repository.upsertProviderConfig(tx, store.id, ProviderName.PAYSTACK, {
          mode,
          encryptedSecretKey: sealProviderSecret(
            this.key,
            input.secretKey,
            providerSecretContext(store.id, ProviderName.PAYSTACK),
          ),
          secretKeyLast4: lastFour(input.secretKey),
          publicKey: input.publicKey ?? null,
          callbackUrl: input.callbackUrl ?? null,
          updatedById: actorId,
        });
        return { before, after };
      },
      ({ before, after }) => ({
        entity: 'PaymentProviderConfig',
        entityId: after.id,
        action: before ? 'UPDATE' : 'CREATE',
        userId: actorId,
        details: {
          provider: ProviderName.PAYSTACK,
          secretKeyReplaced: true,
          ...(before
            ? { changes: fieldChanges(before, after, AUDITED_CONFIG_FIELDS) }
            : { after: fieldValues(after, AUDITED_CONFIG_FIELDS) }),
        },
      }),
    );
    return this.getSettings();
  }

  /** Deletes the store's Paystack config, so PAYSTACK_SECRET_KEY (if set) applies again. */
  async removePaystackConfig(actorId: string): Promise<PaymentSettingsView> {
    await this.auditService.record(
      async (tx) => {
        const config = configOf(await this.repository.find(tx), ProviderName.PAYSTACK);
        if (!config) throw new NotFoundException('The store has no Paystack config to remove');
        await this.repository.deleteProviderConfig(tx, config.id);
        return config;
      },
      (removed) => ({
        entity: 'PaymentProviderConfig',
        entityId: removed.id,
        action: 'DELETE',
        userId: actorId,
        details: { provider: removed.provider, before: fieldValues(removed, AUDITED_CONFIG_FIELDS) },
      }),
    );
    return this.getSettings();
  }

  async updatePaymentMethods(input: Partial<PaymentMethodSettings>, actorId: string): Promise<PaymentSettingsView> {
    const { after } = await this.auditService.record(
      async (tx) => ({
        before: await this.repository.find(tx),
        after: await this.repository.updateMethods(tx, input),
      }),
      (change) => ({
        entity: 'Store',
        entityId: change.after.id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(change.before, change.after, METHOD_FIELDS) },
      }),
    );
    return this.viewOf(after);
  }

  private available(settings: StorePaymentSettings): AvailablePaymentMethods {
    const configured = new Set(settings.paymentProviderConfigs.map((config) => config.provider));
    if (this.envPaystack) configured.add(ProviderName.PAYSTACK);
    return availablePaymentMethods(settings, configured);
  }

  private credentialsFrom(settings: StorePaymentSettings): PaystackCredentials | null {
    const config = configOf(settings, ProviderName.PAYSTACK);
    if (!config) return this.envPaystack;
    let secretKey: string;
    try {
      secretKey = openProviderSecret(
        this.key,
        config.encryptedSecretKey,
        providerSecretContext(settings.id, ProviderName.PAYSTACK),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The stored Paystack secret key cannot be decrypted with PAYMENT_CONFIG_ENCRYPTION_KEY (was the key changed?): ${reason}`,
      );
    }
    return { secretKey, callbackUrl: config.callbackUrl ?? this.envCallbackUrl };
  }

  private viewOf(settings: StorePaymentSettings): PaymentSettingsView {
    const methods: PaymentMethodSettings = {
      cardPaymentsEnabled: settings.cardPaymentsEnabled,
      mobileMoneyPaymentsEnabled: settings.mobileMoneyPaymentsEnabled,
      cashOnDeliveryEnabled: settings.cashOnDeliveryEnabled,
      cardPaymentProvider: settings.cardPaymentProvider,
      mobileMoneyPaymentProvider: settings.mobileMoneyPaymentProvider,
    };
    return { methods, paystack: this.paystackView(settings) };
  }

  private paystackView(settings: StorePaymentSettings): PaystackSettingsView {
    const config = configOf(settings, ProviderName.PAYSTACK);
    if (config) {
      return {
        configured: true,
        source: 'DATABASE',
        mode: config.mode,
        secretKeyLast4: config.secretKeyLast4,
        publicKey: config.publicKey,
        callbackUrl: config.callbackUrl,
        updatedAt: config.updatedAt,
        updatedById: config.updatedById,
      };
    }
    const env = this.envPaystack;
    return {
      configured: env !== null,
      source: env ? 'ENVIRONMENT' : 'NONE',
      mode: env ? envPaystackModeOf(env.secretKey) : null,
      secretKeyLast4: env ? lastFour(env.secretKey) : null,
      publicKey: null,
      callbackUrl: env?.callbackUrl ?? null,
      updatedAt: null,
      updatedById: null,
    };
  }
}

function configOf(settings: StorePaymentSettings, provider: ProviderName) {
  return settings.paymentProviderConfigs.find((config) => config.provider === provider) ?? null;
}
