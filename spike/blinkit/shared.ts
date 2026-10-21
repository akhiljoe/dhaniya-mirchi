// Shared types + helpers for the Blinkit ingestion spike.

export const ORDER_HISTORY_URL = 'https://blinkit.com/v1/layout/order_history';
export const SESSION_FILE = 'session.json';

// Everything the replay step needs to reconstruct the page's own request.
export interface CapturedSession {
  capturedAt: string; // ISO
  orderHistory: {
    url: string;
    method: string;
    // The exact request the logged-in page sent, headers and body verbatim.
    requestHeaders: Record<string, string>;
    postData: string | null;
    responseStatus: number;
  };
  // Cookies from the browser context, for a cookie-only replay scenario.
  cookieHeader: string;
  // Location/device bits Blinkit attaches; needed to probe device binding.
  storage: Record<string, string | null>;
  // Decoded token metadata (never the token itself is the point — but this is
  // the author's own machine and own account, so the raw values live in
  // session.json which is gitignored).
  tokenMeta: TokenMeta[];
}

export interface TokenMeta {
  where: string; // e.g. "header:auth_key" | "localStorage:authKey"
  jwt: boolean;
  claims?: Record<string, unknown>;
  lifetimeHours?: number;
  expiresAt?: string;
  issuedAt?: string;
}

// Decode a JWT's payload for expiry/claims. Returns { jwt:false } for opaque
// tokens. Does not verify — we only want lifetime + binding claims.
export function decodeJwtMeta(where: string, value: string | null): TokenMeta {
  if (!value) return { where, jwt: false };
  const t = value.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
  if (!/^ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\./.test(t)) return { where, jwt: false };
  try {
    const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    const meta: TokenMeta = { where, jwt: true, claims: {} };
    for (const k of ['exp', 'iat', 'nbf', 'iss', 'aud', 'sub', 'token_type', 'device_id', 'deviceId', 'user_id']) {
      if (k in payload) (meta.claims as Record<string, unknown>)[k] = payload[k];
    }
    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') {
      meta.lifetimeHours = Math.round((payload.exp - payload.iat) / 3600);
    }
    if (typeof payload.exp === 'number') meta.expiresAt = new Date(payload.exp * 1000).toISOString();
    if (typeof payload.iat === 'number') meta.issuedAt = new Date(payload.iat * 1000).toISOString();
    return meta;
  } catch {
    return { where, jwt: false };
  }
}

// Header names that a raw HTTP client cannot / should not resend.
const STRIP = new Set([
  'host', 'connection', 'content-length', 'accept-encoding',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
]);

export function replayableHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(':')) continue; // HTTP/2 pseudo-headers
    if (STRIP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
