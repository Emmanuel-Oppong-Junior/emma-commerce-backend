import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min, NotEquals } from 'class-validator';
import { LoyaltyTransactionType } from '../generated/prisma/client';

export const LOYALTY_HISTORY_MAX = 100;

registerEnumType(LoyaltyTransactionType, {
  name: 'LoyaltyTransactionType',
  description: 'What a loyalty transaction did to the points',
  valuesMap: {
    EARN: { description: 'Earned by a completed order' },
    REDEEM: { description: 'Spent at checkout' },
    REDEEM_RETURN: { description: 'Redeemed points given back (order cancelled, expired or refunded)' },
    REVERSE: { description: 'Earned points taken back because the order was refunded' },
    EXPIRE: { description: 'Unspent points past their expiry' },
    ADJUST: { description: 'A correction by the store, with a reason' },
    REFERRAL: { description: 'A referral reward' },
  },
});

@ObjectType({ description: 'One change to a customer’s loyalty points' })
export class LoyaltyTransactionEntity {
  @Field(() => ID)
  id: string;

  @Field(() => LoyaltyTransactionType)
  type: LoyaltyTransactionType;

  @Field(() => Int, { description: 'Change to the balance: positive credited, negative spent, taken back or expired' })
  points: number;

  @Field(() => Int, {
    description:
      'Change to the points owed: positive when points taken back exceeded the balance, negative when repaid',
  })
  debtChange: number;

  @Field(() => ID, { nullable: true, description: 'The order it is about' })
  orderId: string | null;

  @Field(() => String, { nullable: true, description: 'ADJUST: the store’s reason (shown to the customer)' })
  reason: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Points credited by it expire at this time' })
  expiresAt: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType()
export class LoyaltyTransactionPage {
  @Field(() => [LoyaltyTransactionEntity], { description: 'Newest first' })
  nodes: LoyaltyTransactionEntity[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType({ description: 'The points that expire first' })
export class LoyaltyExpiry {
  @Field(() => Int)
  points: number;

  @Field(() => GraphQLISODateTime)
  expiresAt: Date;
}

@ObjectType({ description: 'A customer’s loyalty points' })
export class LoyaltySummary {
  @Field(() => Int, { description: 'Points that can be spent now' })
  balance: number;

  @Field(() => Int, {
    description: 'Points owed: refunds took back more than the balance held; the next points credited pay them off',
  })
  pointsOwed: number;

  @Field(() => LoyaltyExpiry, { nullable: true, description: 'Null when no points are due to expire' })
  nextExpiry: LoyaltyExpiry | null;

  @Field(() => LoyaltyTransactionPage)
  history: LoyaltyTransactionPage;
}

@ObjectType({ description: 'How the store’s loyalty programme earns and redeems points' })
export class LoyaltySettingsEntity {
  @Field({ description: 'Off: no points are earned or redeemed; balances are kept and still expire' })
  enabled: boolean;

  @Field(() => Int, { description: 'Points per whole GHS 1 of goods paid, credited when the order completes' })
  earnPointsPerCedi: number;

  @Field(() => Int, { description: 'Points worth GHS 1 at checkout' })
  redeemPointsPerCedi: number;

  @Field(() => Int, { description: 'The fewest points one checkout may redeem' })
  minimumRedeemPoints: number;

  @Field(() => Int, { description: 'Points pay at most this percentage of the goods after promotions' })
  maxRedeemPercent: number;

  @Field(() => Int, { description: 'Credited points expire after this many months' })
  pointsExpiryMonths: number;
}

@ArgsType()
export class LoyaltyHistoryArgs {
  @Field(() => Int, { defaultValue: 20, description: `1-${LOYALTY_HISTORY_MAX}` })
  @IsInt()
  @Min(1)
  @Max(LOYALTY_HISTORY_MAX)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'Id of the last transaction of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ArgsType()
export class CustomerLoyaltyArgs extends LoyaltyHistoryArgs {
  @Field(() => ID)
  @IsString()
  userId: string;
}

@InputType()
export class AdjustLoyaltyPointsInput {
  @Field(() => ID)
  @IsString()
  userId: string;

  @Field(() => Int, { description: 'Points to add (positive) or take (negative, at most the balance); not 0' })
  @IsInt()
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  points: number;

  @Field({ description: 'Why (3-500 characters); the customer sees it in their history' })
  @IsString()
  @Length(3, 500)
  reason: string;
}

@InputType()
export class UpdateLoyaltySettingsInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @Field(() => Int, { nullable: true, description: '0-100' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  earnPointsPerCedi?: number;

  @Field(() => Int, { nullable: true, description: '1-10000' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  redeemPointsPerCedi?: number;

  @Field(() => Int, { nullable: true, description: '1-1000000' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minimumRedeemPoints?: number;

  @Field(() => Int, { nullable: true, description: '1-100' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxRedeemPercent?: number;

  @Field(() => Int, { nullable: true, description: '1-120; applies to points credited from now on' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  pointsExpiryMonths?: number;
}
