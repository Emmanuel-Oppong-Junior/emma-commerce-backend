import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PromotionScope, RedemptionStatus } from '../../generated/prisma/client';

@ArgsType()
export class PromotionsArgs {
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => PromotionScope, { nullable: true })
  @IsOptional()
  @IsEnum(PromotionScope)
  scope?: PromotionScope;
}

/** One page of redemptions: newest first, `after` is the id of the last row of the previous page. */
@ArgsType()
export class RedemptionsArgs {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  promotionId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  customerId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  orderId?: string;

  @Field(() => RedemptionStatus, { nullable: true })
  @IsOptional()
  @IsEnum(RedemptionStatus)
  status?: RedemptionStatus;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last redemption of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
