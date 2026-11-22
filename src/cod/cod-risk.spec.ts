import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertValidCodRiskSettings,
  CodCheckoutFacts,
  codRefusal,
  codRefusalError,
  CodUnavailableReason as R,
} from './cod-risk';

const settings = { maxOpenOrdersPerPhone: 2, maxOrderTotal: new Prisma.Decimal('2000') };

const passing: CodCheckoutFacts = {
  storeOffersCod: true,
  verifiedPhone: '+233244123456',
  blacklisted: false,
  zoneCodEnabled: true,
  openCodOrders: 1,
  grandTotal: new Prisma.Decimal('2000'),
};

describe('codRefusal', () => {
  it('allows a checkout that passes every gate (the cap itself is allowed)', () => {
    expect(codRefusal(passing, settings)).toBeNull();
  });

  it.each<[string, Partial<CodCheckoutFacts>, R]>([
    ['the store does not offer it', { storeOffersCod: false }, R.NOT_OFFERED],
    ['the phone is not verified', { verifiedPhone: null }, R.PHONE_NOT_VERIFIED],
    ['a phone or the address is blacklisted', { blacklisted: true }, R.BLOCKED],
    ['the delivery zone does not take it', { zoneCodEnabled: false }, R.SHIPPING_ZONE_EXCLUDED],
    ['the phone has the most open COD orders allowed', { openCodOrders: 2 }, R.OPEN_ORDER_LIMIT],
    ['the grand total is above the cap', { grandTotal: new Prisma.Decimal('2000.01') }, R.ORDER_TOTAL_ABOVE_CAP],
  ])('refuses when %s', (_case, change, reason) => {
    expect(codRefusal({ ...passing, ...change }, settings)).toBe(reason);
  });

  it('applies no zone gate to pickup', () => {
    expect(codRefusal({ ...passing, zoneCodEnabled: null }, settings)).toBeNull();
  });

  it('names the first gate in order when several hold', () => {
    const all = { storeOffersCod: true, verifiedPhone: null, blacklisted: true, zoneCodEnabled: false };
    expect(codRefusal({ ...passing, ...all }, settings)).toBe(R.PHONE_NOT_VERIFIED);
    expect(codRefusal({ ...passing, blacklisted: true, openCodOrders: 9 }, settings)).toBe(R.BLOCKED);
  });
});

describe('codRefusalError', () => {
  const extensionsOf = (error: BadRequestException) =>
    (error.getResponse() as { extensions: Record<string, unknown> }).extensions;

  it('answers an unverified phone with PHONE_NOT_VERIFIED', () => {
    expect(extensionsOf(codRefusalError(R.PHONE_NOT_VERIFIED))).toEqual({ reason: 'PHONE_NOT_VERIFIED' });
  });

  it.each([R.BLOCKED, R.SHIPPING_ZONE_EXCLUDED, R.OPEN_ORDER_LIMIT, R.ORDER_TOTAL_ABOVE_CAP, R.NOT_OFFERED])(
    'answers %s with COD_NOT_AVAILABLE and the gate',
    (gate) => {
      expect(extensionsOf(codRefusalError(gate))).toEqual({ reason: 'COD_NOT_AVAILABLE', codReason: gate });
    },
  );
});

describe('assertValidCodRiskSettings', () => {
  it('accepts values in range and a partial update', () => {
    expect(() =>
      assertValidCodRiskSettings({ maxOpenOrdersPerPhone: 1, maxOrderTotal: new Prisma.Decimal('0.01') }),
    ).not.toThrow();
    expect(() => assertValidCodRiskSettings({ maxOpenOrdersPerPhone: 100 })).not.toThrow();
    expect(() => assertValidCodRiskSettings({})).not.toThrow();
  });

  it.each([0, 101, 1.5, -1])('refuses %p open orders', (value) => {
    expect(() => assertValidCodRiskSettings({ maxOpenOrdersPerPhone: value })).toThrow(
      'maxOpenOrdersPerPhone must be a whole number from 1 to 100',
    );
  });

  it.each(['0', '-5', '10.001'])('refuses a cap of %p', (value) => {
    expect(() => assertValidCodRiskSettings({ maxOrderTotal: new Prisma.Decimal(value) })).toThrow(
      'maxOrderTotal must be above 0 with at most 2 decimals',
    );
  });
});
