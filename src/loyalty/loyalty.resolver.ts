import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { LoyaltyService } from './loyalty.service';
import {
  AdjustLoyaltyPointsInput,
  CustomerLoyaltyArgs,
  LoyaltyHistoryArgs,
  LoyaltySettingsEntity,
  LoyaltySummary,
  UpdateLoyaltySettingsInput,
} from './loyalty.entities';

/** Loyalty points (P6-L.1). */
@Resolver()
export class LoyaltyResolver {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Auth(AuthType.Bearer)
  @Query(() => LoyaltySummary, {
    description: 'Your loyalty points: balance, points owed, the next expiry and your history (newest first)',
  })
  myLoyalty(@ActiveUser('id') userId: string, @Args() { first, after }: LoyaltyHistoryArgs) {
    return this.loyalty.summary(userId, first, after);
  }

  @Auth(AuthType.None)
  @Query(() => LoyaltySettingsEntity, { description: 'How the loyalty programme earns and redeems points (public)' })
  loyaltySettings() {
    return this.loyalty.settings();
  }

  @RequirePermission('user.view')
  @Query(() => LoyaltySummary, { description: "A customer's loyalty points and history (staff)" })
  customerLoyalty(@Args() { userId, first, after }: CustomerLoyaltyArgs) {
    return this.loyalty.customerSummary(userId, first, after);
  }

  @RequirePermission('loyalty.manage')
  @RequireStepUp()
  @Mutation(() => LoyaltySummary, {
    description:
      "Add (positive) or take (negative) a customer's points with a reason. Added points expire like earned ones; " +
      'taking more than the balance is CONFLICT (reason INSUFFICIENT_POINTS); staff accounts are refused. Owner or ' +
      'Manager, recent step-up, audited',
  })
  adjustLoyaltyPoints(@ActiveUser('id') actorId: string, @Args('input') input: AdjustLoyaltyPointsInput) {
    return this.loyalty.adjust(input, actorId);
  }

  @RequirePermission('loyalty.manage')
  @RequireStepUp()
  @Mutation(() => LoyaltySettingsEntity, {
    description:
      'Change the loyalty programme settings; fields left out keep theirs. Owner or Manager, recent step-up, audited',
  })
  updateLoyaltySettings(@ActiveUser('id') actorId: string, @Args('input') input: UpdateLoyaltySettingsInput) {
    return this.loyalty.updateSettings(input, actorId);
  }
}
