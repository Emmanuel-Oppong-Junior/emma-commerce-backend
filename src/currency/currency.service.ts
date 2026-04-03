import { Injectable } from '@nestjs/common';

const RATES: Record<string, number> = {
  GHS: 1,
  USD: 0.068,
  EUR: 0.063,
  GBP: 0.053,
  NGN: 110,
};

@Injectable()
export class CurrencyService {
  convert(amount: number, fromCurrency: string, toCurrency: string): number {
    const fromRate = RATES[fromCurrency] ?? 1;
    const toRate = RATES[toCurrency] ?? 1;
    const amountInBase = amount / fromRate;
    return Math.round(amountInBase * toRate * 100) / 100;
  }

  getSupportedCurrencies(): string[] {
    return Object.keys(RATES);
  }
}
