import { BadRequestException } from '@nestjs/common';
import { Address } from '../generated/prisma/client';

export const INCOMPLETE_ADDRESS_MESSAGE =
  'Complete the delivery address (region, recipient name and phone) before checkout';

// Addresses saved before region, recipient and phone existed keep nulls there until the customer edits them.
export function assertDeliverableAddress(address: Pick<Address, 'region' | 'recipientName' | 'phone'>): void {
  if (!address.region || !address.recipientName || !address.phone) {
    throw new BadRequestException(INCOMPLETE_ADDRESS_MESSAGE);
  }
}
