// Storefront links staff enter on banners, rich text and path redirects (P8-C). Pure.

export const MAX_PATH_LENGTH = 500;

/**
 * Why `path` is not an internal storefront path, or null. It starts with one "/" (never "//", which browsers read as
 * another host), has no scheme, backslash, whitespace or control character, and is at most 500 characters. A query and
 * fragment are allowed only when `allowQuery`.
 */
export function internalPathProblem(path: string, allowQuery = true): string | null {
  if (path.length > MAX_PATH_LENGTH) return `Path is longer than ${MAX_PATH_LENGTH} characters`;
  if (!path.startsWith('/') || path.startsWith('//')) return `Path "${path}" must start with a single "/"`;
  if (/[\s\\\u0000-\u001f\u007f]/.test(path)) {
    return `Path "${path}" must not contain spaces, backslashes or control characters`;
  }
  if (!allowQuery && /[?#]/.test(path)) return `Path "${path}" must not have a query or fragment`;
  return null;
}

/** The path without a trailing "/" (except the root), so "/sale/" and "/sale" are one path. */
export function normalisePath(path: string): string {
  const [pathname, ...rest] = path.split(/(?=[?#])/);
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  return trimmed + rest.join('');
}

/** An absolute https URL with a host. */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}
