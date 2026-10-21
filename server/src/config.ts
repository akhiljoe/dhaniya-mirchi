// Configuration, read once at startup from the environment and validated.
//
// A broken setup is refused here, with every problem named at once, rather
// than surfacing later as something that looks unrelated — the sign-in lessons
// from an earlier project (design §14.3): an http issuer breaks token validation with
// an "invalid token" error; a half-configured client fails silently; a secret
// saved on Windows carries an invisible \r.
import { ANTHROPIC_DEFAULT_MODEL, DEFAULT_API_PORT, OPENAI_DEFAULT_MODEL, VAPID_PRIVATE_KEY_BYTES, VAPID_PUBLIC_KEY_BYTES } from './constants.js';
import { publicKeyOf, VaultError } from './vault.js';

export class ConfigError extends Error {}

export interface AuthConfig {
  enabled: boolean;
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  clientId: string;
  clientSecret: string;
  // One per address the site is opened on (localhost, a dev tunnel, the
  // real domain). A sign-in returns to the one matching its address.
  redirectUris: string[];
  identityProvider: string; // '' = Cognito's hosted form; 'Google' = straight to Google
  returnUrl: string;
  secureCookies: boolean;
  // Ask for the `profile` scope so the ID token carries the Google photo.
  // Off by default: the app client must allow Profile first, or Cognito
  // rejects the whole sign-in with invalid_scope.
  profilePicture: boolean;
  // Who may sign in at all: verified emails, lowercased. Anyone else is turned
  // away at the callback, and an existing session stops working the moment its
  // email leaves the list. Required when sign-in is on: the site is public
  // (a tunnel, the real domain) and any Google account can reach Cognito.
  allowedEmails: string[];
}

// The vault (design §14.3). The api needs only the public key (it seals);
// the worker also needs the private keys (it opens) — current first, then any
// older ones kept for rotation. Absent public key = connecting grocery apps is
// unavailable on this server.
export interface VaultConfig {
  publicKey: string | null;
  privateKeys: string[];
}

// Web Push (design §13.1): self-generated VAPID keys. The api needs only the
// public key (the browser subscribes with it); the worker also signs with the
// private key and names a contact (`mailto:` or `https:`) push services can
// reach. Absent public key = notifications are unavailable on this server.
export interface PushConfig {
  publicKey: string | null;
  privateKey: string | null;
  subject: string | null;
}

// The AI layer (design §7.8, §19). `provider` answers on our key, within each
// household's free allowance: 'openai' for users, 'anthropic' (Claude) for our
// own testing, 'off' for none. A household's own OpenAI key works either way.
// Only the worker needs the keys; the api needs only the provider (to say
// whether the allowance exists).
export interface AiConfig {
  // The site-wide switch (guardrails, design §7.8): false stops every AI
  // call, households' own keys included. The forms keep working.
  enabled: boolean;
  provider: 'off' | 'openai' | 'anthropic';
  openaiKey: string | null;
  openaiModel: string;
  anthropicKey: string | null;
  anthropicModel: string;
}

export interface Config {
  production: boolean;
  port: number;
  databaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: AuthConfig;
  vault: VaultConfig;
  push: PushConfig;
  ai: AiConfig;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const str = (name: string): string => env[name]?.trim() ?? '';

  const bool = (name: string, fallback: boolean): boolean => {
    const v = str(name).toLowerCase();
    if (v === '') return fallback;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    problems.push(`${name} must be true or false, got "${env[name]}"`);
    return fallback;
  };

  // Secrets are checked raw (not trimmed): a trailing \r or space is the bug.
  const secret = (name: string): string => {
    const raw = env[name] ?? '';
    if (/[\r\n]|^\s|\s$/.test(raw)) problems.push(`${name} has leading/trailing whitespace or a line break — regenerate it with printf, not an editor`);
    return raw.trim();
  };

  const production = str('NODE_ENV') === 'production';

  const portRaw = str('PORT');
  let port = DEFAULT_API_PORT;
  if (portRaw !== '') {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push(`PORT must be a port number, got "${portRaw}"`);
  }

  const databaseUrl = str('DATABASE_URL');
  if (databaseUrl === '') problems.push('DATABASE_URL is required');

  const level = (str('LOG_LEVEL') || 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(level)) problems.push(`LOG_LEVEL must be debug|info|warn|error`);

