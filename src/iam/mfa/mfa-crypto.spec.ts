import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  openSecret,
  parseMfaKey,
  RECOVERY_CODE_COUNT,
  sealSecret,
} from './mfa-crypto';

const KEY = parseMfaKey('0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0');
const OTHER_KEY = parseMfaKey('a'.repeat(64));

// The first base64url character carries the top bits of the first byte (the last one can be padding bits only).
function flipFirstChar(part: string): string {
  return (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
}

describe('MFA secret encryption (AES-256-GCM)', () => {
  it('round-trips a secret for the same user', () => {
    const sealed = sealSecret(KEY, 'JBSWY3DPEHPK3PXP', 'user-1');

    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(KEY, sealed, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV, so the same secret never encrypts the same way twice', () => {
    expect(sealSecret(KEY, 'JBSWY3DPEHPK3PXP', 'user-1')).not.toBe(sealSecret(KEY, 'JBSWY3DPEHPK3PXP', 'user-1'));
  });

  it.each([
    ['the ciphertext', 3],
    ['the auth tag', 2],
    ['the IV', 1],
  ])('detects tampering with %s', (_part, index) => {
    const parts = sealSecret(KEY, 'JBSWY3DPEHPK3PXP', 'user-1').split('.');
    parts[index] = flipFirstChar(parts[index]);

    expect(() => openSecret(KEY, parts.join('.'), 'user-1')).toThrow();
  });

  it("refuses a ciphertext moved to another user's row", () => {
    const sealed = sealSecret(KEY, 'JBSWY3DPEHPK3PXP', 'user-1');

    expect(() => openSecret(KEY, sealed, 'user-2')).toThrow();
  });

  it('refuses a ciphertext sealed with another key', () => {
    expect(() => openSecret(OTHER_KEY, sealSecret(KEY, 'S', 'user-1'), 'user-1')).toThrow();
  });

  it('rejects a malformed or unknown-version value', () => {
    expect(() => openSecret(KEY, 'plaintext-secret', 'user-1')).toThrow('Unsupported or malformed');
    expect(() => openSecret(KEY, 'v2.a.b.c', 'user-1')).toThrow('Unsupported or malformed');
  });

  it('accepts only a 64-character hex key', () => {
    expect(() => parseMfaKey('abc')).toThrow('MFA_ENCRYPTION_KEY must be 64 hexadecimal characters');
    expect(() => parseMfaKey('z'.repeat(64))).toThrow();
    expect(parseMfaKey('A'.repeat(64))).toHaveLength(32);
  });
});

describe('recovery codes', () => {
  it(`generates ${RECOVERY_CODE_COUNT} distinct codes of 10 characters`, () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
  });

  it('hashes per user and key, ignoring case, spaces and dashes', () => {
    const hash = hashRecoveryCode(KEY, 'user-1', 'abcde-fghij');

    expect(hashRecoveryCode(KEY, 'user-1', 'ABCDE FGHIJ')).toBe(hash);
    expect(hashRecoveryCode(KEY, 'user-2', 'abcde-fghij')).not.toBe(hash);
    expect(hashRecoveryCode(OTHER_KEY, 'user-1', 'abcde-fghij')).not.toBe(hash);
    expect(hash).not.toContain('abcde');
  });

  it('normalizes typed codes', () => {
    expect(normalizeRecoveryCode(' AbCdE-fGhIj ')).toBe('abcdefghij');
  });
});
