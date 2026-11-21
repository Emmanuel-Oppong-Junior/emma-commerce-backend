import { registerEnumType } from '@nestjs/graphql';

export enum PaymentStatus {
  PENDING = 'PENDING',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(PaymentStatus, { name: 'PaymentStatus' });
