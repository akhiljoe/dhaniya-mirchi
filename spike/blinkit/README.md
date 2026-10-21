# Blinkit ingestion spike — Phase 0 go/no-go

This answers the single question the whole product hinges on (design.md §7.5):

> Can a Blinkit session, obtained once with phone + OTP, be **replayed from our
> server** to read the user's order history — and how long does it last before
> the user has to re-enter an OTP?

If yes → the automatic-ingestion design is GO.
If no (the token is bound to the browser or the login IP) → we need a
residential proxy or the browser-extension path, and the product model changes.

Nothing here is production code. It proves or kills the premise before we build
the worker, the token vault, or the vendor UI.

## What it does not touch

No AWS, no database, no framework. Two small scripts and Playwright.

## Setup (your machine — needs your phone for the OTP)

```
cd spike/blinkit
npm install
npx playwright install chromium
```

## Step 0 — capture the login (2026-09-20)

```
npm run capture:login
```

The step the original spike skipped: it logged in by hand, so **send-OTP and
verify-OTP were never recorded**, and the worker cannot drive a login it has
never watched (design §7.10).

A Chrome window opens on a fresh, signed-out profile — the installed Chrome,
spawned as a plain process and attached over CDP, which is the worker's own
recipe. You log in with your phone + OTP. Every blinkit.com call is recorded;
the script stops by itself once you are logged in and writes
`login-recon.json`: each call's method, url, headers, body and answer, plus the
localStorage, cookies and `order_history` request headers the page holds
afterwards. The console prints masked shapes only.

`login-recon.json` holds **your phone number, the code you typed and a live
token**. It is gitignored, like `session.json`. Delete it once the connect
adapter is written. So is `.logindata`, the browser profile it runs in.

Write what it shows into design Appendix A, then build
`server/src/worker/adapters/blinkit.ts` against it.

## Step 1 — capture

```
npm run capture
```

A Chromium window opens. Log into Blinkit with your phone + OTP, enter your
pincode if asked. The script waits until you're logged in, opens your Orders
page, grabs the page's own `order_history` request (headers + body), and writes
`session.json`. It also prints the token lifetime if the token is a JWT.

`session.json` holds a **live token to your real account with a saved card.**
It is gitignored. Don't share it, don't commit it, delete it when done.

## Step 2 — replay (the actual test)

```
npm run replay
```

Pure HTTP, no browser — exactly what the Oracle worker would do. It prints your
public IP and runs four scenarios:

| Scenario | What it proves |
|---|---|
| `full` | the captured token works detached from the browser at all |
| `cookie-only` | confirms cookies alone are not enough (recon said 401) |
| `headers-no-cookie` | whether the cookie is load-bearing or the header token is enough |
| `synthetic-deviceid` | whether the token is bound to the device id |

Read the verdict it prints at the end.

### Run it in three places

1. **Locally, right after capture** — does the token survive outside the
   browser? If even this 401s, the token is short-lived or fingerprinted;
   re-capture and replay within seconds.
2. **On the Oracle ARM box** — copy `session.json` across and run `npm run
   replay` there. This is the real test: does it work from a datacenter IP?
   **This result is the go/no-go.**
3. **Again after hours, then days** — keep `session.json` and re-run until it
   401s. The elapsed time is how often a user must re-enter an OTP (design §7.3).
   Determines whether "connect once" is literally once or a periodic reconnect.

## Interpreting the outcome

- **200 with order fields, locally and on Oracle** → GO. Record the token
  lifetime; that sets the reconnect cadence. Proceed to design Phase 1.
- **200 locally, 401/403 on Oracle** → IP-bound or datacenter-blocked. Try a
  residential proxy from the worker; if that fails, fall back to the extension.
- **401 even locally** → the token doesn't detach from the browser as captured.
  Inspect `session.json` headers for something not resent, or it's very
  short-lived. Re-capture + replay back-to-back to tell which.

Write whatever you find back into design.md §7.5 and Appendix A.
