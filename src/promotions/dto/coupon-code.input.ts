import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODE_MESSAGE = 'code may contain only letters, digits, "-" and "_"';

@InputType()
export class CreateCouponCodeInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  promotionId: string;

  @Field({ description: 'Stored upper case; unique ignoring case' })
  @IsString()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code: string;

  @Field({ defaultValue: true })
  @IsBoolean()
  isActive: boolean = true;

  @Field(() => Int, { nullable: true, description: 'Orders that may use this code; null for no limit' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;
}

@InputType({ description: 'Changes to a coupon code: omitted fields stay as they are, null clears usageLimit' })
export class UpdateCouponCodeInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;
}
