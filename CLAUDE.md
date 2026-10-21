# CLAUDE.md — working notes for this repository

Read this first, then `docs/product/design.md` (the contract) and the progress log (kept private).

**Status: the website works end to end locally** (`docker compose up --build` → http://localhost:8100) for Instamart: Google sign-in, phone + OTP connect, background import with progress and push notices, and pages built from the household's real orders (live-tested 2026-09-19). A household can have several people, each connecting their own apps (invite from the Household page, design §19), and an Insights page reads everyone's orders together. The running-low list comes from the household's buying rhythm (`src/engine/due.ts`, design §9.6); measure any change to it with `npx tsx --tsconfig tsconfig.app.json spike/db/backtest.ts`. Households can say who lives here, guests, pets, time away and daily use (forms, or plain words read by the AI layer in the worker: `server/src/ai/`, design §7.8, §9.12), and the app asks when buying changes. Announcements go out only when the user says what to send (`worker announce`). Syncs run on their own (6 h; 30 min while an order is on its way). **Add to cart works** (session 7): taps land on a cart list, one Send fills the household's real Instamart cart through the vendor's own page (`server/src/worker/cart.ts`, design §19 stage 1, Appendix C), carts queue per household, and the address the cart belongs to is chosen. Everything it adds is a prompted purchase, kept out of the rate (`src/lib/prompted.ts`). **"Cook something"** turns a dish into a shopping list (`CookView.tsx`, `server/src/ai/meal-schema.ts`). A friend outside the household used the dev site on 2026-09-20. **Blinkit reads, and cannot be written to** (session 8): two real accounts imported through the website, every pack size known. Its **cart is impossible from a server**: a Blinkit cart belongs to a `device_id`, not an account, so the cart the household's phone shows can never be reached by us (design Appendix A carries the whole investigation, and the household confirmed it from both devices). `CART_VENDORS` stays Instamart-only and should stay that way. Nothing AI-shaped has run against a live model yet (no key). **Paying from the app is built and taken to the bank** (session 9, design §19 stages 2-3): the worker drives the vendor's own payment screen, refuses anything the household did not agree to, asks about the price the checkout actually wants, and relays the CVV and then the bank's OTP (`server/src/worker/pay.ts`, `server/src/api/order.ts`, `src/components/PayNow.tsx`, migrations 022-025). Three live attempts: stopped on the price, stopped on the CVV, then reached the bank's own 3-D Secure page with the OTP delivered to the household's phone. **No payment has been completed** - the OTP has never been typed, so `submitOtp` has never run for real. An audit afterwards closed six gaps, one of which would have reported every successful payment as a failure. 843 tests. **Zepto reads** (session 12, design Appendix D): connect drives Zepto's own login form, and the whole history imports through our in-page fetch unsigned (the full history, packs from each order's detail). Its access token lasts an hour and the refresh token rotates, so every sync re-seals the session it ends with. No Zepto cart yet.

**Friends can use the dev site** at https://app.dev.example.com while `npm run tunnel` runs; only emails on `AUTH_ALLOWED_EMAILS` get in. Sign-in was checked end to end in desktop Chrome on 2026-09-19 after a friend's first try failed; a phone sign-in after the fixes is still to be done. **Before sending anyone the link, follow `docs/operations/SIGNIN-SETUP.md`** (checks, allowlist, reading failures).

Still-open go/no-go items: the datacenter-IP test on the Oracle VM (once it exists — `docker compose run --rm worker node dist/worker/main.js probe`), and token-lifetime measurement. Headless is settled (passed from Windows Chrome and from Linux Chromium in the worker container).

## What this project is

**DhaniyaMirchi** (repo: `dhaniya-mirchi`) — a household inventory and replenishment assistant. The user connects their grocery accounts (Instamart, Blinkit, Zepto) **once**, and from then on the system pulls their real order history automatically, estimates what's at home, and tells them what to buy before they run out. The name — coriander & green chilli, the staples every Indian kitchen always needs — is the spirit: never run out of the everyday stuff.

The whole product bets on **zero data entry**: previous attempts at this die because users won't log purchases. So we read order history server-side instead of asking. That is the hard part and the risky part — see the rules below.

Target: a real deployed website for the author + one friend (two households), at ₹0/month: one Docker Compose stack, identical locally and in production, on an Oracle Cloud Always Free VM behind a Cloudflare Tunnel, on a subdomain of the already-owned `example.com` (design §11, §14).

## The rules that override normal judgement

**The LLM never does arithmetic.** Quantities, dates, consumption rates, thresholds, depletion estimates, confidence, status — all deterministic code in `src/engine/`. The model only turns text into structured JSON (typed entry) and computed state into a sentence. Order-history ingestion needs no LLM at all: the data is already structured JSON. If you find an LLM computing inventory, that is the bug. (design §7.8, §9)

**Inventory is a projection, never state.** `inventory_state` is a cache derived from the event log (`purchases`, `consumption_events`) plus `algorithm_version`. It can be truncated and rebuilt at any time. An engine bug is fixed by a recompute, never a data migration. Never mutate an inventory balance directly — append an event and recompute. (design §11 rule 2, §9.9)

**The engine is pure, with no I/O.** `src/engine/` is imported by both the browser and the ingestion worker. Same inputs, same outputs. It touches no database, no network, no clock it isn't handed. It must be fully testable with fixture histories. Do not reach for `Date.now()` inside it — pass time in.

**Consumption rate is never derived from prompted purchases.** If we told the user to buy something and they did, that purchase is contaminated evidence — using it makes the model confirm its own predictions forever. `purchases.prompted_by` marks these; they are excluded from rate estimation (trust weight 0.00) and used only for accuracy scoring. This is the single most important correctness rule in the engine. (design §9.1, §9.2)

**A vendor keeps one cart per store, and the store follows from the delivery address.** Fill the wrong one and the household sees nothing: their items sit in a cart the app never shows. The address is chosen on every cart job (`vendor_connections.cart_address`), and the page says when it is only our guess. Instamart also signs its page's own requests, so our call can read a cart and clear it but never add: items go in through the page's own buttons, and a product's card is found by its image (the page scrambles product names).

**Every AI call goes through the guardrails (`server/src/ai/guard.ts`, design §7.8 "Guardrails").** Private details cut before a note is stored or sent; the note fenced as data; any number the household didn't say dropped and asked; rate limits on every key; `AI_ENABLED=false` stops it all. A new AI feature adds its checks there before it ships, never around them.

**Never invent a consumption rate.** No signals for an item → `rate = null`, status `UNKNOWN`, "not enough history yet". Never borrow a rate from another household or a category default. A confident wrong number destroys trust faster than an honest "don't know". (design §9.3)

**The engine degrades, never lies.** A broken adapter or a missing order lowers confidence and widens ranges; it must never silently halve the rate. Partial data is more dangerous than no data. Confidence floors on stale data (design §9.4, §9.10).

**Vendor tokens are secrets and are handled like secrets.** The ingestion worker holds live authenticated sessions to accounts with saved payment methods. Tokens are encrypted at rest (AES-256-GCM under `VAULT_KEY`, design §14.3), decrypted only in the worker at fetch time, **never logged, never in an error message, never sent to the browser.** If you need to log something about a connection, log its vendor, its status, and `last_sync_at` — never the token.

**Store line items, quantities, and dates only.** Order pages expose delivery address, phone-on-file, and card digits. These are discarded on ingest and never persisted. `raw_orders.payload` is normalized line items only. (design §7.6)

**Authorization is the handler's job on every route.** There is no row-level security. Household membership is checked in the api handler on every request — and it now also gates the token vault. Skipping it on any route leaks one household's data (and grocery sessions) to another. (design §14.3)

**No placeholders.** No TODOs, no stub files, no "implement this yourself". A phase ships complete files or does not create them yet.

## The engine invariants (design §9)

State these in a comment on any exported engine function that touches them:

- **Signals are ranked, not averaged flat.** Depletion (1.0) > level assertion (0.8) > unprompted interval (0.5) > onboarding prior (0.25) > prompted interval (0.0, excluded). Recency-weighted, 30-day half-life.
- **`discarded` reduces stock but never feeds the rate.** Food thrown out was not consumed; counting it inflates the rate and over-orders.
- **Status thresholds test `days_low`, the pessimistic end of the range.** Lower confidence → earlier warning. Being reminded early is cheap; running out is not.
- **`algorithm_version` is bumped on any math change**, and triggers a full rebuild of `inventory_state` from events.

## Things that will bite you

**The worker MUST drive a real browser engine — raw HTTP is blocked outright.** The spike proved it (design Appendix B): Blinkit's edge does client-fingerprint bot detection. The identical `order_history` request — same token, same IP, same headers — returns 403 (a 561 KB HTML block page) from a Node `fetch` but 200 (order JSON) from a `fetch` inside a real Playwright Chrome. So `order_history` is called from inside the page context; a lightweight server-side HTTP client is not an option. Do not "simplify" the worker into a plain HTTP client — it cannot work. (design §7.5, §14.1, Appendix B)

**Scraping runs headless, in the background — the user never sees a browser.** This is a website: the user types phone + OTP on *our* page, and the worker logs in and reads orders out of sight (design §7.10). Headless is proven for both vendors (2026-09-18, home IP) with one recipe: the installed Chrome spawned with `--headless=new` **and a normal Chrome user agent** (`--user-agent=…Chrome/<version>…`, version read from the installed binary), attached over CDP. Blinkit 403s the default `HeadlessChrome` UA even on page load; Instamart accepts either. A stored session (cookies + header token) restored into a fresh profile works — that's how the vault restores sessions. Probes: `npm run probe:headless` in `spike/blinkit/` and `spike/instamart/`.

**Never let Playwright launch the browser — spawn Chrome and attach.** Instamart (Swiggy) blocks a `chromium.launch()`/`launchPersistentContext` browser at the first page load ("Your request looks automated"), before login. Starting the installed Chrome as a plain process with `--remote-debugging-port` and attaching via `connectOverCDP` works. `spike/instamart/shared.ts` is the reference. Instamart also lives on **instamart.in** (not swiggy.com, whose orders page is food-only) and serves only a rolling 12 months of history. (design Appendix C)

**One go/no-go is still open: the datacenter IP.** Headless passed (Windows Chrome, and Linux Chromium in the worker container — `worker probe`). But every pass so far is from a home residential IP; Oracle's datacenter IP may be challenged even with a real browser. Run `worker probe` on the VM first thing. Fallback: run the worker container on a home machine against the VM's database (design §14.1). Don't treat the ingestion path as settled for production until it passes. (design Appendix B)

**Token lifetime is unknown and must be measured.** The token is opaque (not a JWT), so lifetime can't be read — replay a captured session until it 401s. That elapsed time is how often the user re-enters an OTP, and it decides whether "connect once" is literally once or a periodic reconnect. (design §7.3)

**The OTP is relayed through the user's phone and we can never see it.** Any design that assumes we can read the OTP is wrong. The user types it; we submit it. How often they re-do this depends on token lifetime (unknown until the spike). Build the reconnect flow, don't pretend sessions are permanent. (design §7.3)

**Per-vendor adapters behind one interface.** One vendor breaking must never take another down. Each adapter reports health so a silent sync failure is caught, not left to poison the model.

**Auth is Google via Cognito, server-side.** the shared Cognito pool, with its own confidential app client for this app. The `api` runs the OIDC code flow (`/auth/start` → Cognito → `/auth/callback`) and issues its own httpOnly session cookie; the SPA never sees a Cognito token. Ported from an earlier project with its tests (`server/src/auth/`, design §14.3). Traps: nginx must proxy `/auth/` (else every auth route returns the SPA with a 200); Google must be ticked on the app client (else Cognito silently shows its email form); `AUTH_REDIRECT_URI` is the browser-facing origin; issuer/JWKS (pool) and authorize/token (hosted domain) are different hosts. Only emails on `AUTH_ALLOWED_EMAILS` (`.env`) can sign in; add a friend there and `docker compose up -d`. The SPA side is `src/lib/auth.ts` + `onboarding/SignIn.tsx` ("Continue with Google" → `/auth/start`). Note: `onboarding/Auth.tsx` is NOT account sign-in — it is the per-vendor phone + OTP screen.

**Paying is signed like the cart, and the order exists before the money does.** Instamart signs its own payment call: the cart page's `POST /api/v3/payment/get-payment-options` is answered normally, and the identical path from our own `fetch` in the same signed-in page is told `statusCode: 999, "Session expired"` (probed 2026-09-21). So payment is driven through the page and overheard from it, exactly as adding to a cart is. And `checkout/order` answers `PLACED` with `payment_status: PENDING` **before** the gateway is called, so pressing Pay and then failing leaves a real unpaid order. Two rules follow and are enforced in `server/src/worker/pay.ts`: nothing is retried once `pay_pressed_at` is set, and any order id seen on the wire is recorded even when the payment fails, so the app can say "an order was placed and not paid for" instead of "it failed". A card needs the CVV **and** the bank's OTP every time; Pay on Delivery is the only method needing nobody. **And the cart's bill is not what the checkout charges**: a cart billed at 130 (48 items + 30 delivery + 9 surge + 20 small cart, which is only 107 itself) reached the payment screen as 147, because the vendor adds fees neither we nor its own cart call spell out. So the worker stops on the payment screen, shows the vendor's own total, and waits for the household to agree to that exact number (`awaiting_ok`, `agreed_total`). Never a tolerance and never a guess: paying a number nobody saw is the thing this is built to prevent. **The card tick is a toggle and the preferred card starts ticked**: tapping it closes the row and takes the CVV box with it. Leave a chosen row alone, read "chosen" as "showing a way to pay", scope the CVV box and the Pay button to that row, and ask the household for a CVV only when the screen is asking for one. (design §19 stages 2-3)

**The CVV and the OTP are secrets and never become anything else.** They travel the way the connect OTP does: digits over TLS, sealed by the api before any write, opened only in the worker, typed, and cleared in the same statement that reads them. Never logged, never returned to a browser, never kept, and refused once five minutes old. **An order pays for a named cart, through that cart's own connection.** A connection belongs to one person and the table allows one per person per vendor, so a household with two accounts on one vendor is a household with two members - which this one is. `order_jobs.cart_job_id` says which cart is being paid for; the worker pays through that cart's connection and checks the payment screen's own item count against it (`cart_lines`). Without the link, one member's cart could be filled and the other member's account charged, and a cart quietly replaced by the vendor's own app could be paid for without a word.

**The bank's 3-D Secure page is the one surface nobody here controls.** Every bank's differs, none of it is ours, and it can change without warning. So the code's box is chosen by SHAPE, never by taking the first input: never one hidden, disabled or read-only (that is how a page marks what is not for you); one digit per box when the bank splits the code that way, as many Indian banks do; otherwise a box named for the code, preferring one long enough to hold it. That choosing is a pure function with tests (`chooseOtpBoxes`) precisely because it cannot be tried against a real bank on demand. The code is read back after typing - a half-entered code is a decline on an order that already exists - and when no box is found at all, the shapes that WERE on the page are logged, never a value.

**The verdict never comes from the call that places the order.** It answers before the money moves, so reading it back tells you nothing: ask the vendor afterwards, from its own list of the household's orders, matched by order id. And when it will not say either way, say `unconfirmed` - "we could not tell, check the app" - never "it failed". Telling a household a payment failed when it did not is how they pay twice. `ORDER_HARD_CAP_RUPEES` caps every order whatever a page asks for, and is **held at ₹2,000** while paying is being tested (raised from ₹200 on 2026-09-22 so a real shop can go through): a bug then costs the price of a carton of milk. Raise it only once a card order and a Pay on Delivery order have each gone through and been seen in the vendor's app. The SPA mirrors it as `ORDER_MAX_RUPEES` purely so the page can say so before the household taps; the api is what enforces it.

**Anything that can be pushed away must stay pushed away, and that goes through `src/lib/seen.ts`.** Three notices have come back after being dismissed - the list Home made up, the cart's "ready" line, then the Pay card - every time because the dismissal was plain `useState`, which does not survive a reload. Pushing something away and having it return on F5 is the app arguing with the household. So a dismissible notice holds `useSeen(KEY)`, never `useState`, and what it remembers is WHICH thing was dismissed (a cart id, a list's signature), never a bare "hidden" flag, so tomorrow's cart is a new notice and shows. The store is per browser and guarded: a private window or cleared data throws, every read shrugs to null and the notice simply shows again. Two dismissals on one screen need two keys - the "ready" line and the Pay card shared one flag once, so saying "yes I saw it" also took away the only way to pay. Checked by dismissing each notice, reloading, and looking.

