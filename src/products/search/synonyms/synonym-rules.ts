// Search synonyms (P6-S.4). Pure: validation, normalisation and query-time expansion of the search text.

export type SynonymKind = 'TWO_WAY' | 'ONE_WAY';

/** TWO_WAY: every term finds the others. ONE_WAY: `term` also finds `synonyms`, not the reverse. */
export interface SynonymGroup {
  kind: SynonymKind;
  term: string | null;
  synonyms: readonly string[];
}

export const MAX_SYNONYMS = 20;
export const MAX_TERM_LENGTH = 100;
export const MAX_SYNONYM_GROUPS = 500;
/** Search texts tried per search, the original first. */
export const MAX_SEARCH_VARIANTS = 8;

// Words of letters and digits joined by single spaces or hyphens: nothing websearch_to_tsquery reads as syntax.
const TERM = /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u;

/** Lower case, trimmed, single-spaced. */
export function normaliseTerm(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function termProblem(term: string): string | null {
  if (term.length === 0 || term.length > MAX_TERM_LENGTH) {
    return `"${term}" must be 1-${MAX_TERM_LENGTH} characters`;
  }
  if (!TERM.test(term)) return `"${term}" may contain only letters, digits, single spaces and hyphens`;
  return null;
}

/** Why the (normalised) group cannot be saved, or null. */
export function synonymGroupProblem(group: SynonymGroup): string | null {
  const terms = group.term === null ? group.synonyms : [group.term, ...group.synonyms];
  if (group.kind === 'TWO_WAY' && group.term !== null)
    return 'A TWO_WAY group has no term; list every term in synonyms';
  if (group.kind === 'ONE_WAY' && group.term === null) return 'A ONE_WAY group needs the term it expands';
  const minimum = group.kind === 'TWO_WAY' ? 2 : 1;
  if (group.synonyms.length < minimum || group.synonyms.length > MAX_SYNONYMS) {
    return `A ${group.kind} group takes ${minimum}-${MAX_SYNONYMS} synonyms, got ${group.synonyms.length}`;
  }
  for (const term of terms) {
    const problem = termProblem(term);
    if (problem) return problem;
  }
  const repeated = terms.find((term, index) => terms.indexOf(term) !== index);
  if (repeated) return `"${repeated}" appears twice in the group`;
  return null;
}

/** For each term, what else it finds. */
function alternativesByTerm(groups: readonly SynonymGroup[]): Map<string, Set<string>> {
  const byTerm = new Map<string, Set<string>>();
  const add = (term: string, others: readonly string[]) => {
    const set = byTerm.get(term) ?? new Set<string>();
    others.filter((other) => other !== term).forEach((other) => set.add(other));
    byTerm.set(term, set);
  };
  for (const group of groups) {
    if (group.kind === 'ONE_WAY') add(group.term!, group.synonyms);
    else group.synonyms.forEach((term) => add(term, group.synonyms));
  }
  return byTerm;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Occurrence {
  start: number;
  end: number;
  alternatives: string[];
}

/** Whole-word occurrences of known terms, longest first, not overlapping; negated (-term) and OR are left alone. */
function occurrences(text: string, byTerm: Map<string, Set<string>>): Occurrence[] {
  const lower = text.toLowerCase();
  const found: Occurrence[] = [];
  const terms = [...byTerm.keys()].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'gu');
    for (const match of lower.matchAll(pattern)) {
      const start = match.index;
      const end = start + term.length;
      if (text[start - 1] === '-' || text.slice(start, end) === 'OR') continue;
      if (found.some((other) => start < other.end && end > other.start)) continue;
      found.push({ start, end, alternatives: [...byTerm.get(term)!] });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The search text and its variants with synonyms substituted (the original first, at most MAX_SEARCH_VARIANTS). The
 * search matches any variant; each keeps the rest of the text, so quotes, OR and -exclusions still apply.
 */
export function expandSearchText(text: string, groups: readonly SynonymGroup[]): string[] {
  const found = occurrences(text, alternativesByTerm(groups));
  // Substitute left to right; each variant tracks how far its later positions moved. The list never grows past the
  // cap, so many synonyms cannot blow it up.
  let variants: { text: string; offset: number }[] = [{ text, offset: 0 }];
  for (const occurrence of found) {
    const next = [...variants];
    for (const variant of variants) {
      for (const alternative of occurrence.alternatives) {
        if (next.length >= MAX_SEARCH_VARIANTS) break;
        const start = occurrence.start + variant.offset;
        const end = occurrence.end + variant.offset;
        const substituted = variant.text.slice(0, start) + alternative + variant.text.slice(end);
        next.push({ text: substituted, offset: variant.offset + alternative.length - (end - start) });
      }
    }
    variants = next;
  }
  return [...new Set(variants.map((variant) => variant.text))];
}
