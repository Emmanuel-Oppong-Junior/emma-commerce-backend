import { BadRequestException } from '@nestjs/common';
import { isPaystackDisputeEvent, parsePaystackDispute } from './paystack-dispute';

describe('parsePaystackDispute', () => {
  const data = (overrides: Record<string, unknown> = {}) => ({
    id: 358950,
    refund_amount: 12050,
    currency: 'GHS',
    status: 'awaiting-merchant-feedback',
    resolution: null,
    category: 'chargeback',
    transaction: { id: 896467688, reference: 'order1-ref', amount: 12050, currency: 'GHS' },
    dueAt: '2026-12-05T18:00:00.000Z',
    resolvedAt: null,
    customer: { email: 'buyer@example.com', phone: '+233244000000' },
    ...overrides,
  });

  it('recognises the three dispute events only', () => {
    expect(
      ['charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve'].map(isPaystackDisputeEvent),
    ).toEqual([true, true, true]);
    expect(isPaystackDisputeEvent('charge.success')).toBe(false);
  });

  it('maps a dispute to the provider-neutral notice, amount from subunits, no customer data', () => {
    const notice = parsePaystackDispute('charge.dispute.create', data());

    expect(notice).toEqual({
      stage: 'OPENED',
      providerDisputeId: '358950',
      reference: 'order1-ref',
      amount: '120.50',
      currency: 'GHS',
      category: 'chargeback',
      status: 'AWAITING_EVIDENCE',
      providerStatus: 'awaiting-merchant-feedback',
      evidenceDueAt: '2026-12-05T18:00:00.000Z',
      resolvedAt: null,
    });
    expect(JSON.stringify(notice)).not.toContain('buyer@example.com');
  });

  it.each([
    [{ status: 'pending' }, 'OPEN'],
    [{ status: 'awaiting-bank-feedback' }, 'UNDER_REVIEW'],
    [{ status: 'resolved', resolution: 'merchant-accepted' }, 'ACCEPTED'],
    [{ status: 'resolved', resolution: 'declined' }, 'WON'],
  ])('maps %p to %s', (overrides, status) => {
    expect(parsePaystackDispute('charge.dispute.resolve', data(overrides)).status).toBe(status);
  });

  it.each([
    [{ status: 'archived' }, 'archived'],
    [{ status: 'resolved', resolution: 'something-new' }, 'resolved:something-new'],
    [{ status: 'resolved', resolution: null }, 'resolved'],
    [{ status: undefined }, null],
  ])('maps an unknown status %p to null, keeping the raw value', (overrides, providerStatus) => {
    const notice = parsePaystackDispute('charge.dispute.resolve', data(overrides));

    expect(notice.status).toBeNull();
    expect(notice.providerStatus).toBe(providerStatus);
  });

  it('falls back to transaction_reference and to the transaction amount and currency', () => {
    const notice = parsePaystackDispute(
      'charge.dispute.remind',
      data({
        transaction: { amount: 5000, currency: 'GHS' },
        transaction_reference: 'ref-2',
        refund_amount: null,
        currency: null,
      }),
    );

    expect(notice).toMatchObject({ stage: 'REMINDED', reference: 'ref-2', amount: '50.00', currency: 'GHS' });
  });

  it.each([
    ['no id', { id: undefined }, 'id'],
    ['a fractional id', { id: 1.5 }, 'id'],
    ['no transaction reference', { transaction: { amount: 100 } }, 'transaction reference'],
    ['no amount', { refund_amount: undefined, transaction: { reference: 'r' } }, 'refund_amount'],
    ['a negative amount', { refund_amount: -1, transaction: { reference: 'r', amount: -1 } }, 'refund_amount'],
    ['an amount as text', { refund_amount: '120', transaction: { reference: 'r' } }, 'refund_amount'],
    ['no currency', { currency: undefined, transaction: { reference: 'r', amount: 1 } }, 'currency'],
    ['a malformed currency', { currency: 'cedi' }, 'currency'],
    ['an unreadable due date', { dueAt: 'next week' }, 'dueAt'],
  ])('refuses a payload with %s (BAD_REQUEST naming the field)', (_label, overrides, field) => {
    const parse = () => parsePaystackDispute('charge.dispute.create', data(overrides));

    expect(parse).toThrow(BadRequestException);
    expect(parse).toThrow(`no valid ${field}`);
  });
});
