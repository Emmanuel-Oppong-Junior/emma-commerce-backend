import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentIntentStatus, PaymentMethod, PaymentStatus } from '../generated/prisma/client';
import { PAID_INTENT_STATUSES } from './payment-intent-status';

/**
 * What initiation needs to know about an order to decide whether it can be paid. Without `paymentIntent` the
 * payment-history checks are skipped; the locked re-check that opens the attempt always passes it.
 */
export interface PayableOrder {
  id: string;
  userId: string;
  status: OrderStatus;
  deleted: boolean;
  paymentMethod: PaymentMethod;
  paymentIntent?: { status: PaymentIntentStatus; attempts: { status: PaymentStatus }[] } | null;
}

/** An earlier attempt found under the same idempotency key. */
export interface KeyedAttempt {
  status: PaymentStatus;
  authorizationUrl: string | null;
}

export function assertOrderPayable<T extends PayableOrder>(
  order: T | null,
  orderId: string,
  userId: string,
): asserts order is T {
  if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
  if (order.userId !== userId) throw new ForbiddenException('Order does not belong to you');
  if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
    throw new BadRequestException('This order uses cash on delivery. Online payment is not available.');
  }
  const intent = order.paymentIntent;
  if (
    (intent && PAID_INTENT_STATUSES.includes(intent.status)) ||
    intent?.attempts.some((attempt) => attempt.status === PaymentStatus.CAPTURED)
  ) {
    throw new BadRequestException('Payment for this order has already been completed');
  }
  if (order.status !== OrderStatus.PLACED) {
    throw new BadRequestException(`Order "${orderId}" is ${order.status} and can no longer be paid`);
  }
}

/** The checkout URL to hand back when a request repeats an idempotency key. */
export function checkoutUrlForReplay(attempt: KeyedAttempt): string {
  if (attempt.status !== PaymentStatus.PENDING) {
    throw new ConflictException(
      `The payment attempt for this idempotency key is ${attempt.status}; start a new attempt with a new key`,
    );
  }
  if (!attempt.authorizationUrl) {
    throw new ConflictException('A payment attempt with this idempotency key is still being set up; retry shortly');
  }
  return attempt.authorizationUrl;
}
