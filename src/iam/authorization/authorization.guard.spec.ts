import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard } from './authorization.guard';
import { CustomerOnly, RequirePermission } from './policy.decorators';
import { CUSTOMER_ACCESS, staffAccessFor } from './staff-access';
import { graphqlContext, httpContext } from '../../../test/helpers/execution-context.helper';

class AdminController {
  @RequirePermission('order.view', 'order.manage')
  adminOnly() {
    return 'ok';
  }

  @CustomerOnly()
  customerOnly() {
    return 'ok';
  }

  open() {
    return 'ok';
  }
}

@RequirePermission('report.view')
class ReportsController {
  report() {
    return 'ok';
  }
}

const manager = staffAccessFor({ key: 'MANAGER', permissions: ['order.view', 'order.manage'], mfaRequired: true });
const cashier = staffAccessFor({ key: 'CASHIER', permissions: ['order.view'], mfaRequired: false });

describe('AuthorizationGuard', () => {
  const guard = new AuthorizationGuard(new Reflector());

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('allows a handler without a policy', () => {
      const context = buildContext({}, AdminController.prototype.open, AdminController);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows a user holding every required permission', () => {
      const request = { user: { id: 'u1' }, access: manager };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('denies a user missing one of the required permissions', () => {
      const request = { user: { id: 'u1' }, access: cashier };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      expect(guard.canActivate(context)).toBe(false);
    });

    it('denies a customer', () => {
      const request = { user: { id: 'u1' }, access: CUSTOMER_ACCESS };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      expect(guard.canActivate(context)).toBe(false);
    });

    it('denies an anonymous request to a permission-guarded handler', () => {
      const context = buildContext({}, AdminController.prototype.adminOnly, AdminController);

      expect(guard.canActivate(context)).toBe(false);
    });

    it('applies a class-level permission to its handlers', () => {
      const allowed = buildContext(
        { user: { id: 'u1' }, access: staffAccessFor({ key: 'X', permissions: ['report.view'], mfaRequired: false }) },
        ReportsController.prototype.report,
        ReportsController,
      );
      const denied = buildContext(
        { user: { id: 'u1' }, access: cashier },
        ReportsController.prototype.report,
        ReportsController,
      );

      expect(guard.canActivate(allowed)).toBe(true);
      expect(guard.canActivate(denied)).toBe(false);
    });

    it('lets a customer use a customer-only handler and refuses staff', () => {
      const customer = buildContext(
        { user: { id: 'u1' }, access: CUSTOMER_ACCESS },
        AdminController.prototype.customerOnly,
        AdminController,
      );
      const staff = buildContext(
        { user: { id: 'u2' }, access: manager },
        AdminController.prototype.customerOnly,
        AdminController,
      );

      expect(guard.canActivate(customer)).toBe(true);
      expect(() => guard.canActivate(staff)).toThrow(ForbiddenException);
    });
  });
});
