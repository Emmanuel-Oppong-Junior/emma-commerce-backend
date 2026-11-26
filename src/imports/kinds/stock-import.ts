import { ImportRowAction, StockAdjustmentReason } from '../../generated/prisma/client';
import { MANUAL_ADJUSTMENT_REASONS, manualAdjustmentError } from '../../inventory/stock-adjustment';
import { ImportColumns, parseWholeNumber, RowOutcome, textProblem } from './import-rows';

export const STOCK_COLUMNS: ImportColumns = {
  required: ['sku'],
  optional: ['location', 'delta', 'count', 'reason', 'note'],
  prefixes: [],
};

export const STOCK_TEMPLATE_EXAMPLE: Record<string, string> = {
  sku: 'TSHIRT-RED-M',
  location: 'Main warehouse',
  delta: '',
  count: '24',
  reason: 'CORRECTION',
  note: 'Shelf count 25 November',
};

const MAX_NOTE_LENGTH = 500;

export interface StockVariantFacts {
  id: string;
  trackLots: boolean;
  trackSerials: boolean;
}

export interface LocationFacts {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
}

export interface StockLevelFacts {
  onHand: number;
  reserved: number;
}

export interface StockPlan {
  variantId: string;
  locationId: string;
  /** Signed change of on-hand stock; for a count, the count minus the on-hand stock when checked */
  delta: number;
  count: number | null;
  reason: StockAdjustmentReason;
  note: string | null;
}

/** The location a cell names: blank is the default location, otherwise an id or a name (any letter case). */
export function resolveLocation(
  text: string | undefined,
  locations: readonly LocationFacts[],
): { id: string } | { error: string } {
  if (!text) {
    const fallback = locations.find((location) => location.isDefault);
    return fallback ? { id: fallback.id } : { error: 'The store has no default stock location' };
  }
  const byId = locations.find((location) => location.id === text);
  const matches = byId ? [byId] : locations.filter((location) => location.name.toLowerCase() === text.toLowerCase());
  if (matches.length === 0) return { error: `No stock location is called "${text}"` };
  if (matches.length > 1) return { error: `Several stock locations are called "${text}": use the location id` };
  if (!matches[0].isActive) return { error: `Stock location "${text}" is inactive` };
  return { id: matches[0].id };
}

function parseReason(text: string | undefined, isCount: boolean): StockAdjustmentReason | string {
  if (!text) return isCount ? StockAdjustmentReason.CORRECTION : 'reason is required with a delta';
  const reason = text.toUpperCase() as StockAdjustmentReason;
  return MANUAL_ADJUSTMENT_REASONS.includes(reason)
    ? reason
    : `reason must be one of ${MANUAL_ADJUSTMENT_REASONS.join(', ')}, got "${text}"`;
}

/**
 * One STOCK row: a signed `delta`, or a counted quantity (`count`) that becomes the delta from the on-hand stock at
 * the location (the ledger only ever applies deltas). A count defaults to the CORRECTION reason. Lot- and
 * serial-tracked variants are refused: their units must be named, which a row cannot do. `level` is null when the
 * variant has no stock at the location yet.
 */
export function planStockRow(
  values: Record<string, string>,
  variant: StockVariantFacts | undefined,
  locations: readonly LocationFacts[],
  level: StockLevelFacts | null,
): RowOutcome & { plan?: StockPlan } {
  const errors: string[] = [];
  const none = () => ({ errors, warnings: [], action: ImportRowAction.NONE });
  if (!values.sku) errors.push('sku is required');
  else if (!variant) errors.push(`No variant has SKU "${values.sku}"`);
  else if (variant.trackLots) errors.push('The product tracks lots: adjust its stock in the admin, naming the lot');
  else if (variant.trackSerials) {
    errors.push('The product tracks serial numbers: adjust its stock in the admin, naming the units');
  }
  const location = resolveLocation(values.location, locations);
  if ('error' in location) errors.push(location.error);

  const hasDelta = values.delta !== undefined;
  const hasCount = values.count !== undefined;
  let quantity: number | undefined;
  if (hasDelta === hasCount) errors.push('Give either delta or count, not both and not neither');
  else {
    const parsed = hasDelta
      ? parseWholeNumber('delta', values.delta)
      : parseWholeNumber('count', values.count, { min: 0 });
    if (parsed.ok) quantity = parsed.value;
    else errors.push(parsed.error);
  }
  const reason = parseReason(values.reason, hasCount && !hasDelta);
  if (!Object.values(StockAdjustmentReason).includes(reason as StockAdjustmentReason)) errors.push(reason);
  const noteProblem = textProblem('note', values.note, MAX_NOTE_LENGTH);
  if (noteProblem) errors.push(noteProblem);
  if (errors.length || !variant || 'error' in location || quantity === undefined) return none();

  const onHand = level?.onHand ?? 0;
  const reserved = level?.reserved ?? 0;
  const delta = hasCount ? quantity - onHand : quantity;
  const plan: StockPlan = {
    variantId: variant.id,
    locationId: location.id,
    delta,
    count: hasCount ? quantity : null,
    reason: reason as StockAdjustmentReason,
    note: values.note ?? null,
  };
  if (delta === 0) {
    if (hasDelta) errors.push('delta must not be 0');
    return { ...none(), plan };
  }
  const refusal = manualAdjustmentError({ delta, reason: plan.reason, note: plan.note });
  if (refusal) errors.push(hasCount ? `${refusal} (the count changes stock by ${delta})` : refusal);
  if (onHand + delta < reserved) {
    errors.push(
      reserved > 0
        ? `Stock cannot go below the ${reserved} unit(s) reserved for orders (on hand ${onHand})`
        : `Cannot remove ${-delta} unit(s): only ${onHand} on hand`,
    );
  }
  if (errors.length) return none();
  return { errors, warnings: [], action: ImportRowAction.UPDATE, plan };
}
