import { PurchaseOrderStatus } from '../../generated/prisma/client';
import {
  canPurchaseOrderTransition,
  isReceivable,
  purchaseOrderReference,
  statusAfterReceipt,
} from './purchase-order-status';

const S = PurchaseOrderStatus;

describe('purchase order status machine', () => {
  it.each([
    [S.DRAFT, S.SENT],
    [S.DRAFT, S.CANCELLED],
    [S.SENT, S.PARTIALLY_RECEIVED],
    [S.SENT, S.RECEIVED],
    [S.SENT, S.CANCELLED],
    [S.PARTIALLY_RECEIVED, S.PARTIALLY_RECEIVED],
    [S.PARTIALLY_RECEIVED, S.RECEIVED],
    [S.PARTIALLY_RECEIVED, S.CLOSED],
  ])('allows %s -> %s', (from, to) => {
    expect(canPurchaseOrderTransition(from, to)).toBe(true);
  });

  it.each([
    [S.DRAFT, S.RECEIVED],
    [S.DRAFT, S.PARTIALLY_RECEIVED],
    [S.DRAFT, S.CLOSED],
    [S.SENT, S.DRAFT],
    [S.SENT, S.CLOSED],
    [S.PARTIALLY_RECEIVED, S.CANCELLED],
    [S.PARTIALLY_RECEIVED, S.SENT],
  ])('refuses %s -> %s', (from, to) => {
    expect(canPurchaseOrderTransition(from, to)).toBe(false);
  });

  it.each([S.RECEIVED, S.CLOSED, S.CANCELLED])('makes %s final', (from) => {
    expect(Object.values(S).filter((to) => canPurchaseOrderTransition(from, to))).toEqual([]);
  });

  it('receives only sent or partly received orders', () => {
    expect(Object.values(S).filter(isReceivable)).toEqual([S.SENT, S.PARTIALLY_RECEIVED]);
  });

  it('is RECEIVED once every line has all its units, else PARTIALLY_RECEIVED', () => {
    expect(
      statusAfterReceipt([
        { quantityOrdered: 5, quantityReceived: 5 },
        { quantityOrdered: 2, quantityReceived: 2 },
      ]),
    ).toBe(S.RECEIVED);
    expect(
      statusAfterReceipt([
        { quantityOrdered: 5, quantityReceived: 5 },
        { quantityOrdered: 2, quantityReceived: 0 },
      ]),
    ).toBe(S.PARTIALLY_RECEIVED);
  });

  it('formats the reference with at least five digits', () => {
    expect(purchaseOrderReference(42)).toBe('PO-00042');
    expect(purchaseOrderReference(123456)).toBe('PO-123456');
  });
});
