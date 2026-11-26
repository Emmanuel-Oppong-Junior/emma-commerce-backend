import { ProductSortKey, SortDirection } from '../product-search.port';

// Keyset cursor of the Postgres adapter: the sort key value and id of the last row, opaque to clients. The key is the
// value Postgres returned (a float8 rank, a name, a timestamp as ISO text, or a collection position), so comparing it
// back is exact.

/** How the search text matched: full-text, or trigram name similarity when full-text found nothing. */
export type TextMatchMode = 'FTS' | 'FUZZY';

export interface SearchCursor {
  sort: ProductSortKey;
  direction: SortDirection;
  mode?: TextMatchMode;
  key: number | string;
  id: string;
}

interface Encoded {
  s: ProductSortKey;
  d: SortDirection;
  m?: TextMatchMode;
  k: number | string;
  i: string;
}

export function encodeCursor(cursor: SearchCursor): string {
  const encoded: Encoded = { s: cursor.sort, d: cursor.direction, k: cursor.key, i: cursor.id };
  if (cursor.mode) encoded.m = cursor.mode;
  return Buffer.from(JSON.stringify(encoded)).toString('base64url');
}

// How Postgres writes a timestamp(3) in JSON.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

function keyFits(sort: ProductSortKey, key: unknown): boolean {
  if (sort === 'RELEVANCE') return typeof key === 'number' && Number.isFinite(key);
  if (sort === 'POSITION') return Number.isInteger(key);
  if (sort === 'NAME') return typeof key === 'string';
  return typeof key === 'string' && TIMESTAMP.test(key);
}

/** The cursor, or null when it is not one of ours or was made for another sort. */
export function decodeCursor(raw: string, sort: ProductSortKey, direction: SortDirection): SearchCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { s, d, m, k, i } = parsed as Partial<Encoded>;
  if (s !== sort || d !== direction || typeof i !== 'string' || i === '') return null;
  if (m !== undefined && m !== 'FTS' && m !== 'FUZZY') return null;
  if (!keyFits(sort, k)) return null;
  return { sort, direction, mode: m, key: k as number | string, id: i };
}
