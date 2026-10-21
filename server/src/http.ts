// Small HTTP helpers on node:http — no framework (the same choice an earlier project
// made: fewer dependencies, nothing hidden between a request and its handler).
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number; // 0 clears the cookie
  secure: boolean;
}

// Always HttpOnly, Path=/ and SameSite=Lax: Lax so the cookie survives the
// provider's cross-site redirect back to /auth/callback (Strict would drop it
// and break exactly the sign-ins that completed). `__Host-` names require
// Secure + Path=/ + no Domain, which this satisfies.
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${opts.maxAgeSeconds}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export function noContent(res: ServerResponse, cookies: string[] = []): void {
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Read a JSON request body. Only `application/json` is accepted: a cross-site
// HTML form can't send that content type without a CORS preflight (which we
// never answer), so together with SameSite=Lax cookies this is the CSRF
// defence for every state-changing route.
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'malformed JSON');
  }
}
