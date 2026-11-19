import { Decimal } from '@prisma/client/runtime/client';
import { MoneyResolver } from './money.resolver';
import { Money } from '../commons/money/money';
import { StoreService } from './store.service';

describe('MoneyResolver', () => {
  const storeService = { getCurrency: jest.fn() };
  const resolver = new MoneyResolver(storeService as unknown as StoreService);

  beforeEach(() => {
    storeService.getCurrency.mockReset().mockResolvedValue('GHS');
  });

  it('shows a stored amount with exactly 2 decimal places', () => {
    expect(resolver.amount(new Decimal('480'))).toBe('480.00');
    expect(resolver.amount(new Decimal('19.9'))).toBe('19.90');
    expect(resolver.amount(new Decimal('0'))).toBe('0.00');
  });

  it('rounds an amount with more decimal places half-up', () => {
    expect(resolver.amount(new Decimal('2.675'))).toBe('2.68');
  });

  it('shows a Money value in its own currency', () => {
    const money = Money.of('12.5', 'USD');

    expect(resolver.amount(money)).toBe('12.50');
    expect(resolver.currency(money, {})).toBe('USD');
    expect(storeService.getCurrency).not.toHaveBeenCalled();
  });

  it('labels a stored amount with the store currency, read once per request', async () => {
    const request = {};

    await expect(resolver.currency(new Decimal(1), request)).resolves.toBe('GHS');
    await expect(resolver.currency(new Decimal(2), request)).resolves.toBe('GHS');
    expect(storeService.getCurrency).toHaveBeenCalledTimes(1);

    await resolver.currency(new Decimal(3), {});
    expect(storeService.getCurrency).toHaveBeenCalledTimes(2);
  });
});
