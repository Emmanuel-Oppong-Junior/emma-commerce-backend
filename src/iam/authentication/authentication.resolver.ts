import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AuthEntity } from './entities/auth.entity';
import { SignUpInput } from './dto/sign-up.input';
import { AuthenticationService } from './authentication.service';
import { SignInInput } from './dto/sign-in.input';
import { RefreshTokenInput } from './dto/refresh-token.input';
import { SocialLoginInput } from './dto/social-login.input';
import { AuthType } from './enums/auth-type.enum';
import { Auth } from './decorators/auth.decorator';
import { GoogleAuthenticationService } from './social/google-authentication.service';
import { FacebookAuthenticationService } from './social/facebook-authentication.service';

@Auth(AuthType.None)
@Resolver(() => AuthEntity)
export class AuthenticationResolver {
  constructor(
    private readonly authService: AuthenticationService,
    private readonly googleAuthService: GoogleAuthenticationService,
    private readonly facebookAuthService: FacebookAuthenticationService,
  ) {}

  @Mutation(() => AuthEntity, {
    description: 'Register a new user with email and password',
  })
  signUp(@Args('input', { type: () => SignUpInput }) input: SignUpInput) {
    return this.authService.signUp(input);
  }

  @Mutation(() => AuthEntity, {
    description: 'Sign in an existing user with email and password',
  })
  signIn(@Args('input', { type: () => SignInInput }) input: SignInInput) {
    return this.authService.signIn(input);
  }

  @Mutation(() => AuthEntity, {
    description: 'Refresh access and refresh tokens using a valid refresh token',
  })
  refreshToken(@Args('input', { type: () => RefreshTokenInput }) input: RefreshTokenInput) {
    return this.authService.refreshToken(input);
  }

  @Mutation(() => AuthEntity, { description: 'Sign in or register with a Google ID token' })
  signInWithGoogle(@Args('input', { type: () => SocialLoginInput }) input: SocialLoginInput) {
    return this.googleAuthService.authenticate(input.token);
  }

  @Mutation(() => AuthEntity, { description: 'Sign in or register with a Facebook access token' })
  signInWithFacebook(@Args('input', { type: () => SocialLoginInput }) input: SocialLoginInput) {
    return this.facebookAuthService.authenticate(input.token);
  }
}
