import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  FulfillmentType,
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
} from '../generated/prisma/client';
import { assertCodCollectable, CollectableOrder } from './cash-on-delivery';

const shipped: CollectableOrder = {
  status: OrderStatus.SHIPPED,
  deleted: false,
  paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
  paymentIntent: null,
};

const check = (order: CollectableOrder | null) => () => assertCodCollectable(order, 'order1');

describe('assertCodCollectable', () => {
  it('accepts a SHIPPED cash-on-delivery order with no payment yet', () => {
    expect(check(shipped)).not.toThrow();
  });

  it('accepts a SHIPPED pickup order the same way as a delivery order', () => {
    const pickup = { ...shipped, fulfillmentType: FulfillmentType.PICKUP };

    expect(check(pickup)).not.toThrow();
  });

  it('accepts an order whose intent exists but is unpaid', () => {
    expect(check({ ...shipped, paymentIntent: { status: PaymentIntentStatus.PENDING, attempts: [] } })).not.toThrow();
  });

  it('treats a missing or soft-deleted order as not found', () => {
    expect(check(null)).toThrow(new NotFoundException('Order "order1" not found'));
    expect(check({ ...shipped, deleted: true })).toThrow(new NotFoundException('Order "order1" not found'));
  });

  it('refuses an online order', () => {
    expect(check({ ...shipped, paymentMethod: PaymentMethod.ONLINE })).toThrow(
      new BadRequestException('Order "order1" is not a cash-on-delivery order'),
    );
  });

  it.each([OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
    'refuses an order in %s',
    (status) => {
      expect(check({ ...shipped, status })).toThrow(
        new ConflictException(`Order "order1" is ${status}; cash can only be recorded for a SHIPPED order`),
      );
    },
  );

  it('refuses an order whose payment is already recorded', () => {
    const paid = { ...shipped, paymentIntent: { status: PaymentIntentStatus.PAID, attempts: [] } };
    const completed = {
      ...shipped,
      paymentIntent: { status: PaymentIntentStatus.PENDING, attempts: [{ status: PaymentStatus.COMPLETED }] },
    };
    const alreadyRecorded = new ConflictException('Payment for order "order1" has already been recorded');

    expect(check(paid)).toThrow(alreadyRecorded);
    expect(check(completed)).toThrow(alreadyRecorded);
  });
});
