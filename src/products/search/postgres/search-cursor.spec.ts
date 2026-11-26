import { decodeCursor, encodeCursor, SearchCursor } from './search-cursor';

describe('search cursor', () => {
  it.each<SearchCursor>([
    { sort: 'RELEVANCE', direction: 'DESC', mode: 'FTS', key: 0.0607927106320858, id: 'p1' },
    { sort: 'RELEVANCE', direction: 'DESC', mode: 'FUZZY', key: 0.5, id: 'p2' },
    { sort: 'NAME', direction: 'ASC', key: 'Men\'s "Shoes"', id: 'p3' },
    { sort: 'CREATED_AT', direction: 'DESC', key: '2026-01-01T00:00:00.123', id: 'p4' },
    { sort: 'UPDATED_AT', direction: 'ASC', key: '2026-01-01T00:00:00', id: 'p5' },
    { sort: 'POSITION', direction: 'ASC', key: 3, id: 'p6' },
  ])('round-trips $sort $direction exactly', (cursor) => {
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, cursor.sort, cursor.direction)).toEqual(cursor);
  });

  it('refuses a cursor made for another sort field or direction', () => {
    const encoded = encodeCursor({ sort: 'NAME', direction: 'ASC', key: 'a', id: 'p1' });
    expect(decodeCursor(encoded, 'CREATED_AT', 'ASC')).toBeNull();
    expect(decodeCursor(encoded, 'NAME', 'DESC')).toBeNull();
  });

  const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each<[string, string, SearchCursor['sort'], SearchCursor['direction']]>([
    ['not base64 JSON', 'not-a-cursor', 'NAME', 'ASC'],
    ['a JSON scalar', raw(42), 'NAME', 'ASC'],
    ['no id', raw({ s: 'NAME', d: 'ASC', k: 'a' }), 'NAME', 'ASC'],
    ['a relevance key that is not a number', raw({ s: 'RELEVANCE', d: 'DESC', k: 'x', i: 'p' }), 'RELEVANCE', 'DESC'],
    [
      'a timestamp key that is not a timestamp',
      raw({ s: 'CREATED_AT', d: 'DESC', k: "'; x", i: 'p' }),
      'CREATED_AT',
      'DESC',
    ],
    ['a position that is not an integer', raw({ s: 'POSITION', d: 'ASC', k: 1.5, i: 'p' }), 'POSITION', 'ASC'],
    ['an unknown match mode', raw({ s: 'RELEVANCE', d: 'DESC', m: 'OTHER', k: 1, i: 'p' }), 'RELEVANCE', 'DESC'],
  ])('refuses %s', (_case, cursor, sort, direction) => {
    expect(decodeCursor(cursor, sort, direction)).toBeNull();
  });
});
