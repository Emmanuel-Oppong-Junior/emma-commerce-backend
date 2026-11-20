import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { JwtService } from '@nestjs/jwt';
import jwtConfig from '../../config/jwt.config';
import { UsersService } from '../../../users/users.service';
import { graphqlContext, httpContext } from '../../../../test/helpers/execution-context.helper';
import { CUSTOMER_ACCESS } from '../../authorization/staff-access';

describe('AccessTokenGuard', () => {
  let guard: AccessTokenGuard;
  const jwtService = { verifyAsync: jest.fn() };
  const usersService = { findWithStaffRole: jest.fn() };
  const activeUser = { id: 'user-1', isActive: true };
  const managerRole = { key: 'MANAGER', permissions: ['order.view'], mfaRequired: true };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessTokenGuard,
        { provide: JwtService, useValue: jwtService },
        { provide: jwtConfig.KEY, useValue: {} },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    guard = module.get<AccessTokenGuard>(AccessTokenGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('accepts a valid token and attaches the user to the request', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
      usersService.findWithStaffRole.mockResolvedValue({ ...activeUser, storeMemberships: [] });
      const request: Record<string, unknown> = { headers: { authorization: 'Bearer valid-token' } };

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-token', {});
      expect(request.user).toEqual(activeUser);
      expect(request.access).toEqual(CUSTOMER_ACCESS);
    });

    it("loads the staff role's permissions with the user, once per request", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
      usersService.findWithStaffRole.mockResolvedValue({ ...activeUser, storeMemberships: [{ role: managerRole }] });
      const request: Record<string, unknown> = { headers: { authorization: 'Bearer valid-token' } };

      await guard.canActivate(buildContext(request));

      expect(usersService.findWithStaffRole).toHaveBeenCalledTimes(1);
      expect(request.user).toEqual(activeUser);
      expect(request.access).toEqual({ roleKey: 'MANAGER', permissions: new Set(['order.view']), mfaRequired: true });
    });

    it('rejects a request without a token', async () => {
      await expect(guard.canActivate(buildContext({ headers: {} }))).rejects.toThrow(UnauthorizedException);
      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('rejects a token that fails verification', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(guard.canActivate(buildContext({ headers: { authorization: 'Bearer expired' } }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token for an inactive user', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
      usersService.findWithStaffRole.mockResolvedValue({ ...activeUser, isActive: false, storeMemberships: [] });

      await expect(
        guard.canActivate(buildContext({ headers: { authorization: 'Bearer valid-token' } })),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
