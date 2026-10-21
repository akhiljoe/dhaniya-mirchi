// Zepto recon: record EVERYTHING while a person drives the site by hand.
//
// Nothing here clicks, types or pays. The household logs in, fills a cart,
// goes to checkout, taps Pay, and stops once the bank's OTP arrives (closing
// the window or cancelling). This writes down what the site did at every step,
// so the adapter can be built against the real thing instead of a guess, and
// so no fact has to be bought with a second live run.
//
//   npm run record
//
// What is kept, per run, in runs/<timestamp>/ (gitignored, all of it real):
//   events.jsonl   one line per thing that happened, appended as it happens
//                  (a closed window loses nothing): every request with its
//                  headers and body, every response with its headers and body
//                  (not images, fonts, media, css, scripts), failed requests,
//                  websocket frames, navigations, popups, console output,
//                  every click and every field touched on the page.
//   shots/         a screenshot after every navigation and every click.
//   dom/           the HTML of every frame, same moments.
//   storage/       cookies, localStorage and sessionStorage, same moments.
//
// What is NOT kept: anything that looks like a card number or a CVV is cut
// from bodies before they are written, and a field's typed value is recorded
// only when it is plainly not a secret (a search box). The bank OTP is never
// typed while this runs, by agreement: stop at the OTP.
//
// Keep every run until Zepto is fully done and the household says it can go.
// The Blinkit checkout capture was deleted early once and a second live run
// was needed for one fact left in it.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Frame, type Page, type Request, type Response, type WebSocket } from 'playwright';

const START_URL = process.env.START_URL ?? 'https://www.zeptonow.com/';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336); // 9333 instamart, 9334/9335 blinkit
const USER_DATA_DIR = './.chromedata';
const BODY_LIMIT = 1_000_000;
const SNAPSHOT_DELAY_MS = 1500; // let a click's result paint before the shot
const HEARTBEAT_SNAPSHOT_MS = 30_000; // a shot even when nothing is clicked (timers, redirects)
const MARK = '__ZREC__';
// Bodies not worth the disk: the page's look, not its behaviour.
const NO_BODY_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'script', 'manifest']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = resolve('runs', stamp);
for (const d of ['shots', 'dom', 'storage']) mkdirSync(join(RUN_DIR, d), { recursive: true });
const EVENTS = join(RUN_DIR, 'events.jsonl');

let seq = 0;
function log(kind: string, data: Record<string, unknown>): number {
  const n = ++seq;
  appendFileSync(EVENTS, JSON.stringify({ n, at: new Date().toISOString(), kind, ...data }) + '\n');
  return n;
}

