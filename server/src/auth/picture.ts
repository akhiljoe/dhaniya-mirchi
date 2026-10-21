// The profile picture relay (design §14.3; the pattern an earlier project used).
//
// The Google photo URL from the ID token is stored server-side and never
// handed to the browser: the api fetches the image and serves it from our own
// origin at /api/me/picture. That keeps the page's CSP at img-src 'self' and
// doesn't give the provider's address to the page. Because the server does
// the fetching, only a pinned provider host is ever fetched — so no stored
// value can point it at an internal or arbitrary address (SSRF).
import { PICTURE_MAX_BYTES, PICTURE_TIMEOUT_MS, PICTURE_URL_PATTERN } from '../constants.js';

export function isAllowedPictureUrl(url: string): boolean {
  if (!PICTURE_URL_PATTERN.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

export async function fetchPicture(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ contentType: string; bytes: Buffer } | null> {
  if (!isAllowedPictureUrl(url)) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS), redirect: 'error' });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > PICTURE_MAX_BYTES) return null;
    return { contentType: type, bytes };
  } catch {
    return null;
  }
}
