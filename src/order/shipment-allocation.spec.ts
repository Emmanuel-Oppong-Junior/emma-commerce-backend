import { PaymentMethod, ShipmentStatus } from '../generated/prisma/client';
import {
  AllocatedShipment,
  COD_ORDER_NOT_SPLIT,
  isOrderDelivered,
  NOTHING_TO_SHIP,
  planShipment,
  SHIPMENT_QUANTITY_EXCEEDED,
  unshippedQuantities,
} from './shipment-allocation';

const { ONLINE, CASH_ON_DELIVERY } = PaymentMethod;
const lines = [
  { id: 'a', quantity: 3 },
  { id: 'b', quantity: 1 },
];
const shipped = (status: ShipmentStatus, a: number, b = 0): AllocatedShipment => ({
  status,
  items: [...(a > 0 ? [{ orderItemId: 'a', quantity: a }] : []), ...(b > 0 ? [{ orderItemId: 'b', quantity: b }] : [])],
});

describe('unshippedQuantities', () => {
  it('takes every non-cancelled shipment off the ordered quantities', () => {
    const remaining = unshippedQuantities(lines, [
      shipped(ShipmentStatus.DELIVERED, 1),
      shipped(ShipmentStatus.PENDING, 1, 1),
      shipped(ShipmentStatus.CANCELLED, 1),
    ]);

    expect(Object.fromEntries(remaining)).toEqual({ a: 1, b: 0 });
  });
});

describe('planShipment', () => {
  it('ships every unshipped unit when no lines are requested, leaving out lines already shipped', () => {
    expect(planShipment(ONLINE, lines, [shipped(ShipmentStatus.PACKED, 1, 1)])).toEqual({
      ok: true,
      lines: [{ orderItemId: 'a', quantity: 2 }],
    });
  });

  it('ships the requested units within what is unshipped', () => {
    expect(
      planShipment(ONLINE, lines, [shipped(ShipmentStatus.PENDING, 1)], [{ orderItemId: 'a', quantity: 2 }]),
    ).toEqual({
      ok: true,
      lines: [{ orderItemId: 'a', quantity: 2 }],
    });
  });

  it('refuses over-allocation as a conflict', () => {
    expect(
      planShipment(ONLINE, lines, [shipped(ShipmentStatus.PENDING, 2)], [{ orderItemId: 'a', quantity: 2 }]),
    ).toEqual({
      ok: false,
      conflict: true,
      reason: SHIPMENT_QUANTITY_EXCEEDED,
      problem: 'Order line "a" has 1 unit(s) not yet in a shipment; 2 requested',
    });
  });

  it('gives a cancelled shipment’s units back', () => {
    expect(
      planShipment(ONLINE, lines, [shipped(ShipmentStatus.CANCELLED, 3)], [{ orderItemId: 'a', quantity: 3 }]).ok,
    ).toBe(true);
  });

  it('refuses when everything is already in a shipment', () => {
    expect(planShipment(ONLINE, lines, [shipped(ShipmentStatus.PENDING, 3, 1)])).toMatchObject({
      ok: false,
      conflict: true,
      reason: NOTHING_TO_SHIP,
    });
  });

  it.each([
    [[{ orderItemId: 'x', quantity: 1 }], 'Order line "x" is not on this order'],
    [
      [
        { orderItemId: 'a', quantity: 1 },
        { orderItemId: 'a', quantity: 1 },
      ],
      'Order line "a" is named twice',
    ],
    [[{ orderItemId: 'a', quantity: 0 }], 'Quantity of order line "a" must be a whole number above 0'],
  ])('refuses a bad request %#', (requested, problem) => {
    expect(planShipment(ONLINE, lines, [], requested)).toEqual({ ok: false, problem });
  });

  it('ships a cash-on-delivery order only whole, in one shipment', () => {
    expect(planShipment(CASH_ON_DELIVERY, lines, [])).toEqual({
      ok: true,
      lines: [
        { orderItemId: 'a', quantity: 3 },
        { orderItemId: 'b', quantity: 1 },
      ],
    });
    expect(planShipment(CASH_ON_DELIVERY, lines, [], [{ orderItemId: 'a', quantity: 3 }])).toMatchObject({
      ok: false,
      reason: COD_ORDER_NOT_SPLIT,
    });
    expect(planShipment(CASH_ON_DELIVERY, lines, [shipped(ShipmentStatus.CANCELLED, 3, 1)]).ok).toBe(true);
  });
});

describe('isOrderDelivered', () => {
  const none = new Map<string, number>();

  it('is true once every unit is in a delivered shipment', () => {
    expect(
      isOrderDelivered(lines, [shipped(ShipmentStatus.DELIVERED, 2), shipped(ShipmentStatus.DELIVERED, 1, 1)], none),
    ).toBe(true);
  });

  it('is false while another shipment is still open, or units are not shipped', () => {
    expect(
      isOrderDelivered(
        lines,
        [shipped(ShipmentStatus.DELIVERED, 2, 1), shipped(ShipmentStatus.OUT_FOR_DELIVERY, 1)],
        none,
      ),
    ).toBe(false);
    expect(isOrderDelivered(lines, [shipped(ShipmentStatus.DELIVERED, 2, 1)], none)).toBe(false);
  });

  it('counts refunded units as done, but needs a delivery', () => {
    const refunded = new Map([['a', 1]]);
    expect(
      isOrderDelivered(
        lines,
        [shipped(ShipmentStatus.DELIVERED, 2, 1), shipped(ShipmentStatus.CANCELLED, 1)],
        refunded,
      ),
    ).toBe(true);
    expect(
      isOrderDelivered(
        lines,
        [shipped(ShipmentStatus.CANCELLED, 3, 1)],
        new Map([
          ['a', 3],
          ['b', 1],
        ]),
      ),
    ).toBe(false);
  });
});
