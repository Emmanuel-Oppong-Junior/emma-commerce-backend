import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ZoneAreaInput } from './zone-area.input';

// Omitted means unchanged; null is validated (and rejected): none of these can be cleared.
const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({ description: 'Zone fields to change; omitted fields keep their value' })
export class UpdateShippingZoneInput {
  @Field({ nullable: true })
  @unlessOmitted
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @Field(() => [ZoneAreaInput], { nullable: true, description: 'Replaces every area of the zone' })
  @unlessOmitted
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ZoneAreaInput)
  areas?: ZoneAreaInput[];

  @Field({ nullable: true })
  @unlessOmitted
  @IsBoolean()
  isActive?: boolean;
}
