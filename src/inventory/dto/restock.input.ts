import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

@InputType()
export class RestockProductInput {
  @Field(() => ID)
  @IsString()
  productId: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  reason?: string;
}

@InputType()
export class RestockVariantInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  reason?: string;
}
