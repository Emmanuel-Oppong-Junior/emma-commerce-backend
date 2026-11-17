import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GoogleAuthenticationService } from './google-authentication.service';
import { ConfigService } from '@nestjs/config';
import { AuthenticationService } from '../authentication.service';
import { UsersService } from '../../../users/users.service';
import { PROVIDERS } from '../../iam.constants';

const CLIENT_ID = 'our-client.apps.googleusercontent.com';
const TOKEN = 'ya29.access-token';
const tokens = { accessToken: 'access', refreshToken: 'refresh' };

const tokenInfoFixture = { sub: 'google-123', aud: CLIENT_ID, azp: CLIENT_ID, scope: 'openid email profile' };
const userInfoFixture = {
  sub: 'google-123',
  email: 'ama@gmail.com',
  email_verified: true,
  name: 'Ama Mensah',
  picture: 'https://lh3.googleusercontent.com/a/photo',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GoogleAuthenticationService', () => {
  let service: GoogleAuthenticationService;
  let fetchMock: jest.SpyInstance;
  const authService = { generateTokens: jest.fn() };
  const usersService = { findUserByProviderId: jest.fn(), createUserByAuthProvider: jest.fn() };

  const respondWith = (tokenInfo: unknown, userInfo: unknown = userInfoFixture) =>
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(url.hostname === 'oauth2.googleapis.com' ? jsonResponse(tokenInfo) : jsonResponse(userInfo)),
    );

  beforeEach(async () => {
    jest.resetAllMocks();
    fetchMock = jest.spyOn(global, 'fetch');
    authService.generateTokens.mockResolvedValue(tokens);
    usersService.findUserByProviderId.mockResolvedValue(null);
    usersService.createUserByAuthProvider.mockResolvedValue({ id: 'new-user' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleAuthenticationService,
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue(CLIENT_ID) } },
        { provide: AuthenticationService, useValue: authService },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get(GoogleAuthenticationService);
  });

  afterEach(() => fetchMock.mockRestore());

  it('creates an account for a new Google identity with a verified email', async () => {
    respondWith(tokenInfoFixture);

    await expect(service.authenticate(TOKEN)).resolves.toEqual(tokens);

    expect(usersService.createUserByAuthProvider).toHaveBeenCalledWith(
      'google-123',
      PROVIDERS.google,
      'ama@gmail.com',
      'Ama Mensah',
      userInfoFixture.picture,
    );
    expect(authService.generateTokens).toHaveBeenCalledWith({ id: 'new-user' });
  });

  it('signs in the account already linked to the Google identity', async () => {
    respondWith(tokenInfoFixture);
    usersService.findUserByProviderId.mockResolvedValue({ id: 'linked-user' });

    await service.authenticate(TOKEN);

    expect(usersService.findUserByProviderId).toHaveBeenCalledWith('google-123');
    expect(usersService.createUserByAuthProvider).not.toHaveBeenCalled();
    expect(authService.generateTokens).toHaveBeenCalledWith({ id: 'linked-user' });
  });

  it('rejects a token issued to another application', async () => {
    respondWith({ ...tokenInfoFixture, aud: 'someone-else.apps.googleusercontent.com' });

    await expect(service.authenticate(TOKEN)).rejects.toThrow(
      new UnauthorizedException('Google token was not issued for this application'),
    );
    expect(authService.generateTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['false', { ...userInfoFixture, email_verified: false }],
    ['missing', { ...userInfoFixture, email_verified: undefined }],
    ['the string "true"', { ...userInfoFixture, email_verified: 'true' }],
  ])('rejects an account whose email_verified is %s', async (_label, userInfo) => {
    respondWith(tokenInfoFixture, userInfo);

    await expect(service.authenticate(TOKEN)).rejects.toThrow('Google account email address is not verified');
    expect(usersService.findUserByProviderId).not.toHaveBeenCalled();
    expect(authService.generateTokens).not.toHaveBeenCalled();
  });

  it('rejects a profile that belongs to a different Google user than the token', async () => {
    respondWith(tokenInfoFixture, { ...userInfoFixture, sub: 'google-999' });

    await expect(service.authenticate(TOKEN)).rejects.toThrow(new UnauthorizedException('Invalid Google token'));
  });

  it('rejects an account without an email address', async () => {
    respondWith(tokenInfoFixture, { ...userInfoFixture, email: undefined });

    await expect(service.authenticate(TOKEN)).rejects.toThrow('Google account must have an email address');
  });

  it('rejects a token Google refuses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_token', error_description: 'Invalid Value' }, 400));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(new UnauthorizedException('Invalid Google token'));
  });

  it('does not sign in when an account with the email already exists (pre-hijack)', async () => {
    respondWith(tokenInfoFixture);
    usersService.createUserByAuthProvider.mockRejectedValue(new ConflictException('exists'));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(ConflictException);
    expect(authService.generateTokens).not.toHaveBeenCalled();
  });

  it('encodes the token so it cannot add query parameters, and sends it to userinfo as a header', async () => {
    respondWith(tokenInfoFixture);
    const craftedToken = 'ya29.abc&access_token=attacker';

    await service.authenticate(craftedToken);

    const [tokenInfoUrl, tokenInfoInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(tokenInfoUrl.searchParams.getAll('access_token')).toEqual([craftedToken]);
    expect(tokenInfoInit.signal).toBeInstanceOf(AbortSignal);
    const [userInfoUrl, userInfoInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(userInfoUrl.search).toBe('');
    expect(userInfoInit.headers).toEqual({ Authorization: `Bearer ${craftedToken}` });
    expect(userInfoInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports Google as unavailable when the request fails or times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(ServiceUnavailableException);
  });

  it('reports Google as unavailable on a server error', async () => {
    fetchMock.mockResolvedValue(new Response('upstream error', { status: 502 }));

    await expect(service.authenticate(TOKEN)).rejects.toThrow(ServiceUnavailableException);
  });
});
