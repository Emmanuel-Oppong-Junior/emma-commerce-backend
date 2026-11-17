import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';
import { fetchProviderJson } from './fetch-provider-json';

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const INVALID_TOKEN = 'Invalid Google token';

interface GoogleTokenInfo {
  sub?: string;
  aud?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

@Injectable()
export class GoogleAuthenticationService {
  private readonly clientId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthenticationService,
    private readonly userService: UsersService,
  ) {
    this.clientId = this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID');
  }

  async authenticate(token: string) {
    const { googleId, email, name, picture } = await this.getVerifiedProfile(token);
    const user = await this.userService.findUserByProviderId(googleId);
    if (user) {
      return this.authService.generateTokens(user);
    }
    const newUser = await this.userService.createUserByAuthProvider(googleId, PROVIDERS.google, email, name, picture);
    return this.authService.generateTokens(newUser);
  }

  private async getVerifiedProfile(token: string) {
    const tokenInfoUrl = new URL(GOOGLE_TOKENINFO_URL);
    tokenInfoUrl.searchParams.set('access_token', token);
    const tokenInfo = await fetchProviderJson<GoogleTokenInfo>(PROVIDERS.google, tokenInfoUrl, INVALID_TOKEN);
    if (!tokenInfo.sub) throw new UnauthorizedException(INVALID_TOKEN);
    if (tokenInfo.aud !== this.clientId) {
      throw new UnauthorizedException('Google token was not issued for this application');
    }

    const userInfo = await fetchProviderJson<GoogleUserInfo>(
      PROVIDERS.google,
      new URL(GOOGLE_USERINFO_URL),
      INVALID_TOKEN,
      { Authorization: `Bearer ${token}` },
    );
    if (userInfo.sub !== tokenInfo.sub) throw new UnauthorizedException(INVALID_TOKEN);
    if (!userInfo.email) {
      throw new UnauthorizedException('Google account must have an email address to sign in');
    }
    if (userInfo.email_verified !== true) {
      throw new UnauthorizedException('Google account email address is not verified');
    }

    return { googleId: tokenInfo.sub, email: userInfo.email, name: userInfo.name, picture: userInfo.picture };
  }
}
