// Can this browser be told when the import is done (design §13.1)? iPhones
// only get web push from a site added to the Home Screen, so they're asked to
// install first rather than shown a button that can't work.
import { describe, expect, it } from 'vitest';

import { base64UrlToBytes, pushAvailability } from './push';

const desktop = { serviceWorker: true, pushManager: true, notification: true, iOS: false, standalone: false, permission: 'default' as const };

describe('pushAvailability', () => {
  it('is ready on a browser with push support', () => {
    expect(pushAvailability(desktop)).toBe('ready');
    expect(pushAvailability({ ...desktop, permission: 'granted' })).toBe('ready');
  });

  it('says blocked when the user said no before — the browser will not ask again', () => {
    expect(pushAvailability({ ...desktop, permission: 'denied' })).toBe('denied');
  });

  it('asks an iPhone to add the site to the Home Screen first', () => {
    expect(pushAvailability({ ...desktop, iOS: true, pushManager: false, notification: false })).toBe('needs-install');
  });

  it('works on an iPhone once opened from the Home Screen', () => {
    expect(pushAvailability({ ...desktop, iOS: true, standalone: true })).toBe('ready');
  });

  it('is unsupported without the APIs', () => {
    expect(pushAvailability({ ...desktop, serviceWorker: false })).toBe('unsupported');
    expect(pushAvailability({ ...desktop, pushManager: false })).toBe('unsupported');
  });
});

describe('base64UrlToBytes', () => {
  it('decodes the VAPID key format, padding or not', () => {
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes('_-8')]).toEqual([255, 239]);
  });
});
