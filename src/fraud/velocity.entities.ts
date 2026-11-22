import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { OrderStatus, VelocityLevel, VelocityRule } from '../generated/prisma/client';
import { MoneyObject } from '../commons/money/money.object';
import { OrderStatusEnum } from '../order/enums/order.enum';
import { VelocityEvent, VelocitySubject } from './velocity-rules';

registerEnumType(VelocityRule, {
  name: 'VelocityRule',
  description: 'A velocity rule: one event counted per subject (customer, phone, IP, card) over a fixed window',
});
registerEnumType(VelocityLevel, {
  name: 'VelocityLevel',
  description: 'SOFT lets the action through and flags the order; HARD refuses it (card rules can only flag)',
});
registerEnumType(VelocityEvent, { name: 'VelocityEvent', description: 'What a velocity rule counts' });
registerEnumType(VelocitySubject, { name: 'VelocitySubject', description: 'Who or what a velocity rule counts per' });

@ObjectType({ description: 'A velocity rule and the limits in force for it' })
export class VelocityLimitEntity {
  @Field(() => VelocityRule)
  rule: VelocityRule;

  @Field(() => VelocityEvent)
  event: VelocityEvent;

  @Field(() => VelocitySubject)
  subject: VelocitySubject;

  @Field(() => Int)
  windowSeconds: number;

  @Field(() => Int, { description: 'Above this count in the window the order is flagged for review' })
  softLimit: number;

  @Field(() => Int, { description: 'Above this count in the window the action is refused (card rules: flagged HARD)' })
  hardLimit: number;

  @Field({ description: 'Whether the code default applies (the store has not set its own limits for the rule)' })
  isDefault: boolean;
}

@InputType()
export class VelocityLimitInput {
  @Field(() => VelocityRule)
  @IsEnum(VelocityRule)
  rule: VelocityRule;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  softLimit: number;

  @Field(() => Int, { description: 'At least softLimit' })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  hardLimit: number;
}

@InputType({ description: 'Limits to set; rules left out keep theirs' })
export class UpdateVelocityLimitsInput {
  @Field(() => [VelocityLimitInput])
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VelocityLimitInput)
  limits: VelocityLimitInput[];
}

@ObjectType({ description: 'A velocity rule that fired on an order; never shows the phone, IP or card it counted' })
export class OrderReviewFlagEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => VelocityRule)
  rule: VelocityRule;

  @Field(() => VelocityLevel)
  level: VelocityLevel;

  @Field(() => Int, { description: 'The count in the window when the rule fired' })
  count: number;

  @Field(() => Int, { description: 'The limit the count went above' })
  limit: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  clearedAt: Date | null;

  @Field(() => ID, { nullable: true, description: 'The staff user who cleared the flag' })
  clearedById: string | null;

  @Field(() => String, { nullable: true })
  clearNote: string | null;
}

@ObjectType({ description: 'An order with open review flags (viewOrder has the details)' })
export class FlaggedOrder {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => ID)
  userId: string;

  @Field(() => OrderStatusEnum)
  status: OrderStatus;

  @Field(() => MoneyObject)
  grandTotal: Decimal;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => [OrderReviewFlagEntity], { description: 'The open flags, oldest first' })
  reviewFlags: OrderReviewFlagEntity[];
}

@ArgsType()
export class FlaggedOrdersArgs {
  @Field(() => Int, { defaultValue: 20, description: '1-100, newest orders first' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 20;
}

@InputType()
export class ClearOrderReviewFlagsInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @Field({ description: 'Why the order is fine (or what was done), kept with the flags and in the audit log' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note: string;
}
