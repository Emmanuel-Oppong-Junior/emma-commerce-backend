import { Prisma } from '../generated/prisma/client';
import { Money } from '../commons/money/money';
import { PriceHistoryService } from './price-history.service';

const tx = { tx: true } as unknown as Prisma.TransactionClient;
const origin = { source: 'ADMIN_EDIT' as const, actorId: 'admin1', reason: 'Promo' };
const d = (value: string) => new Prisma.Decimal(value);

function row(id: string, oldValue: string | null, newValue: string) {
  return {
    id,
    variantId: 'v1',
    field: 'PRICE' as const,
    oldValue: oldValue === null ? null : d(oldValue),
    newValue: d(newValue),
    currency: 'GHS' as const,
    source: 'ADMIN_EDIT' as const,
    reason: 'Promo',
    actorId: 'admin1',
    createdAt: new Date('2026-11-21T10:00:00.000Z'),
  };
}

describe('PriceHistoryService', () => {
  let repository: { append: jest.Mock; findPage: jest.Mock };
  let service: PriceHistoryService;

  beforeEach(() => {
    repository = { append: jest.fn().mockResolvedValue(undefined), findPage: jest.fn() };
    service = new PriceHistoryService(repository as never);
  });

  describe('recordVariantPrices', () => {
    it('appends one row per changed field on the given transaction', async () => {
      await service.recordVariantPrices(
        tx,
        'v1',
        { basePrice: d('10.00'), price: d('12.00') },
        { basePrice: d('11.00'), price: d('13.20') },
        origin,
      );

      expect(repository.append).toHaveBeenCalledTimes(1);
      expect(repository.append).toHaveBeenCalledWith(
        tx,
        'v1',
        [
          { field: 'BASE_PRICE', oldValue: d('10.00'), newValue: d('11.00') },
          { field: 'PRICE', oldValue: d('12.00'), newValue: d('13.20') },
        ],
        origin,
      );
    });

    it('appends nothing when no price changed', async () => {
      const prices = { basePrice: d('10.00'), price: d('12.00') };

      await service.recordVariantPrices(tx, 'v1', prices, { ...prices }, origin);

      expect(repository.append).not.toHaveBeenCalled();
    });
  });

  describe('getChanges', () => {
    it('returns a page of changes with amounts in the currency they were recorded in', async () => {
      repository.findPage.mockResolvedValue([[row('pc2', '10.00', '12.00'), row('pc1', null, '10.00')], 2]);

      const page = await service.getChanges({ variantId: 'v1' }, 5);

      expect(repository.findPage).toHaveBeenCalledWith({ variantId: 'v1' }, { take: 6, after: undefined });
      expect(page.totalCount).toBe(2);
      expect(page.hasNextPage).toBe(false);
      expect(page.nodes.map((n) => n.id)).toEqual(['pc2', 'pc1']);
      expect(page.nodes[0].oldValue).toEqual(Money.of('10.00', 'GHS'));
      expect(page.nodes[0].newValue).toEqual(Money.of('12.00', 'GHS'));
      expect(page.nodes[1].oldValue).toBeNull();
    });

    it('reads one extra row to tell whether another page follows', async () => {
      repository.findPage.mockResolvedValue([[row('pc3', '1.00', '2.00'), row('pc2', '1.00', '2.00')], 3]);

      const page = await service.getChanges({ productId: 'p1' }, 1, 'pc4');

      expect(repository.findPage).toHaveBeenCalledWith({ productId: 'p1' }, { take: 2, after: 'pc4' });
      expect(page.nodes.map((n) => n.id)).toEqual(['pc3']);
      expect(page.hasNextPage).toBe(true);
    });
  });
});
