import { BadRequestException } from '@nestjs/common';
import { DisputeStatus } from '../generated/prisma/client';
import { DisputeNotice, DisputeStage } from './disputes/dispute-notice';
import { fromSubunits } from './payment-verification';

export const PAYSTACK_DISPUTE_STAGES: Record<string, DisputeStage> = {
  'charge.dispute.create': DisputeStage.OPENED,
  'charge.dispute.remind': DisputeStage.REMINDED,
  'charge.dispute.resolve': DisputeStage.RESOLVED,
};

/*
 * Paystack's dispute statuses and resolutions. Their documentation could not be fetched while this was written, so
 * these are the values Paystack is known to send; anything else maps to null and the record keeps its status, with the
 * raw value in its history and a warning in the log, never a guess.
 */
const OPEN_STATUSES: Record<string, DisputeStatus> = {
  pending: DisputeStatus.OPEN,
  'awaiting-merchant-feedback': DisputeStatus.AWAITING_EVIDENCE,
  'awaiting-bank-feedback': DisputeStatus.UNDER_REVIEW,
};
const RESOLUTIONS: Record<string, DisputeStatus> = {
  'merchant-accepted': DisputeStatus.ACCEPTED,
  declined: DisputeStatus.WON,
};
const RESOLVED = 'resolved';
const MAX_TEXT = 200;

export function isPaystackDisputeEvent(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAYSTACK_DISPUTE_STAGES, event);
}

/**
 * Validates the `data` of a signed Paystack dispute webhook and maps it to a dispute notice. A field we depend on
 * (dispute id, transaction reference, amount, currency) that is missing or malformed is refused with BAD_REQUEST.
 * The amount is `refund_amount` (else the transaction's `amount`), in subunits like every Paystack amount.
 */
export function parsePaystackDispute(event: string, data: Record<string, unknown>): DisputeNotice {
  const stage = PAYSTACK_DISPUTE_STAGES[event];
  const transaction = isRecord(data.transaction) ? data.transaction : {};
  const id = data.id;
  if (!(Number.isSafeInteger(id) || (typeof id === 'string' && id !== ''))) refuse(event, 'id');
  const reference = text(transaction.reference) ?? text(data.transaction_reference);
  if (!reference) refuse(event, 'transaction reference');
  const subunits = [data.refund_amount, transaction.amount].find(
    (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  ) as number | undefined;
  if (subunits === undefined) refuse(event, 'refund_amount');
  const currency = text(data.currency) ?? text(transaction.currency);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) refuse(event, 'currency');

  const status = text(data.status);
  const resolution = text(data.resolution);
  return {
    stage,
    providerDisputeId: String(id),
    reference: reference as string,
    amount: fromSubunits(subunits as number).toFixed(2),
    currency: currency as string,
    category: text(data.category)?.slice(0, MAX_TEXT) ?? null,
    status: mapStatus(status, resolution),
    providerStatus: [status, resolution].filter(Boolean).join(':').slice(0, MAX_TEXT) || null,
    evidenceDueAt: isoDate(event, 'dueAt', data.dueAt),
    resolvedAt: isoDate(event, 'resolvedAt', data.resolvedAt),
  };
}

function mapStatus(status: string | undefined, resolution: string | undefined): DisputeStatus | null {
  if (status === RESOLVED || (status === undefined && resolution !== undefined)) {
    return resolution === undefined ? null : (RESOLUTIONS[resolution] ?? null);
  }
  return status === undefined ? null : (OPEN_STATUSES[status] ?? null);
}

function isoDate(event: string, field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) refuse(event, field);
  return (date as Date).toISOString();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function refuse(event: string, field: string): never {
  throw new BadRequestException(`Paystack ${event} webhook has no valid ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