// The vendor holds a card as a token, so its digits should never be on the
// wire; if they ever are, they stop here.
function scrub(text: string | null): string | null {
  if (!text) return text;
  return text
    // Not after a decimal point: a latitude's fraction (12.97160...) is not a card.
    .replace(/(?<![\d.])\b(?:\d[ -]*?){13,19}\b/g, '[card-number-removed]')
    .replace(/("(?:cvv|cvc|card_?number|cardNo|pan|card_?cvv|security_?code)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"')
    .replace(/((?:^|&)(?:cvv|cvc|card_?number|cardNo|pan|card_?cvv|security_?code)=)[^&]*/gi, '$1[removed]');
}

// The console is a shared screen: mask long digit runs and token-shaped strings.
function mask(s: string): string {
  return s
    .replace(/\d{4,}/g, (d) => `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 2))}`)
    .replace(/([A-Za-z0-9_-]{24,})/g, (t) => `${t.slice(0, 6)}…(${t.length})`);
}

// Runs in every frame, the bank's included. Reports clicks and field edits
// through console.log, which the recorder reads. A typed value is reported
// only for a field that is plainly not a secret; for the rest, its length.
const PAGE_SCRIPT = `(() => {
  if (window.__zrecInstalled) return;
  window.__zrecInstalled = true;
  const SECRET = /otp|cvv|cvc|card|pin|pass|secur|code|expiry|month|year|mm|yy|phone|mobile|tel|upi|vpa/i;
  const describe = (el) => {
    if (!el || !el.tagName) return null;
    const attrs = {};
    for (const a of ['id','class','name','type','role','aria-label','data-testid','placeholder','href','title','autocomplete','inputmode','maxlength']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) attrs[a] = String(v).slice(0, 200);
    }
    const path = [];
    let e = el;
    for (let i = 0; e && e.tagName && i < 6; i++, e = e.parentElement) {
      path.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.getAttribute('data-testid') ? '[data-testid=' + e.getAttribute('data-testid') + ']' : ''));
    }
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      text: ('value' in el && el.tagName !== 'BUTTON' ? '' : (el.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 160),
      attrs,
      path: path.join(' < '),
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    };
  };
  const send = (o) => { try { console.log('${MARK}' + JSON.stringify(Object.assign({ frame: location.href }, o))); } catch (e) {} };
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const clickable = t && t.closest ? t.closest('button,a,[role=button],label,input,[onclick],[data-testid]') : null;
    send({ ev: 'click', target: describe(t), clickable: clickable && clickable !== t ? describe(clickable) : null });
  }, true);
  const field = (ev) => {
    const t = ev.target;
    if (!t || !('value' in t)) return;
    const d = describe(t);
    const hint = JSON.stringify(d.attrs);
    const v = String(t.value || '');
    const safe = !SECRET.test(hint) && t.type !== 'password' && !/^\\d+$/.test(v);
    send({ ev: ev.type, target: d, valueLength: v.length, value: safe ? v.slice(0, 200) : undefined });
  };
  document.addEventListener('change', field, true);
  document.addEventListener('input', field, true);
  document.addEventListener('submit', (ev) => send({ ev: 'submit', target: describe(ev.target) }), true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'Tab') send({ ev: 'key', key: ev.key, target: describe(ev.target) }); }, true);
  window.addEventListener('popstate', () => send({ ev: 'popstate' }));
  const wrap = (name) => { const orig = history[name]; history[name] = function () { const r = orig.apply(this, arguments); send({ ev: name, to: location.href }); return r; }; };
  wrap('pushState'); wrap('replaceState');
})();`;

function launchChrome(): void {
  const chrome = spawn(
    CHROME_PATH,
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${resolve(USER_DATA_DIR)}`, '--no-first-run', '--no-default-browser-check', START_URL],
    { stdio: 'ignore', detached: true },
  );
  chrome.on('error', (e) => {
    console.error(`[fail] could not start Chrome at ${CHROME_PATH}: ${e.message}`);
    process.exit(1);
  });
  chrome.unref();
}

async function attach() {
  const up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    () => true,
    () => false,
  );
  if (!up) launchChrome();
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw last;
}

const pageIds = new Map<Page, number>();
let nextPageId = 0;
const pid = (p: Page) => pageIds.get(p) ?? -1;

let snapN = 0;
async function snapshot(context: BrowserContext, page: Page, why: string): Promise<void> {
  const n = ++snapN;
  const base = `${String(n).padStart(4, '0')}-p${pid(page)}`;
  const files: Record<string, unknown> = {};
  try {
    await page.screenshot({ path: join(RUN_DIR, 'shots', `${base}.png`), timeout: 5000 });
    files.shot = `shots/${base}.png`;
  } catch (e) {
    files.shotError = (e as Error).message.split('\n')[0];
  }
  const frames: { i: number; url: string; file?: string; error?: string }[] = [];
  const storage: Record<string, unknown> = {};
  let i = 0;
  for (const f of page.frames()) {
    const idx = i++;
    const url = f.url();
    try {
      writeFileSync(join(RUN_DIR, 'dom', `${base}-f${idx}.html`), await f.content());
      frames.push({ i: idx, url, file: `dom/${base}-f${idx}.html` });
    } catch (e) {
      frames.push({ i: idx, url, error: (e as Error).message.split('\n')[0] });
    }
    try {
      storage[`f${idx} ${url}`] = await f.evaluate(`(() => {
        const dump = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch (e) { return String(e); } return o; };
        return { local: dump(localStorage), session: dump(sessionStorage), cookie: document.cookie };
      })()`);
    } catch {
      /* a frame gone mid-read */
    }
  }
  try {
    storage.cookies = await context.cookies();
  } catch {
    /* browser closing */
  }
  writeFileSync(join(RUN_DIR, 'storage', `${base}.json`), JSON.stringify(storage, null, 2));
  log('snapshot', { why, page: pid(page), url: page.url(), ...files, frames, storage: `storage/${base}.json` });
}

// Several clicks in a row give one shot, after the last has settled.
const pending = new Map<Page, ReturnType<typeof setTimeout>>();
function snapshotSoon(context: BrowserContext, page: Page, why: string): void {
  const t = pending.get(page);
  if (t) clearTimeout(t);
  pending.set(
    page,
    setTimeout(() => {
      pending.delete(page);
      if (!page.isClosed()) void snapshot(context, page, why);
    }, SNAPSHOT_DELAY_MS),
  );
}

const reqIds = new Map<Request, number>();
const hosts = new Map<string, number>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function onRequest(page: Page, req: Request): Promise<void> {
  const h = hostOf(req.url());
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
  let headers: Record<string, string> = req.headers();
  try {
    headers = await req.allHeaders();
  } catch {
    /* keep the provisional ones */
  }
  let post: string | null = null;
  try {
    post = req.postData();
  } catch {
    const buf = req.postDataBuffer();
    post = buf ? `[binary ${buf.length} bytes] ${buf.toString('base64').slice(0, 4000)}` : null;
  }
  const id = log('request', {
    page: pid(page),
    frame: req.frame()?.url?.() ?? null,
    type: req.resourceType(),
    method: req.method(),
    url: req.url(),
    navigation: req.isNavigationRequest(),
    redirectedFrom: req.redirectedFrom()?.url() ?? null,
    headers,
    postData: scrub(post),
  });
  reqIds.set(req, id);
}

async function onResponse(page: Page, res: Response): Promise<void> {
  const req = res.request();
  let headers: Record<string, string> = res.headers();
  try {
    headers = await res.allHeaders();
  } catch {
    /* keep the provisional ones */
  }
  let body: string | null = null;
  let bodyNote: string | undefined;
  if (NO_BODY_TYPES.has(req.resourceType())) bodyNote = `skipped (${req.resourceType()})`;
  else if (res.status() >= 300 && res.status() < 400) bodyNote = 'redirect';
  else {
    try {
      const buf = await res.body();
      const ct = headers['content-type'] ?? '';
      if (/json|text|html|xml|javascript|x-www-form-urlencoded/i.test(ct) || ct === '') {
        body = buf.toString('utf8');
        if (body.length > BODY_LIMIT) {
          bodyNote = `truncated from ${body.length}`;
          body = body.slice(0, BODY_LIMIT);
        }
      } else bodyNote = `binary ${ct} ${buf.length} bytes`;
    } catch (e) {
      bodyNote = `unreadable: ${(e as Error).message.split('\n')[0]}`;
    }
  }
  log('response', {
    page: pid(page),
    req: reqIds.get(req) ?? null,
    method: req.method(),
    url: res.url(),
    status: res.status(),
    statusText: res.statusText(),
    fromServiceWorker: res.fromServiceWorker(),
    headers,
    body: scrub(body),
    bodyNote,
  });
}

function onWebSocket(page: Page, ws: WebSocket): void {
  log('websocket', { page: pid(page), url: ws.url() });
  ws.on('framesent', (f) => log('ws-sent', { url: ws.url(), payload: scrub(typeof f.payload === 'string' ? f.payload : `[binary ${f.payload.length}]`) }));
  ws.on('framereceived', (f) =>
    log('ws-received', { url: ws.url(), payload: scrub(typeof f.payload === 'string' ? f.payload.slice(0, BODY_LIMIT) : `[binary ${f.payload.length}]`) }),
  );
  ws.on('close', () => log('ws-close', { url: ws.url() }));
}

function watchPage(context: BrowserContext, page: Page, how: string): void {
  if (pageIds.has(page)) return;
  pageIds.set(page, nextPageId++);
  log('page', { page: pid(page), how, url: page.url(), opener: null });
  console.log(`[page ${pid(page)}] ${how}: ${mask(page.url())}`);
  void page.evaluate(PAGE_SCRIPT).catch(() => undefined);
  for (const f of page.frames()) void f.evaluate(PAGE_SCRIPT).catch(() => undefined);

  page.on('request', (r) => void onRequest(page, r));
  page.on('response', (r) => void onResponse(page, r));
  page.on('requestfailed', (r) => log('request-failed', { page: pid(page), req: reqIds.get(r) ?? null, url: r.url(), error: r.failure()?.errorText ?? null }));
  page.on('websocket', (ws) => onWebSocket(page, ws));
  page.on('framenavigated', (f: Frame) => {
    log('navigated', { page: pid(page), main: f === page.mainFrame(), url: f.url(), name: f.name() });
    if (f === page.mainFrame()) {
      console.log(`[page ${pid(page)}] → ${mask(f.url())}`);
      snapshotSoon(context, page, 'navigated');
    } else if (f.url() && f.url() !== 'about:blank') {
      console.log(`[page ${pid(page)}]   frame → ${mask(f.url())}`);
      snapshotSoon(context, page, 'frame navigated');
    }
  });
  page.on('dialog', (d) => log('dialog', { page: pid(page), type: d.type(), message: d.message() }));
  page.on('popup', (p) => log('popup', { page: pid(page), url: p.url() }));
  page.on('close', () => {
    log('page-closed', { page: pid(page) });
    console.log(`[page ${pid(page)}] closed`);
  });
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith(MARK)) {
      let o: Record<string, unknown> = {};
      try {
        o = JSON.parse(text.slice(MARK.length));
      } catch {
        o = { raw: text };
      }
      log('user', { page: pid(page), ...o });
      if (o.ev === 'click') {
        const t = (o.clickable ?? o.target) as { tag?: string; text?: string } | null;
        console.log(`[page ${pid(page)}] click ${t?.tag ?? '?'} "${mask(String(t?.text ?? '').slice(0, 50))}"`);
        snapshotSoon(context, page, 'click');
      } else if (o.ev === 'submit' || o.ev === 'key') snapshotSoon(context, page, String(o.ev));
      return;
    }
    log('console', { page: pid(page), type: m.type(), text: text.slice(0, 4000), location: m.location() });
  });
  page.on('pageerror', (e) => log('page-error', { page: pid(page), message: e.message }));
}

async function main() {
  console.log(`\nrecording to ${RUN_DIR}\n`);
  const browser = await attach();
  const context = browser.contexts()[0];
  await context.addInitScript(PAGE_SCRIPT);
  log('start', { startUrl: START_URL, cdpPort: CDP_PORT, profile: resolve(USER_DATA_DIR) });
  for (const p of context.pages()) watchPage(context, p, 'already open');
  context.on('page', (p) => watchPage(context, p, 'opened'));
  if (context.pages().every((p) => !/zepto/i.test(p.url()))) {
    const p = context.pages()[0] ?? (await context.newPage());
    await p.goto(START_URL).catch(() => undefined);
  }

  console.log('=================================================================');
  console.log(' RECORDING. This script clicks nothing and pays for nothing.');
  console.log('');
  console.log(' 1. Log in to Zepto (phone + OTP).');
  console.log(' 2. Add items to the cart.');
  console.log(' 3. Go to checkout, choose how to pay, tap Pay.');
  console.log(' 4. When the bank OTP ARRIVES, do NOT type it. Cancel or close.');
  console.log('');
  console.log(' Closing all of Chrome ends the run. Ctrl+C here also ends it.');
  console.log('=================================================================\n');

  const heartbeat = setInterval(() => {
    for (const p of context.pages()) if (!p.isClosed()) void snapshot(context, p, 'heartbeat');
  }, HEARTBEAT_SNAPSHOT_MS);

  let finished = false;
  const finish = (why: string) => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    log('stop', { why });
    const byHost = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
    writeFileSync(join(RUN_DIR, 'hosts.json'), JSON.stringify(Object.fromEntries(byHost), null, 2));
    console.log(`\n[stop] ${why}. ${seq} events, ${snapN} snapshots → ${RUN_DIR}`);
    console.log('hosts seen:');
    for (const [h, c] of byHost.slice(0, 40)) console.log(`  ${String(c).padStart(5)}  ${h}`);
    process.exit(0);
  };
  browser.on('disconnected', () => finish('Chrome closed'));
  process.on('SIGINT', () => finish('Ctrl+C'));
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
