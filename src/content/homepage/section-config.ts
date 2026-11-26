import { HomepageSectionType } from '../../generated/prisma/client';
import { internalPathProblem, isHttpsUrl } from '../links';

// The config of each homepage section type (P8-C), as stored in HomepageSection.config. Pure.

export const MAX_SECTION_ITEMS = 24;
export const DEFAULT_PRODUCT_LIMIT = 12;
export const MAX_SECTION_BANNERS = 10;
export const DEFAULT_BANNER_LIMIT = 5;
export const MAX_RICH_TEXT_LENGTH = 5000;
const PLACEMENT = /^[A-Z][A-Z0-9_]{0,49}$/;

export interface SectionConfigValues {
  collectionId?: string | null;
  productLimit?: number | null;
  categoryIds?: string[] | null;
  brandIds?: string[] | null;
  bannerPlacement?: string | null;
  bannerLimit?: number | null;
  text?: string | null;
}

export interface ProductCarouselConfig {
  collectionId: string;
  productLimit: number;
}
export interface CategoryGridConfig {
  categoryIds: string[];
}
export interface BrandStripConfig {
  brandIds: string[];
}
export interface BannerStripConfig {
  bannerPlacement: string;
  bannerLimit: number;
}
export interface RichTextConfig {
  text: string;
}
export type SectionConfig =
  ProductCarouselConfig | CategoryGridConfig | BrandStripConfig | BannerStripConfig | RichTextConfig;

const FIELDS: Record<HomepageSectionType, (keyof SectionConfigValues)[]> = {
  PRODUCT_CAROUSEL: ['collectionId', 'productLimit'],
  CATEGORY_GRID: ['categoryIds'],
  BRAND_STRIP: ['brandIds'],
  BANNER_STRIP: ['bannerPlacement', 'bannerLimit'],
  RICH_TEXT: ['text'],
};

type Checked = { config: SectionConfig; problem?: undefined } | { problem: string };

/** The stored config of a section of the type, with defaults filled in, or why the values do not fit the type. */
export function checkSectionConfig(type: HomepageSectionType, values: SectionConfigValues): Checked {
  const allowed = FIELDS[type];
  const foreign = (Object.keys(values) as (keyof SectionConfigValues)[]).find(
    (key) => values[key] != null && !allowed.includes(key),
  );
  if (foreign) return { problem: `A ${type} section takes ${allowed.join(', ')}, not ${foreign}` };
  switch (type) {
    case 'PRODUCT_CAROUSEL': {
      if (!values.collectionId) return { problem: 'A PRODUCT_CAROUSEL section needs collectionId' };
      const productLimit = values.productLimit ?? DEFAULT_PRODUCT_LIMIT;
      if (!Number.isInteger(productLimit) || productLimit < 1 || productLimit > MAX_SECTION_ITEMS) {
        return { problem: `productLimit must be 1-${MAX_SECTION_ITEMS}, got ${productLimit}` };
      }
      return { config: { collectionId: values.collectionId, productLimit } };
    }
    case 'CATEGORY_GRID':
    case 'BRAND_STRIP': {
      const key = type === 'CATEGORY_GRID' ? 'categoryIds' : 'brandIds';
      const ids = values[key] ?? [];
      if (ids.length < 1 || ids.length > MAX_SECTION_ITEMS) {
        return { problem: `A ${type} section needs 1-${MAX_SECTION_ITEMS} ${key}, got ${ids.length}` };
      }
      const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
      if (repeated) return { problem: `${key} lists "${repeated}" twice` };
      return { config: (key === 'categoryIds' ? { categoryIds: ids } : { brandIds: ids }) as SectionConfig };
    }
    case 'BANNER_STRIP': {
      if (!values.bannerPlacement || !PLACEMENT.test(values.bannerPlacement)) {
        return { problem: 'A BANNER_STRIP section needs a bannerPlacement such as HOME_STRIP' };
      }
      const bannerLimit = values.bannerLimit ?? DEFAULT_BANNER_LIMIT;
      if (!Number.isInteger(bannerLimit) || bannerLimit < 1 || bannerLimit > MAX_SECTION_BANNERS) {
        return { problem: `bannerLimit must be 1-${MAX_SECTION_BANNERS}, got ${bannerLimit}` };
      }
      return { config: { bannerPlacement: values.bannerPlacement, bannerLimit } };
    }
    case 'RICH_TEXT': {
      const text = values.text?.trim() ?? '';
      const problem = richTextProblem(text);
      return problem ? { problem } : { config: { text } };
    }
  }
}

// An HTML tag, comment or declaration: rich text is markdown only, so nothing a browser would parse as markup.
const HTML = /<[a-zA-Z!/?]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const INLINE_LINK = /\]\(\s*<?([^)\s>]*)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s*<?(\S*?)>?(\s|$)/gm;

/**
 * Why the text is not acceptable rich text, or null. Allowed: plain text with limited markdown (headings, bold,
 * italics, lists, line breaks and links to an internal path or an https URL), 1-5000 characters. Refused: HTML,
 * images, control characters and any other link target (javascript:, http:, data:, "//host"). Clients render it as
 * markdown with HTML off.
 */
export function richTextProblem(text: string): string | null {
  if (!text) return 'A RICH_TEXT section needs text';
  if (text.length > MAX_RICH_TEXT_LENGTH) return `text is longer than ${MAX_RICH_TEXT_LENGTH} characters`;
  if (CONTROL.test(text)) return 'text must not contain control characters';
  if (HTML.test(text)) return 'text must not contain HTML; use markdown';
  if (text.includes('![')) return 'text must not contain images';
  const hrefs = [...text.matchAll(INLINE_LINK), ...text.matchAll(REFERENCE_LINK)].map((match) => match[1]);
  const bad = hrefs.find((href) => !isHttpsUrl(href) && internalPathProblem(href) !== null);
  return bad === undefined ? null : `Link "${bad}" must be an internal path or an https URL`;
}
