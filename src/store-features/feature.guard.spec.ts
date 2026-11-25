import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureGuard } from './feature.guard';
import { RequireFeature } from './require-feature';

class FeatureResolver {
  @RequireFeature('WISHLIST')
  gated() {}

  open() {}
}

function contextFor(type: 'graphql' | 'http', handler: () => void): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => FeatureResolver,
  } as unknown as ExecutionContext;
}

describe('FeatureGuard (P8-F)', () => {
  const features = { isEnabled: jest.fn() };
  const guard = new FeatureGuard(new Reflector(), features as never);
  const prototype = FeatureResolver.prototype;

  beforeEach(() => features.isEnabled.mockReset());

  it.each(['graphql', 'http'] as const)('refuses a gated %s operation while its feature is off', async (type) => {
    features.isEnabled.mockResolvedValue(false);

    const refusal = guard.canActivate(contextFor(type, prototype.gated));

    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toMatchObject({
      response: { extensions: { reason: 'FEATURE_DISABLED', feature: 'WISHLIST' } },
    });
    expect(features.isEnabled).toHaveBeenCalledWith('WISHLIST');
  });

  it.each(['graphql', 'http'] as const)('lets a gated %s operation through while its feature is on', async (type) => {
    features.isEnabled.mockResolvedValue(true);

    await expect(guard.canActivate(contextFor(type, prototype.gated))).resolves.toBe(true);
  });

  it('never reads the switches for an operation without @RequireFeature', async () => {
    await expect(guard.canActivate(contextFor('graphql', prototype.open))).resolves.toBe(true);
    expect(features.isEnabled).not.toHaveBeenCalled();
  });
});