**Units are canonical: `ml`, `g`, `piece`.** All storage and math in canonical units; display converts out. Pack labels ("packet", "tray") are per-item and must be **learned, never guessed** — a wrong pack size corrupts every prediction for that item silently. Unknown pack → ask once, store it, never fabricate a quantity. (design §8)

**`households.timezone` is required.** Depletion dates, "this week" summaries, and notification quiet hours all need it. A prediction with no timezone is meaningless.

**iOS web push needs a PWA install.** iOS Safari only delivers Web Push if the site is added to the home screen. If a tester is on iPhone, the "Add to Home Screen" step is mandatory, not optional. (design §13.1)

**The dev site on a phone: `npm run tunnel` → https://app.dev.example.com.** A named Cloudflare tunnel (`dhaniya-dev`, credentials in `~/.cloudflared`, never in the repo) to localhost:8100, as an earlier project did with dev.example.com. A plain `http://192.168…` address can't work identically: Cognito allows http callbacks only for localhost, and browsers allow push and Add to Home Screen only on https. `AUTH_REDIRECT_URI` lists every address; the Cognito app client must list the same callback and sign-out URLs. The one-time code sign-in was removed (migration 011): phones use the tunnel. The site is not installable until launch (no manifest link in `index.html`): an installed Android app replayed the Google callback.

