import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { FacebookAuthenticationService } from './facebook-authentication.service';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';

const APP_ID = '1234567890';
const APP_SECRET = 'test-app-secret';
const TOKEN = 'EAAGtoken';
const tokens = { accessToken: 'access', refreshToken: 'refresh' };

const debugFixture = { data: { app_id: APP_ID, type: 'USER', is_valid: true, user_id: 'fb-42', expires_at: 0 } };
const meFixture = { id: 'fb-42', email: 'kofi@example.com' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('FacebookAuthenticationService', () => {
  let service: FacebookAuthenticationService;
  let fetchMock: jest.SpyInstance;
  const authService = { generateTokens: jest.fn() };
  const usersService = { findUserByProviderId: jest.fn(), createUserByAuthProvider: jest.fn() };
  const config: Record<string, string> = { FACEBOOK_APP_ID: APP_ID, FACEBOOK_APP_SECRET: APP_SECRET };

  const respondWith = (debug: unknown, me: unknown = meFixture) =>
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(url.pathname === '/debug_token' ? jsonResponse(debug) : jsonResponse(me)),
    );

  beforeEach(async () => {
    jest.resetAllMocks();
    fetchMock = jest.spyOn(global, 'fetch');
    authService.generateTokens.mockResolvedValue(tokens);
    usersService.findUserByProviderId.mockResolvedValue(null);
    usersService.createUserByAuthProvider.mockResolvedValue({ id: 'new-user' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FacebookAuthenticationService,
        { provide: ConfigService, useValue: { getOrThrow: (key: string) => config[key] } },
        { provide: AuthenticationService, useValue: authService },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get(FacebookAuthenticationService);
  });

  afterEach(() => fetchMock.mockRestore());

  it('creates an account for a new Facebook identity using the email Facebook returns', async () => {
    respondWith(debugFixture);

    await expect(service.authenticate(TOKEN)).resolves.toEqual(tokens);

    expect(usersService.createUserByAuthProvider).toHaveBeenCalledWith(
      'fb-42',
      PROVIDERS.facebook,
      'kofi@example.com',
      false,
    );
  });

  it('signs in the account already linked to the Facebook identity', async () => {
    respondWith(debugFixture);
    usersService.findUserByProviderId.mockResolvedValue({ id: 'linked-user' });

    await service.authenticate(TOKEN);

    expect(usersService.createUserByAuthProvider).not.toHaveBeenCalled();
    expect(authService.generateTokens).toHaveBeenCalledWith({ id: 'linked-user' });
  });

  it('rejects a token issued to another app', async () => {
    respondWith({ data: { ...debugFixture.data, app_id: '999' } });

    await expect(service.authenticate(TOKEN)).rejects.toThrow(
      new UnauthorizedException('Invalid or expired Facebook token'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a token Facebook reports as invalid', async () => {
    respondWith({ data: { ...debugFixture.data, is_valid: false } });

    await expect(service.authenticate(TOKEN)).rejects.toThrow('Invalid or expired Facebook token');
  });

  it('rejects an error answer from debug_token instead of crashing', async () => {
    respondWith({ error: { message: 'Invalid OAuth access token.', code: 190 } });

    await expect(service.authenticate(TOKEN)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a profile whose id differs from the user the token was issued to', async () => {
    respondWith(debugFixture, { ...meFixture, id: 'fb-other' });

    await expect(service.authenticate(TOKEN)).rejects.toThrow('Invalid or expired Facebook token');
    expect(usersService.findUserByProviderId).not.toHaveBeenCalled();
  });

  it('rejects an account without an email address', async () => {
    respondWith(debugFixture, { id: 'fb-42' });

    await expect(service.authenticate(TOKEN)).rejects.toThrow('Facebook account must have an email address');
  });

  it('does not sign in when an account with the email already exists (pre-hijack)', async () => {
    respondWith(debugFixture);
    usersService.createUserByAuthProvider.mockRejectedValue(new ConflictException('exists'));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(ConflictException);
    expect(authService.generateTokens).not.toHaveBeenCalled();
  });

  it('encodes the token in both calls and signs the profile call with appsecret_proof', async () => {
    respondWith(debugFixture);
    const craftedToken = 'EAAG1&access_token=attacker-token';

    await service.authenticate(craftedToken);

    const [debugUrl, debugInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(debugUrl.searchParams.getAll('input_token')).toEqual([craftedToken]);
    expect(debugUrl.searchParams.getAll('access_token')).toEqual([`${APP_ID}|${APP_SECRET}`]);
    expect(debugInit.signal).toBeInstanceOf(AbortSignal);
    const [meUrl, meInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(meUrl.searchParams.getAll('access_token')).toEqual([craftedToken]);
    expect(meUrl.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', APP_SECRET).update(craftedToken).digest('hex'),
    );
    expect(meInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports Facebook as unavailable when the request fails or times out', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(ServiceUnavailableException);
  });
});
