import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { StockMovementReason } from '../../generated/prisma/client';

@ArgsType()
export class StockMovementsArgs {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  variantId?: string;

  @Field(() => ID, { nullable: true, description: 'Movements of every variant of the product' })
  @IsOptional()
  @IsString()
  productId?: string;

  @Field(() => StockMovementReason, { nullable: true })
  @IsOptional()
  @IsEnum(StockMovementReason)
  reason?: StockMovementReason;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last movement of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
