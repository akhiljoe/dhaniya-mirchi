// Phase 0 spike — STEP 2: replay.
//
// Pure HTTP. No browser. This is what the Oracle worker would do: take the
// captured token and call order_history directly. It runs several scenarios to
// find exactly what the endpoint requires, and prints your public IP so a
// laptop run and an Oracle run are distinguishable.
//
//   npm run replay
//
// Run it:
//   1. Locally, right after capture      → proves the token works detached from
//                                           the browser at all (bearer vs bound).
//   2. On the Oracle ARM box (copy        → proves it replays from a datacenter
//      session.json over)                   IP — THE go/no-go for auto-ingest.
//   3. Again after hours/days             → measures token lifetime empirically.
//
import { readFileSync } from 'node:fs';
import {
  SESSION_FILE,
  replayableHeaders,
  type CapturedSession,
} from './shared.ts';

interface Scenario {
  name: string;
  note: string;
  build: (s: CapturedSession) => { headers: Record<string, string>; body: string | null };
}

const scenarios: Scenario[] = [
  {
    name: 'full',
    note: 'exact headers the page sent — baseline, should match capture',
    build: (s) => ({
      headers: replayableHeaders(s.orderHistory.requestHeaders),
      body: s.orderHistory.postData,
    }),
  },
  {
    name: 'cookie-only',
    note: 'cookies but no auth headers — recon said this 401s',
    build: (s) => ({
      headers: { 'content-type': 'application/json', cookie: s.cookieHeader },
      body: s.orderHistory.postData ?? JSON.stringify({ offset: 0, limit: 5 }),
    }),
  },
  {
    name: 'headers-no-cookie',
    note: 'auth headers but cookies stripped — is the cookie load-bearing?',
    build: (s) => {
      const h = replayableHeaders(s.orderHistory.requestHeaders);
      delete h['cookie'];
      return { headers: h, body: s.orderHistory.postData };
    },
  },
  {
    name: 'synthetic-deviceid',
    note: 'flip any device-id header to a new value — is the token device-bound?',
    build: (s) => {
      const h = replayableHeaders(s.orderHistory.requestHeaders);
      for (const k of Object.keys(h)) {
        if (/device[-_]?id/i.test(k)) {
          h[k] = 'spike-synthetic-' + '0'.repeat(Math.max(0, h[k].length - 16));
        }
      }
      return { headers: h, body: s.orderHistory.postData };
    },
  },
];

function summariseBody(text: string): string {
  try {
    const j = JSON.parse(text);
    const keys = Object.keys(j);
    // Look for anything that smells like a line item / order list.
    const s = JSON.stringify(j);
    const looksLikeOrders = /order|item|product|qty|quantity|snippet/i.test(s);
    return `json keys=[${keys.slice(0, 8).join(',')}] ${looksLikeOrders ? '✓ contains order/item fields' : '✗ no order fields'}`;
  } catch {
    return `non-json (${text.length} chars): ${text.slice(0, 80).replace(/\s+/g, ' ')}`;
  }
}

async function publicIp(): Promise<string> {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { ip: string };
    return j.ip;
  } catch {
    return '(could not determine)';
  }
}

async function main() {
  let session: CapturedSession;
  try {
    session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    console.error(`Could not read ${SESSION_FILE}. Run \`npm run capture\` first.`);
    process.exit(1);
  }

  const ip = await publicIp();
  const ageMin = Math.round((Date.now() - Date.parse(session.capturedAt)) / 60000);
  const dc = /^(?:13\.|15\.|3\.|18\.|34\.|35\.|52\.|54\.)/.test(ip); // rough AWS-ish hint
  console.log('=================================================================');
  console.log(` Replaying from public IP: ${ip}${dc ? '  (looks like a datacenter range)' : ''}`);
  console.log(` Token captured ${ageMin} min ago (${session.capturedAt})`);
  console.log('=================================================================\n');

  const jwt = session.tokenMeta.find((t) => t.jwt && t.expiresAt);
  if (jwt) {
    const expired = Date.parse(jwt.expiresAt!) < Date.now();
    console.log(`Token (${jwt.where}) expires ${jwt.expiresAt} — ${expired ? 'EXPIRED' : 'still valid'}\n`);
  }

  const results: { scenario: string; status: number | string; note: string; body: string }[] = [];

  for (const sc of scenarios) {
    const { headers, body } = sc.build(session);
    try {
      const res = await fetch(session.orderHistory.url, {
        method: session.orderHistory.method || 'POST',
        headers,
        body: body ?? undefined,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      results.push({ scenario: sc.name, status: res.status, note: sc.note, body: summariseBody(text) });
    } catch (e) {
      results.push({ scenario: sc.name, status: 'ERR', note: sc.note, body: String(e) });
    }
  }

  console.log('SCENARIO             STATUS  RESULT');
  console.log('-------------------- ------  --------------------------------------------');
  for (const r of results) {
    console.log(`${r.scenario.padEnd(20)} ${String(r.status).padEnd(6)}  ${r.body}`);
    console.log(`${''.padEnd(20)}         (${r.note})`);
  }

  // Verdict helper.
  const full = results.find((r) => r.scenario === 'full');
  console.log('\n--- reading this ---');
  if (full && full.status === 200 && /contains order/i.test(full.body)) {
    console.log('✓ Token replays via pure HTTP with no browser.');
    console.log('  → Run this same command on the Oracle ARM box. If it stays 200 there,');
    console.log('    the auto-ingestion design is GO. If it 401/403s from the datacenter IP,');
    console.log('    the token or IP is bound → need a residential proxy or the extension path.');
    const synth = results.find((r) => r.scenario === 'synthetic-deviceid');
    if (synth) console.log(`  → synthetic-deviceid returned ${synth.status}: ` +
      (synth.status === 200 ? 'device binding is loose (good).' : 'looks device-bound — reuse the captured deviceId.'));
  } else if (full) {
    console.log(`✗ Baseline "full" replay returned ${full.status}, not a clean 200 with orders.`);
    console.log('  The token does NOT survive outside the browser as captured. Likely causes:');
    console.log('  a short-lived token (re-capture and replay within seconds), a required header');
    console.log('  we did not capture, or TLS/browser fingerprinting. Inspect session.json headers.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
