import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { CustomerOnly, RequirePermission } from '../iam/authorization/policy.decorators';
import { ReferralsService } from './referrals.service';
import { ApplyReferralCodeInput, CustomerReferrals, CustomerReferralsArgs, MyReferrals } from './referrals.entities';

/** Referrals (P6-L.2). */
@Resolver()
export class ReferralsResolver {
  constructor(private readonly referrals: ReferralsService) {}

  @Auth(AuthType.Bearer)
  @Query(() => MyReferrals, {
    description: 'Your referral code (created on first use), who referred you, and the friends who used your code',
  })
  myReferrals(@ActiveUser('id') userId: string) {
    return this.referrals.mine(userId);
  }

  @CustomerOnly()
  @Mutation(() => MyReferrals, {
    description:
      "Enter a friend's referral code, once and before your first order. BAD_REQUEST with reason " +
      'INVALID_REFERRAL_CODE, SELF_REFERRAL, ALREADY_REFERRED, HAS_ORDERS or MUTUAL_REFERRAL; FORBIDDEN with reason ' +
      'VELOCITY_LIMIT when the code was used too often today',
  })
  applyReferralCode(@ActiveUser('id') userId: string, @Args('input') input: ApplyReferralCodeInput) {
    return this.referrals.apply(userId, input.code);
  }

  @RequirePermission('user.view')
  @Query(() => CustomerReferrals, { description: "A customer's referral code and referrals (staff)" })
  customerReferrals(@Args() { userId }: CustomerReferralsArgs) {
    return this.referrals.forCustomer(userId);
  }
}
