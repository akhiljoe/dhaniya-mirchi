// The browser side of sign-in (design §14.3). The api runs the whole Google /
// Cognito flow and keeps the session in an httpOnly cookie, so the SPA never
// holds a token: it navigates to /auth/start to sign in and asks
// /auth/session whether it is signed in.
import type { PendingInvite } from './members';

// A full-page navigation, not a fetch — the flow redirects through Google.
export const SIGN_IN_URL = '/auth/start';

export type Session =
  | { state: 'signed-in'; userId: string }
  | { state: 'signed-out' }
  // The server has sign-in switched off (503) or can't be reached. Kept
  // distinct from signed-out so the UI doesn't send people to a dead button.
  | { state: 'unavailable' };

export async function fetchSession(): Promise<Session> {
  try {
    const res = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json()) as { signedIn?: boolean; userId?: string };
    return body.signedIn && body.userId ? { state: 'signed-in', userId: body.userId } : { state: 'signed-out' };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function signOut(): Promise<void> {
  await fetch('/auth/signout', { method: 'POST', credentials: 'same-origin' });
}

export type SignInOutcome = 'failed' | 'cancelled' | 'not_allowed';

// After a sign-in that didn't complete the api redirects home with
// ?signin=failed|cancelled|not_allowed (not_allowed: the Google account is
// not on the site's allowlist). Anything else is ignored.
export function signInOutcome(search: string): SignInOutcome | null {
  const v = new URLSearchParams(search).get('signin');
  return v === 'failed' || v === 'cancelled' || v === 'not_allowed' ? v : null;
}

export interface Me {
  userId: string;
  email: string | null;
  name?: string | null; // what the pages call this person
  hasPicture: boolean; // the photo itself is served by the api at PICTURE_URL
  // `billingDay`: the day the household's spending month starts. 1 is the
  // calendar month; a card billed on the 16th makes it 16 (design §10.5).
  household: { id: string; name: string; timezone: string; billingDay?: number; cartVendor?: string | null; cartFallback?: boolean; role: 'owner' | 'member' } | null;
  // Households that invited this user (design §19). Shown before connect, so
  // someone invited joins instead of starting an empty household.
  invites?: PendingInvite[];
}

// The Google profile photo, relayed by our api from Google's host — the page
// never loads it from Google directly (CSP img-src 'self', design §14.3).
export const PICTURE_URL = '/api/me/picture';

// The address to load it from for this user. The api answers PICTURE_URL for
// whoever is signed in and the browser caches it, so the address names the
// user: after switching accounts, one account's photo is never shown for
// another's from the cache (the api ignores the query).
export function pictureUrlFor(me: Pick<Me, 'userId'>): string {
  return `${PICTURE_URL}?u=${encodeURIComponent(me.userId)}`;
}

export async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

// The letter shown in the avatar circle when there is no photo.
export function initialOf(email: string | null): string {
  return email && email.length ? email[0].toUpperCase() : '?';
}

// Google sign-in needs https, or localhost: Cognito allows plain-http
// callbacks only there. On a home-network address (http://192.168.x.x) it
// can't run; the sign-in screen says to use the https address.
export function googleSignInWorksHere(loc: { protocol: string; hostname: string } = window.location): boolean {
  return loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
}

