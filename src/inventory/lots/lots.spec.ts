import { Prisma } from '../../generated/prisma/client';
import {
  allocateFromDrawn,
  assignTransferReceipt,
  DrawPolicy,
  expiredInDraw,
  expiredUnits,
  expiringStockLines,
  ExpiringLotRow,
  expiringWindowProblem,
  expiryWriteOff,
  fefoDraw,
  isExpired,
  LotUnits,
  lotSpecProblem,
  lotTrackingChangeProblem,
  sellableLevels,
} from './lots';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

function lot(lotId: string, expiresInDays: number, onHand: number, createdDaysAgo = 10): LotUnits {
  return { lotId, expiresAt: day(expiresInDays), createdAt: day(-createdDaysAgo), onHand };
}

describe('isExpired', () => {
  it('is expired from the instant of expiry', () => {
    expect(isExpired(NOW, NOW)).toBe(true);
    expect(isExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isExpired(day(-1), NOW)).toBe(true);
  });
});

describe('fefoDraw', () => {
  it('takes the earliest unexpired expiry first', () => {
    const lots = [lot('late', 60, 5), lot('soon', 10, 5)];

    expect(fefoDraw(lots, 3, NOW, DrawPolicy.Sale)).toEqual([{ lotId: 'soon', quantity: 3 }]);
  });

  it('spans lots when the first runs out', () => {
    const lots = [lot('late', 60, 5), lot('soon', 10, 2)];

    expect(fefoDraw(lots, 4, NOW, DrawPolicy.Sale)).toEqual([
      { lotId: 'soon', quantity: 2 },
      { lotId: 'late', quantity: 2 },
    ]);
  });

  it('breaks an expiry tie with the oldest lot', () => {
    const lots = [lot('newer', 30, 5, 1), lot('older', 30, 5, 20)];

    expect(fefoDraw(lots, 1, NOW, DrawPolicy.Removal)).toEqual([{ lotId: 'older', quantity: 1 }]);
  });

  it('skips expired lots while unexpired ones hold enough', () => {
    const lots = [lot('expired', -1, 5), lot('fresh', 30, 5)];

    expect(fefoDraw(lots, 5, NOW, DrawPolicy.Sale)).toEqual([{ lotId: 'fresh', quantity: 5 }]);
  });

  it('falls back to expired lots for a sale or a removal, never for a transfer', () => {
    const lots = [lot('expired', -1, 5), lot('fresh', 30, 2)];

    expect(fefoDraw(lots, 4, NOW, DrawPolicy.Sale)).toEqual([
      { lotId: 'fresh', quantity: 2 },
      { lotId: 'expired', quantity: 2 },
    ]);
    expect(fefoDraw(lots, 4, NOW, DrawPolicy.Removal)).toEqual([
      { lotId: 'fresh', quantity: 2 },
      { lotId: 'expired', quantity: 2 },
    ]);
    expect(fefoDraw(lots, 4, NOW, DrawPolicy.Transfer)).toBeNull();
  });

  it('is null when the lots hold too few units', () => {
    expect(fefoDraw([lot('a', 10, 2), lot('b', 20, 1)], 4, NOW, DrawPolicy.Sale)).toBeNull();
    expect(fefoDraw([], 1, NOW, DrawPolicy.Removal)).toBeNull();
  });
});

describe('expiredUnits and expiredInDraw', () => {
  it('counts the units of expired lots and how many a draw took from them', () => {
    const lots = [lot('expired', -2, 4), lot('fresh', 5, 6)];

    expect(expiredUnits(lots, NOW)).toBe(4);
    expect(
      expiredInDraw(
        [
          { lotId: 'fresh', quantity: 6 },
          { lotId: 'expired', quantity: 1 },
        ],
        lots,
        NOW,
      ),
    ).toBe(1);
  });
});

describe('sellableLevels', () => {
  it("takes the units of the variant's expired lots off onHand at their location only", () => {
    const levels = [
      { locationId: 'main', onHand: 10, reserved: 1 },
      { locationId: 'branch', onHand: 4, reserved: 0 },
    ];
    const expired = [
      { variantId: 'v1', locationId: 'main', units: 6 },
      { variantId: 'v2', locationId: 'branch', units: 4 },
    ];

    expect(sellableLevels('v1', levels, expired)).toEqual([
      { locationId: 'main', onHand: 4, reserved: 1 },
      { locationId: 'branch', onHand: 4, reserved: 0 },
    ]);
  });

  it('leaves a variant without expired lots as it is', () => {
    const levels = [{ locationId: 'main', onHand: 3, reserved: 0 }];

    expect(sellableLevels('v1', levels, [])).toEqual(levels);
  });
});

