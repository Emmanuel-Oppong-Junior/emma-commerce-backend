import { SerialFormat } from '../../generated/prisma/client';

export const MAX_SERIAL_LENGTH = 64;

const FREE_TEXT_SERIAL = /^[A-Z0-9][A-Z0-9\-_./]*$/;
const IMEI = /^\d{15}$/;

export type NormalisedSerial = { ok: true; serial: string } | { ok: false; problem: string };

/** Luhn check over a string of digits (the last one is the check digit). */
export function isLuhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * The stored form of a serial typed or scanned by staff: spaces removed, upper case; an IMEI also loses its dashes and
 * must be 15 digits with a valid Luhn check digit. FREE_TEXT allows 1-64 letters, digits and - _ . / (starting with a
 * letter or digit).
 */
export function normaliseSerial(raw: string, format: SerialFormat): NormalisedSerial {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (format === SerialFormat.IMEI) {
    const imei = compact.replace(/-/g, '');
    if (!IMEI.test(imei)) return { ok: false, problem: `"${raw}" is not an IMEI: it needs exactly 15 digits` };
    if (!isLuhnValid(imei)) return { ok: false, problem: `"${raw}" is not a valid IMEI: its check digit is wrong` };
    return { ok: true, serial: imei };
  }
  if (compact.length === 0 || compact.length > MAX_SERIAL_LENGTH) {
    return { ok: false, problem: `A serial needs 1-${MAX_SERIAL_LENGTH} characters, got "${raw}"` };
  }
  if (!FREE_TEXT_SERIAL.test(compact)) {
    return { ok: false, problem: `"${raw}" may only contain letters, digits and - _ . /` };
  }
  return { ok: true, serial: compact };
}

export type NormalisedSerials = { ok: true; serials: string[] } | { ok: false; problems: string[] };

/** Normalises every serial; refuses invalid ones and serials given twice (after normalisation). */
export function normaliseSerials(raw: readonly string[], format: SerialFormat): NormalisedSerials {
  const problems: string[] = [];
  const serials: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const normalised = normaliseSerial(value, format);
    if (!normalised.ok) {
      problems.push(normalised.problem);
      continue;
    }
    if (seen.has(normalised.serial)) {
      problems.push(`Serial "${normalised.serial}" is given more than once`);
      continue;
    }
    seen.add(normalised.serial);
    serials.push(normalised.serial);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, serials };
}
