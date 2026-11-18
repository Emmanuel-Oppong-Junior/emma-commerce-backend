import { registerEnumType } from '@nestjs/graphql';

export enum RefundStatusEnum {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
}

registerEnumType(RefundStatusEnum, {
  name: 'RefundStatusEnum',
  valuesMap: {
    PENDING: { description: 'Recorded, not yet sent to the provider' },
    SENDING: {
      description:
        'Claimed and sent; if it stays here the provider outcome is unknown and must be checked in Paystack before any resend',
    },
    PROCESSED: { description: 'Accepted by the provider' },
    FAILED: { description: 'Refused by the provider; nothing was refunded and it can be sent again' },
  },
});