describe('lotSpecProblem', () => {
  const existing = { expiresAt: day(90), manufacturedAt: null };

  it('accepts a new lot with a future expiry', () => {
    expect(lotSpecProblem({ lotNumber: 'L1', expiresAt: day(90) }, null, NOW, true)).toBeNull();
  });

  it('needs the expiry on a receipt, and to create a lot', () => {
    expect(lotSpecProblem({ lotNumber: 'L1' }, existing, NOW, true)).toBe('Lot "L1" needs its expiry date (expiresAt)');
    expect(lotSpecProblem({ lotNumber: 'L1' }, null, NOW, false)).toBe('Lot "L1" needs its expiry date (expiresAt)');
    expect(lotSpecProblem({ lotNumber: 'L1' }, existing, NOW, false)).toBeNull();
  });

  it('refuses a blank or long lot number', () => {
    expect(lotSpecProblem({ lotNumber: '  ', expiresAt: day(9) }, null, NOW, true)).toBe(
      'The lot number cannot be blank',
    );
    expect(lotSpecProblem({ lotNumber: 'x'.repeat(101), expiresAt: day(9) }, null, NOW, true)).toBe(
      'The lot number is limited to 100 characters',
    );
  });

  it('refuses an expiry that differs from the existing lot', () => {
    expect(lotSpecProblem({ lotNumber: 'L1', expiresAt: day(91) }, existing, NOW, true)).toBe(
      `Lot "L1" expires at ${day(90).toISOString()}, not ${day(91).toISOString()}`,
    );
  });

  it('refuses an expired lot, new or existing', () => {
    expect(lotSpecProblem({ lotNumber: 'L1', expiresAt: NOW }, null, NOW, true)).toBe(
      `Lot "L1" expired at ${NOW.toISOString()}; expired goods cannot be received`,
    );
    expect(lotSpecProblem({ lotNumber: 'L1' }, { expiresAt: day(-1), manufacturedAt: null }, NOW, false)).toMatch(
      /expired goods cannot be received/,
    );
  });

  it('checks the manufacturing date', () => {
    expect(lotSpecProblem({ lotNumber: 'L1', expiresAt: day(9), manufacturedAt: day(1) }, null, NOW, true)).toBe(
      'Lot "L1" cannot be manufactured in the future',
    );
    expect(
      lotSpecProblem({ lotNumber: 'L1', expiresAt: day(9), manufacturedAt: day(-30) }, null, NOW, true),
    ).toBeNull();
    expect(
      lotSpecProblem(
        { lotNumber: 'L1', expiresAt: day(9), manufacturedAt: day(-1) },
        { expiresAt: day(9), manufacturedAt: day(-2) },
        NOW,
        true,
      ),
    ).toBe('Lot "L1" was recorded with another manufacturing date');
  });
});

describe('assignTransferReceipt', () => {
  const dispatched = [
    { lotId: 'late', quantity: 3, expiresAt: day(60), createdAt: day(-1) },
    { lotId: 'soon', quantity: 4, expiresAt: day(10), createdAt: day(-5) },
  ];

  it('puts every unit back into its lot when all arrived', () => {
    expect(assignTransferReceipt(dispatched, 7)).toEqual([
      { lotId: 'soon', quantity: 4 },
      { lotId: 'late', quantity: 3 },
    ]);
  });

  it('lays a shortfall on the lots that expire last', () => {
    expect(assignTransferReceipt(dispatched, 5)).toEqual([
      { lotId: 'soon', quantity: 4 },
      { lotId: 'late', quantity: 1 },
    ]);
    expect(assignTransferReceipt(dispatched, 2)).toEqual([{ lotId: 'soon', quantity: 2 }]);
  });

  it('refuses more units than were dispatched in lots', () => {
    expect(() => assignTransferReceipt(dispatched, 8)).toThrow('Received 8 units but only 7 were dispatched in lots');
  });
});

describe('allocateFromDrawn', () => {
  it('puts units back into the drawn lots, earliest expiry first, or null when they drew fewer', () => {
    const drawn = [lot('b', 40, 2), lot('a', 20, 1)];

    expect(allocateFromDrawn(drawn, 2)).toEqual([
      { lotId: 'a', quantity: 1 },
      { lotId: 'b', quantity: 1 },
    ]);
    expect(allocateFromDrawn(drawn, 4)).toBeNull();
  });
});

