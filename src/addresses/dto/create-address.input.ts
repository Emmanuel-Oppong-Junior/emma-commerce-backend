import { Field, Float, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { GhanaRegion } from '../enums/ghana-region.enum';
import { GHANA_PHONE_FORMATS_DESCRIPTION, IsGhanaPhone } from '../../commons/phone/ghana-phone';
import { GHANA_POST_GPS_DESCRIPTION, IsGhanaPostGps } from '../ghana-post-gps';
import { IsCoordinate } from './coordinate.validator';

export const STORE_COUNTRY = 'GH';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class CreateAddressInput {
  @Field({ description: 'Name of the person receiving the delivery (1-100 characters)' })
  @Transform(trim)
  @IsString({ message: 'Recipient name must be a string' })
  @IsNotEmpty({ message: 'Recipient name must not be empty' })
  @MaxLength(100, { message: 'Recipient name must not exceed 100 characters' })
  recipientName: string;

  @Field({ description: `Phone number of the recipient: ${GHANA_PHONE_FORMATS_DESCRIPTION}` })
  @IsGhanaPhone()
  phone: string;

  @Field(() => GhanaRegion, { description: 'Region' })
  @IsEnum(GhanaRegion, { message: 'Region must be one of the 16 Ghana regions' })
  region: GhanaRegion;

  @Field({ description: 'Street address' })
  @IsNotEmpty({ message: 'Street must not be empty' })
  @IsString({ message: 'Street must be a string' })
  @MaxLength(255, { message: 'Street must not exceed 255 characters' })
  street: string;

  @Field({ description: 'City or town; shipping zones are matched on it' })
  @IsNotEmpty({ message: 'City must not be empty' })
  @IsString({ message: 'City must be a string' })
  @MaxLength(100, { message: 'City must not exceed 100 characters' })
  city: string;

  @Field(() => String, { nullable: true, description: 'Area, neighbourhood or suburb (up to 100 characters)' })
  @IsOptional()
  @IsString({ message: 'Area must be a string' })
  @MaxLength(100, { message: 'Area must not exceed 100 characters' })
  area?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Nearby landmark and delivery directions (up to 200 characters)',
  })
  @IsOptional()
  @IsString({ message: 'Landmark must be a string' })
  @MaxLength(200, { message: 'Landmark must not exceed 200 characters' })
  landmark?: string | null;

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

  @Field(() => String, { nullable: true, description: 'Postal code, if any (Ghana has none in common use)' })
  @IsOptional()
  @IsString({ message: 'Zip code must be a string' })
  @MaxLength(20, { message: 'Zip code must not exceed 20 characters' })
  zipCode?: string | null;

  @Field(() => String, {
    nullable: true,
    defaultValue: STORE_COUNTRY,
    description: 'Country as an ISO 3166-1 alpha-2 code. The store delivers in Ghana only, so it must be GH.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([STORE_COUNTRY], { message: 'Country must be GH: the store delivers in Ghana only' })
  country?: string;
}
