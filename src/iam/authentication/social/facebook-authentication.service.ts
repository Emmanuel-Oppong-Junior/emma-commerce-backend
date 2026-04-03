import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';

interface FacebookDebugTokenResponse {
  data: {
    app_id: string;
    is_valid: boolean;
    user_id: string;
    error?: { message: string };
  };
}

interface FacebookUserResponse {
  id: string;
  email?: string;
  error?: { message: string };
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
    const { facebookId, email } = await this.getUserDetailsFromToken(token);
    if (!email) {
      throw new UnauthorizedException('Facebook account must have an email address to sign in');
    }
    const user = await this.userService.findUserByProviderId(facebookId);
    if (user) {
      return this.authService.generateTokens(user);
    }
    const newUser = await this.userService.createUserByAuthProvider(facebookId, PROVIDERS.facebook, email);
    return this.authService.generateTokens(newUser);
  }

  private async getUserDetailsFromToken(token: string) {
    await this.verifyToken(token);

    const response = await fetch(`https://graph.facebook.com/me?fields=id,email&access_token=${token}`);
    const userData: FacebookUserResponse = await response.json();

    if (userData.error || !userData.id) {
      throw new UnauthorizedException('Could not retrieve Facebook user data');
    }

    return { facebookId: userData.id, email: userData.email };
  }

  private async verifyToken(token: string) {
    const appToken = `${this.appId}|${this.appSecret}`;
    const response = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${token}&access_token=${appToken}`,
    );
    const debugData: FacebookDebugTokenResponse = await response.json();

    if (!debugData.data.is_valid || debugData.data.app_id !== this.appId) {
      throw new UnauthorizedException('Invalid or expired Facebook token');
    }
  }
}
