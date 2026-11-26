import { Field, ObjectType } from '@nestjs/graphql';

/** The SEO fields of a product, category, sub-category, brand or collection (P8-C). */
@ObjectType({ isAbstract: true })
export abstract class SeoFields {
  @Field(() => String, { description: 'URL key, unique per kind (see resolveSlug for old slugs)' })
  slug: string;

  @Field(() => String, { nullable: true, description: 'Page title for search engines' })
  metaTitle?: string | null;

  @Field(() => String, { nullable: true, description: 'Page description for search engines' })
  metaDescription?: string | null;

  @Field(() => String, { nullable: true, description: 'HTTPS URL of the image shown when the page is shared' })
  ogImageUrl?: string | null;
}
