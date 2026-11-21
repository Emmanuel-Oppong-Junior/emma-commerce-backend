import { Injectable } from '@nestjs/common';
import {
  PaymentProvider as ProviderName,
  PaymentProviderConfig,
  PaymentProviderMode,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentMethodSettings } from './payment-methods';

const STORE_PAYMENT_SETTINGS = {
  id: true,
  cardPaymentsEnabled: true,
  mobileMoneyPaymentsEnabled: true,
  cashOnDeliveryEnabled: true,
  cardPaymentProvider: true,
  mobileMoneyPaymentProvider: true,
  paymentProviderConfigs: true,
} as const satisfies Prisma.StoreSelect;

/** The store's payment-method switches and every provider config it holds, read in one query. */
export type StorePaymentSettings = Prisma.StoreGetPayload<{ select: typeof STORE_PAYMENT_SETTINGS }>;

export interface ProviderConfigWrite {
  mode: PaymentProviderMode;
  encryptedSecretKey: string;
  secretKeyLast4: string;
  publicKey: string | null;
  callbackUrl: string | null;
  updatedById: string;
}

// findFirst, not findUnique: Prisma batches concurrent findUnique calls into an `in` filter, which a Boolean key rejects.
const THE_STORE = { singleton: true } as const;

@Injectable()
export class PaymentSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(db: Prisma.TransactionClient = this.prisma): Promise<StorePaymentSettings> {
    const store = await db.store.findFirst({ where: THE_STORE, select: STORE_PAYMENT_SETTINGS });
    if (!store) throw new Error('No Store row exists; apply the database migrations');
    return store;
  }

  async upsertProviderConfig(
    tx: Prisma.TransactionClient,
    storeId: string,
    provider: ProviderName,
    data: ProviderConfigWrite,
  ): Promise<PaymentProviderConfig> {
    return tx.paymentProviderConfig.upsert({
      where: { storeId_provider: { storeId, provider } },
      create: { storeId, provider, ...data },
      update: data,
    });
  }

  async deleteProviderConfig(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.paymentProviderConfig.delete({ where: { id } });
  }

  async updateMethods(
    tx: Prisma.TransactionClient,
    data: Partial<PaymentMethodSettings>,
  ): Promise<StorePaymentSettings> {
    return tx.store.update({ where: THE_STORE, data, select: STORE_PAYMENT_SETTINGS });
  }
}
