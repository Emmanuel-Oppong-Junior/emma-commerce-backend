import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsString, MaxLength } from 'class-validator';
import { ReferralStatus } from '../generated/prisma/client';

registerEnumType(ReferralStatus, {
  name: 'ReferralStatus',
  description: 'Where a referral stands',
  valuesMap: {
    PENDING: { description: "Waiting for the new customer's first order to complete" },
    REWARDED: { description: 'Both were rewarded when that order completed' },
    REVERSED: { description: 'The rewards were taken back: that order was refunded in full within the return window' },
    DISQUALIFIED: { description: 'The first order completed without qualifying (e.g. no verified phone)' },
  },
});

@ObjectType({ description: 'A friend you referred, as you may see them: a first name only' })
export class ReferredFriend {
  @Field()
  displayName: string;

  @Field(() => ReferralStatus)
  status: ReferralStatus;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  rewardedAt: Date | null;
}

@ObjectType({ description: 'Your referral code and the friends who used it' })
export class MyReferrals {
  @Field({ description: 'Share it: a new customer enters it at sign-up or before their first order' })
  code: string;

  @Field(() => String, { nullable: true, description: 'Who referred you (first name), if anyone' })
  referredBy: string | null;

  @Field(() => Int, { description: 'Friends whose first order has not completed yet' })
  pendingCount: number;

  @Field(() => Int, { description: 'Friends whose first order completed and earned you both points' })
  rewardedCount: number;

  @Field(() => Int, { description: 'Referral points you earned (rewards later taken back excluded)' })
  pointsEarned: number;

  @Field(() => [ReferredFriend], { description: 'Newest first' })
  referrals: ReferredFriend[];
}

@ObjectType({ description: 'A referral as staff see it' })
export class StaffReferral {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  referrerId: string;

  @Field(() => ID)
  refereeId: string;

  @Field({ description: "The new customer's first name" })
  refereeDisplayName: string;

  @Field(() => ReferralStatus)
  status: ReferralStatus;

  @Field(() => String, {
    nullable: true,
    description: 'DISQUALIFIED: PHONE_NOT_VERIFIED, SAME_PHONE, REFERRALS_DISABLED or LOYALTY_DISABLED',
  })
  disqualifiedReason: string | null;

  @Field({ description: "The referrer's sign-ups were over the soft velocity limit when this one was entered" })
  velocityFlagged: boolean;

  @Field(() => ID, { nullable: true, description: "The new customer's first completed order" })
  orderId: string | null;

  @Field(() => Int)
  referrerPoints: number;

  @Field(() => Int)
  refereePoints: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  rewardedAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  reversedAt: Date | null;
}

@ObjectType({ description: "A customer's referrals (staff)" })
export class CustomerReferrals {
  @Field(() => String, { nullable: true, description: 'Null until the customer first asks for it' })
  code: string | null;

  @Field(() => StaffReferral, { nullable: true, description: 'The referral that brought this customer, if any' })
  referredBy: StaffReferral | null;

  @Field(() => [StaffReferral], { description: 'Customers this one referred, newest first' })
  referrals: StaffReferral[];
}

@InputType()
export class ApplyReferralCodeInput {
  @Field({ description: "A friend's referral code (case, spaces and hyphens ignored)" })
  @IsString()
  @MaxLength(32)
  code: string;
}

@ArgsType()
export class CustomerReferralsArgs {
  @Field(() => ID)
  @IsString()
  userId: string;
}
