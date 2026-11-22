import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../../commons/logger.service';
import { HubtelSmsProvider } from './hubtel-sms.provider';
import { maskPhone, SMS_PROVIDER, SmsProvider } from './sms-provider.port';

const CONTEXT = 'SmsSender';

export const SMS_NOT_CONFIGURED =
  'SMS is not configured: set HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET and HUBTEL_SENDER_ID';

/** Hubtel when its credentials are set (env validation makes them all-or-none), else no provider. */
export function smsProviderFrom(config: ConfigService): SmsProvider | null {
  const clientId = config.get<string>('HUBTEL_CLIENT_ID');
  const clientSecret = config.get<string>('HUBTEL_CLIENT_SECRET');
  const senderId = config.get<string>('HUBTEL_SENDER_ID');
  if (!clientId || !clientSecret || !senderId) return null;
  return new HubtelSmsProvider({ clientId, clientSecret, senderId });
}

/**
 * Sends one SMS through the configured provider. Without one, production fails (the job retries and then stays in the
 * failed set); other environments skip the send and log the masked number, so development works without a gateway.
 */
@Injectable()
export class SmsSender {
  private readonly production: boolean;

  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider | null,
    private readonly logger: LoggerService,
    config: ConfigService,
  ) {
    this.production = config.get<string>('NODE_ENV') === 'production';
  }

  /** Whether an SMS can go out in this environment (a provider, or anything but production). */
  get canSend(): boolean {
    return this.provider !== null || !this.production;
  }

  async send(to: string, text: string, purpose: string): Promise<void> {
    if (!this.provider) {
      if (this.production) throw new Error(SMS_NOT_CONFIGURED);
      this.logger.warn(`SMS not sent (no provider configured) | purpose: ${purpose} | to: ${maskPhone(to)}`, CONTEXT);
      return;
    }
    const { messageId } = await this.provider.send(to, text);
    this.logger.log(`SMS sent | purpose: ${purpose} | to: ${maskPhone(to)} | messageId: ${messageId}`, CONTEXT);
  }
}
