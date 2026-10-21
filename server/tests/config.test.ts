// The config loader refuses a broken setup at startup, loudly, instead of
// letting it fail later in a way that looks like something else (design §14.3).
import { describe, expect, it } from 'vitest';
import webpush from 'web-push';

import { ConfigError, loadConfig } from '../src/config.js';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5435/db' };

const AUTH = {
  AUTH_ENABLED: 'true',
  AUTH_ISSUER: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test',
  AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
  AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
  AUTH_JWKS_URL: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test/.well-known/jwks.json',
  AUTH_CLIENT_ID: 'client_abc',
  AUTH_CLIENT_SECRET: 'secret_abc',
  AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback',
  AUTH_ALLOWED_EMAILS: 'me@example.com',
};

describe('loadConfig', () => {
  it('requires a database', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('starts with sign-in off when AUTH_ENABLED is not set', () => {
    const c = loadConfig(BASE);
    expect(c.auth.enabled).toBe(false);
    expect(c.production).toBe(false);
  });

  it('names every missing sign-in variable at once, not one per restart', () => {
    let message = '';
    try {
      loadConfig({ ...BASE, AUTH_ENABLED: 'true' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ['AUTH_ISSUER', 'AUTH_AUTHORIZE_URL', 'AUTH_TOKEN_URL', 'AUTH_JWKS_URL', 'AUTH_CLIENT_ID', 'AUTH_REDIRECT_URI', 'AUTH_ALLOWED_EMAILS']) {
      expect(message).toContain(name);
    }
  });

  it('accepts a complete sign-in configuration', () => {
    const c = loadConfig({ ...BASE, ...AUTH });
    expect(c.auth.enabled).toBe(true);
    expect(c.auth.clientId).toBe('client_abc');
    expect(c.auth.identityProvider).toBe('');
    expect(c.auth.returnUrl).toBe('/');
    expect(c.auth.secureCookies).toBe(true); // secure unless explicitly turned off
  });

  it('reads the allowlist trimmed and lowercased, and refuses sign-in without one', () => {
    const c = loadConfig({ ...BASE, ...AUTH, AUTH_ALLOWED_EMAILS: ' Me@Example.com , friend@gmail.com,' });
    expect(c.auth.allowedEmails).toEqual(['me@example.com', 'friend@gmail.com']);
    // No list would let any Google account in: refused, not treated as "everyone".
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_ALLOWED_EMAILS: '' })).toThrow(/AUTH_ALLOWED_EMAILS is required/);
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_ALLOWED_EMAILS: 'me@example.com,not an email' })).toThrow(
      /"not an email" is not an email address/,
    );
  });

  it('refuses a non-https issuer or JWKS URL — token validation depends on them', () => {
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_ISSUER: 'http://cognito.example/pool' })).toThrow(/AUTH_ISSUER/);
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_JWKS_URL: 'http://x/jwks.json' })).toThrow(/AUTH_JWKS_URL/);
  });

  it('refuses insecure cookies in production', () => {
    expect(() => loadConfig({ ...BASE, ...AUTH, NODE_ENV: 'production', AUTH_SECURE_COOKIES: 'false' })).toThrow(
      /AUTH_SECURE_COOKIES/,
    );
    // Locally it is allowed — the dev stack is plain http on localhost.
    expect(loadConfig({ ...BASE, ...AUTH, AUTH_SECURE_COOKIES: 'false' }).auth.secureCookies).toBe(false);
  });

  it('refuses a plain-http redirect URI in production', () => {
    expect(() => loadConfig({ ...BASE, ...AUTH, NODE_ENV: 'production' })).toThrow(/AUTH_REDIRECT_URI/);
  });

  it('takes several redirect URIs — one per address the site is opened on', () => {
    const c = loadConfig({ ...BASE, ...AUTH, AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback, https://app.dev.example.com/auth/callback' });
    expect(c.auth.redirectUris).toEqual(['http://localhost:8100/auth/callback', 'https://app.dev.example.com/auth/callback']);
  });

  it('refuses a plain-http redirect URI that is not localhost — Cognito would reject it', () => {
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_REDIRECT_URI: 'http://192.168.0.106:8100/auth/callback' })).toThrow(
      /AUTH_REDIRECT_URI.*localhost/,
    );
  });

  it('refuses a secret with a stray carriage return (written on Windows)', () => {
    // A \r is invisible and silently breaks the Basic auth header.
    expect(() => loadConfig({ ...BASE, ...AUTH, AUTH_CLIENT_SECRET: 'secret_abc\r' })).toThrow(/AUTH_CLIENT_SECRET/);
  });

  it('rejects a boolean it cannot read instead of guessing', () => {
    expect(() => loadConfig({ ...BASE, AUTH_ENABLED: 'yes please' })).toThrow(/AUTH_ENABLED/);
  });

  it('reads the listen port, defaulting when absent', () => {
    expect(loadConfig(BASE).port).toBe(8080);
    expect(loadConfig({ ...BASE, PORT: '9000' }).port).toBe(9000);
    expect(() => loadConfig({ ...BASE, PORT: 'eighty' })).toThrow(/PORT/);
  });
});

