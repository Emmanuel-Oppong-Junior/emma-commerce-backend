import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseMfaKey } from '../iam/mfa/mfa-crypto';
import { guestOrderToken, guestOrderTokenKey, guestOrderUrl, orderIdFromGuestToken } from './guest-order-token';

/** Issues and checks guest order access tokens (P6-G.1) with the key derived from MFA_ENCRYPTION_KEY. */
@Injectable()
export class GuestOrderAccess {
  private readonly key: Buffer;
  private readonly frontendUrl: string;

  constructor(config: ConfigService) {
    this.key = guestOrderTokenKey(parseMfaKey(config.getOrThrow<string>('MFA_ENCRYPTION_KEY')));
    this.frontendUrl = config.getOrThrow<string>('FRONTEND_URL');
  }

  tokenFor(orderId: string): string {
    return guestOrderToken(this.key, orderId);
  }

  orderIdOf(token: string): string | null {
    return orderIdFromGuestToken(this.key, token);
  }

  /** The storefront link to the guest order, with its token, for the order's SMS and email. */
  urlFor(orderId: string): string {
    return guestOrderUrl(this.frontendUrl, this.tokenFor(orderId));
  }
}

@Module({ providers: [GuestOrderAccess], exports: [GuestOrderAccess] })
export class GuestOrderAccessModule {}
