import { Decimal } from '@prisma/client/runtime/client';
import { margin } from './margins';

const d = (value: string) => new Decimal(value);

describe('margin (P8-A)', () => {
  it('is costed net sales minus cost of goods sold, with the rate to 4 dp', () => {
    const result = margin({
      unitsSold: 5,
      costedNetSales: d('200.00'),
      cogs: d('122.5050'),
      unknownCostUnits: 0,
      unknownCostNetSales: d('0'),
    });

    expect(result).toEqual({
      unitsSold: 5,
      netSales: d('200'),
      costedNetSales: d('200'),
      cogs: d('122.51'),
      grossMargin: d('77.49'),
      marginRate: d('0.3875'),
      unknownCostUnits: 0,
      unknownCostNetSales: d('0'),
    });
  });

  it('leaves lines of unknown cost out of the margin instead of counting them at zero cost', () => {
    const result = margin({
      unitsSold: 3,
      costedNetSales: d('50.00'),
      cogs: d('30.0000'),
      unknownCostUnits: 2,
      unknownCostNetSales: d('80.00'),
    });

    expect(result).toMatchObject({
      netSales: d('130'),
      grossMargin: d('20'),
      marginRate: d('0.4'),
      unknownCostUnits: 2,
      unknownCostNetSales: d('80'),
    });
  });

  it('has no rate when nothing sold had a known cost', () => {
    const result = margin({
      unitsSold: 1,
      costedNetSales: d('0'),
      cogs: d('0'),
      unknownCostUnits: 1,
      unknownCostNetSales: d('10.00'),
    });

    expect(result.marginRate).toBeNull();
    expect(result.grossMargin).toEqual(d('0'));
  });

  it('turns negative when restocked units reverse cost after a full refund', () => {
    const result = margin({
      unitsSold: 2,
      costedNetSales: d('0.00'),
      cogs: d('-0.0000'),
      unknownCostUnits: 0,
      unknownCostNetSales: d('0'),
    });

    expect(result.grossMargin).toEqual(d('0'));
  });
});
