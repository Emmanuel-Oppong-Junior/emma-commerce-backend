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
  /**
   * Converts an amount from one supported currency to another using fixed exchange rates.
   * @param amount - The monetary amount to convert.
   * @param fromCurrency - The ISO currency code of the source currency (e.g., "GHS").
   * @param toCurrency - The ISO currency code of the target currency (e.g., "USD").
   * @returns The converted amount rounded to two decimal places.
   */
  convert(amount: number, fromCurrency: string, toCurrency: string): number {
    const fromRate = RATES[fromCurrency] ?? 1;
    const toRate = RATES[toCurrency] ?? 1;
    const amountInBase = amount / fromRate;
    return Math.round(amountInBase * toRate * 100) / 100;
  }

  /**
   * Returns the list of currency codes supported by this service.
   * @returns Array of ISO currency code strings.
   */
  getSupportedCurrencies(): string[] {
    return Object.keys(RATES);
  }
}
