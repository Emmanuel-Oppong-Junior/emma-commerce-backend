import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ZoneAreaInput } from './zone-area.input';

@InputType()
export class CreateShippingZoneInput {
  @Field({ description: 'Unique name for this shipping zone' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Field(() => [ZoneAreaInput], {
    description: 'Regions, towns and areas covered. Each may belong to one zone only (CONFLICT naming the clash)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ZoneAreaInput)
  areas: ZoneAreaInput[];

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
