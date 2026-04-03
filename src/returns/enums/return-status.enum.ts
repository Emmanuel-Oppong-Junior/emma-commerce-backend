import { registerEnumType } from '@nestjs/graphql';

export enum ReturnStatusEnum {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REFUNDED = 'REFUNDED',
}

registerEnumType(ReturnStatusEnum, { name: 'ReturnStatusEnum' });
