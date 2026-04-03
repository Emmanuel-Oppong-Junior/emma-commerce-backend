import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AuthEntity } from './entities/auth.entity';
import { SignUpInput } from './dto/sign-up.input';
import { AuthenticationService } from './authentication.service';
import { SignInInput } from './dto/sign-in.input';
import { RefreshTokenInput } from './dto/refresh-token.input';
import { SignOutInput } from './dto/sign-out.input';
import { SocialLoginInput } from './dto/social-login.input';
import { ForgotPasswordInput } from './dto/forgot-password.input';
import { ResetPasswordInput } from './dto/reset-password.input';
import { AuthType } from './enums/auth-type.enum';
import { Auth } from './decorators/auth.decorator';
import { GoogleAuthenticationService } from './social/google-authentication.service';
import { FacebookAuthenticationService } from './social/facebook-authentication.service';
import { Throttle } from '@nestjs/throttler';

@Auth(AuthType.None)
@Throttle({ auth: { ttl: 60000, limit: 10 } })
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

  @Auth(AuthType.Bearer)
  @Mutation(() => Boolean, {
    description: 'Revoke the provided refresh token, signing the user out',
  })
  signOut(@Args('input', { type: () => SignOutInput }) input: SignOutInput) {
    return this.authService.signOut(input.refreshToken);
  }

  @Mutation(() => AuthEntity, { description: 'Sign in or register with a Google ID token' })
  signInWithGoogle(@Args('input', { type: () => SocialLoginInput }) input: SocialLoginInput) {
    return this.googleAuthService.authenticate(input.token);
  }

  @Mutation(() => AuthEntity, { description: 'Sign in or register with a Facebook access token' })
  signInWithFacebook(@Args('input', { type: () => SocialLoginInput }) input: SocialLoginInput) {
    return this.facebookAuthService.authenticate(input.token);
  }

  @Mutation(() => Boolean, { description: 'Request a password reset email' })
  forgotPassword(@Args('input', { type: () => ForgotPasswordInput }) input: ForgotPasswordInput) {
    return this.authService.forgotPassword(input.email);
  }

  @Mutation(() => Boolean, { description: 'Reset password using a valid reset token' })
  resetPassword(@Args('input', { type: () => ResetPasswordInput }) input: ResetPasswordInput) {
    return this.authService.resetPassword(input.resetToken, input.newPassword);
  }
}
