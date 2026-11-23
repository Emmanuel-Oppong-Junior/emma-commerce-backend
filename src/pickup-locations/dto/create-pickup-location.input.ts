import { Field, Float, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Weekday } from '../../shipping-zones/enums/delivery.enums';
import { GhanaRegion } from '../../addresses/enums/ghana-region.enum';
import { GHANA_PHONE_FORMATS_DESCRIPTION, IsGhanaPhone } from '../../commons/phone/ghana-phone';
import { GHANA_POST_GPS_DESCRIPTION, IsGhanaPostGps } from '../../addresses/ghana-post-gps';
import { IsCoordinate } from '../../addresses/dto/coordinate.validator';
import { STORE_COUNTRY } from '../../addresses/dto/create-address.input';

const TIME = /^\d{2}:\d{2}$/;

@InputType({
  description: 'When the point is open on a weekday; HH:MM, Africa/Accra (= UTC). A weekday left out is closed',
})
export class OpeningHoursInput {
  @Field(() => Weekday)
  @IsEnum(Weekday)
  weekday: Weekday;

  @Field()
  @Matches(TIME, { message: 'opens must be HH:MM' })
  opens: string;

  @Field()
  @Matches(TIME, { message: 'closes must be HH:MM' })
  closes: string;
}

@InputType()
export class CreatePickupLocationInput {
  @Field({ description: 'Display name of the pickup location' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Field({ description: 'Street address' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @Field(() => GhanaRegion)
  @IsEnum(GhanaRegion)
  region: GhanaRegion;

  @Field({ nullable: true, defaultValue: STORE_COUNTRY, description: 'GH: pickup points are in Ghana' })
  @IsOptional()
  @IsIn([STORE_COUNTRY], { message: 'Country must be GH' })
  country?: string;

  @Field(() => String, { nullable: true, description: GHANA_PHONE_FORMATS_DESCRIPTION })
  @IsOptional()
  @IsGhanaPhone()
  contactPhone?: string | null;

  @Field(() => String, { nullable: true, description: 'How to find the counter and what to bring' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string | null;

  @Field(() => String, { nullable: true, description: GHANA_POST_GPS_DESCRIPTION })
  @IsOptional()
  @IsGhanaPostGps()
  ghanaPostGps?: string | null;

  @Field(() => Float, { nullable: true, description: 'Latitude, -90 to 90; give it together with longitude' })
  @IsCoordinate('latitude', 'longitude', 90)
  latitude?: number | null;

  @Field(() => Float, { nullable: true, description: 'Longitude, -180 to 180; give it together with latitude' })
  @IsCoordinate('longitude', 'latitude', 180)
  longitude?: number | null;

  @Field(() => [OpeningHoursInput], { nullable: true, defaultValue: [], description: 'At most one entry per weekday' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursInput)
  openingHours?: OpeningHoursInput[];

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
