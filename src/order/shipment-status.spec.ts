import { FulfillmentType, ShipmentStatus } from '../generated/prisma/client';
import { canShipmentTransition, isDispatch, isShipmentOpen } from './shipment-status';

const {
  PENDING,
  PICKING,
  PACKED,
  READY_FOR_PICKUP,
  OUT_FOR_DELIVERY,
  DELIVERED,
  FAILED_DELIVERY,
  RETURNED,
  CANCELLED,
} = ShipmentStatus;

const COMMON: [ShipmentStatus, ShipmentStatus][] = [
  [PENDING, PICKING],
  [PENDING, PACKED],
  [PICKING, PACKED],
  [READY_FOR_PICKUP, DELIVERED],
  [READY_FOR_PICKUP, FAILED_DELIVERY],
  [OUT_FOR_DELIVERY, DELIVERED],
  [OUT_FOR_DELIVERY, FAILED_DELIVERY],
  [FAILED_DELIVERY, RETURNED],
  [PENDING, CANCELLED],
  [PICKING, CANCELLED],
  [PACKED, CANCELLED],
];
const toDispatch = (dispatch: ShipmentStatus): [ShipmentStatus, ShipmentStatus][] =>
  [PENDING, PICKING, PACKED, FAILED_DELIVERY].map((from) => [from, dispatch]);

const ALLOWED: Record<FulfillmentType, [ShipmentStatus, ShipmentStatus][]> = {
  DELIVERY: [...COMMON, ...toDispatch(OUT_FOR_DELIVERY)],
  PICKUP: [...COMMON, ...toDispatch(READY_FOR_PICKUP)],
};

const CASES = Object.values(FulfillmentType).flatMap((type) =>
  Object.values(ShipmentStatus).flatMap((from) =>
    Object.values(ShipmentStatus).map((to) => [type, from, to] as [FulfillmentType, ShipmentStatus, ShipmentStatus]),
  ),
);

describe('shipment status transitions', () => {
  it.each(CASES)('%s order: %s → %s matches the table', (type, from, to) => {
    const expected = ALLOWED[type].some(([f, t]) => f === from && t === to);

    expect(canShipmentTransition(from, to, type)).toBe(expected);
  });

  it('counts only ready-for-pickup and out-for-delivery as dispatch', () => {
    expect(Object.values(ShipmentStatus).filter(isDispatch)).toEqual([READY_FOR_PICKUP, OUT_FOR_DELIVERY]);
  });

  it('counts every status but delivered, returned and cancelled as open', () => {
    expect(Object.values(ShipmentStatus).filter((status) => !isShipmentOpen(status))).toEqual([
      DELIVERED,
      RETURNED,
      CANCELLED,
    ]);
  });
});
