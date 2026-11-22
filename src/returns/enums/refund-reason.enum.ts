import { registerEnumType } from '@nestjs/graphql';
import { RefundMethod, RefundReason } from '../../generated/prisma/client';

registerEnumType(RefundReason, {
  name: 'RefundReason',
  description: 'Why money was refunded. Staff choose any but RETURN and PAYMENT_NOT_ACCEPTED, which the system sets',
  valuesMap: {
    OTHER: { description: 'Anything else; a note is required' },
    RETURN: { description: 'Set by the returns flow (processRefund)' },
    PAYMENT_NOT_ACCEPTED: {
      description: 'Set by the system for a charge it could not accept (late, wrong amount or duplicate payment)',
    },
  },
});

registerEnumType(RefundMethod, {
  name: 'RefundMethod',
  valuesMap: {
    PROVIDER: { description: "Sent back through the payment's provider (Paystack)" },
    CASH: { description: 'A cash-on-delivery payment: staff handed the cash back and recorded it' },
  },
});

export enum OrderRefundStatus {
  PENDING = 'PENDING',
  REFUNDED = 'REFUNDED',
}

registerEnumType(OrderRefundStatus, {
  name: 'OrderRefundStatus',
  valuesMap: {
    PENDING: { description: 'Being processed' },
    REFUNDED: { description: 'The money was sent back' },
  },
});

export { RefundMethod, RefundReason };
