import { BadRequestException } from '@nestjs/common';
import { RefundReason, RefundStatus } from '../generated/prisma/client';
import { customerRefundStatus, REFUND_REASON_LABELS, staffRefundNote, STAFF_REFUND_REASONS } from './refund-reason';

describe('refund reasons', () => {
  it('labels every reason', () => {
    for (const reason of Object.values(RefundReason)) expect(REFUND_REASON_LABELS[reason]).toMatch(/\w/);
  });

  it('accepts a staff reason with an optional note, trimmed and blank as null', () => {
    expect(staffRefundNote(RefundReason.DAMAGED, undefined)).toBeNull();
    expect(staffRefundNote(RefundReason.DAMAGED, '   ')).toBeNull();
    expect(staffRefundNote(RefundReason.PRICE_ADJUSTMENT, '  matched a competitor ')).toBe('matched a competitor');
  });

  it('requires a note for OTHER', () => {
    expect(() => staffRefundNote(RefundReason.OTHER, ' ')).toThrow(
      new BadRequestException('A note is required when the refund reason is OTHER'),
    );
    expect(staffRefundNote(RefundReason.OTHER, 'goodwill')).toBe('goodwill');
  });

  it('refuses the reasons only the system sets', () => {
    expect(STAFF_REFUND_REASONS).not.toContain(RefundReason.RETURN);
    expect(() => staffRefundNote(RefundReason.RETURN, null)).toThrow(BadRequestException);
    expect(() => staffRefundNote(RefundReason.PAYMENT_NOT_ACCEPTED, null)).toThrow(BadRequestException);
  });

  it('shows the customer a refund as refunded once processed, and pending otherwise (a refused send is retried)', () => {
    expect(customerRefundStatus(RefundStatus.PROCESSED)).toBe('REFUNDED');
    for (const status of [RefundStatus.PENDING, RefundStatus.SENDING, RefundStatus.FAILED]) {
      expect(customerRefundStatus(status)).toBe('PENDING');
    }
  });
});
