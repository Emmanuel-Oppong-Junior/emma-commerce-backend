import { DisputeStatus, Prisma } from '../../generated/prisma/client';

export enum DisputeStage {
  OPENED = 'OPENED',
  REMINDED = 'REMINDED',
  RESOLVED = 'RESOLVED',
}

/**
 * A provider's dispute webhook reduced to what the dispute record needs, in a provider-neutral shape. The adapter
 * builds it from a signed delivery and the inbox stores it as the event payload (`{ event, dispute }`), so the
 * worker never reads provider fields. Dates are ISO strings and the amount a decimal string, to survive JSON.
 */
export interface DisputeNotice {
  stage: DisputeStage;
  providerDisputeId: string;
  /** Our reference of the disputed payment attempt. */
  reference: string;
  /** In major units, e.g. "120.50". */
  amount: string;
  currency: string;
  category: string | null;
  /** Null when the provider's status (and resolution) is not one we map; the record keeps its status. */
  status: DisputeStatus | null;
  /** The provider's own status and resolution, kept in the dispute history. */
  providerStatus: string | null;
  evidenceDueAt: string | null;
  resolvedAt: string | null;
}

const STAGES = Object.values(DisputeStage) as string[];
const STATUSES = Object.values(DisputeStatus) as string[];

/** The dispute notice of a stored webhook event, or null when the event is not a dispute. */
export function storedDisputeNotice(payload: Prisma.JsonValue): DisputeNotice | null {
  if (!isRecord(payload) || !isRecord(payload.dispute)) return null;
  const notice = payload.dispute;
  const valid =
    STAGES.includes(notice.stage as string) &&
    isText(notice.providerDisputeId) &&
    isText(notice.reference) &&
    isText(notice.amount) &&
    isText(notice.currency) &&
    (notice.status === null || STATUSES.includes(notice.status as string));
  if (!valid) throw new Error('Stored dispute notice is malformed');
  return notice as unknown as DisputeNotice;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
