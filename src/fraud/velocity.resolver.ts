import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { VelocityService } from './velocity.service';
import {
  ClearOrderReviewFlagsInput,
  FlaggedOrder,
  FlaggedOrdersArgs,
  OrderReviewFlagEntity,
  UpdateVelocityLimitsInput,
  VelocityLimitEntity,
} from './velocity.entities';

@Resolver()
export class VelocityResolver {
  constructor(private readonly velocity: VelocityService) {}

  @RequirePermission('payment.settings.manage')
  @Query(() => [VelocityLimitEntity], {
    description: 'Every velocity rule with its window and the soft and hard limits in force (Owner)',
  })
  velocityLimits() {
    return this.velocity.getLimits();
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => [VelocityLimitEntity], {
    description:
      'Set the soft and hard limits of velocity rules (whole numbers >= 1, hard >= soft); rules left out keep theirs. Owner, recent step-up, audited',
  })
  updateVelocityLimits(@ActiveUser('id') actorId: string, @Args('input') input: UpdateVelocityLimitsInput) {
    return this.velocity.updateLimits(input.limits, actorId);
  }

  @RequirePermission('order.view')
  @Query(() => [FlaggedOrder], {
    description: 'Orders a velocity rule flagged for review that no one has cleared yet, newest first (staff)',
  })
  flaggedOrders(@Args() args: FlaggedOrdersArgs) {
    return this.velocity.flaggedOrders(args.first);
  }

  @RequirePermission('order.manage')
  @Mutation(() => [OrderReviewFlagEntity], {
    description:
      "Clear an order's open review flags with a note, returning them. NOT_FOUND when it has none. Staff, audited",
  })
  clearOrderReviewFlags(@ActiveUser('id') actorId: string, @Args('input') input: ClearOrderReviewFlagsInput) {
    return this.velocity.clearFlags(input.orderId, input.note, actorId);
  }
}
