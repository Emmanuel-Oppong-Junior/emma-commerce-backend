import { trackingTimeline } from './tracking-timeline';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 23, 10, minute));

describe('trackingTimeline', () => {
  it('merges order and shipment steps by time, order steps first on a tie, with each shipment’s carrier', () => {
    const steps = trackingTimeline(
      [
        { id: 'o1', to: 'PLACED', createdAt: at(0) },
        { id: 'o2', to: 'CONFIRMED', createdAt: at(1) },
        { id: 'o3', to: 'IN_FULFILMENT', createdAt: at(5) },
      ],
      [
        {
          id: 'ship2',
          carrier: null,
          trackingNumber: null,
          events: [{ id: 's3', to: 'PENDING', createdAt: at(4) }],
        },
        {
          id: 'ship1',
          carrier: 'DHL',
          trackingNumber: 'TRK1',
          events: [
            { id: 's1', to: 'PENDING', createdAt: at(2) },
            { id: 's2', to: 'PICKING', createdAt: at(5) },
          ],
        },
      ],
    );

    expect(steps.map((step) => step.orderStatus ?? `${step.shipmentId}:${step.shipmentStatus}`)).toEqual([
      'PLACED',
      'CONFIRMED',
      'ship1:PENDING',
      'ship2:PENDING',
      'IN_FULFILMENT',
      'ship1:PICKING',
    ]);
    expect(steps[2]).toEqual({
      at: at(2),
      orderStatus: null,
      shipmentId: 'ship1',
      shipmentStatus: 'PENDING',
      carrier: 'DHL',
      trackingNumber: 'TRK1',
    });
    expect(steps[0]).toEqual({
      at: at(0),
      orderStatus: 'PLACED',
      shipmentId: null,
      shipmentStatus: null,
      carrier: null,
      trackingNumber: null,
    });
  });

  it('is empty for nothing and keeps no actor or reason', () => {
    expect(trackingTimeline([], [])).toEqual([]);
    const [step] = trackingTimeline(
      [{ id: 'o1', to: 'PLACED', createdAt: at(0), actorId: 'staff1', reason: 'internal' } as never],
      [],
    );
    expect(Object.keys(step).sort()).toEqual(
      ['at', 'carrier', 'orderStatus', 'shipmentId', 'shipmentStatus', 'trackingNumber'].sort(),
    );
  });
});
