// Read checkout-recon.json and print the payment chain in a form that is safe
// to paste into the design doc: endpoints, header NAMES, parameter NAMES, and
// where each secret travels - never a secret's value.
//
//   npx tsx extract-payment-chain.ts [path]
//
// It exists because the last capture was deleted before the one fact that
// mattered had been taken out of it: zpaykit answers "Empty Access token" and
// the access_token from createOrder is not carried as a header, a bearer or a
// form field (design Appendix A). So this script's main job is the last
// section - it takes the token VALUE out of createOrder's answer and looks for
// that exact string in every later request, which says where the token
// actually goes without ever printing it.
import { readFileSync } from 'node:fs';
import { URL, URLSearchParams } from 'node:url';

interface Call {
  at?: string;
  method?: string;
  url: string;
  host?: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  status?: number;
  body?: string;
}

const file = process.argv[2] ?? 'checkout-recon.json';
const recon = JSON.parse(readFileSync(file, 'utf8')) as { calls: Call[]; challengeSeen?: string; capturedAt?: string };

// Hosts that are advertising, not the checkout.
const NOISE = /google|doubleclick|facebook|clarity|segment|branch|appsflyer|moengage|clevertap|amplitude|sentry|newrelic|jumbo|cdn\.|analytics/i;
// Anything whose value must never be printed, only named.
const SECRET = /token|hash|secret|auth|signature|cvv|otp|password|session|cookie/i;

const chain = recon.calls
  .map((c, i) => ({ ...c, i }))
  .filter((c) => !NOISE.test(c.url))
  .filter((c) => /zpaykit|payment|createOrder|carts|razorpay|3dsecure|address|zomato/i.test(c.url));

function fields(post: string | undefined): string[] {
  if (!post) return [];
  const multipart = [...post.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  if (multipart.length) return multipart;
  try {
    return Object.keys(JSON.parse(post) as Record<string, unknown>);
  } catch {
    /* not JSON */
  }
  return [...new URLSearchParams(post).keys()];
}

console.log(`captured ${recon.capturedAt ?? '?'}`);
console.log(`bank page reached: ${recon.challengeSeen ?? 'none'}`);
console.log('\n=== THE CHAIN ===');
for (const c of chain) {
  const u = new URL(c.url);
  const query = [...u.searchParams.keys()];
  console.log(`\n${String(c.i).padStart(3)} ${c.method ?? '?'} ${u.host}${u.pathname}  [${c.status ?? '?'}]`);
  if (query.length) console.log(`     query   : ${query.join(', ')}`);
  const hdr = Object.keys(c.requestHeaders ?? {}).filter((h) => !/^(accept|accept-|content-length|user-agent|sec-|origin|referer)/i.test(h));
  if (hdr.length) console.log(`     headers : ${hdr.join(', ')}`);
  const f = fields(c.postData);
  if (f.length) console.log(`     body    : ${f.join(', ')}`);
}

// ---- where the secrets actually travel --------------------------------------
//
// The point of the whole script. Each secret is found once in an answer, then
// looked for by value in every later request - and reported only as "this call
// carries it, here". The value itself is never printed.
console.log('\n=== WHERE EACH SECRET TRAVELS ===');

function findSecrets(): { name: string; value: string; from: number }[] {
  const out: { name: string; value: string; from: number }[] = [];
  for (const c of recon.calls) {
    if (!c.body || typeof c.body !== 'string') continue;
    let json: unknown;
    try {
      json = JSON.parse(c.body);
    } catch {
      continue;
    }
    const walk = (v: unknown, path: string[]) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val.length >= 12 && SECRET.test(k)) {
          const i = recon.calls.indexOf(c);
          if (!out.some((o) => o.value === val)) out.push({ name: [...path, k].join('.'), value: val, from: i });
        } else if (val && typeof val === 'object' && path.length < 4) {
          walk(val, [...path, k]);
        }
      }
    };
    walk(json, []);
  }
  return out;
}

const secrets = findSecrets();
if (!secrets.length) console.log('  (none found in any answer)');
for (const s of secrets) {
  const src = recon.calls[s.from];
  console.log(`\n  ${s.name}  (${s.value.length} chars) first seen in the answer to #${s.from} ${new URL(src.url).pathname}`);
  let carried = false;
  for (const [i, c] of recon.calls.entries()) {
    if (i <= s.from) continue;
    const where: string[] = [];
    if (c.url.includes(s.value)) {
      const u = new URL(c.url);
      const param = [...u.searchParams.entries()].find(([, v]) => v === s.value)?.[0];
      where.push(param ? `query param "${param}"` : 'in the url');
    }
    for (const [h, v] of Object.entries(c.requestHeaders ?? {})) if (typeof v === 'string' && v.includes(s.value)) where.push(`header "${h}"`);
    if (c.postData?.includes(s.value)) {
      const named = [...(c.postData.matchAll(/name="([^"]+)"\r?\n\r?\n([^\r\n]+)/g) as Iterable<RegExpMatchArray>)].find((m) => m[2] === s.value)?.[1];
      const urlenc = [...new URLSearchParams(c.postData).entries()].find(([, v]) => v === s.value)?.[0];
      where.push(named || urlenc ? `body field "${named ?? urlenc}"` : 'in the body');
    }
    if (where.length) {
      carried = true;
      console.log(`      -> #${i} ${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}: ${where.join(', ')}`);
    }
  }
  if (!carried) console.log('      -> never sent anywhere. It is used inside the page, not on the wire.');
}
