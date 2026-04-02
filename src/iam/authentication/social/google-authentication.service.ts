import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';

interface GoogleTokenInfo {
  sub?: string;
  aud?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
  error?: { message: string };
}

@Injectable()
export class GoogleAuthenticationService {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthenticationService,
    private readonly userService: UsersService,
  ) {}

  async authenticate(token: string) {
    const { email, googleId, name, picture } = await this.getUserDetailsFromToken(token);
    if (!email) {
      throw new UnauthorizedException('Google account must have an email address to sign in');
    }
    const user = await this.userService.findUserByProviderId(googleId);
    if (user) {
      return this.authService.generateTokens(user);
    }
    const newUser = await this.userService.createUserByAuthProvider(googleId, PROVIDERS.google, email, name, picture);
    return this.authService.generateTokens(newUser);
  }

  private async getUserDetailsFromToken(token: string) {
    const [tokenInfoRes, userInfoRes] = await Promise.all([
      fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`),
      fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${token}`),
    ]);

    const [tokenInfo, userInfo]: [GoogleTokenInfo, GoogleUserInfo] = await Promise.all([
      tokenInfoRes.json(),
      userInfoRes.json(),
    ]);

    if (tokenInfo.error_description || !tokenInfo.sub) {
      throw new UnauthorizedException('Invalid Google token');
    }

    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    if (tokenInfo.aud !== clientId) {
      throw new UnauthorizedException('Google token was not issued for this application');
    }

    return {
      googleId: tokenInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
    };
  }
}
