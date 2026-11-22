import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { StockTakeStatus } from '../../../generated/prisma/client';

@ArgsType()
export class StockTakesArgs {
  @Field(() => StockTakeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(StockTakeStatus)
  status?: StockTakeStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => Int, { defaultValue: 20, description: '1-200' })
  @IsInt()
  @Min(1)
  @Max(200)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'Id of the last stock-take of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ArgsType()
export class StockTakeLinesArgs {
  @Field(() => ID)
  @IsString()
  stockTakeId: string;

  @Field({ nullable: true, description: 'true: counted lines only; false: lines still to count; omitted: all' })
  @IsOptional()
  @IsBoolean()
  counted?: boolean;

  @Field(() => Int, { defaultValue: 50, description: '1-200' })
  @IsInt()
  @Min(1)
  @Max(200)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last line of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
