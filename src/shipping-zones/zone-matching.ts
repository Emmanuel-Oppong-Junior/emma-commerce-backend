import { GhanaRegion, ZoneAreaLevel } from '../generated/prisma/client';

/** `extensions.reason` when an address is outside every active delivery zone (or outside Ghana). */
export const DELIVERY_UNAVAILABLE = 'DELIVERY_UNAVAILABLE';

/** A zone entry as stored: a region, a town, or an area within a town (towns and areas normalised). */
export interface ZoneAreaValue {
  level: ZoneAreaLevel;
  region: GhanaRegion | null;
  town: string | null;
  area: string | null;
}

/** What an entry is given as: a region alone, a town alone, or a town and an area within it. */
export interface ZoneAreaSpec {
  region?: GhanaRegion | null;
  town?: string | null;
  area?: string | null;
}

/** The parts of an address a zone is matched on. */
export interface AddressPlace {
  country: string;
  region: GhanaRegion | null;
  city: string;
  area: string | null;
}

const SPECIFICITY: Record<ZoneAreaLevel, number> = { AREA: 3, TOWN: 2, REGION: 1 };

/**
 * The form towns and areas are compared in: accents and apostrophes dropped, lower case, any other run of characters
 * that are not letters or digits one space, trimmed. "East-Legon", "east  legon" and "Éast Legon" are all "east legon".
 * The backfill of 20261207100000_delivery_rates applies the same rule in SQL.
 */
export function normalisePlaceName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether a stored address country means Ghana: "GH" since Ghana addresses (P1-G), "Ghana" on older rows. */
export function isGhana(country: string): boolean {
  return ['gh', 'ghana'].includes(normalisePlaceName(country));
}

/** The canonical key of an entry, unique across zones (ZoneArea.matchKey). */
export function matchKey(value: ZoneAreaValue): string {
  switch (value.level) {
    case ZoneAreaLevel.REGION:
      return `REGION:${value.region}`;
    case ZoneAreaLevel.TOWN:
      return `TOWN:${value.town}`;
    case ZoneAreaLevel.AREA:
      return `AREA:${value.town}|${value.area}`;
  }
}

/**
 * Turns an entry as given into its stored form, or the reason it is invalid: exactly a region, a town, or a town with
 * an area; names must not normalise to nothing.
 */
export function toZoneArea(spec: ZoneAreaSpec): ZoneAreaValue | string {
  const town = spec.town == null ? null : normalisePlaceName(spec.town);
  const area = spec.area == null ? null : normalisePlaceName(spec.area);
  if (town === '' || area === '') return 'Zone towns and areas must contain letters or digits';
  if (spec.region && town === null && area === null) {
    return { level: ZoneAreaLevel.REGION, region: spec.region, town: null, area: null };
  }
  if (!spec.region && town !== null) {
    return area === null
      ? { level: ZoneAreaLevel.TOWN, region: null, town, area: null }
      : { level: ZoneAreaLevel.AREA, region: null, town, area };
  }
  return 'A zone area is a region alone, a town alone, or a town with an area';
}

/** The keys an address could match, most specific first. */
export function candidateKeys(place: Pick<AddressPlace, 'region' | 'city' | 'area'>): string[] {
  const town = normalisePlaceName(place.city);
  const area = place.area ? normalisePlaceName(place.area) : '';
  return [
    ...(town && area ? [`AREA:${town}|${area}`] : []),
    ...(town ? [`TOWN:${town}`] : []),
    ...(place.region ? [`REGION:${place.region}`] : []),
  ];
}

/**
 * The zone covering an address: its most specific matching entry among `entries` (those of active zones), an area of
 * the town beating the town, the town beating the region. Null outside Ghana or when nothing matches: delivery there
 * is not offered, never free.
 */
export function matchZone<T extends ZoneAreaValue & { zoneId: string }>(
  entries: readonly T[],
  place: AddressPlace,
): T | null {
  if (!isGhana(place.country)) return null;
  const keys = new Set(candidateKeys(place));
  const matches = entries.filter((entry) => keys.has(matchKey(entry)));
  return matches.reduce<T | null>(
    (best, entry) => (best === null || SPECIFICITY[entry.level] > SPECIFICITY[best.level] ? entry : best),
    null,
  );
}
