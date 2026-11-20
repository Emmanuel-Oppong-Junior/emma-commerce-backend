import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { getRequest } from '../../commons/request-context';
import { Permission } from './permissions';
import { CUSTOMER_ONLY_KEY, PERMISSIONS_KEY, STEP_UP_KEY, StepUpCondition } from './policy.decorators';
import { mfaEnrollmentRequired, stepUpRequired } from './policy-errors';
import { isStepUpFresh, StepUpStore } from '../mfa/step-up.store';

/**
 * Enforces @RequirePermission, @CustomerOnly and @RequireStepUp after AuthenticationGuard has loaded the user and
 * their access. Staff whose role requires two-factor authentication are refused every permission-guarded operation
 * until they enrol.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUpStore: StepUpStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const permissions = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    const customerOnly = this.reflector.getAllAndOverride<boolean | undefined>(CUSTOMER_ONLY_KEY, targets);
    const stepUp = this.reflector.getAllAndOverride<StepUpCondition | true | undefined>(STEP_UP_KEY, targets);
    if (!permissions?.length && !customerOnly && !stepUp) return true;

    const { user, access, sessionId } = getRequest(context);
    if (!user || !access) return false;
    if (customerOnly && access.roleKey) {
      throw new ForbiddenException('Staff accounts cannot use customer self-service operations');
    }
    if (!(permissions ?? []).every((permission) => access.permissions.has(permission))) return false;
    if (permissions?.length && access.mfaRequired && !user.mfaEnabledAt) throw mfaEnrollmentRequired();
    if (stepUp && this.stepUpApplies(stepUp, context)) {
      const verifiedAt = sessionId ? await this.stepUpStore.lastVerifiedAt(user.id, sessionId) : null;
      if (!isStepUpFresh(verifiedAt, Date.now())) throw stepUpRequired();
    }
    return true;
  }

  private stepUpApplies(stepUp: StepUpCondition | true, context: ExecutionContext): boolean {
    if (stepUp === true) return true;
    const args = context.getType<GqlContextType>() === 'graphql' ? GqlExecutionContext.create(context).getArgs() : {};
    return stepUp.applies(args);
  }
}
