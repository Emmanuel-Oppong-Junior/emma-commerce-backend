import { Field, ID, InputType, Int, ObjectType, OmitType, PartialType, registerEnumType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HomepageSectionType } from '../../generated/prisma/client';
import { ScheduleInput } from '../dto/schedule.input';
import { ScheduledContent } from '../entities/scheduled.entity';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { Brand } from '../../brand/entities/brand.entity';
import { Banner } from '../banners/banner.entities';
import { MAX_RICH_TEXT_LENGTH, MAX_SECTION_ITEMS } from './section-config';

registerEnumType(HomepageSectionType, {
  name: 'HomepageSectionType',
  description:
    'PRODUCT_CAROUSEL (a collection), CATEGORY_GRID, BRAND_STRIP, BANNER_STRIP (a placement) or RICH_TEXT (markdown)',
});

@ObjectType({ description: 'The settings of a homepage section; only those of its type are set' })
export class HomepageSectionConfig {
  @Field(() => ID, { nullable: true, description: 'PRODUCT_CAROUSEL' })
  collectionId?: string;

  @Field(() => Int, { nullable: true, description: 'PRODUCT_CAROUSEL: products shown' })
  productLimit?: number;

  @Field(() => [ID], { nullable: true, description: 'CATEGORY_GRID, in order' })
  categoryIds?: string[];

  @Field(() => [ID], { nullable: true, description: 'BRAND_STRIP, in order' })
  brandIds?: string[];

  @Field(() => String, { nullable: true, description: 'BANNER_STRIP: the banner placement shown' })
  bannerPlacement?: string;

  @Field(() => Int, { nullable: true, description: 'BANNER_STRIP: banners shown' })
  bannerLimit?: number;

  @Field(() => String, { nullable: true, description: 'RICH_TEXT: markdown' })
  text?: string;
}

@ObjectType({ description: 'A homepage section as staff configure it' })
export class HomepageSection extends ScheduledContent {
  @Field(() => ID)
  id: string;

  @Field(() => HomepageSectionType)
  type: HomepageSectionType;

  @Field(() => String, { nullable: true })
  title: string | null;

  @Field(() => Int, { description: 'Order on the homepage, lowest first' })
  position: number;

  @Field(() => HomepageSectionConfig)
  config: HomepageSectionConfig;
}

@ObjectType({ description: 'A live homepage section with its items resolved; only the list of its type is filled' })
export class HomepageBlock {
  @Field(() => ID)
  id: string;

  @Field(() => HomepageSectionType)
  type: HomepageSectionType;

  @Field(() => String, { nullable: true })
  title: string | null;

  @Field(() => [Product], { description: 'PRODUCT_CAROUSEL: published products of the collection, in its order' })
  products: Product[];

  @Field(() => [Category], { description: 'CATEGORY_GRID: the categories that still exist, in order' })
  categories: Category[];

  @Field(() => [Brand], { description: 'BRAND_STRIP: the brands that still exist, in order' })
  brands: Brand[];

  @Field(() => [Banner], { description: 'BANNER_STRIP: the live banners of the placement' })
  banners: Banner[];

  @Field(() => String, { nullable: true, description: 'RICH_TEXT: markdown; render it with HTML off' })
  text: string | null;
}

@InputType({ description: 'The settings of a homepage section: give only those of its type' })
export class HomepageSectionConfigInput {
  @Field(() => ID, { nullable: true, description: 'PRODUCT_CAROUSEL: required' })
  @IsOptional()
  @IsString()
  collectionId?: string | null;

  @Field(() => Int, { nullable: true, description: 'PRODUCT_CAROUSEL: 1-24, default 12' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SECTION_ITEMS)
  productLimit?: number | null;

  @Field(() => [ID], { nullable: true, description: 'CATEGORY_GRID: 1-24, in order' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SECTION_ITEMS)
  @IsString({ each: true })
  categoryIds?: string[] | null;

  @Field(() => [ID], { nullable: true, description: 'BRAND_STRIP: 1-24, in order' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SECTION_ITEMS)
  @IsString({ each: true })
  brandIds?: string[] | null;

  @Field(() => String, { nullable: true, description: 'BANNER_STRIP: required, a placement such as HOME_STRIP' })
  @IsOptional()
  @IsString()
  bannerPlacement?: string | null;

  @Field(() => Int, { nullable: true, description: 'BANNER_STRIP: 1-10, default 5' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  bannerLimit?: number | null;

  @Field(() => String, {
    nullable: true,
    description:
      'RICH_TEXT: required, 1-5000 characters of markdown (headings, bold, italics, lists, links to an internal path ' +
      'or https URL); no HTML or images',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RICH_TEXT_LENGTH)
  text?: string | null;
}

@InputType()
export class CreateHomepageSectionInput extends ScheduleInput {
  @Field(() => HomepageSectionType, { description: 'Cannot change later' })
  @IsEnum(HomepageSectionType)
  type: HomepageSectionType;

  @Field(() => String, { nullable: true, description: 'Max 120 characters' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @Field(() => Int, { nullable: true, description: 'Order on the homepage, lowest first; default 0' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;

  @Field(() => HomepageSectionConfigInput)
  @ValidateNested()
  @Type(() => HomepageSectionConfigInput)
  config: HomepageSectionConfigInput;
}

@InputType()
export class UpdateHomepageSectionInput extends PartialType(OmitType(CreateHomepageSectionInput, ['type'] as const)) {}
