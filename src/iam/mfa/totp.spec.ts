import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, timeStep, totp } from './totp';

// RFC 6238 appendix B, SHA-1 rows: the seed is the ASCII string "12345678901234567890", codes have 8 digits.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 test vector at T=%i', (seconds, expected) => {
    expect(totp(RFC_SEED, seconds * 1000, 8)).toBe(expected);
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 9].map((counter) => hotp(RFC_SEED, counter))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('uses 30-second steps', () => {
    expect(timeStep(59_999)).toBe(1);
    expect(timeStep(60_000)).toBe(2);
  });

  describe('matchTotp', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    const codeAt = (s: number) => hotp(RFC_SEED, s);

    it('accepts the current code and one step either side, returning the step', () => {
      expect(matchTotp(RFC_SEED, codeAt(step), now, null)).toBe(step);
      expect(matchTotp(RFC_SEED, codeAt(step - 1), now, null)).toBe(step - 1);
      expect(matchTotp(RFC_SEED, codeAt(step + 1), now, null)).toBe(step + 1);
    });

    it('rejects codes outside the window', () => {
      expect(matchTotp(RFC_SEED, codeAt(step - 2), now, null)).toBeNull();
      expect(matchTotp(RFC_SEED, codeAt(step + 2), now, null)).toBeNull();
    });

    it('rejects a replay of an already used step, and anything older', () => {
      expect(matchTotp(RFC_SEED, codeAt(step), now, step)).toBeNull();
      expect(matchTotp(RFC_SEED, codeAt(step - 1), now, step)).toBeNull();
      expect(matchTotp(RFC_SEED, codeAt(step + 1), now, step)).toBe(step + 1);
    });

    it('rejects malformed codes', () => {
      for (const code of ['', '12345', '1234567', 'abcdef', ` ${codeAt(step)}`]) {
        expect(matchTotp(RFC_SEED, code, now, null)).toBeNull();
      }
    });
  });

  describe('base32', () => {
    it('encodes and decodes the RFC 4648 vectors without padding', () => {
      expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
      expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
      expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    });

    it('round-trips a 20-byte secret', () => {
      const secret = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
      expect(base32Decode(base32Encode(secret))).toEqual(secret);
    });

    it('rejects characters outside the alphabet', () => {
      expect(() => base32Decode('ABC1')).toThrow('Invalid base32 character "1"');
    });
  });

  it('builds an otpauth URI with the issuer, account and parameters', () => {
    expect(otpauthUri('Ama Shop', 'ama@example.com', 'MZXW6YTBOI')).toBe(
      'otpauth://totp/Ama%20Shop:ama%40example.com?secret=MZXW6YTBOI&issuer=Ama%20Shop&algorithm=SHA1&digits=6&period=30',
    );
  });
});