describe('vault keys', () => {
  it('are optional, and absent means connecting grocery apps is unavailable', () => {
    const c = loadConfig(BASE);
    expect(c.vault).toEqual({ publicKey: null, privateKeys: [] });
  });

  it('accepts a matching public/private pair', async () => {
    const { generateVaultKeys } = await import('../src/vault.js');
    const k = generateVaultKeys();
    const c = loadConfig({ ...BASE, VAULT_PUBLIC_KEY: k.publicKey, VAULT_PRIVATE_KEYS: k.privateKey });
    expect(c.vault).toEqual({ publicKey: k.publicKey, privateKeys: [k.privateKey] });
  });

  it('accepts older private keys after the current one (rotation)', async () => {
    const { generateVaultKeys } = await import('../src/vault.js');
    const now = generateVaultKeys();
    const old = generateVaultKeys();
    const c = loadConfig({ ...BASE, VAULT_PUBLIC_KEY: now.publicKey, VAULT_PRIVATE_KEYS: `${now.privateKey},${old.privateKey}` });
    expect(c.vault.privateKeys).toEqual([now.privateKey, old.privateKey]);
  });

  it('refuses a private key that does not match the public key — caught at startup, not at first use', async () => {
    const { generateVaultKeys } = await import('../src/vault.js');
    const a = generateVaultKeys();
    const b = generateVaultKeys();
    expect(() => loadConfig({ ...BASE, VAULT_PUBLIC_KEY: a.publicKey, VAULT_PRIVATE_KEYS: b.privateKey })).toThrow(/VAULT_PRIVATE_KEYS/);
  });

  it('refuses a malformed key', () => {
    expect(() => loadConfig({ ...BASE, VAULT_PUBLIC_KEY: 'not-a-key' })).toThrow(/VAULT_PUBLIC_KEY/);
  });
});

describe('profile picture', () => {
  it('is off by default — asking for the profile scope before the app client allows it breaks sign-in', () => {
    expect(loadConfig({ ...BASE, ...AUTH }).auth.profilePicture).toBe(false);
    expect(loadConfig({ ...BASE, ...AUTH, AUTH_PROFILE_PICTURE: 'true' }).auth.profilePicture).toBe(true);
  });
});

describe('web push keys', () => {
  const keys = webpush.generateVAPIDKeys();

  it('are optional, and absent means notifications are unavailable', () => {
    expect(loadConfig(BASE).push).toEqual({ publicKey: null, privateKey: null, subject: null });
  });

  it('accept a VAPID pair with a contact subject', () => {
    const c = loadConfig({ ...BASE, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' });
    expect(c.push).toEqual({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:ops@example.com' });
  });

  it('let the api run with the public key only — it never sends', () => {
    expect(loadConfig({ ...BASE, VAPID_PUBLIC_KEY: keys.publicKey }).push.publicKey).toBe(keys.publicKey);
  });

  it('refuse a private key without its public key, or a missing or odd subject', () => {
    expect(() => loadConfig({ ...BASE, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:a@b.c' })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => loadConfig({ ...BASE, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey })).toThrow(/VAPID_SUBJECT/);
    expect(() =>
      loadConfig({ ...BASE, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'ops@example.com' }),
    ).toThrow(/VAPID_SUBJECT/);
  });

  it('refuse a key that is not a VAPID key — caught at startup, not at first send', () => {
    expect(() => loadConfig({ ...BASE, VAPID_PUBLIC_KEY: 'not-a-key' })).toThrow(/VAPID_PUBLIC_KEY/);
  });
});
