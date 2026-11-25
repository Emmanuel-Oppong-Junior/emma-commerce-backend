import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseMfaKey } from '../iam/mfa/mfa-crypto';
import { unsubscribeKey, unsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token';

/** The customer-site links marketing messages carry: the cart, and the signed one-click unsubscribe link. */
@Injectable()
export class MarketingLinks {
  private readonly frontendUrl: string;
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.frontendUrl = config.getOrThrow<string>('FRONTEND_URL').replace(/\/+$/, '');
    this.key = unsubscribeKey(parseMfaKey(config.getOrThrow<string>('MFA_ENCRYPTION_KEY')));
  }

  cartUrl(): string {
    return `${this.frontendUrl}/cart`;
  }

  /** The frontend page reads `token` and calls unsubscribeMarketingEmail with it. */
  unsubscribeUrl(userId: string): string {
    return `${this.frontendUrl}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(this.key, userId))}`;
  }

  /** The user an unsubscribe token was signed for, or null. */
  userIdOf(token: string): string | null {
    return verifyUnsubscribeToken(this.key, token);
  }
}
