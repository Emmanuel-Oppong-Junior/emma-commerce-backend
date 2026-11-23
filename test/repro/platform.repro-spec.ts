import 'reflect-metadata';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { GraphqlLoggingInterceptor } from '../../src/commons/interceptors/graphql-logging.interceptor';
import { PaymentController } from '../../src/payment/payment.controller';
import { AccessTokenGuard } from '../../src/iam/authentication/guards/access-token.guard';
import { AuthenticationGuard } from '../../src/iam/authentication/guards/authentication.guard';
import { sanitizeVariables } from '../../src/commons/useful-functions';
import { SignInInput } from '../../src/iam/authentication/dto/sign-in.input';
import { ShippingZonesService } from '../../src/shipping-zones/shipping-zones.service';

function httpContext(request: Record<string, unknown>, controller: unknown, handler: (...args: never[]) => unknown) {
  const context = new ExecutionContextHost([request, {}, () => undefined], controller as never, handler);
  context.setType('http');
  return context;
}

describe('REST requests (audit repro: PLAT-01, IAM-07)', () => {
  it('PLAT-01: the global GraphQL logging interceptor lets a REST webhook request through', async () => {
    const interceptor = new GraphqlLoggingInterceptor({ log: jest.fn(), error: jest.fn() } as never);
    const request = { headers: {}, body: { event: 'charge.success' }, url: '/payment/webhook' };
    const context = httpContext(request, PaymentController, PaymentController.prototype.paymentWebhookHandler);

    const result = await lastValueFrom(interceptor.intercept(context, { handle: () => of('handled') }));

    expect(result).toBe('handled');
  });

  it('IAM-07: a valid Bearer token is accepted on a REST route', async () => {
    const accessTokenGuard = new AccessTokenGuard(
      { verifyAsync: async () => ({ sub: 'user-1' }) } as never,
      {} as never,
      { findWithStaffRole: async () => ({ id: 'user-1', isActive: true, storeMemberships: [] }) } as never,
    );
    const guard = new AuthenticationGuard(new Reflector(), accessTokenGuard);
    const request = { headers: { authorization: 'Bearer token' } };
    const context = httpContext(request, PaymentController, PaymentController.prototype.initializeTransaction);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe('Logging of secrets (audit repro: PLAT-02 / OBS-01)', () => {
  it.each(['refreshToken', 'resetToken', 'token', 'newPassword', 'oldPassword'])(
    'masks %s in logged GraphQL variables',
    (field) => {
      const sanitized = sanitizeVariables({ input: { [field]: 'secret-value' } });

      expect(JSON.stringify(sanitized)).not.toContain('secret-value');
    },
  );
});

describe('Sign-in validation (audit repro: IAM-05 / DOC-08)', () => {
  it('accepts a 20-character password that sign-up allowed', async () => {
    const input = plainToInstance(SignInInput, { email: 'customer@test.local', password: 'Abcdefgh1!Abcdefgh1!' });

    const errors = await validate(input);

    expect(errors).toEqual([]);
  });
});

describe('Shipping fee (audit repro: SHZ-01 / MONEY-02)', () => {
  it('does not silently charge GHS 0 delivery for a city no shipping zone covers', async () => {
    const service = new ShippingZonesService(
      { findMatchableAreas: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
    );

    await expect(
      service.deliveryZoneFor({ country: 'GH', region: 'NORTHERN', city: 'Tamale', area: null }),
    ).rejects.toThrow();
  });
});