**After changing `server/`, rebuild every server image: `docker compose up -d --build`.** The api and the worker are built from the same code; restarting one without rebuilding runs stale code (it crashed a sync once, against a new migration).

**Docker: bind every host port to 127.0.0.1, forward every env var explicitly.** Docker's iptables rules bypass ufw, so `"8100:80"` is public even when the firewall says it isn't — always `"127.0.0.1:8100:80"`. Compose has no `env_file` here: a variable only in `.env` never reaches a container unless `docker-compose.yml` forwards it. `spike/` (real order data, sessions, browser profiles) and `.env` are in `.dockerignore` and must stay there.

**DNS is Cloudflare (`example.com`), reached through a Cloudflare Tunnel** — the VM opens no inbound ports and its IP is never published. Keep Cognito Advanced Security **off** — it bills per MAU. Generate every secret with `openssl rand`/`printf`, never an editor (a Windows `
` breaks it silently; `loadConfig` refuses one).

**The insight layer runs in the BROWSER, and that is the thing standing between this app and voice.** `buildInsights`, `forecastMonth`, `comparePrices` and the running-low list are all computed in React from orders the browser fetched; the api serves rows and nothing else. An Alexa skill has no page, and neither does a scheduled notice or the AI layer when it is asked "what did we spend on chocolate?" - every one of them needs the server to hold the answer. The code is already pure and already shared with the worker, so this is relocation rather than rewriting: `GET /api/state`, `GET /api/spend`, `POST /api/ask`. Do it before building the voice layer, not during.

