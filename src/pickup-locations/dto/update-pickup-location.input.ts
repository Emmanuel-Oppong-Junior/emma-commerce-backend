import { Field, Float, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { GhanaRegion } from '../../addresses/enums/ghana-region.enum';
import { GHANA_PHONE_FORMATS_DESCRIPTION, IsGhanaPhone } from '../../commons/phone/ghana-phone';
import { GHANA_POST_GPS_DESCRIPTION, IsGhanaPostGps } from '../../addresses/ghana-post-gps';
import { IsCoordinate } from '../../addresses/dto/coordinate.validator';
import { OpeningHoursInput } from './create-pickup-location.input';

// Omitted means unchanged; null is validated (and rejected) for fields that cannot be cleared.
const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({
  description: 'Pickup point fields to change; omitted fields keep their value, null clears an optional one',
})
export class UpdatePickupLocationInput {
  @Field({ nullable: true })
  @unlessOmitted
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @Field({ nullable: true })
  @unlessOmitted
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address?: string;

  @Field({ nullable: true })
  @unlessOmitted
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @Field(() => GhanaRegion, { nullable: true })
  @unlessOmitted
  @IsEnum(GhanaRegion)
  region?: GhanaRegion;

  @Field(() => String, { nullable: true, description: GHANA_PHONE_FORMATS_DESCRIPTION })
  @IsOptional()
  @IsGhanaPhone()
  contactPhone?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string | null;

  @Field(() => String, { nullable: true, description: GHANA_POST_GPS_DESCRIPTION })
  @IsOptional()
  @IsGhanaPostGps()
  ghanaPostGps?: string | null;

  @Field(() => Float, { nullable: true })
  @IsCoordinate('latitude', 'longitude', 90)
  latitude?: number | null;

  @Field(() => Float, { nullable: true })
  @IsCoordinate('longitude', 'latitude', 180)
  longitude?: number | null;

  @Field(() => [OpeningHoursInput], { nullable: true, description: 'Replaces the whole week' })
  @unlessOmitted
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursInput)
  openingHours?: OpeningHoursInput[];

  @Field({ nullable: true })
  @unlessOmitted
  @IsBoolean()
  isActive?: boolean;
}
