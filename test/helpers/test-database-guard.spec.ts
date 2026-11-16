import { assertTestDatabaseUrl } from './test-database-guard';

describe('assertTestDatabaseUrl', () => {
  it('throws when the URL is undefined', () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow('DATABASE_URL is not set');
  });

  it('throws when the URL cannot be parsed', () => {
    expect(() => assertTestDatabaseUrl('not a url')).toThrow('not a valid URL');
  });

  it('throws without leaking credentials when the database name does not end in _test', () => {
    let message = '';
    try {
      assertTestDatabaseUrl('postgresql://u:p@localhost:5432/emma_commerce');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('emma_commerce');
    expect(message).not.toContain('u:p');
    expect(message).not.toContain('p@');
  });

  it('throws when _test appears only in the middle of the name', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/emma_test_commerce')).toThrow(
      'emma_test_commerce',
    );
  });

  it('accepts a database name ending in _test', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/emma_commerce_test')).not.toThrow();
  });

  it('ignores the query string when checking the name', () => {
    expect(() =>
      assertTestDatabaseUrl('postgresql://u:p@localhost:5432/emma_commerce_test?schema=public'),
    ).not.toThrow();
  });
});
