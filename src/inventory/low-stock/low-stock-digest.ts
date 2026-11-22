import { DEFAULT_LOW_STOCK_THRESHOLD } from '../stock';

/** A low-stock alert waiting for the next digest, with the variant's stock at that location now. */
export interface PendingLowStockAlert {
  id: string;
  variantId: string;
  locationId: string;
  available: number;
  threshold: number | null;
}

export interface DigestPlan {
  /** Still at or below the threshold: listed in the digest */
  send: PendingLowStockAlert[];
  /** Recovered above the threshold since the alert (restocked, order cancelled): dropped without an email */
  drop: PendingLowStockAlert[];
}

/** The same rule as the event (crossesLowStock): at or below the variant's threshold, or the default one. */
export function isStillLow(available: number, threshold: number | null): boolean {
  return available <= (threshold ?? DEFAULT_LOW_STOCK_THRESHOLD);
}

export function planDigest(pending: PendingLowStockAlert[]): DigestPlan {
  const plan: DigestPlan = { send: [], drop: [] };
  for (const alert of pending) {
    (isStillLow(alert.available, alert.threshold) ? plan.send : plan.drop).push(alert);
  }
  return plan;
}

export interface DigestItem {
  locationName: string;
  productName: string;
  sku: string;
  available: number;
  threshold: number | null;
}

export interface DigestSection {
  locationName: string;
  items: DigestItem[];
}

/** One section per location (by name), its variants emptiest first, then by SKU. */
export function digestSections(items: DigestItem[]): DigestSection[] {
  const byLocation = new Map<string, DigestItem[]>();
  for (const item of items) {
    byLocation.set(item.locationName, [...(byLocation.get(item.locationName) ?? []), item]);
  }
  return [...byLocation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locationName, sectionItems]) => ({
      locationName,
      items: [...sectionItems].sort((a, b) => a.available - b.available || a.sku.localeCompare(b.sku)),
    }));
}
