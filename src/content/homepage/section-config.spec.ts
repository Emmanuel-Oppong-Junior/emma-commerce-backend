import { HomepageSectionType } from '../../generated/prisma/client';
import { checkSectionConfig, richTextProblem, SectionConfigValues } from './section-config';

describe('homepage section config', () => {
  it('fills the defaults of a product carousel and a banner strip', () => {
    expect(checkSectionConfig('PRODUCT_CAROUSEL', { collectionId: 'col1' })).toEqual({
      config: { collectionId: 'col1', productLimit: 12 },
    });
    expect(checkSectionConfig('BANNER_STRIP', { bannerPlacement: 'HOME_STRIP' })).toEqual({
      config: { bannerPlacement: 'HOME_STRIP', bannerLimit: 5 },
    });
  });

  it('keeps the chosen categories and brands in order', () => {
    expect(checkSectionConfig('CATEGORY_GRID', { categoryIds: ['c2', 'c1'] })).toEqual({
      config: { categoryIds: ['c2', 'c1'] },
    });
    expect(checkSectionConfig('BRAND_STRIP', { brandIds: ['b1'], collectionId: null })).toEqual({
      config: { brandIds: ['b1'] },
    });
  });

  it.each([
    ['PRODUCT_CAROUSEL', {}, 'A PRODUCT_CAROUSEL section needs collectionId'],
    ['PRODUCT_CAROUSEL', { collectionId: 'c', productLimit: 25 }, 'productLimit must be 1-24, got 25'],
    [
      'PRODUCT_CAROUSEL',
      { collectionId: 'c', text: 'hi' },
      'A PRODUCT_CAROUSEL section takes collectionId, productLimit, not text',
    ],
    ['CATEGORY_GRID', { categoryIds: [] }, 'A CATEGORY_GRID section needs 1-24 categoryIds, got 0'],
    ['CATEGORY_GRID', { categoryIds: ['c1', 'c1'] }, 'categoryIds lists "c1" twice'],
    [
      'BRAND_STRIP',
      { brandIds: Array.from({ length: 25 }, (_, i) => `b${i}`) },
      'A BRAND_STRIP section needs 1-24 brandIds, got 25',
    ],
    [
      'BANNER_STRIP',
      { bannerPlacement: 'home strip' },
      'A BANNER_STRIP section needs a bannerPlacement such as HOME_STRIP',
    ],
    ['BANNER_STRIP', { bannerPlacement: 'HOME', bannerLimit: 0 }, 'bannerLimit must be 1-10, got 0'],
    ['RICH_TEXT', { text: '   ' }, 'A RICH_TEXT section needs text'],
  ] as [HomepageSectionType, SectionConfigValues, string][])(
    'refuses a %s section with %o',
    (type, values, problem) => {
      expect(checkSectionConfig(type, values)).toEqual({ problem });
    },
  );

  it('stores rich text trimmed', () => {
    expect(checkSectionConfig('RICH_TEXT', { text: '  **Free delivery** in Accra  ' })).toEqual({
      config: { text: '**Free delivery** in Accra' },
    });
  });

  describe('richTextProblem', () => {
    it('accepts limited markdown with internal and https links', () => {
      const text =
        '# Welcome\n\n**Bold**, _italic_ and a list:\n- [Sale](/sale?ref=home)\n- [Brand](https://brand.example)\n\n[faq]: /help/faq';
      expect(richTextProblem(text)).toBeNull();
    });

    it.each([
      ['<script>alert(1)</script>', 'text must not contain HTML; use markdown'],
      ['Hello <b>there</b>', 'text must not contain HTML; use markdown'],
      ['<!-- hidden -->', 'text must not contain HTML; use markdown'],
      ['![logo](https://x.example/a.png)', 'text must not contain images'],
      ['[click](javascript:alert(1))', 'Link "javascript:alert(1" must be an internal path or an https URL'],
      ['[old](http://x.example)', 'Link "http://x.example" must be an internal path or an https URL'],
      ['[x](//evil.example)', 'Link "//evil.example" must be an internal path or an https URL'],
      ['[x]: data:text/html;base64,AAAA', 'Link "data:text/html;base64,AAAA" must be an internal path or an https URL'],
      ['bell\u0007', 'text must not contain control characters'],
      ['a'.repeat(5001), 'text is longer than 5000 characters'],
    ])('refuses %j', (text, problem) => {
      expect(richTextProblem(text)).toBe(problem);
    });

    it('allows a plain "less than" that is not a tag', () => {
      expect(richTextProblem('Prices < GHS 100 this week')).toBeNull();
    });
  });
});
