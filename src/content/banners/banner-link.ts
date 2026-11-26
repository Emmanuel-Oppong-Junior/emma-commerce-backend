import { internalPathProblem, isHttpsUrl, normalisePath } from '../links';

// Where a banner leads (P8-C): a product, category or collection page, an internal path, or an https URL staff typed
// (content.manage only; never http, javascript: or a protocol-relative "//host"). Pure.

export enum BannerLinkType {
  PRODUCT = 'PRODUCT',
  CATEGORY = 'CATEGORY',
  COLLECTION = 'COLLECTION',
  PATH = 'PATH',
  URL = 'URL',
}

export const MAX_URL_LENGTH = 2000;

export interface BannerLinkValue {
  type: BannerLinkType;
  targetId?: string | null;
  path?: string | null;
  url?: string | null;
}

export interface BannerLinkColumns {
  linkProductId: string | null;
  linkCategoryId: string | null;
  linkCollectionId: string | null;
  linkPath: string | null;
  linkUrl: string | null;
}

export const NO_LINK: BannerLinkColumns = {
  linkProductId: null,
  linkCategoryId: null,
  linkCollectionId: null,
  linkPath: null,
  linkUrl: null,
};

const TARGET_COLUMNS = {
  [BannerLinkType.PRODUCT]: 'linkProductId',
  [BannerLinkType.CATEGORY]: 'linkCategoryId',
  [BannerLinkType.COLLECTION]: 'linkCollectionId',
} as const;

/** The banner columns for a link (null: no link), or why the link is not valid. */
export function bannerLinkColumns(
  link: BannerLinkValue | null,
): { columns: BannerLinkColumns; problem?: undefined } | { problem: string } {
  if (!link) return { columns: NO_LINK };
  const { type, targetId, path, url } = link;
  const given = [targetId, path, url].filter((value) => value != null).length;
  if (type === BannerLinkType.PATH) {
    if (path == null || given !== 1) return { problem: 'A PATH link takes path only' };
    const problem = internalPathProblem(path);
    return problem ? { problem } : { columns: { ...NO_LINK, linkPath: normalisePath(path) } };
  }
  if (type === BannerLinkType.URL) {
    if (url == null || given !== 1) return { problem: 'A URL link takes url only' };
    if (url.length > MAX_URL_LENGTH) return { problem: `url is longer than ${MAX_URL_LENGTH} characters` };
    return isHttpsUrl(url)
      ? { columns: { ...NO_LINK, linkUrl: url } }
      : { problem: `url "${url}" must be an absolute https URL` };
  }
  if (targetId == null || given !== 1) return { problem: `A ${type} link takes targetId only` };
  return { columns: { ...NO_LINK, [TARGET_COLUMNS[type]]: targetId } };
}

/** The link the banner columns hold, or null. */
export function bannerLinkOf(columns: BannerLinkColumns): BannerLinkValue | null {
  if (columns.linkProductId) return { type: BannerLinkType.PRODUCT, targetId: columns.linkProductId };
  if (columns.linkCategoryId) return { type: BannerLinkType.CATEGORY, targetId: columns.linkCategoryId };
  if (columns.linkCollectionId) return { type: BannerLinkType.COLLECTION, targetId: columns.linkCollectionId };
  if (columns.linkPath) return { type: BannerLinkType.PATH, path: columns.linkPath };
  if (columns.linkUrl) return { type: BannerLinkType.URL, url: columns.linkUrl };
  return null;
}