## Layout

**Run everything locally:** `docker compose up --build`, then http://localhost:8100 (needs `.env` from `.env.example`). Tests: `npm test` (engine), `npm --prefix server test` (unit), `npm --prefix server run test:integration` (needs `docker compose up -d postgres`).

```
docker-compose.yml          postgres, migrate (one-shot), api, worker, web — local = prod
.env.example                every variable, documented; copy to .env (gitignored)
src/                        the React SPA (Bolt prototype = the UI; data still mocked)
src/engine/                 pure TS engine: units, coverage gaps, away periods,
                            rate, confidence, projection, status. constants.ts holds
                            every tunable. Tested (npm test). Shared with the worker.
                            packs.ts: catalog pack labels → canonical quantities.
src/catalog/                pure product rules: vendor name → canonical item,
                            category, unit, emoji (rules.ts is the table to edit)
src/lib/household.ts        orders → catalog → engine → the pages' words. Runs in
                            the browser today (design §10.5).
server/                     one Node package, two containers (server/Dockerfile targets)
  src/api/                  the api: /auth/* (server-side Cognito OIDC) and /api/*
  src/auth/                 oidc.ts (ported from an earlier project), sessions, routes
  src/worker/               headless Chromium launcher (chrome.ts), heartbeat,
                            `probe` go/no-go; cart.ts fills a cart, order.ts
                            walks the checkout without buying (`order-dry-run`),
                            pay.ts pays for one (design §19 stages 1-3)
  src/constants.ts          every server tunable and fixed name
  db/migrations/            SQL, applied in order by the `migrate` service
  tests/                    unit (vitest.config.ts) + integration/ (real Postgres)
web/                        nginx image: serves the built SPA, proxies /api + /auth
docs/operations/            SIGNIN-SETUP.md: sign-in wiring, checks, failures
docs/docker-compose-explained.md   what `docker compose up -d --build` does
spike/                      Phase-0 proving ground (blinkit, instamart, merge) —
                            real data, gitignored, never in a Docker build context
```

