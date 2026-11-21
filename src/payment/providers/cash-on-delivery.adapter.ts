import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentProvider as ProviderName } from '../../generated/prisma/client';
import { PaymentProvider } from './payment-provider.port';

/**
 * Pay on delivery: the cash is collected in person and recorded by staff (`recordCodPayment`), so there is no
 * checkout, verification, refund, webhook or transaction list to ask a provider for.
 */
@Injectable()
export class CashOnDeliveryAdapter implements PaymentProvider {
  readonly name = ProviderName.CASH_ON_DELIVERY;
  readonly label = 'Cash on delivery';
  readonly capabilities = { onlineCheckout: false, refunds: false, webhooks: false, transactionList: false };

  initialize(): Promise<never> {
    return this.unsupported('online checkout');
  }

  verify(): Promise<never> {
    return this.unsupported('provider verification');
  }

  refund(): Promise<never> {
    return this.unsupported('refunds through a provider');
  }

  parseWebhook(): Promise<never> {
    return this.unsupported('webhooks');
  }

  settlesPayment(): boolean {
    return false;
  }

  listTransactions(): Promise<never> {
    return this.unsupported('a transaction list');
  }

  private unsupported(operation: string): Promise<never> {
    return Promise.reject(
      new BadRequestException(`Cash on delivery is collected in person; ${operation} is not available for it`),
    );
  }
}
