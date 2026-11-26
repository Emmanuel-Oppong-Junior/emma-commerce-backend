import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_KEY, featureDisabled } from './require-feature';
import { SwitchableFeature } from './store-feature-registry';
import { StoreFeaturesService } from './store-features.service';

/**
 * Enforces @RequireFeature on GraphQL operations and REST routes alike: it reads only handler metadata, never the
 * request, so the context type does not matter.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: StoreFeaturesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<SwitchableFeature | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (feature && !(await this.features.isEnabled(feature))) throw featureDisabled(feature);
    return true;
  }
}
