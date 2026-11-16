import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticationGuard } from './authentication.guard';
import { AccessTokenGuard } from './access-token.guard';
import { Auth } from '../decorators/auth.decorator';
import { AuthType } from '../enums/auth-type.enum';
import { graphqlContext, httpContext } from '../../../../test/helpers/execution-context.helper';

class MixedController {
  @Auth(AuthType.None)
  publicRoute() {
    return 'ok';
  }

  privateRoute() {
    return 'ok';
  }
}

describe('AuthenticationGuard', () => {
  const accessTokenGuard = { canActivate: jest.fn() };
  const guard = new AuthenticationGuard(new Reflector(), accessTokenGuard as unknown as AccessTokenGuard);

  beforeEach(() => jest.resetAllMocks());

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('lets an @Auth(None) handler through without checking a token', async () => {
      const context = buildContext({}, MixedController.prototype.publicRoute, MixedController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(accessTokenGuard.canActivate).not.toHaveBeenCalled();
    });

    it('requires a bearer token by default', async () => {
      accessTokenGuard.canActivate.mockResolvedValue(true);
      const context = buildContext({}, MixedController.prototype.privateRoute, MixedController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(accessTokenGuard.canActivate).toHaveBeenCalledWith(context);
    });

    it('rethrows the bearer check failure', async () => {
      accessTokenGuard.canActivate.mockRejectedValue(new UnauthorizedException('bad token'));
      const context = buildContext({}, MixedController.prototype.privateRoute, MixedController);

      await expect(guard.canActivate(context)).rejects.toThrow('bad token');
    });
  });
});
