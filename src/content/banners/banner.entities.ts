import { Field, ID, InputType, Int, ObjectType, PartialType, registerEnumType } from '@nestjs/graphql';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ScheduleInput } from '../dto/schedule.input';
import { ScheduledContent } from '../entities/scheduled.entity';
import { BannerLinkType } from './banner-link';

registerEnumType(BannerLinkType, {
  name: 'BannerLinkType',
  description: 'PRODUCT, CATEGORY, COLLECTION (targetId), PATH (internal path) or URL (https)',
});

export const PLACEMENT_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PLACEMENT_RULE = 'upper-case letters, digits and underscores starting with a letter, e.g. HOME_HERO';
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@ObjectType({ description: 'Where a banner leads' })
export class BannerLink {
  @Field(() => BannerLinkType)
  type: BannerLinkType;

  @Field(() => ID, { nullable: true, description: 'PRODUCT, CATEGORY, COLLECTION: the linked entity' })
  targetId?: string | null;

  @Field(() => String, { nullable: true, description: 'PRODUCT, CATEGORY, COLLECTION: its current slug' })
  slug?: string | null;

  @Field(() => String, { nullable: true, description: 'PATH: the internal path' })
  path?: string | null;

  @Field(() => String, { nullable: true, description: 'URL: the https URL' })
  url?: string | null;
}

@ObjectType({ description: 'A promotional image in a storefront slot (placement)' })
export class Banner extends ScheduledContent {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  title: string;

  @Field(() => String, { nullable: true })
  subtitle: string | null;

  @Field(() => String, { nullable: true, description: 'Text alternative of the image' })
  altText: string | null;

  @Field(() => String, { description: 'Desktop image (HTTPS)' })
  imageUrl: string;

  @Field(() => String, { nullable: true, description: 'Mobile image (HTTPS); null: use imageUrl' })
  mobileImageUrl: string | null;

  @Field(() => String)
  placement: string;

  @Field(() => Int, { description: 'Order within the placement, lowest first' })
  position: number;

  @Field(() => BannerLink, {
    nullable: true,
    description:
      'Null without a link; in public reads also when the linked product, category or collection is gone or hidden',
  })
  link: BannerLink | null;
}

@InputType()
export class BannerLinkInput {
  @Field(() => BannerLinkType)
  @IsEnum(BannerLinkType)
  type: BannerLinkType;

  @Field(() => ID, { nullable: true, description: 'PRODUCT, CATEGORY, COLLECTION: the entity id' })
  @IsOptional()
  @IsString()
  targetId?: string | null;

  @Field(() => String, { nullable: true, description: 'PATH: internal path starting with one "/"' })
  @IsOptional()
  @IsString()
  path?: string | null;

  @Field(() => String, { nullable: true, description: 'URL: absolute https URL (max 2000 characters)' })
  @IsOptional()
  @IsString()
  url?: string | null;
}

@InputType()
export class CreateBannerInput extends ScheduleInput {
  @Field(() => String, { description: 'Max 120 characters' })
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @Field(() => String, { nullable: true, description: 'Max 240 characters' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  subtitle?: string | null;

  @Field(() => String, { nullable: true, description: 'Text alternative of the image (max 240 characters)' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  altText?: string | null;

  @Field(() => String, { description: 'Desktop image, HTTPS (upload it with POST /upload/single-image)' })
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'imageUrl must be a valid HTTPS URL' })
  imageUrl: string;

  @Field(() => String, { nullable: true, description: 'Mobile image, HTTPS' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'mobileImageUrl must be a valid HTTPS URL' })
  mobileImageUrl?: string | null;

  @Field(() => String, { description: `Storefront slot: ${PLACEMENT_RULE} (max 50 characters)` })
  @MaxLength(50)
  @Matches(PLACEMENT_PATTERN, { message: `placement must be ${PLACEMENT_RULE}` })
  placement: string;

  @Field(() => Int, { nullable: true, description: 'Order within the placement, lowest first; default 0' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;

  @Field(() => BannerLinkInput, { nullable: true, description: 'Where the banner leads; null: nowhere' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BannerLinkInput)
  link?: BannerLinkInput | null;
}

@InputType()
export class UpdateBannerInput extends PartialType(CreateBannerInput) {}
