import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';
import { fetchProviderJson } from './fetch-provider-json';

const GRAPH_API_URL = 'https://graph.facebook.com';
const INVALID_TOKEN = 'Invalid or expired Facebook token';

interface FacebookDebugTokenResponse {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    user_id?: string;
  };
}

interface FacebookUserResponse {
  id?: string;
  email?: string;
}

@Injectable()
export class FacebookAuthenticationService {
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthenticationService,
    private readonly userService: UsersService,
  ) {
    this.appId = this.configService.getOrThrow<string>('FACEBOOK_APP_ID');
    this.appSecret = this.configService.getOrThrow<string>('FACEBOOK_APP_SECRET');
  }

  async authenticate(token: string) {
    const { facebookId, email } = await this.getVerifiedProfile(token);
    const user = await this.userService.findUserByProviderId(facebookId);
    if (user) {
      return this.authService.generateTokens(user);
    }
    // Facebook does not assert that the email it returns was verified.
    const newUser = await this.userService.createUserByAuthProvider(facebookId, PROVIDERS.facebook, email, false);
    return this.authService.generateTokens(newUser);
  }

  private async getVerifiedProfile(token: string) {
    const facebookUserId = await this.verifyTokenWasIssuedToThisApp(token);

    const meUrl = new URL(`${GRAPH_API_URL}/me`);
    meUrl.searchParams.set('fields', 'id,email');
    meUrl.searchParams.set('access_token', token);
    meUrl.searchParams.set('appsecret_proof', createHmac('sha256', this.appSecret).update(token).digest('hex'));
    const me = await fetchProviderJson<FacebookUserResponse>(
      PROVIDERS.facebook,
      meUrl,
      'Could not retrieve Facebook user data',
    );
    if (me.id !== facebookUserId) throw new UnauthorizedException(INVALID_TOKEN);
    if (!me.email) {
      throw new UnauthorizedException('Facebook account must have an email address to sign in');
    }

    return { facebookId: me.id, email: me.email };
  }

  private async verifyTokenWasIssuedToThisApp(token: string): Promise<string> {
    const debugUrl = new URL(`${GRAPH_API_URL}/debug_token`);
    debugUrl.searchParams.set('input_token', token);
    debugUrl.searchParams.set('access_token', `${this.appId}|${this.appSecret}`);
    const { data } = await fetchProviderJson<FacebookDebugTokenResponse>(PROVIDERS.facebook, debugUrl, INVALID_TOKEN);
    if (data?.is_valid !== true || data.app_id !== this.appId || !data.user_id) {
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    return data.user_id;
  }
}
