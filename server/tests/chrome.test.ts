// The browser identity the worker presents (design §7.10): the version is read
// from the installed binary, and the user agent is a normal Chrome one —
// Blinkit refuses "HeadlessChrome".
import { describe, expect, it } from 'vitest';

import { normalUserAgent, parseBrowserVersion } from '../src/worker/chrome.js';

describe('parseBrowserVersion', () => {
  it('reads Debian Chromium and Google Chrome version strings', () => {
    expect(parseBrowserVersion('Chromium 139.0.7258.66 built on Debian GNU/Linux 12 (bookworm)')).toBe('139.0.7258.66');
    expect(parseBrowserVersion('Google Chrome 152.0.7977.83 ')).toBe('152.0.7977.83');
  });

  it('returns null rather than guessing when there is no version', () => {
    expect(parseBrowserVersion('command not found')).toBeNull();
  });
});

describe('normalUserAgent', () => {
  it('is a normal Chrome user agent — never HeadlessChrome', () => {
    const ua = normalUserAgent('139.0.7258.66');
    expect(ua).toContain('Chrome/139.0.7258.66');
    expect(ua).not.toMatch(/Headless/i);
    expect(ua).toMatch(/^Mozilla\/5\.0 \(X11; Linux x86_64\)/);
  });
});