  const enabled = bool('AUTH_ENABLED', false);
  const auth: AuthConfig = {
    enabled,
    issuer: str('AUTH_ISSUER'),
    authorizeUrl: str('AUTH_AUTHORIZE_URL'),
    tokenUrl: str('AUTH_TOKEN_URL'),
    jwksUrl: str('AUTH_JWKS_URL'),
    clientId: str('AUTH_CLIENT_ID'),
    clientSecret: secret('AUTH_CLIENT_SECRET'),
    redirectUris: str('AUTH_REDIRECT_URI').split(',').map((u) => u.trim()).filter(Boolean),
    identityProvider: str('AUTH_IDENTITY_PROVIDER'),
    returnUrl: str('AUTH_RETURN_URL') || '/',
    secureCookies: bool('AUTH_SECURE_COOKIES', true),
    profilePicture: bool('AUTH_PROFILE_PICTURE', false),
    allowedEmails: str('AUTH_ALLOWED_EMAILS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  };

  if (enabled) {
    const required: [string, string][] = [
      ['AUTH_ISSUER', auth.issuer],
      ['AUTH_AUTHORIZE_URL', auth.authorizeUrl],
      ['AUTH_TOKEN_URL', auth.tokenUrl],
      ['AUTH_JWKS_URL', auth.jwksUrl],
      ['AUTH_CLIENT_ID', auth.clientId],
      ['AUTH_REDIRECT_URI', auth.redirectUris.join(',')],
      ['AUTH_ALLOWED_EMAILS', auth.allowedEmails.join(',')],
    ];
    for (const [name, value] of required) if (value === '') problems.push(`${name} is required when AUTH_ENABLED=true`);

    // The issuer and JWKS name the user pool; validation trusts them, so they
    // must be https. (The authorize/token URLs name the hosted domain — a
    // different host, see design §14.3.)
    for (const [name, value] of [['AUTH_ISSUER', auth.issuer], ['AUTH_JWKS_URL', auth.jwksUrl]] as const) {
      if (value !== '' && !value.startsWith('https://')) problems.push(`${name} must be https`);
    }
    // Cognito accepts a plain-http callback only on loopback; anything else
    // it rejects at sign-in with an unhelpful error page.
    for (const u of auth.redirectUris) {
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) {
        problems.push(`AUTH_REDIRECT_URI ${u} must be https, or http only on localhost (Cognito's rule)`);
      }
    }
    for (const e of auth.allowedEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) problems.push(`AUTH_ALLOWED_EMAILS: "${e}" is not an email address`);
    }
    if (production) {
      if (!auth.secureCookies) problems.push('AUTH_SECURE_COOKIES=false is not allowed in production');
      if (auth.redirectUris.some((u) => !u.startsWith('https://'))) {
        problems.push('AUTH_REDIRECT_URI must be https in production');
      }
    }
  }

  const vaultPublic = secret('VAULT_PUBLIC_KEY');
  const vaultPrivate = secret('VAULT_PRIVATE_KEYS').split(',').map((k) => k.trim()).filter(Boolean);
  const vault: VaultConfig = { publicKey: vaultPublic || null, privateKeys: vaultPrivate };
  if (vaultPublic && Buffer.from(vaultPublic, 'base64url').length !== 32) {
    problems.push('VAULT_PUBLIC_KEY is not a vault public key — generate one with `npm run vault:keygen`');
  } else if (vaultPrivate.length) {
    if (!vaultPublic) problems.push('VAULT_PRIVATE_KEYS is set but VAULT_PUBLIC_KEY is not');
    else {
      try {
        if (publicKeyOf(vaultPrivate[0]) !== vaultPublic) {
          problems.push('VAULT_PRIVATE_KEYS: the first (current) key does not match VAULT_PUBLIC_KEY');
        }
        vaultPrivate.slice(1).forEach((k) => publicKeyOf(k));
      } catch (err) {
        if (!(err instanceof VaultError)) throw err;
        problems.push('VAULT_PRIVATE_KEYS contains a malformed key');
      }
    }
  }

  const pushPublic = secret('VAPID_PUBLIC_KEY');
  const pushPrivate = secret('VAPID_PRIVATE_KEY');
  const pushSubject = str('VAPID_SUBJECT');
  const push: PushConfig = { publicKey: pushPublic || null, privateKey: pushPrivate || null, subject: pushSubject || null };
  if (pushPublic && Buffer.from(pushPublic, 'base64url').length !== VAPID_PUBLIC_KEY_BYTES) {
    problems.push('VAPID_PUBLIC_KEY is not a VAPID public key — generate a pair with `npx web-push generate-vapid-keys`');
  }
  if (pushPrivate) {
    if (!pushPublic) problems.push('VAPID_PRIVATE_KEY is set but VAPID_PUBLIC_KEY is not');
    if (Buffer.from(pushPrivate, 'base64url').length !== VAPID_PRIVATE_KEY_BYTES) problems.push('VAPID_PRIVATE_KEY is not a VAPID private key');
    if (!/^(mailto:|https:\/\/)/.test(pushSubject)) {
      problems.push('VAPID_SUBJECT must be a mailto: or https:// contact when VAPID_PRIVATE_KEY is set');
    }
  }

  const provider = (str('LLM_PROVIDER') || 'off') as AiConfig['provider'];
  if (!['off', 'openai', 'anthropic'].includes(provider)) problems.push('LLM_PROVIDER must be off, openai or anthropic');
  const ai: AiConfig = {
    enabled: bool('AI_ENABLED', true),
    provider,
    openaiKey: secret('OPENAI_API_KEY') || null,
    openaiModel: str('OPENAI_MODEL') || OPENAI_DEFAULT_MODEL,
    anthropicKey: secret('ANTHROPIC_API_KEY') || null,
    anthropicModel: str('ANTHROPIC_MODEL') || ANTHROPIC_DEFAULT_MODEL,
  };

  if (problems.length) throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  return { production, port, databaseUrl, logLevel: level, auth, vault, push, ai };
}
