import { Reflector } from '@nestjs/core';
import { Role } from '../../../generated/prisma/client';
import { RolesGuard } from './roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { graphqlContext, httpContext } from '../../../../test/helpers/execution-context.helper';

class AdminController {
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  adminOnly() {
    return 'ok';
  }

  open() {
    return 'ok';
  }
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('should be defined', () => {
    expect(new RolesGuard(new Reflector())).toBeDefined();
  });

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('allows a handler without @Roles', async () => {
      const context = buildContext({}, AdminController.prototype.open, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('allows a user whose role is listed', async () => {
      const request = { user: { role: Role.ADMIN } };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('denies a user whose role is not listed', async () => {
      const request = { user: { role: Role.USER } };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('denies an anonymous request to a role-restricted handler', async () => {
      const context = buildContext({}, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(false);
    });
  });
});
