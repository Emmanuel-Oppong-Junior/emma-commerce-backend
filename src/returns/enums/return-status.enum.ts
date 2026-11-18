import { registerEnumType } from '@nestjs/graphql';

export enum ReturnStatusEnum {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
}

registerEnumType(ReturnStatusEnum, { name: 'ReturnStatusEnum' });
