import { Field, ID, InputType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { StockLocationType } from '../../generated/prisma/client';
import { MAX_FULFILMENT_LOCATIONS } from './stock-locations.service';

@InputType()
export class CreateStockLocationInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @Field(() => StockLocationType, { nullable: true, description: 'Defaults to WAREHOUSE' })
  @IsOptional()
  @IsEnum(StockLocationType)
  type?: StockLocationType;

  @Field({ nullable: true, description: 'Defaults to true' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType()
export class UpdateStockLocationInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @Field(() => StockLocationType, { nullable: true })
  @IsOptional()
  @IsEnum(StockLocationType)
  type?: StockLocationType;

  @Field({ nullable: true, description: 'The default location cannot be deactivated' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'true makes this (active) location the default instead of the current one' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

@InputType()
export class FulfilmentLocationsInput {
  @Field(() => [ID], {
    description: `Locations in the order they are tried (at most ${MAX_FULFILMENT_LOCATIONS}); empty = the default location`,
  })
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(MAX_FULFILMENT_LOCATIONS)
  locationIds: string[];
}
