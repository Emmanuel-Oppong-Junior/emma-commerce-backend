import { BadRequestException, SetMetadata } from '@nestjs/common';
import { SwitchableFeature } from './store-feature-registry';

export const FEATURE_KEY = 'requiredStoreFeature';

/** `extensions.reason` of the BAD_REQUEST for an operation of a feature the store switched off; `feature` names it. */
export const FEATURE_DISABLED = 'FEATURE_DISABLED';

/** The operation belongs to `feature`: FeatureGuard refuses it while the store has the feature off. */
export const RequireFeature = (feature: SwitchableFeature) => SetMetadata(FEATURE_KEY, feature);

export function featureDisabled(feature: SwitchableFeature): BadRequestException {
  return new BadRequestException({
    message: `${feature} is switched off for this store`,
    extensions: { reason: FEATURE_DISABLED, feature },
  });
}
