import { BadRequestException } from '@nestjs/common';
import { CodBlacklistKind } from '../generated/prisma/client';
import { normalisePhoneSubject } from '../fraud/velocity-rules';

// Stored blacklist keys use this form (trim, single spaces, lower case); changing it would orphan existing entries.
function normaliseCity(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface CodBlacklistKey {
  kind: CodBlacklistKind;
  value: string;
}

/** What staff blacklist: exactly one of a phone, a GhanaPost GPS code, or a street with its city. */
export interface CodBlacklistTarget {
  phone?: string | null;
  ghanaPostGps?: string | null;
  street?: string | null;
  city?: string | null;
}

export interface DeliveryAddressFacts {
  phone?: string | null;
  ghanaPostGps?: string | null;
  street: string;
  city: string;
}

/** GA-183-8164, ga 183 8164 and GA1838164 are one code. */
export function normaliseGhanaPostGps(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * "12 Oxford St., Osu" and "12 oxford st osu" are one street: lower case, punctuation and repeated spaces dropped.
 * Spelling variants ("Street" and "St") still differ; the GPS code is the reliable key.
 */
export function normaliseStreet(street: string): string {
  return street
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function streetKey(street: string, city: string): string {
  return `${normaliseStreet(street)}|${normaliseCity(city)}`;
}

/** The normalised entry for what staff entered; BAD_REQUEST unless exactly one form is given and it is not blank. */
export function blacklistKeyOf(target: CodBlacklistTarget): CodBlacklistKey {
  const forms = [target.phone, target.ghanaPostGps, target.street ?? target.city].filter(
    (value) => value !== undefined && value !== null,
  );
  if (forms.length !== 1) {
    throw new BadRequestException('Give exactly one of phone, ghanaPostGps, or street with city');
  }
  if (target.phone != null) {
    const value = normalisePhoneSubject(target.phone);
    if (!value) throw new BadRequestException('phone must contain digits');
    return { kind: CodBlacklistKind.PHONE, value };
  }
  if (target.ghanaPostGps != null) {
    const value = normaliseGhanaPostGps(target.ghanaPostGps);
    if (!value) throw new BadRequestException('ghanaPostGps must contain letters or digits');
    return { kind: CodBlacklistKind.GHANA_POST_GPS, value };
  }
  if (!target.street?.trim() || !target.city?.trim() || !normaliseStreet(target.street)) {
    throw new BadRequestException('street and city are both required to blacklist an address');
  }
  return { kind: CodBlacklistKind.STREET_ADDRESS, value: streetKey(target.street, target.city) };
}

/** Every blacklist key a checkout matches against: its phones, and the delivery address (none for pickup). */
export function checkoutBlacklistKeys(phones: (string | null | undefined)[], address: DeliveryAddressFacts | null) {
  const keys: CodBlacklistKey[] = [];
  for (const phone of [...phones, address?.phone]) {
    const value = phone ? normalisePhoneSubject(phone) : '';
    if (value) keys.push({ kind: CodBlacklistKind.PHONE, value });
  }
  if (address) {
    const gps = address.ghanaPostGps ? normaliseGhanaPostGps(address.ghanaPostGps) : '';
    if (gps) keys.push({ kind: CodBlacklistKind.GHANA_POST_GPS, value: gps });
    keys.push({ kind: CodBlacklistKind.STREET_ADDRESS, value: streetKey(address.street, address.city) });
  }
  return keys;
}
