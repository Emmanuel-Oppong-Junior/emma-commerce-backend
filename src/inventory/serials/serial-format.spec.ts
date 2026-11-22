import { SerialFormat } from '../../generated/prisma/client';
import { isLuhnValid, normaliseSerial, normaliseSerials } from './serial-format';

describe('serial format', () => {
  describe('isLuhnValid', () => {
    it('accepts digits whose Luhn sum is a multiple of 10', () => {
      expect(isLuhnValid('490154203237518')).toBe(true);
      expect(isLuhnValid('79927398713')).toBe(true);
    });

    it('refuses a wrong check digit', () => {
      expect(isLuhnValid('490154203237517')).toBe(false);
      expect(isLuhnValid('79927398710')).toBe(false);
    });
  });

  describe('IMEI', () => {
    it('stores 15 digits without spaces or dashes', () => {
      expect(normaliseSerial(' 49-015420-323751-8 ', SerialFormat.IMEI)).toEqual({
        ok: true,
        serial: '490154203237518',
      });
      expect(normaliseSerial('4901 5420 3237 518', SerialFormat.IMEI)).toEqual({ ok: true, serial: '490154203237518' });
    });

    it('refuses anything but 15 digits', () => {
      for (const raw of ['49015420323751', '4901542032375189', '49015420323751A', '']) {
        const result = normaliseSerial(raw, SerialFormat.IMEI);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.problem).toContain('15 digits');
      }
    });

    it('refuses a bad check digit', () => {
      const result = normaliseSerial('490154203237519', SerialFormat.IMEI);
      expect(result).toEqual({ ok: false, problem: expect.stringContaining('check digit') });
    });
  });

  describe('FREE_TEXT', () => {
    it('stores upper case without whitespace', () => {
      expect(normaliseSerial('  sn-001 a/b.c_d ', SerialFormat.FREE_TEXT)).toEqual({
        ok: true,
        serial: 'SN-001A/B.C_D',
      });
    });

    it('refuses empty, too long, or other characters, and a leading symbol', () => {
      for (const raw of ['   ', 'X'.repeat(65), 'SN#1', 'ÄB1', '-SN1']) {
        expect(normaliseSerial(raw, SerialFormat.FREE_TEXT).ok).toBe(false);
      }
      expect(normaliseSerial('X'.repeat(64), SerialFormat.FREE_TEXT).ok).toBe(true);
    });
  });

  describe('normaliseSerials', () => {
    it('returns the stored serials in order', () => {
      expect(normaliseSerials(['a1', 'B2'], SerialFormat.FREE_TEXT)).toEqual({ ok: true, serials: ['A1', 'B2'] });
    });

    it('refuses a serial given twice once normalised, and lists every problem', () => {
      const result = normaliseSerials(['a1', ' A1', 'bad#', 'b2'], SerialFormat.FREE_TEXT);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.problems).toEqual([
        'Serial "A1" is given more than once',
        expect.stringContaining('bad#'),
      ]);
    });
  });
});
