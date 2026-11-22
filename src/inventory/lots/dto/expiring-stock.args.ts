import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DEFAULT_EXPIRING_WITHIN_DAYS, MAX_EXPIRING_WITHIN_DAYS } from '../lots';

@ArgsType()
export class ExpiringStockArgs {
  @Field(() => Int, {
    defaultValue: DEFAULT_EXPIRING_WITHIN_DAYS,
    description: `Lots expiring within this many days, expired ones included (1-${MAX_EXPIRING_WITHIN_DAYS})`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_EXPIRING_WITHIN_DAYS)
  withinDays: number = DEFAULT_EXPIRING_WITHIN_DAYS;

  @Field(() => ID, { nullable: true, description: 'Only units at this location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => ID, { nullable: true, description: 'Only products of this category' })
  @IsOptional()
  @IsString()
  categoryId?: string;
}
