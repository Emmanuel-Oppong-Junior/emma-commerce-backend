import { Field, ID, InputType, IntersectionType, OmitType, PartialType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Decimal } from '@prisma/client/runtime/client';
import { CollectionType } from '../../../generated/prisma/client';
import { DecimalInputField, IsMoneyAmount } from '../../../commons/money/decimal.scalar';
import { SeoFieldsInput } from '../../../seo/dto/seo-fields.input';
import { ScheduleInput } from '../../dto/schedule.input';

export const MAX_COLLECTION_PRODUCTS = 500;

@InputType({ description: 'Product filters of a rule-based collection; a product must match every rule set' })
export class CollectionRulesInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  subcategoryId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  brandId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  tagId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  productTypeId?: string | null;

  @DecimalInputField({
    nullable: true,
    description: 'Lowest price (inclusive) of an active variant, as the product list filter priceMin',
  })
  @IsOptional()
  @IsMoneyAmount()
  priceMin?: Decimal | null;

  @DecimalInputField({ nullable: true, description: 'Highest price (inclusive), as the product list filter priceMax' })
  @IsOptional()
  @IsMoneyAmount()
  priceMax?: Decimal | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'true: products a visitor sees at a reduced price (a live automatic item promotion open to everyone, without ' +
      'coupon, customer group or first-order condition); false: products with none',
  })
  @IsOptional()
  @IsBoolean()
  onSale?: boolean | null;

  @Field(() => Boolean, { nullable: true, description: 'As the product list filter inStock' })
  @IsOptional()
  @IsBoolean()
  inStock?: boolean | null;
}

@InputType()
export class CreateCollectionInput extends IntersectionType(SeoFieldsInput, ScheduleInput) {
  @Field(() => String, { description: 'Name (max 120 characters); the slug is made from it unless given' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @Field(() => String, { nullable: true, description: 'Max 5000 characters' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @Field(() => String, { nullable: true, description: 'HTTPS URL (upload it with POST /upload/single-image)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'imageUrl must be a valid HTTPS URL' })
  imageUrl?: string | null;

  @Field(() => CollectionType, { description: 'Cannot change later' })
  @IsEnum(CollectionType)
  type: CollectionType;

  @Field(() => CollectionRulesInput, { nullable: true, description: 'RULE: required, at least one rule' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesInput)
  rules?: CollectionRulesInput;

  @Field(() => [ID], {
    nullable: true,
    description: 'MANUAL: the products in order (any status; customers see the published ones), at most 500',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COLLECTION_PRODUCTS)
  @IsString({ each: true })
  productIds?: string[];
}

@InputType()
export class UpdateCollectionInput extends PartialType(
  OmitType(CreateCollectionInput, ['type', 'productIds'] as const),
) {
  @Field(() => CollectionRulesInput, { nullable: true, description: 'RULE only: replaces every rule' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesInput)
  rules?: CollectionRulesInput;
}
