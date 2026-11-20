import { Field, InputType, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { AttributeDataTypeEnum } from '../enums/attribute-data-type.enum';

export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class AttributeDefinitionInput {
  @Field({ description: 'Lower-case key used in attribute maps, e.g. "screen_size" (letters, digits, underscores)' })
  @Matches(ATTRIBUTE_KEY_PATTERN, {
    message: 'key must start with a lower-case letter and contain only a-z, 0-9 and _ (at most 50 characters)',
  })
  key: string;

  @Field()
  @Transform(trim)
  @Length(1, 100)
  label: string;

  @Field(() => AttributeDataTypeEnum)
  @IsEnum(AttributeDataTypeEnum)
  dataType: AttributeDataTypeEnum;

  @Field(() => String, { nullable: true, description: 'Unit of a NUMBER attribute, e.g. "g" or "ml"' })
  @IsOptional()
  @Transform(trim)
  @Length(1, 20)
  unit?: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  isRequired: boolean = false;

  @Field(() => [String], { nullable: true, description: 'Allowed values; omit or leave empty to allow any value' })
  @IsOptional()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  allowedValues?: string[];

  @Field({ defaultValue: false, description: 'Set per variant (size, colour) rather than per product' })
  @IsBoolean()
  isVariantAxis: boolean = false;

  @Field({ defaultValue: false })
  @IsBoolean()
  isFilterable: boolean = false;

  @Field(() => Int, { defaultValue: 0, description: 'Display order, lowest first' })
  @IsInt()
  @Min(0)
  @Max(1000)
  position: number = 0;
}

@InputType({ description: 'Changes to an attribute definition; key, data type and variant-axis flag cannot change' })
export class UpdateAttributeDefinitionInput {
  @Field({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @Length(1, 100)
  label?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Transform(trim)
  @Length(1, 20)
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  allowedValues?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isFilterable?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}
