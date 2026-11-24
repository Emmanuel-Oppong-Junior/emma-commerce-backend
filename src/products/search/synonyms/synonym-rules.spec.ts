import {
  expandSearchText,
  MAX_SEARCH_VARIANTS,
  normaliseTerm,
  SynonymGroup,
  synonymGroupProblem,
} from './synonym-rules';

const phones: SynonymGroup = { kind: 'TWO_WAY', term: null, synonyms: ['phone', 'mobile', 'cellphone'] };
const tv: SynonymGroup = { kind: 'ONE_WAY', term: 'tv', synonyms: ['television'] };

describe('synonym rules', () => {
  describe('normaliseTerm', () => {
    it('lower-cases, trims and single-spaces', () => {
      expect(normaliseTerm('  Cell   Phone ')).toBe('cell phone');
    });
  });

  describe('synonymGroupProblem', () => {
    it('accepts a two-way group and a one-way group', () => {
      expect(synonymGroupProblem(phones)).toBeNull();
      expect(synonymGroupProblem(tv)).toBeNull();
      expect(synonymGroupProblem({ kind: 'TWO_WAY', term: null, synonyms: ['t-shirt', 'tee'] })).toBeNull();
    });

    it.each<[string, SynonymGroup, string]>([
      ['a two-way group with a term', { kind: 'TWO_WAY', term: 'x', synonyms: ['a', 'b'] }, 'has no term'],
      ['a one-way group without a term', { kind: 'ONE_WAY', term: null, synonyms: ['a'] }, 'needs the term'],
      ['a two-way group of one', { kind: 'TWO_WAY', term: null, synonyms: ['a'] }, 'takes 2-20 synonyms, got 1'],
      [
        'too many synonyms',
        { kind: 'ONE_WAY', term: 'x', synonyms: Array.from({ length: 21 }, (_, i) => `s${i}`) },
        'takes 1-20',
      ],
      ['search syntax in a term', { kind: 'TWO_WAY', term: null, synonyms: ['"phone"', 'mobile'] }, 'only letters'],
      ['a leading hyphen', { kind: 'ONE_WAY', term: 'tv', synonyms: ['-cheap'] }, 'only letters'],
      ['a blank term', { kind: 'TWO_WAY', term: null, synonyms: ['', 'a'] }, '1-100 characters'],
      ['a repeated term', { kind: 'ONE_WAY', term: 'tv', synonyms: ['tv'] }, '"tv" appears twice'],
    ])('refuses %s', (_case, group, message) => {
      expect(synonymGroupProblem(group)).toContain(message);
    });
  });

  describe('expandSearchText', () => {
    it('adds a variant per synonym of a two-way term, keeping the rest of the text', () => {
      expect(expandSearchText('Samsung phone case', [phones])).toEqual([
        'Samsung phone case',
        'Samsung mobile case',
        'Samsung cellphone case',
      ]);
      expect(expandSearchText('mobile', [phones])).toEqual(['mobile', 'phone', 'cellphone']);
    });

    it('expands a one-way term only from its own side', () => {
      expect(expandSearchText('tv stand', [tv])).toEqual(['tv stand', 'television stand']);
      expect(expandSearchText('television', [tv])).toEqual(['television']);
    });

    it('matches whole words only, ignoring case', () => {
      expect(expandSearchText('phones', [phones])).toEqual(['phones']);
      expect(expandSearchText('PHONE', [phones])).toEqual(['PHONE', 'mobile', 'cellphone']);
    });

    it('matches multi-word terms, longest first', () => {
      const groups: SynonymGroup[] = [{ kind: 'TWO_WAY', term: null, synonyms: ['cell phone', 'handset'] }, phones];
      expect(expandSearchText('cell phone cover', groups)).toEqual(['cell phone cover', 'handset cover']);
    });

    it('leaves exclusions and the OR operator alone, and keeps quotes', () => {
      expect(expandSearchText('case -phone', [phones])).toEqual(['case -phone']);
      expect(
        expandSearchText('"phone case" OR tv', [phones, tv, { kind: 'ONE_WAY', term: 'or', synonyms: ['x'] }]),
      ).toEqual([
        '"phone case" OR tv',
        '"mobile case" OR tv',
        '"cellphone case" OR tv',
        '"phone case" OR television',
        '"mobile case" OR television',
        '"cellphone case" OR television',
      ]);
    });

    it('never returns more than the cap, the original first', () => {
      const many: SynonymGroup = {
        kind: 'ONE_WAY',
        term: 'a',
        synonyms: Array.from({ length: 20 }, (_, i) => `w${i}`),
      };
      const variants = expandSearchText('a a a a', [many]);
      expect(variants).toHaveLength(MAX_SEARCH_VARIANTS);
      expect(variants[0]).toBe('a a a a');
    });

    it('returns only the text without synonyms', () => {
      expect(expandSearchText("men's shoes", [])).toEqual(["men's shoes"]);
    });
  });
});