describe('expiryWriteOff', () => {
  it('writes off every expired unit when the level has them free', () => {
    const lots = [lot('fresh', 10, 5), lot('old', -3, 2), lot('older', -9, 4)];

    expect(expiryWriteOff(lots, 11, NOW)).toEqual({
      writeOff: [
        { lotId: 'older', quantity: 4 },
        { lotId: 'old', quantity: 2 },
      ],
      blocked: 0,
    });
  });

  it('leaves the units held for orders', () => {
    const lots = [lot('old', -3, 6), lot('fresh', 10, 4)];

    expect(expiryWriteOff(lots, 2, NOW)).toEqual({ writeOff: [{ lotId: 'old', quantity: 2 }], blocked: 4 });
    expect(expiryWriteOff(lots, 0, NOW)).toEqual({ writeOff: [], blocked: 6 });
  });

  it('writes nothing when nothing has expired', () => {
    expect(expiryWriteOff([lot('fresh', 1, 3)], 3, NOW)).toEqual({ writeOff: [], blocked: 0 });
  });
});

describe('lotTrackingChangeProblem', () => {
  it('allows a switch only without stock anywhere', () => {
    expect(lotTrackingChangeProblem(true, { onHand: 0, inTransit: 0, awaitingDispatch: 0 })).toBeNull();
    expect(lotTrackingChangeProblem(true, { onHand: 3, inTransit: 1, awaitingDispatch: 2 })).toBe(
      'Lot tracking can only be turned on when the product holds no stock: 3 on hand, 1 in transit, 2 sold ' +
        'awaiting dispatch. Adjust the stock out (CORRECTION) and receive it again with lot numbers',
    );
    expect(lotTrackingChangeProblem(false, { onHand: 0, inTransit: 2, awaitingDispatch: 0 })).toMatch(
      /^Lot tracking can only be turned off .*Sell, adjust or write off the lots first$/,
    );
  });
});

describe('expiringWindowProblem', () => {
  it('accepts 1 to 365 whole days', () => {
    expect(expiringWindowProblem(1)).toBeNull();
    expect(expiringWindowProblem(365)).toBeNull();
    expect(expiringWindowProblem(0)).toBe('withinDays must be a whole number from 1 to 365, got 0');
    expect(expiringWindowProblem(366)).not.toBeNull();
    expect(expiringWindowProblem(1.5)).not.toBeNull();
  });
});

describe('expiringStockLines', () => {
  const row = (overrides: Partial<ExpiringLotRow>): ExpiringLotRow => ({
    lotId: 'lot1',
    lotNumber: 'L1',
    expiresAt: day(5),
    manufacturedAt: null,
    lotCreatedAt: day(-30),
    variantId: 'var1',
    sku: 'SKU-1',
    productId: 'prod1',
    productName: 'Milk',
    price: new Prisma.Decimal('12.50'),
    costPrice: null,
    locationId: 'main',
    locationName: 'Main',
    onHand: 4,
    ...overrides,
  });

  it('groups a lot over its locations, soonest expiry first, valued at the current price', () => {
    const lines = expiringStockLines(
      [
        row({ lotId: 'lot2', lotNumber: 'L2', expiresAt: day(20), onHand: 1 }),
        row({ locationId: 'west', locationName: 'West', onHand: 2 }),
        row({ locationId: 'east', locationName: 'East', onHand: 3 }),
        row({ lotId: 'gone', lotNumber: 'L0', expiresAt: day(-1), price: null, onHand: 5 }),
      ],
      NOW,
    );

    expect(lines.map((line) => line.lotNumber)).toEqual(['L0', 'L1', 'L2']);
    expect(lines[0]).toMatchObject({ expired: true, onHand: 5, unitPrice: null, value: null });
    expect(lines[1]).toMatchObject({
      lotId: 'lot1',
      expired: false,
      onHand: 5,
      locations: [
        { locationId: 'east', locationName: 'East', onHand: 3 },
        { locationId: 'west', locationName: 'West', onHand: 2 },
      ],
    });
    expect(lines[1].value?.toFixed(2)).toBe('62.50');
    expect(lines[1]).not.toHaveProperty('createdAt');
  });

  it('values the units at the weighted-average cost too, null when the cost is unknown (P4-E.1)', () => {
    const [costed, uncosted] = expiringStockLines(
      [row({ costPrice: new Prisma.Decimal('7.1234'), onHand: 3 }), row({ lotId: 'lot2', expiresAt: day(9) })],
      NOW,
    );

    expect(costed.unitCost?.toFixed(4)).toBe('7.1234');
    expect(costed.costValue?.toFixed(4)).toBe('21.3702');
    expect(uncosted).toMatchObject({ unitCost: null, costValue: null });
  });

  it('leaves out rows without units', () => {
    expect(expiringStockLines([row({ onHand: 0 })], NOW)).toEqual([]);
  });
});
