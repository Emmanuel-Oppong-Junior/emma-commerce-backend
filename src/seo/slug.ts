import { SlugEntityType } from '../generated/prisma/client';

// The database makes a slug from the name when none is given ("seo_slug_base"/"seo_unique_slug" in the
// 20261217100000_content_seo migration) and records old slugs as redirects (trigger); this file only checks the slugs
// staff type.

/** Lower-case ASCII letters and digits in words joined by single hyphens (the database CHECK is the same). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 100;
export const META_TITLE_MAX_LENGTH = 120;
export const META_DESCRIPTION_MAX_LENGTH = 320;

/** Why `slug` cannot be a slug, or null. */
export function slugProblem(slug: string): string | null {
  if (slug.length > SLUG_MAX_LENGTH) return `Slug "${slug}" is longer than ${SLUG_MAX_LENGTH} characters`;
  if (!SLUG_PATTERN.test(slug)) {
    return `Slug "${slug}" must be lower-case letters and digits in words joined by single hyphens, e.g. "summer-sale"`;
  }
  return null;
}

export const SLUG_ENTITY_LABELS: Record<SlugEntityType, string> = {
  PRODUCT: 'product',
  CATEGORY: 'category',
  SUB_CATEGORY: 'sub-category',
  BRAND: 'brand',
  COLLECTION: 'collection',
};