Frontend still to change: `Connect.tsx` (pick apps) + `Auth.tsx` (per-vendor phone → OTP) become the real connect flow (design §7.10); Google sign-in is done (`SignIn.tsx`, before Connect); the mock data layer is replaced by the API; `MealPlanView` (the prototype's mock) stays, hidden from the nav and Home (`SHOW_MEAL_PLAN`) — the real one is the Cook tab (`CookView.tsx`); the shopping list page is gone (Stock is the one page); remove the unused `@supabase/supabase-js` dependency.

## Frontend conventions (from the prototype's setup)

**Mobile first.** The household uses it on phones; design and check every screen at phone width first. `cd server && npx tsx --env-file=../.env scripts/phone-shots.ts <email> <out-dir> home insights household how` saves 390 × 844 screenshots of the local stack, signed in as that local user (a session minted in the local database and deleted afterwards).

UI copy: no em dashes anywhere on screen; short, plain sentences; information, not reassurance filler ("we never see your password", "encrypted"). The app is DhaniyaMirchi. Label buttons; never ship UI that does nothing.

React 18 + Vite + TypeScript + Tailwind. Icons from `lucide-react` only. Import with the `@/` alias (`@/components/Foo` = `src/components/Foo`), never deep relative paths. Do not add UI/icon/theme packages without being asked.

## Working rules

- **All constants in one file per module.** Every tunable number, threshold, default, and magic value lives in that module's `constants.ts` (engine: `src/engine/constants.ts`), grouped and commented with the design section it implements — never inline in the logic. Only structural numbers (0, array indices, `/ 2` for a median) stay in code. New code follows this from the start. In the engine, changing any value there is a math change → bump `ALGORITHM_VERSION`.
- Tests assert behaviour, not "does not throw". The engine's correctness rules each get an explicit test — especially the prompted-purchase exclusion and the "never invent a rate" case.
- Commit per phase; conventional-commit subject; body explains **why**.
- When a design decision and the code disagree, the design doc wins — fix the code or raise it, don't let them drift.

## Reference: the Blinkit recon

The design doc's Appendix A records what was found by inspecting the logged-in Blinkit web app on 2026-09-18: the `order_history` endpoint, the cookie-vs-token auth finding (cookies alone → 401), and the data richness (name, pack size, unit, count, price, timestamp per line item). Read it before touching the Blinkit adapter — it's the ground truth the adapter is built against, and the open questions in it (token replay, token lifetime) are exactly what the Phase 0 spike must answer.
