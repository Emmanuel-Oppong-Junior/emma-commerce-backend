import { CATALOGUE_KEY, CatalogueChangeReason, isCatalogueChangeReason } from './surrogate-keys';

/** Changes are collected this long before one purge goes out, so a burst of edits is one CDN call. */
export const PURGE_WINDOW_MS = 5_000;
/** Most CDN purge APIs take a few hundred keys per call (Fastly: 256). */
export const MAX_KEYS_PER_PURGE = 256;

/** One call to the CDN: the keys to purge and the kinds of change behind them (for logs and metrics). */
export interface PurgeRequest {
  keys: string[];
  reasons: CatalogueChangeReason[];
}

const SEPARATOR = '|';

/** How a pending key is stored while it waits for the window to close: the reason travels with it. */
export function pendingPurge(reason: CatalogueChangeReason, key: string): string {
  return `${reason}${SEPARATOR}${key}`;
}

/**
 * Turns the pending purges of one window into CDN calls: each key once, at most `maxKeys` per call. A pending
 * `catalogue` purge covers everything, so it is then the only key.
 */
export function planPurges(pending: Iterable<string>, maxKeys = MAX_KEYS_PER_PURGE): PurgeRequest[] {
  const reasonsByKey = new Map<string, Set<CatalogueChangeReason>>();
  for (const entry of pending) {
    const at = entry.indexOf(SEPARATOR);
    const reason = entry.slice(0, at);
    const key = entry.slice(at + 1);
    if (at <= 0 || !key || !isCatalogueChangeReason(reason)) throw new Error(`Malformed pending CDN purge "${entry}"`);
    reasonsByKey.set(key, (reasonsByKey.get(key) ?? new Set()).add(reason));
  }
  if (reasonsByKey.size === 0) return [];
  if (reasonsByKey.has(CATALOGUE_KEY)) {
    return [{ keys: [CATALOGUE_KEY], reasons: sortedReasons([...reasonsByKey.values()]) }];
  }
  const keys = [...reasonsByKey.keys()].sort();
  const requests: PurgeRequest[] = [];
  for (let start = 0; start < keys.length; start += maxKeys) {
    const chunk = keys.slice(start, start + maxKeys);
    requests.push({ keys: chunk, reasons: sortedReasons(chunk.map((key) => reasonsByKey.get(key)!)) });
  }
  return requests;
}

function sortedReasons(sets: Set<CatalogueChangeReason>[]): CatalogueChangeReason[] {
  return [...new Set(sets.flatMap((set) => [...set]))].sort();
}
