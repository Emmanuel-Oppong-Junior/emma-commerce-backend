import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { assertReportRange, buildRiderCashReport, RiderCashRow } from './cash-report';

const d = (value: string) => new Prisma.Decimal(value);

function row(riderId: string, overrides: Partial<RiderCashRow> = {}): RiderCashRow {
  return {
    riderId,
    riderName: `Rider ${riderId}`,
    collectionsCount: 0,
    collectedTotal: d('0'),
    outstandingCount: 0,
    outstandingTotal: d('0'),
    remittancesCount: 0,
    remittedTotal: d('0'),
    discrepancyCount: 0,
    shortTotal: d('0'),
    overTotal: d('0'),
    ...overrides,
  };
}

const ama = row('r_ama', {
  collectionsCount: 3,
  collectedTotal: d('600.00'),
  outstandingCount: 1,
  outstandingTotal: d('100.00'),
  remittancesCount: 1,
  remittedTotal: d('480.00'),
  discrepancyCount: 1,
  shortTotal: d('20.00'),
});
const kofi = row('r_kofi', {
  collectionsCount: 1,
  collectedTotal: d('250.50'),
  remittancesCount: 2,
  remittedTotal: d('255.50'),
  discrepancyCount: 1,
  overTotal: d('5.00'),
});
const yaw = row('r_yaw', {
  collectionsCount: 2,
  collectedTotal: d('80'),
  outstandingCount: 2,
  outstandingTotal: d('80'),
});

describe('buildRiderCashReport', () => {
  it('gives each rider a net discrepancy (negative: owes cash) and totals every rider', () => {
    const report = buildRiderCashReport([kofi, ama, yaw], { first: 20 });

    expect(report.riders.map(({ riderId, netDiscrepancy }) => [riderId, netDiscrepancy])).toEqual([
      ['r_ama', '-20.00'],
      ['r_kofi', '5.00'],
      ['r_yaw', '0.00'],
    ]);
    expect(report.totals).toEqual({
      collectionsCount: 6,
      collectedTotal: d('930.50'),
      outstandingCount: 3,
      outstandingTotal: d('180.00'),
      remittancesCount: 3,
      remittedTotal: d('735.50'),
      discrepancyCount: 2,
      shortTotal: d('20.00'),
      overTotal: d('5.00'),
      netDiscrepancy: '-15.00',
    });
    expect(report.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false, pageSize: 3, totalCount: 3 });
  });

  it('pages riders by id after a cursor while the totals still cover every rider', () => {
    const first = buildRiderCashReport([yaw, kofi, ama], { first: 2 });
    const second = buildRiderCashReport([yaw, kofi, ama], { first: 2, after: first.riders[1].riderId });

    expect(first.riders.map(({ riderId }) => riderId)).toEqual(['r_ama', 'r_kofi']);
    expect(first.pageInfo).toEqual({ hasNextPage: true, hasPreviousPage: false, pageSize: 2, totalCount: 3 });
    expect(second.riders.map(({ riderId }) => riderId)).toEqual(['r_yaw']);
    expect(second.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: true, pageSize: 1, totalCount: 3 });
    expect(second.totals).toEqual(first.totals);
  });

  it('reports zeros for a range with no cash', () => {
    const report = buildRiderCashReport([], { first: 20 });

    expect(report.riders).toEqual([]);
    expect(report.totals.collectedTotal.toFixed(2)).toBe('0.00');
    expect(report.totals.netDiscrepancy).toBe('0.00');
    expect(report.pageInfo.totalCount).toBe(0);
  });
});

describe('assertReportRange', () => {
  it('refuses an empty or reversed range', () => {
    const at = new Date('2026-11-22T00:00:00Z');

    expect(() => assertReportRange(at, at)).toThrow(BadRequestException);
    expect(() => assertReportRange(new Date('2026-11-23T00:00:00Z'), at)).toThrow(BadRequestException);
    expect(() => assertReportRange(at, new Date('2026-11-23T00:00:00Z'))).not.toThrow();
  });
});
