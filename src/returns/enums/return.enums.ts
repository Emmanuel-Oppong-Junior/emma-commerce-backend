import { registerEnumType } from '@nestjs/graphql';
import { ReturnReason, ReturnResolution, ReturnStatus } from '../../generated/prisma/client';

registerEnumType(ReturnStatus, {
  name: 'ReturnStatus',
  valuesMap: {
    REQUESTED: { description: 'Asked for by the customer, waiting for staff' },
    APPROVED: { description: 'Accepted: the customer sends the goods back' },
    REJECTED: { description: 'Refused by staff (see rejectionReason)' },
    RECEIVED: { description: 'The goods arrived back (each line records how many units)' },
    INSPECTED: { description: 'Staff decided what happens to each unit received (restock or write-off)' },
    REFUND_PENDING: { description: 'The refund is recorded and being sent through the payment provider' },
    REFUNDED: { description: 'Refunded' },
    EXCHANGED: { description: 'Replaced by a replacement order (see replacementOrderId)' },
    CANCELLED: { description: 'Withdrawn by the customer before the goods arrived' },
  },
});

registerEnumType(ReturnReason, {
  name: 'ReturnReason',
  valuesMap: { OTHER: { description: 'Anything else; a note is required' } },
});

registerEnumType(ReturnResolution, {
  name: 'ReturnResolution',
  valuesMap: {
    REFUND: { description: 'The money back for the units received' },
    EXCHANGE: { description: 'Another variant of the same product at the same price for each unit received' },
  },
});

export { ReturnReason, ReturnResolution, ReturnStatus };
