import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { GqlThrottlerGuard } from '../../commons/guards/gql-throttler.guard';
import { graphqlContext } from '../../../test/helpers/execution-context.helper';
import { AuthenticationResolver } from './authentication.resolver';
import { trackForgotPasswordByEmail } from './forgot-password-email.tracker';

describe('forgotPassword rate limits', () => {
  let storage: ThrottlerStorageService;
  let guard: GqlThrottlerGuard;
  let nextIp = 0;

  const forgotPassword = (args: object, ip = `10.0.0.${++nextIp}`) =>
    guard.canActivate(
      graphqlContext(
        { ip, headers: {} },
        AuthenticationResolver.prototype.forgotPassword,
        AuthenticationResolver,
        args,
      ),
    );
  const forEmail = (email: string, ip?: string) => forgotPassword({ input: { email } }, ip);

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new GqlThrottlerGuard(
      [
        { name: 'global', ttl: 60000, limit: 120 },
        { name: 'forgotPassword', ttl: 3600000, limit: 3 },
        { name: 'forgotPasswordEmail', ttl: 3600000, limit: 3 },
      ],
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  afterEach(() => storage.onApplicationShutdown());

  it('blocks the fourth request for one email within an hour, whichever IPs it comes from', async () => {
    for (let i = 0; i < 3; i++) await expect(forEmail('ama@test.local')).resolves.toBe(true);

    await expect(forEmail('ama@test.local')).rejects.toThrow(ThrottlerException);
  });

  it('counts case and whitespace variants as the same email', async () => {
    await forEmail('ama@test.local');
    await forEmail(' AMA@test.local');
    await forEmail('Ama@Test.Local ');

    await expect(forEmail('ama@test.local')).rejects.toThrow(ThrottlerException);
  });

  it('limits each email separately', async () => {
    for (let i = 0; i < 3; i++) await forEmail('ama@test.local');

    await expect(forEmail('kofi@test.local')).resolves.toBe(true);
  });

  it('keeps the per-IP limit', async () => {
    for (const email of ['a@test.local', 'b@test.local', 'c@test.local']) await forEmail(email, '10.1.1.1');

    await expect(forEmail('d@test.local', '10.1.1.1')).rejects.toThrow(ThrottlerException);
  });

  it('rejects a request whose email argument is missing', () => {
    const context = graphqlContext({}, AuthenticationResolver.prototype.forgotPassword, AuthenticationResolver, {});

    expect(() => trackForgotPasswordByEmail({}, context)).toThrow(BadRequestException);
  });
});
