import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SerialUnitStatus } from '../../../generated/prisma/client';

@ArgsType()
export class SerialUnitsArgs {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => ID, { nullable: true, description: 'Units at this location only (IN_STOCK and ASSIGNED have one)' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => [SerialUnitStatus], { defaultValue: [SerialUnitStatus.IN_STOCK] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsEnum(SerialUnitStatus, { each: true })
  statuses: SerialUnitStatus[] = [SerialUnitStatus.IN_STOCK];

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last unit of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
