import { StockTransferStatus } from '../../generated/prisma/client';

export const MAX_TRANSFER_LINES = 100;

/**
 * The transfer machine (P4-A.2): a DRAFT is dispatched (stock leaves the source and is in transit on the lines) or
 * cancelled; a dispatched transfer is received once, in full (RECEIVED) or with a shortfall (PARTIALLY_RECEIVED).
 * There is no way back after dispatch: goods sent back travel on a new transfer.
 */
const TRANSITIONS: Record<StockTransferStatus, readonly StockTransferStatus[]> = {
  DRAFT: [StockTransferStatus.DISPATCHED, StockTransferStatus.CANCELLED],
  DISPATCHED: [StockTransferStatus.RECEIVED, StockTransferStatus.PARTIALLY_RECEIVED],
  RECEIVED: [],
  PARTIALLY_RECEIVED: [],
  CANCELLED: [],
};

export function canTransferTransition(from: StockTransferStatus, to: StockTransferStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransferLineDraft {
  variantId: string;
  quantity: number;
}

/** Why a new transfer is invalid, or null: two different locations, 1-100 lines, one line per variant, quantity >= 1. */
export function transferDraftProblem(fromLocationId: string, toLocationId: string, lines: TransferLineDraft[]) {
  if (fromLocationId === toLocationId) return 'A transfer needs two different locations';
  if (lines.length === 0) return 'A transfer needs at least one line';
  if (lines.length > MAX_TRANSFER_LINES) return `A transfer holds at most ${MAX_TRANSFER_LINES} lines`;
  if (new Set(lines.map((line) => line.variantId)).size !== lines.length) {
    return 'A variant can appear only once in a transfer';
  }
  const bad = lines.find((line) => !Number.isInteger(line.quantity) || line.quantity < 1);
  if (bad) return `Quantity of variant "${bad.variantId}" must be a whole number of at least 1`;
  return null;
}

export interface ReceivedLine {
  variantId: string;
  receivedQuantity: number;
  note?: string;
}

export interface LineReceipt {
  variantId: string;
  quantity: number;
  receivedQuantity: number;
  /** Units dispatched but not received; recorded on the line, no stock is created for them. */
  variance: number;
  varianceNote: string | null;
}

export type ReceiptOutcome = { problem: string } | { problem: null; status: StockTransferStatus; lines: LineReceipt[] };

/**
 * What receiving a dispatched transfer records. Lines not mentioned arrive in full. A line can arrive short (never
 * over what was dispatched) and then needs a note explaining the shortfall; any short line makes the transfer
 * PARTIALLY_RECEIVED.
 */
export function receiptOf(dispatched: TransferLineDraft[], received: ReceivedLine[]): ReceiptOutcome {
  const byVariant = new Map(received.map((line) => [line.variantId, line]));
  if (byVariant.size !== received.length) return { problem: 'A variant can appear only once in a receipt' };
  const unknown = received.find((line) => !dispatched.some((d) => d.variantId === line.variantId));
  if (unknown) return { problem: `Variant "${unknown.variantId}" is not on this transfer` };
  const lines: LineReceipt[] = [];
  for (const line of dispatched) {
    const entry = byVariant.get(line.variantId);
    const receivedQuantity = entry?.receivedQuantity ?? line.quantity;
    if (!Number.isInteger(receivedQuantity) || receivedQuantity < 0 || receivedQuantity > line.quantity) {
      return { problem: `Received quantity of variant "${line.variantId}" must be between 0 and ${line.quantity}` };
    }
    const variance = line.quantity - receivedQuantity;
    const note = entry?.note?.trim() || null;
    if (variance > 0 && !note) {
      return { problem: `Explain the shortfall of ${variance} on variant "${line.variantId}" in a note` };
    }
    lines.push({ ...line, receivedQuantity, variance, varianceNote: variance > 0 ? note : null });
  }
  const short = lines.some((line) => line.variance > 0);
  return {
    problem: null,
    status: short ? StockTransferStatus.PARTIALLY_RECEIVED : StockTransferStatus.RECEIVED,
    lines,
  };
}
