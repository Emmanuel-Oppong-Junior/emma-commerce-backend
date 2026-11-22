import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { roundHalfUp } from '../commons/money/money';
import { OrderTaxSnapshot, refundPartsTax } from './refund-tax';

type Decimal = Prisma.Decimal;
const zero = () => new Prisma.Decimal(0);

/** An order line as stored at placement, with the units refunds have already taken (FAILED refunds excluded). */
export interface RefundableLine {
  id: string;
  quantity: number;
  lineTotal: Decimal;
  /** The line's share of the order-level adjustments (<= 0). */
  orderAdjustmentShare: Decimal;
  taxLineAmounts: Decimal[];
  refundedQuantity: number;
}

/** What a refund of a paid order may take, read under the payment's row lock. */
export interface RefundableOrder extends OrderTaxSnapshot {
  currency: string;
  /** The stored delivery fee after free-shipping promotions; null when unknown (legacy orders). */
  shippingTotal: Decimal | null;
  /** Whether a refund (FAILED excluded) has already returned the delivery fee. */
  shippingRefunded: boolean;
  lines: RefundableLine[];
  /** What is still refundable on the payment, across every kind of refund (returns, auto-refunds, staff refunds). */
  refundable: Decimal;
}

export interface RefundRequestParts {
  lines: { orderItemId: string; quantity: number }[];
  shipping: boolean;
  /** A free amount on top of the lines and the shipping fee. */
  amount: Decimal | null;
}

export interface RefundPlan {
  amount: Decimal;
  taxAmount: Decimal | null;
  shippingAmount: Decimal;
  lines: { orderItemId: string; quantity: number; amount: Decimal }[];
}

/** The line's share of the order-level adjustments for its first `units` units; all units give exactly the share. */
function adjustmentShareFor(line: RefundableLine, units: number): Decimal {
  return roundHalfUp(line.orderAdjustmentShare.mul(units).div(line.quantity));
}

/** What `quantity` more units of the line were charged: their part of the line total and of the order adjustments. */
function lineAmount(line: RefundableLine, quantity: number): Decimal {
  const gross = line.lineTotal.div(line.quantity).mul(quantity);
  const from = line.refundedQuantity;
  return gross.add(adjustmentShareFor(line, from + quantity)).sub(adjustmentShareFor(line, from));
}

/**
 * Works out a refund of chosen line units, the delivery fee and a free amount from what the order stored at placement,
 * never re-pricing. BAD_REQUEST for a request that names nothing, an unknown or repeated line, or a fee that does not
 * exist; CONFLICT when it would refund more units than a line has left, the delivery fee a second time, or more than
 * the payment still holds.
 */
export function planRefund(order: RefundableOrder, request: RefundRequestParts): RefundPlan {
  const freeAmount = request.amount ?? zero();
  if (request.lines.length === 0 && !request.shipping && freeAmount.isZero()) {
    throw new BadRequestException('Choose order lines, the shipping fee or an amount to refund');
  }
  if (freeAmount.lt(0)) {
    throw new BadRequestException(`Refund amount must not be negative, got ${freeAmount.toFixed(2)}`);
  }

  const seen = new Set<string>();
  const lines = request.lines.map(({ orderItemId, quantity }) => {
    if (seen.has(orderItemId)) throw new BadRequestException(`Order line "${orderItemId}" is listed more than once`);
    seen.add(orderItemId);
    const line = order.lines.find((candidate) => candidate.id === orderItemId);
    if (!line) throw new BadRequestException(`Order line "${orderItemId}" is not part of this order`);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException(`Quantity for order line "${orderItemId}" must be a whole number of at least 1`);
    }
    const left = line.quantity - line.refundedQuantity;
    if (quantity > left) {
      throw new ConflictException(
        `Order line "${orderItemId}" has ${left} of ${line.quantity} units left to refund; ${quantity} requested`,
      );
    }
    return { line, quantity, amount: lineAmount(line, quantity) };
  });

  let shippingAmount = zero();
  if (request.shipping) {
    if (!order.shippingTotal || order.shippingTotal.lte(0)) {
      throw new BadRequestException('This order has no shipping fee to refund');
    }
    if (order.shippingRefunded) throw new ConflictException('The shipping fee of this order was already refunded');
    shippingAmount = order.shippingTotal;
  }

  const amount = lines.reduce((total, line) => total.add(line.amount), shippingAmount.add(freeAmount));
  if (amount.lte(0)) {
    throw new BadRequestException('The chosen lines were charged nothing; there is nothing to refund');
  }
  if (amount.gt(order.refundable)) {
    throw new ConflictException(
      `Refund of ${amount.toFixed(2)} ${order.currency} exceeds the ${order.refundable.toFixed(2)} ${order.currency} still refundable on this order's payment`,
    );
  }

  const tax = refundPartsTax(
    {
      lines: lines.map(({ line, quantity }) => ({
        lineQuantity: line.quantity,
        taxLineAmounts: line.taxLineAmounts,
        refundedQuantity: line.refundedQuantity,
        quantity,
      })),
      amount: freeAmount,
    },
    order,
  );
  return {
    amount,
    taxAmount: tax === null ? null : Prisma.Decimal.min(tax, amount),
    shippingAmount,
    lines: lines.map(({ line, quantity, amount: lineRefund }) => ({
      orderItemId: line.id,
      quantity,
      amount: lineRefund,
    })),
  };
}
