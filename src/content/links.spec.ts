import { internalPathProblem, isHttpsUrl, normalisePath } from './links';

describe('storefront links', () => {
  it.each(['/', '/sale', '/c/shoes?sort=new', '/p/tee#reviews'])('accepts the internal path "%s"', (path) => {
    expect(internalPathProblem(path)).toBeNull();
  });

  it.each([
    ['sale', /single "\/"/],
    ['//evil.example', /single "\/"/],
    ['https://evil.example', /single "\/"/],
    ['/a b', /spaces/],
    ['/a\\b', /backslashes/],
    ['/a\u0000', /control/],
  ])('refuses "%s"', (path, message) => {
    expect(internalPathProblem(path)).toMatch(message);
  });

  it('refuses a query or fragment where only a path is allowed', () => {
    expect(internalPathProblem('/sale?x=1', false)).toMatch(/query or fragment/);
    expect(internalPathProblem('/sale', false)).toBeNull();
  });

  it('refuses a path over 500 characters', () => {
    expect(internalPathProblem(`/${'a'.repeat(500)}`)).toMatch(/longer than 500/);
  });

  it('drops trailing slashes but keeps the root, the query and the fragment', () => {
    expect(normalisePath('/sale/')).toBe('/sale');
    expect(normalisePath('/sale//?x=1')).toBe('/sale?x=1');
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('/a/b#top')).toBe('/a/b#top');
  });

  it('knows an https URL from anything else', () => {
    expect(isHttpsUrl('https://example.com/sale')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('/sale')).toBe(false);
  });
});
