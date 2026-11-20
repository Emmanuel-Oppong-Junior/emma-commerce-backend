import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard } from './authorization.guard';
import { CustomerOnly, RequirePermission, RequireStepUp } from './policy.decorators';
import { CUSTOMER_ACCESS, staffAccessFor } from './staff-access';
import { graphqlContext, httpContext } from '../../../test/helpers/execution-context.helper';
import { STEP_UP_WINDOW_MS } from '../mfa/step-up.store';

class AdminController {
  @RequirePermission('order.view', 'order.manage')
  adminOnly() {
    return 'ok';
  }

  @CustomerOnly()
  customerOnly() {
    return 'ok';
  }

  @RequirePermission('order.refund')
  @RequireStepUp()
  refund() {
    return 'ok';
  }

  @RequirePermission('catalog.product.write')
  @RequireStepUp({ label: 'price is set', applies: (args) => args.price != null })
  editProduct() {
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

const manager = staffAccessFor({
  key: 'MANAGER',
  permissions: ['order.view', 'order.manage', 'order.refund', 'catalog.product.write'],
  mfaRequired: true,
});
const cashier = staffAccessFor({ key: 'CASHIER', permissions: ['order.view'], mfaRequired: false });
const enrolled = { id: 'u1', mfaEnabledAt: new Date() };
const notEnrolled = { id: 'u1', mfaEnabledAt: null };

function forbiddenReason(error: unknown): unknown {
  expect(error).toBeInstanceOf(ForbiddenException);
  return ((error as ForbiddenException).getResponse() as { extensions?: { reason?: string } }).extensions?.reason;
}

describe('AuthorizationGuard', () => {
  const stepUpStore = { lastVerifiedAt: jest.fn() };
  const guard = new AuthorizationGuard(new Reflector(), stepUpStore as never);

  beforeEach(() => stepUpStore.lastVerifiedAt.mockReset().mockResolvedValue(null));

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('allows a handler without a policy', async () => {
      const context = buildContext({}, AdminController.prototype.open, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('allows a user holding every required permission', async () => {
      const request = { user: enrolled, access: manager };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('denies a user missing one of the required permissions', async () => {
      const request = { user: enrolled, access: cashier };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('denies a customer', async () => {
      const request = { user: notEnrolled, access: CUSTOMER_ACCESS };
      const context = buildContext(request, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('denies an anonymous request to a permission-guarded handler', async () => {
      const context = buildContext({}, AdminController.prototype.adminOnly, AdminController);

      await expect(guard.canActivate(context)).resolves.toBe(false);
    });

    it('applies a class-level permission to its handlers', async () => {
      const allowed = buildContext(
        { user: enrolled, access: staffAccessFor({ key: 'X', permissions: ['report.view'], mfaRequired: false }) },
        ReportsController.prototype.report,
        ReportsController,
      );
      const denied = buildContext(
        { user: enrolled, access: cashier },
        ReportsController.prototype.report,
        ReportsController,
      );

      await expect(guard.canActivate(allowed)).resolves.toBe(true);
      await expect(guard.canActivate(denied)).resolves.toBe(false);
    });

    it('lets a customer use a customer-only handler and refuses staff', async () => {
      const customer = buildContext(
        { user: notEnrolled, access: CUSTOMER_ACCESS },
        AdminController.prototype.customerOnly,
        AdminController,
      );
      const staff = buildContext(
        { user: enrolled, access: manager },
        AdminController.prototype.customerOnly,
        AdminController,
      );

      await expect(guard.canActivate(customer)).resolves.toBe(true);
      await expect(guard.canActivate(staff)).rejects.toThrow(ForbiddenException);
    });

    it('refuses staff whose role requires MFA until they enrol, with reason MFA_ENROLLMENT_REQUIRED', async () => {
      const context = buildContext(
        { user: notEnrolled, access: manager },
        AdminController.prototype.adminOnly,
        AdminController,
      );

      const error = await guard.canActivate(context).catch((e: unknown) => e);

      expect(forbiddenReason(error)).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('lets staff whose role does not require MFA work without it', async () => {
      const clerk = staffAccessFor({ key: 'CLERK', permissions: ['report.view'], mfaRequired: false });
      const context = buildContext(
        { user: notEnrolled, access: clerk },
        ReportsController.prototype.report,
        ReportsController,
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    describe('step-up', () => {
      const refundContext = (sessionId?: string) =>
        buildContext({ user: enrolled, access: manager, sessionId }, AdminController.prototype.refund, AdminController);

      it('refuses a sensitive action without a recent verification, with reason STEP_UP_REQUIRED', async () => {
        const error = await guard.canActivate(refundContext('s1')).catch((e: unknown) => e);

        expect(forbiddenReason(error)).toBe('STEP_UP_REQUIRED');
        expect(stepUpStore.lastVerifiedAt).toHaveBeenCalledWith('u1', 's1');
      });

      it('allows it within 10 minutes of a verification of this session', async () => {
        stepUpStore.lastVerifiedAt.mockResolvedValue(Date.now() - STEP_UP_WINDOW_MS + 5_000);

        await expect(guard.canActivate(refundContext('s1'))).resolves.toBe(true);
      });

      it('refuses it once the window has passed', async () => {
        stepUpStore.lastVerifiedAt.mockResolvedValue(Date.now() - STEP_UP_WINDOW_MS - 1);

        await expect(guard.canActivate(refundContext('s1'))).rejects.toThrow(ForbiddenException);
      });

      it('refuses it for a token without a session id', async () => {
        await expect(guard.canActivate(refundContext(undefined))).rejects.toThrow(ForbiddenException);
        expect(stepUpStore.lastVerifiedAt).not.toHaveBeenCalled();
      });

      it('checks the permission before the step-up', async () => {
        const context = buildContext(
          { user: enrolled, access: cashier, sessionId: 's1' },
          AdminController.prototype.refund,
          AdminController,
        );

        await expect(guard.canActivate(context)).resolves.toBe(false);
      });
    });
  });

  describe('conditional step-up (GraphQL arguments)', () => {
    const context = (args: object) =>
      graphqlContext(
        { user: enrolled, access: manager, sessionId: 's1' },
        AdminController.prototype.editProduct,
        AdminController,
        args,
      );

    it('applies when the condition matches the arguments', async () => {
      await expect(guard.canActivate(context({ price: '10.00' }))).rejects.toThrow(ForbiddenException);
    });

    it('does not apply otherwise', async () => {
      await expect(guard.canActivate(context({ name: 'Renamed' }))).resolves.toBe(true);
      expect(stepUpStore.lastVerifiedAt).not.toHaveBeenCalled();
    });
  });
});
