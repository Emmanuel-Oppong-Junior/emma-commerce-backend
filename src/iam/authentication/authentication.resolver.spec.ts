import { Test, TestingModule } from '@nestjs/testing';
import { AuthenticationResolver } from './authentication.resolver';
import { AuthenticationService } from './authentication.service';
import { GoogleAuthenticationService } from './social/google-authentication.service';
import { FacebookAuthenticationService } from './social/facebook-authentication.service';
import { EmailVerificationService } from '../../users/email-verification.service';
import { AuthEntity } from './entities/auth.entity';
import { SignUpInput } from './dto/sign-up.input';
import { SignInInput } from './dto/sign-in.input';

const mockAuthService = {
  signUp: jest.fn(),
  signIn: jest.fn(),
};

describe('AuthenticationResolver', () => {
  let resolver: AuthenticationResolver;
  let authService: AuthenticationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationResolver,
        { provide: AuthenticationService, useValue: mockAuthService },
        { provide: GoogleAuthenticationService, useValue: {} },
        { provide: FacebookAuthenticationService, useValue: {} },
        { provide: EmailVerificationService, useValue: {} },
      ],
    }).compile();

    resolver = module.get<AuthenticationResolver>(AuthenticationResolver);
    authService = module.get<AuthenticationService>(AuthenticationService);

    jest.clearAllMocks();
  });

  describe('signUp', () => {
    it('should register a new user and return tokens', async () => {
      const input: SignUpInput = {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test',
      };
      const authResult: AuthEntity = {
        accessToken: 'access',
        refreshToken: 'refresh',
      };

      mockAuthService.signUp.mockResolvedValue(authResult);

      const result = await resolver.signUp(input);

      expect(authService.signUp).toHaveBeenCalledWith(input);
      expect(result).toEqual(authResult);
    });
  });

  describe('signIn', () => {
    it('should sign in an existing user and return tokens', async () => {
      const input: SignInInput = {
        email: 'test@example.com',
        password: 'password123',
      };
      const authResult: AuthEntity = {
        accessToken: 'access',
        refreshToken: 'refresh',
      };

      mockAuthService.signIn.mockResolvedValue(authResult);

      const result = await resolver.signIn(input);

      expect(authService.signIn).toHaveBeenCalledWith(input);
      expect(result).toEqual(authResult);
    });
  });
});
