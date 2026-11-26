import { Field, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { META_DESCRIPTION_MAX_LENGTH, META_TITLE_MAX_LENGTH, SLUG_MAX_LENGTH, SLUG_PATTERN } from '../slug';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The SEO fields of a product, category, sub-category, brand or collection input (P8-C). */
@InputType({ isAbstract: true })
export class SeoFieldsInput {
  @Field(() => String, {
    nullable: true,
    description:
      'URL key, unique per kind: lower-case letters and digits in words joined by hyphens, at most 100 characters. ' +
      'Omitted on create: made from the name (accents dropped, "-2", "-3"... on a clash). A change keeps the old ' +
      'slug as a redirect (resolveSlug); taking an old slug of another entity removes its redirect. Never null.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, { message: 'slug must be lower-case letters and digits in words joined by single hyphens' })
  slug?: string;

  @Field(() => String, { nullable: true, description: 'Page title for search engines (max 120 characters)' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(META_TITLE_MAX_LENGTH)
  metaTitle?: string | null;

  @Field(() => String, { nullable: true, description: 'Page description for search engines (max 320 characters)' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(META_DESCRIPTION_MAX_LENGTH)
  metaDescription?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'HTTPS URL of the image shown when the page is shared (upload it with POST /upload/single-image)',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'ogImageUrl must be a valid HTTPS URL' })
  ogImageUrl?: string | null;
}
