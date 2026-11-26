import { normalisePath } from '../links';

// Path redirects (P8-C). Pure: the caller passes the redirects it read.

/** Most redirects a lookup follows; loops are refused when written, so this only bounds long chains. */
export const MAX_REDIRECT_HOPS = 10;

/** The key a path is looked up by: without query or fragment, without a trailing "/". */
export function redirectKey(path: string): string {
  return normalisePath(path.split(/[?#]/)[0]);
}

/** 301 when every hop is permanent, else 302 (a temporary hop makes the whole chain temporary). */
export function chainStatus(statusCodes: readonly number[]): 301 | 302 {
  return statusCodes.every((code) => code === 301) ? 301 : 302;
}

/**
 * Whether adding fromPath -> toPath closes a loop: following toPath through the existing redirects (from key to
 * target) comes back to fromPath, or to itself.
 */
export function wouldLoop(fromPath: string, toPath: string, redirects: ReadonlyMap<string, string>): boolean {
  const seen = new Set([redirectKey(fromPath)]);
  let key = redirectKey(toPath);
  while (!seen.has(key)) {
    const next = redirects.get(key);
    if (next === undefined) return false;
    seen.add(key);
    key = redirectKey(next);
  }
  return true;
}
