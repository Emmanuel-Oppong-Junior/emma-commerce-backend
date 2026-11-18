import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentIntentStatus, PaymentMethod, PaymentStatus } from '../generated/prisma/client';
import { assertOrderPayable, checkoutUrlForReplay, PayableOrder } from './payment-initiation';

const payable: PayableOrder = {
  id: 'order1',
  userId: 'user1',
  status: OrderStatus.PENDING,
  deleted: false,
  paymentMethod: PaymentMethod.ONLINE,
  paymentIntent: null,
};

const check = (order: PayableOrder | null) => () => assertOrderPayable(order, 'order1', 'user1');

describe('assertOrderPayable', () => {
  it('accepts a PENDING online order of the caller with no payment yet', () => {
    expect(check(payable)).not.toThrow();
  });

  it('accepts a PENDING order whose earlier attempts failed or were abandoned', () => {
    const order = {
      ...payable,
      paymentIntent: {
        status: PaymentIntentStatus.PENDING,
        attempts: [{ status: PaymentStatus.FAILED }, { status: PaymentStatus.ABANDONED }],
      },
    };

    expect(check(order)).not.toThrow();
  });

  it('treats a missing or soft-deleted order as not found', () => {
    expect(check(null)).toThrow(new NotFoundException('Order "order1" not found'));
    expect(check({ ...payable, deleted: true })).toThrow(new NotFoundException('Order "order1" not found'));
  });

  it("refuses another user's order", () => {
    expect(check({ ...payable, userId: 'user2' })).toThrow(new ForbiddenException('Order does not belong to you'));
  });

  it('refuses a cash-on-delivery order', () => {
    expect(check({ ...payable, paymentMethod: PaymentMethod.CASH_ON_DELIVERY })).toThrow(BadRequestException);
  });

  it.each([OrderStatus.CANCELLED, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED])(
    'refuses a %s order',
    (status) => {
      expect(check({ ...payable, status })).toThrow(
        new BadRequestException(`Order "order1" is ${status} and can no longer be paid`),
      );
    },
  );

  it('refuses an order that is already paid, by intent status or by a completed attempt', () => {
    const paid = new BadRequestException('Payment for this order has already been completed');

    expect(check({ ...payable, paymentIntent: { status: PaymentIntentStatus.PAID, attempts: [] } })).toThrow(paid);
    expect(
      check({
        ...payable,
        paymentIntent: { status: PaymentIntentStatus.PENDING, attempts: [{ status: PaymentStatus.COMPLETED }] },
      }),
    ).toThrow(paid);
  });
});

describe('checkoutUrlForReplay', () => {
  it('hands back the checkout URL of a pending attempt', () => {
    expect(checkoutUrlForReplay({ status: PaymentStatus.PENDING, authorizationUrl: 'https://checkout.test/x' })).toBe(
      'https://checkout.test/x',
    );
  });

  it('refuses while the checkout is still being opened', () => {
    expect(() => checkoutUrlForReplay({ status: PaymentStatus.PENDING, authorizationUrl: null })).toThrow(
      ConflictException,
    );
  });

  it.each([PaymentStatus.ABANDONED, PaymentStatus.FAILED, PaymentStatus.COMPLETED])(
    'refuses an attempt that is %s, so a superseded checkout is never handed out again',
    (status) => {
      expect(() => checkoutUrlForReplay({ status, authorizationUrl: 'https://checkout.test/x' })).toThrow(
        ConflictException,
      );
    },
  );
});
