import { bannerLinkColumns, bannerLinkOf, BannerLinkType, NO_LINK } from './banner-link';

describe('banner links', () => {
  it('stores no link as all columns null', () => {
    expect(bannerLinkColumns(null)).toEqual({ columns: NO_LINK });
  });

  it.each([
    [BannerLinkType.PRODUCT, 'linkProductId'],
    [BannerLinkType.CATEGORY, 'linkCategoryId'],
    [BannerLinkType.COLLECTION, 'linkCollectionId'],
  ])('stores a %s link in %s', (type, column) => {
    expect(bannerLinkColumns({ type, targetId: 'id1' })).toEqual({ columns: { ...NO_LINK, [column]: 'id1' } });
  });

  it('stores an internal path, normalised, and an https URL', () => {
    expect(bannerLinkColumns({ type: BannerLinkType.PATH, path: '/sale/?ref=hero' })).toEqual({
      columns: { ...NO_LINK, linkPath: '/sale?ref=hero' },
    });
    expect(bannerLinkColumns({ type: BannerLinkType.URL, url: 'https://brand.example/launch' })).toEqual({
      columns: { ...NO_LINK, linkUrl: 'https://brand.example/launch' },
    });
  });

  it.each([
    [{ type: BannerLinkType.PRODUCT }, 'A PRODUCT link takes targetId only'],
    [{ type: BannerLinkType.PRODUCT, targetId: 'p1', path: '/x' }, 'A PRODUCT link takes targetId only'],
    [{ type: BannerLinkType.PATH, url: 'https://x.example' }, 'A PATH link takes path only'],
    [{ type: BannerLinkType.PATH, path: '//evil.example' }, 'Path "//evil.example" must start with a single "/"'],
    [
      { type: BannerLinkType.URL, url: 'http://brand.example' },
      'url "http://brand.example" must be an absolute https URL',
    ],
    [
      { type: BannerLinkType.URL, url: 'javascript:alert(1)' },
      'url "javascript:alert(1)" must be an absolute https URL',
    ],
    [{ type: BannerLinkType.URL, url: `https://x.example/${'a'.repeat(2000)}` }, 'url is longer than 2000 characters'],
  ])('refuses %o', (link, problem) => {
    expect(bannerLinkColumns(link)).toEqual({ problem });
  });

  it('reads the link back from the columns', () => {
    expect(bannerLinkOf({ ...NO_LINK, linkCategoryId: 'c1' })).toEqual({ type: 'CATEGORY', targetId: 'c1' });
    expect(bannerLinkOf({ ...NO_LINK, linkUrl: 'https://x.example' })).toEqual({
      type: 'URL',
      url: 'https://x.example',
    });
    expect(bannerLinkOf(NO_LINK)).toBeNull();
  });
});
