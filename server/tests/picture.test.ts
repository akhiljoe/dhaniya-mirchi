// The profile picture relay (design §14.3). The browser never gets the
// provider's image URL: the api fetches the image and serves it from our own
// origin — so only a pinned provider host may ever be fetched (no SSRF).
import { describe, expect, it } from 'vitest';

import { PICTURE_MAX_BYTES } from '../src/constants.js';
import { fetchPicture, isAllowedPictureUrl } from '../src/auth/picture.js';

describe('isAllowedPictureUrl', () => {
  it("accepts Google's profile-photo host over https", () => {
    expect(isAllowedPictureUrl('https://lh3.googleusercontent.com/a/ACg8ocK=s96-c')).toBe(true);
  });

  it('refuses anything else — so a stored URL can never make the server fetch an arbitrary address', () => {
    for (const url of [
      'http://lh3.googleusercontent.com/a/x', // not https
      'https://evil.example/a.png',
      'https://googleusercontent.com.evil.example/a',
      'https://lh3.googleusercontent.com.evil.example/a',
      'https://127.0.0.1/a',
      'https://metadata.google.internal/',
      'javascript:alert(1)',
      '',
    ]) {
      expect(isAllowedPictureUrl(url)).toBe(false);
    }
  });
});

describe('fetchPicture', () => {
  const ok = (body: Uint8Array, type = 'image/jpeg') => async () =>
    new Response(new Blob([body as BlobPart]), { status: 200, headers: { 'content-type': type } });

  it('returns the image bytes and type', async () => {
    const img = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const r = await fetchPicture('https://lh3.googleusercontent.com/a/x', ok(img));
    expect(r).toEqual({ contentType: 'image/jpeg', bytes: Buffer.from(img) });
  });

  it('refuses a disallowed URL without fetching it', async () => {
    let fetched = false;
    const r = await fetchPicture('https://evil.example/a.png', async () => {
      fetched = true;
      return new Response('x');
    });
    expect(r).toBeNull();
    expect(fetched).toBe(false);
  });

  it('refuses a response that is not an image, or too large, or failed', async () => {
    expect(await fetchPicture('https://lh3.googleusercontent.com/a/x', ok(new Uint8Array([1]), 'text/html'))).toBeNull();
    expect(await fetchPicture('https://lh3.googleusercontent.com/a/x', ok(new Uint8Array(PICTURE_MAX_BYTES + 1)))).toBeNull();
    expect(await fetchPicture('https://lh3.googleusercontent.com/a/x', async () => new Response('', { status: 404 }))).toBeNull();
    expect(
      await fetchPicture('https://lh3.googleusercontent.com/a/x', async () => {
        throw new Error('network');
      }),
    ).toBeNull();
  });
});
