// The token vault (design §14.3, CLAUDE.md "Vendor tokens are secrets").
// Public-key sealing: the api holds only the public key, so it can seal a
// phone number or an OTP but can never open anything; only the worker holds
// the private key. Each sealed value is bound to its context (the row and
// field it lives in), so a ciphertext moved elsewhere refuses to open.
import { describe, expect, it } from 'vitest';

import { generateVaultKeys, openSealed, seal, VaultError, keyIdOf } from '../src/vault.js';

const keys = generateVaultKeys();
const CTX = 'vendor_connections:42:session';

describe('seal / open', () => {
  it('round-trips with the private key', () => {
    const sealed = seal(keys.publicKey, 'cookie=abc; token=xyz', CTX);
    expect(openSealed([keys.privateKey], sealed, CTX)).toBe('cookie=abc; token=xyz');
  });

  it('never contains the plaintext', () => {
    const sealed = seal(keys.publicKey, 'super-secret-session', CTX);
    expect(sealed).not.toContain('super-secret-session');
    expect(Buffer.from(sealed).toString('base64')).not.toContain(Buffer.from('super-secret-session').toString('base64'));
  });

  it('seals the same plaintext differently every time (fresh key + nonce)', () => {
    expect(seal(keys.publicKey, 'same', CTX)).not.toBe(seal(keys.publicKey, 'same', CTX));
  });

  it('names the key it was sealed for, so a rotated key can still open old values', () => {
    const sealed = seal(keys.publicKey, 'x', CTX);
    expect(sealed.startsWith(`v1.${keyIdOf(keys.publicKey)}.`)).toBe(true);
    const newer = generateVaultKeys();
    // Worker holds the new key first and the old one after it.
    expect(openSealed([newer.privateKey, keys.privateKey], sealed, CTX)).toBe('x');
  });

  it('refuses to open with the wrong private key', () => {
    const sealed = seal(keys.publicKey, 'x', CTX);
    expect(() => openSealed([generateVaultKeys().privateKey], sealed, CTX)).toThrow(VaultError);
  });

  it('refuses a value moved to another row or field (context is bound)', () => {
    const sealed = seal(keys.publicKey, 'x', CTX);
    expect(() => openSealed([keys.privateKey], sealed, 'vendor_connections:43:session')).toThrow(VaultError);
    expect(() => openSealed([keys.privateKey], sealed, 'connect_requests:42:otp')).toThrow(VaultError);
  });

  it('refuses any tampering', () => {
    const sealed = seal(keys.publicKey, 'hello', CTX);
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[5], 'base64url');
    ct[0] ^= 1;
    parts[5] = ct.toString('base64url');
    expect(() => openSealed([keys.privateKey], parts.join('.'), CTX)).toThrow(VaultError);
  });

  it('refuses malformed input without leaking it into the error', () => {
    for (const bad of ['', 'v1', 'v2.a.b.c.d.e', 'not-a-sealed-value']) {
      try {
        openSealed([keys.privateKey], bad, CTX);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        if (bad.length > 3) expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it('error messages never include the plaintext or the key', () => {
    const sealed = seal(keys.publicKey, 'PLAINTEXT-123', CTX);
    try {
      openSealed([generateVaultKeys().privateKey], sealed, CTX);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('PLAINTEXT-123');
      expect(msg).not.toContain(keys.privateKey);
    }
  });
});

describe('keys', () => {
  it('are base64url X25519 keys, distinct each time', () => {
    const a = generateVaultKeys();
    const b = generateVaultKeys();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(32);
    expect(Buffer.from(a.privateKey, 'base64url')).toHaveLength(32);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => seal('c2hvcnQ', 'x', CTX)).toThrow(VaultError);
    expect(() => openSealed(['c2hvcnQ'], seal(keys.publicKey, 'x', CTX), CTX)).toThrow(VaultError);
  });
});
