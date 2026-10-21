# DhaniyaMirchi

*Household inventory & replenishment assistant — so your kitchen never runs out of the everyday stuff.*

**Design document**
Last updated: 2026-09-18

---

## 1. What this is

A household inventory system that learns what you buy and consume, keeps an estimated view of what's currently at home, and tells you what you're likely to need before you run out.

The defining choice: **the user does almost nothing.** They connect their grocery accounts once, and from then on the system pulls their real order history automatically, maintains the inventory itself, and tells them what to buy. No logging purchases, no ticking off lists, no scanning.

> Connect your grocery accounts once. We read what you order, learn what you consume, estimate what's left, and tell you what you'll need next.

It is not a grocery ordering app. It is an inventory and replenishment layer that sits on top of the retailers a household already uses.

---

## 2. The problem

People repeatedly buy the same household items, and keeping track of what's at home is a chore nobody wants. The recurring questions:

- Do I still have milk?
- When will the eggs run out?
- Did I already buy detergent?
- What should I add to my next order?
- What am I likely to run out of this week?

Today the process is entirely manual: notice something is low, go check the fridge and the bathroom, try to remember what was already bought, write a list, open a delivery app, search for each item, order. It gets worse when several things run low at once.

The underlying pain is not shopping. It is **maintaining awareness of household inventory and knowing when something needs replenishing**.

Every previous attempt at this kind of product dies on data entry: if the user has to tell the system what they bought and what they used, they stop, and the inventory goes stale. So the central design bet is to **remove data entry entirely** by reading the household's actual order history from the retailers.

The goal is not perfect physical stock. It is an estimate good enough to make everyday purchasing decisions, presented with honest uncertainty.

---

## 3. Product goal

Answer three questions with almost no user effort:

1. **What do I probably have at home?** — estimated from real purchases, consumption, and corrections.
2. **What am I likely to run out of soon?** — depletion estimated from observed consumption.
3. **What should I buy, and when?** — a replenishment list driven by predicted depletion.

---

## 4. Target user

Individuals or households that order groceries and household supplies online regularly — weekly or more — through Blinkit, Zepto, Instamart, and similar quick-commerce apps in India. They buy recurring products, don't want to maintain a shopping list by hand, and want a nudge before things run out.

A representative pattern:

```
2L milk       every 4–5 days
12 eggs       every week
5kg rice      every 3–4 weeks
bread         every 4 days
toothpaste    every 6–8 weeks
```

The system learns these silently from their order history.

---

## 5. Scope

**In scope**

- **Automatic ingestion of order history** from Blinkit, Zepto, Instamart via server-side connection
- Inventory engine: estimated stock, consumption rate, depletion prediction, confidence
- Shopping list generated from predictions
- User corrections
- Replenishment notifications and a weekly summary
- Natural-language purchase entry (a convenience, not the primary input)

**Out of scope**

- Autonomous shopping, and ever storing or handling card numbers, CVVs or UPI PINs. (Filling the cart, then placing an order only after the user authorises it, is planned in stages — §19 "Ordering".)
- Price comparison (live, across retailers). Tracking what the household itself paid is a later feature (§19).
- Barcode scanning, computer-vision fridge detection
- Nutrition tracking, budgeting
- Meal planning (the UI exists; it stays hidden until the inventory engine is trustworthy)

**Test group:** the author plus one friend. Two households, four users maximum. Every capacity and cost decision in this document assumes that and nothing more.

---

## 6. Product philosophy

**1. Zero effort.** The whole product succeeds or fails on this. After a one-time connection, the user should not have to enter, tick, scan, or maintain anything. The inventory keeps itself up to date.

**2. Useful uncertainty.** Say "probably running low", never "you have exactly 423 ml". False precision destroys trust faster than being vague. Every prediction carries a confidence level, and the interface widens as confidence drops.

**3. Learn silently.** Every order pulled and every correction made improves the next prediction with no configuration screen involved.

---

## 7. How ingestion works — the core of the product

This is the mechanism everything else depends on. It was validated by directly inspecting Blinkit's web app (findings in Appendix A).

### 7.1 The user's experience

```
Sign into our site with Google (Cognito)
   └─ "Connect Blinkit"
        └─ enter phone number
             └─ Blinkit texts an OTP to that phone
                  └─ enter the OTP on our site
                       └─ connected. Done forever, or until the session expires.
```

After that, the user never touches it again. Orders flow in on their own.

### 7.2 What happens on our side

The user has no Blinkit API to give us, and the order history lives behind an authenticated session in their browser. So we authenticate on their behalf, server-side:

```
Our backend receives {phone}
   → drives Blinkit's own login endpoint: request OTP
   → user's phone receives the OTP (we cannot see it)
   → user types OTP into our site
   → our backend submits {phone, OTP} to Blinkit → receives a session token
   → token encrypted (vault key, §14.3) and stored in the vendor_connections vault
   → a scheduled worker calls POST /v1/layout/order_history on a cadence
   → new orders (deduped by vendor order id) become purchases
   → the inventory engine recomputes
```

The order data is already structured JSON — product name, pack size, unit, quantity, price, timestamp (Appendix A). No OCR, no LLM, no parsing. We map fields to our schema.

### 7.3 The one unavoidable touchpoint: OTP relay

Blinkit sends the OTP to the **user's** phone. We cannot intercept it. So the user has to type the OTP each time we authenticate a session. How often that is depends entirely on the token's lifetime:

- If Blinkit issues a **long-lived or refreshable** token, we refresh it silently and the user enters an OTP **once, ever.**
- If it issues a **short session**, the user re-enters an OTP whenever it dies — surfaced as a one-tap "Reconnect Blinkit" prompt, ~15 seconds.

The token lifetime is not yet known (see the spike, §7.5). The design handles both cases: silent refresh where possible, a clean reconnect flow where not.

### 7.4 Per-vendor adapters

Each retailer gets an adapter behind one interface:

```
interface VendorAdapter {
  requestOtp(phone): Promise<OtpHandle>
  submitOtp(handle, code): Promise<VendorSession>   // returns token(s)
  refresh(session): Promise<VendorSession | null>   // null = must re-OTP
  fetchOrders(session, since): Promise<RawOrder[]>
}
```

Blinkit, Zepto, Instamart each implement it. One vendor breaking never takes another down. Each adapter reports health (last successful sync) so a silent failure is caught, not left to quietly poison the model.

### 7.5 The go/no-go spike

Run before any product is built on top. Status: **partially run (2026-09-18), and it changed the architecture.** The spike lives in `spike/blinkit/` (capture → replay/probe). Full results in Appendix B.

**What it settled:** Blinkit's edge does **client-fingerprint bot detection**. The same `order_history` request — same account, same token, same home IP, byte-identical headers — returns:

- **403** with a 561 KB HTML block page when sent from a raw HTTP client (Node `fetch`). It never reaches the auth layer.
- **200** with the full order JSON when sent from inside a real browser engine (a `fetch` inside a logged-in Chrome via Playwright).

So the token and the IP were never the obstacle; the **client fingerprint** is. This forces one architectural decision and rules out another:

- **The worker must drive a real browser engine** (Playwright/Chromium) and issue `order_history` from inside the page context. A lightweight server-side HTTP client cannot be used at all. This is why the worker is a persistent headless-Chrome process on a VM, not a Lambda with `fetch` (§14.1) — the spike vindicates that choice rather than merely preferring it.
- The token is **opaque, not a JWT**, so its lifetime cannot be read and must be measured empirically (keep a captured session, replay until it 401s). That elapsed time sets the OTP-reconnect cadence (§7.3).

**What is still open — both must pass before this is fully GO:**

1. **Headless.** The 200 was from *headful* Chrome. The worker runs headless, whose fingerprint differs and may be blocked. Testable locally: `HEADLESS=1 npm run probe`.
2. **Datacenter IP.** The 200 was from a home residential IP. Bot detection usually weighs IP reputation alongside fingerprint, so a datacenter IP may be challenged even with a real browser. Testable only on the Oracle box: run the probe there.

If headless is blocked: run a headful Chromium under a virtual display (Xvfb) on the worker. If the datacenter IP is blocked: route the worker through a residential proxy, or fall back to a user-installed browser extension that reads orders in the user's own session. These are heavier and are designed only if the follow-up tests force them.

**Instamart is stricter (Appendix C).** Swiggy's edge blocks a *Playwright-launched* Chrome at the first page load ("Your request looks automated") — before login, regardless of headers — and instamart.in also runs an AWS WAF challenge. What works: launching the installed Chrome as a plain process (no `--enable-automation`, no webdriver flag) and only *attaching* to it over CDP, then calling the API with `fetch` inside the page. So the worker must launch its browser that way for every vendor, not via `chromium.launch()`. The headless and datacenter-IP questions above apply to Instamart too, and are likelier to bite there.

**Until this spike passes, the automatic-ingestion product is unproven.** It is therefore the first real engineering task (§16).

### 7.6 Security

Holding a live authenticated session to an account with a saved payment method is a real responsibility, treated as one:

- Tokens are encrypted at rest (AES-256-GCM under the vault key, §14.3), decrypted only in the worker at fetch time, never logged, never sent to the browser.
- We store **line items, quantities, and dates.** Phone-on-file and card digits appear in the order pages and are discarded on ingest, never persisted. The delivery address is *read* at ingest to scope orders (§7.9) but only the household's chosen tracked address is stored; per-order addresses are not otherwise retained.
- The database credential is tightly scoped; the token vault is a separate concern from the rest of the app data.

### 7.7 Terms of service

Automated access to Blinkit/Zepto/Instamart using a user's own session is against those retailers' terms. For a private two-user test this is a low practical risk and an accepted one. It is **not** a foundation to scale publicly without legal review. Stated here so the decision is explicit; the build proceeds.

### 7.8 Natural-language entry as a convenience — the AI layer (built 2026-09-19, phases 2–4 in §9.12)

Typed entry ("bought 2L milk") remains available for anything ingestion misses — an offline purchase, a different shop. It is a convenience path, not the product's spine, and the product is fully useful without ever using it.

The first thing the AI layer reads is **household facts** (§9.12): "some friends are staying with us next week", "my wife and mother-in-law have tea twice a day, half a glass of milk each". Rules:

- **The model only reads text into proposed facts**, in a fixed JSON shape that is validated before use; anything outside the shape is rejected, never half-used. It never computes: it returns the parts ("2 people × twice a day × half a glass") and code multiplies them. A measure the household hasn't defined yet ("glass", "cup") becomes a question ("How many ml is a glass?"), answered once and stored per household (`household_measures`), never guessed. A missing end date comes back as open, and the page asks for it with a default the code proposes.
- **Nothing counts until the person confirms it.** Proposals show as cards: Confirm, Edit, Discard. A confirmed fact keeps the person's own words (`said`).
- **What the model sees**: the text, today's date, the household's timezone, who lives there now, and the names of the household's items (so "tea milk" maps to `milk`). Never orders, emails, phones or addresses. The page says in one line that the text goes to the AI provider.
- **Where it runs**: the worker. The api can seal secrets but never open them (§14.3), and a household may use its own OpenAI key, so the api queues a request row and the worker makes the call (the same pattern as connect, §7.10).
- **Providers, behind one interface** (like vendor adapters, §7.4): **OpenAI** for users (their own key, or the free allowance on ours, §19); **Anthropic (Claude)** for our own testing (`LLM_PROVIDER=anthropic`); **recorded** for automated tests, answers written into fixtures, no live call. A small, cheap model tier each.
- **An accuracy set** of real-style sentences (guests, tea, dogs, away, avoid) with the facts they should give runs as a test against recorded answers and, on demand, against the live provider.
- **No AI available** (no key, allowance used up, provider down): the same facts are entered with plain forms. Nothing depends on the model.

**Guardrails (built 2026-09-19).** The model is useful and untrusted. Every AI call, now and in any later AI feature, goes through `server/src/ai/guard.ts` and the checks around it. A new AI feature adds its own checks there before it ships.

| Where | Guardrail | Why |
|---|---|---|
| Site | `AI_ENABLED=false` stops every call, households' own keys too; the forms keep working | one switch if anything looks wrong |
| Going in | phone, card, Aadhaar and other long numbers, emails, UPI IDs, links, OTPs and PINs, PAN numbers and API keys are cut from the note **before it is stored or sent**; the page says what was cut | the model never needs them, and the note is quoted in proposals |
| Going in | invisible characters (zero-width, direction overrides) removed | the model reads what the person sees |
| Going in | the note is fenced (`<note>…</note>`, a closing tag inside is removed) and the instructions say it is data, never instructions | prompt injection from the note |
| Going in | item names from the page kept only if name-like; the worker cleans the row again | the page is a client, not trusted |
| Provider | OpenAI `store: false`; output capped at 1,500 tokens; 60 s timeout | nothing kept on their side; cost of a runaway answer bounded |
| Coming back | strict shape and ranges (schema.ts); anything else → "unreadable", nothing half-used | |
| Coming back | **numbers held to the note**: a number the note never said is dropped and asked. Allowed without saying: 1 ("a cat"), 2 where the note names a pair ("my sister and her husband"), 0 where it says none, and for "each" the household's own head or pet count. A start date not said → the fact is dropped and asked; an end or length not said → asked with a default; an amount not said → kept as "every day" and asked | "never invent a number" enforced in code, not only asked of the model |
| Coming back | "your words" must be in the note, else the note itself is quoted | a fabricated quote would be stored as the household's own words |
| Coming back | item and measure names must look like names; questions are plain text, at most 3, 200 characters each, no links or contact details, no dashes the app's copy doesn't use | the model's text is shown on the page |
| After | code computes every number (resolve.ts); every fact passes the form's checks (`validateFact`); nothing counts until confirmed | |
| Limits | one note in flight per household; 20 notes an hour per person; 60 a day per household, on any key; 5 key checks a day; our key's budget 500 calls a month for the whole site on top of 50 per household | a stuck page or a stolen session can't run up a bill; our key can't be used to test stolen keys |
| Keeping | the note is cleared once read; proposals (which quote it) are cleared after 40 days; `ai_calls` holds counts only; logs hold counts of what the guard held back, never words | a household's words are kept only while needed |

Tests: `server/tests/ai-guard.test.ts` feeds bad answers on purpose (made-up counts, dates, quotes, names, links); the accuracy set passes the guard untouched; `worker-ai` and `ai-api` integration tests cover the limits, the switch, the site budget and clearing.

### 7.9 Scoping to a tracked address

A single grocery account is used for more than one home — a user orders to their own place, but also to a friend's or a parent's. Those other orders are not this household's consumption and must not enter the model, or they inflate rates and trigger false replenishment.

So a connection is **scoped to one or more delivery addresses the user chooses.** At connect time (once history is pulled), the app shows the distinct delivery addresses seen across the account's orders and asks the user to pick which belong to this household. Only orders delivered to a tracked address become purchases; the rest are ignored — kept in `raw_orders` as unprocessed, never projected into inventory.

The order's delivery address is available per order from the detail response (confirmed in the spike — the `order_summary_details` card), so this filter is a straightforward ingest-time check. Deferred to a later phase (§16); until it lands, the test group simply tracks a single home and mis-addressed orders are a known, tolerated source of noise.

---

### 7.10 Connect and first import — headless, in the background, with an honest ETA

This is a website. The user never sees a vendor page or a browser window: they type their phone number and OTP **on our page**, and everything else happens on the server, headless.

**Connect flow.**
```
User enters phone on our page
   → worker opens a headless Chrome session for that vendor
   → worker calls the vendor's own send-OTP endpoint from inside the page
        (Instamart: /api/instamart/auth/send-otp — Appendix C)
   → user types the OTP on our page (it expires in minutes — the page says so)
   → worker calls verify-OTP → session (cookies + token) captured
   → session encrypted into the vault (§7.6) → import job queued
   → page switches to the progress view
```

**Cancelling.** Until the typed code is with the vendor, the user can cancel ("Wrong number? Change it", or Cancel while the code is being sent): the attempt ends as `cancelled`, its sealed phone and OTP are cleared, the worker stops and closes its browser, and a new attempt can start at once. Cancel is by vendor, not attempt id, so a page that lost the id (a reload, another tab) can still clear an attempt that would otherwise block the next one as "already in progress". It is refused while a code is being checked (`verifying`): the result is seconds away, and cancelling then would race a connection being saved. An SMS the vendor already sent can't be recalled — cancelling stops everything after it.

**Headless is proven** (2026-09-18, home IP) for both vendors, with one launch recipe: the installed Chrome spawned with `--headless=new` and a **normal Chrome user agent**, attached over CDP — never a Playwright-launched browser. Blinkit rejects the default `HeadlessChrome` user agent (403 even on the page load) and accepts a normal one; Instamart accepts both. A stored session restored into a fresh browser profile works, which is how the worker resumes from the vault. The datacenter-IP question (§7.5) is still open.

**The first import is long — so it runs as a background job the user can leave.** Measured this session:

| Step | Measured cost | Real history (this household) |
|---|---|---|
| Instamart order list | ~2.5 s per page of 20 | a year of orders → **~30 s** |
| Instamart pack lookup | ~5–6 s per distinct SKU (catalog search) | ~600 SKUs → **~55 min** |
| Blinkit order list | ~2 s per page of 10, one 429 back-off (~15 s) after ~40 pages | a few hundred orders → **~2 min** |
| Blinkit order details | ~3.2 s per order | a few hundred orders → **~25 min** |

Vendors run in parallel (separate adapters, §7.4); within a vendor, calls are sequential and paced (rate limits). So a first import is **~25 min to ~1 h** for a heavy household; later syncs fetch only new orders and take seconds.

**Two milestones, not one progress bar:**
1. **"Ready to use"** — orders listed and the most-bought items resolved. Instamart pack lookups run in order of **purchase frequency**, so the items that drive predictions (milk, curd, vegetables) resolve first; ~100 SKUs covers most of the value and takes ~10 min. The app becomes usable here, with a note that rarer items are still filling in.
2. **"Complete"** — every order and SKU processed. Predictions refine silently as the rest lands.

**The ETA is computed, never a canned number.**
- Almost all the time is pack lookups (measured 2026-09-19: 454 lookups took 15.7 min, 347 took 20.0 min; reading the order list under a minute). So ETA = lookups left × (measured lookup time + the pause after each). The lookup time is the moving average of this import's recent lookups, else the last import's measured average, else a default. (The first version left the pause out and ran ~2.5× optimistic.)
- While the order list is still being read, the lookups known so far are those needed by the orders read so far, so the page says "at least 12 min left" and the number grows as orders arrive. Before any order is read it says "working out how long this takes", never a canned range (the old fixed "usually 20–60 minutes" is gone, 2026-09-19).
- Once the list is fetched, the remaining work is known and the estimate is the real one ("about 9 min left"), recomputed on every poll.
- A sync that finds nothing new says "Up to date. No new orders.", never "0 orders read" (`/api/imports` says whether a run is the `first` import or a `sync`).
- A back-off or retry shows as such ("Blinkit is rate-limiting us — pausing 15 s"), not as a frozen bar.

**The user can leave.** The job lives on the server, not in the tab: progress is written to an `import_jobs` row the page polls. Closing the tab changes nothing. When "Ready to use" and "Complete" are reached, the user gets a Web Push / email (§13) — "Your Instamart history is in — 120 orders". Reopening the site shows the current state.

The page says so in words: the import screen reads "You can close this page — the import runs on our server", gives the ETA ("at least N min" while orders are read, then the measured estimate), and offers **"Explore while we work"**. While an import runs, a slim bar across the top of the app shows its percent and time left; when it finishes during the visit, the bar says "All done" once. A returning user with a connected app lands in the app, not on the connect screen. A stopped import shows "tap to fix it": **Try again** (`POST /api/imports/:vendor/retry`, continues where it stopped) or **Reconnect** when the vendor logged us out. Progress comes from `GET /api/imports` — the latest run per connection, household-scoped.

**Failure and resume.** Each stage caches what it has (proven in the spike: orders and packs are cached per SKU/order), so a worker restart or a vendor hiccup resumes rather than restarts. A dead session mid-import pauses the job as "needs reconnect", with the progress kept.

**`import_jobs`**
```
id              uuid pk
household_id    uuid fk
vendor          text
status          text     -- 'queued' | 'listing' | 'details' | 'packs' | 'ready' | 'complete' | 'needs_reconnect' | 'failed'
orders_total    integer null
orders_done     integer
skus_total      integer null
skus_done       integer
avg_step_ms     integer null  -- moving average, drives the ETA
eta_at          timestamptz null
ready_at        timestamptz null
completed_at    timestamptz null
last_error      text null     -- never contains a token (§7.6)
started_at      timestamptz
updated_at      timestamptz
```

All pacing delays, back-off steps, the ETA window size and the typical-range defaults live in the worker's constants file.

## 8. Units and pack sizes

Consumption arithmetic is meaningless until "2 packets of bread" and "1kg of bread" can be reconciled. Because ingestion delivers pack sizes directly (Blinkit gives "15 ml x 1"), most items resolve automatically — this layer mostly handles typed entry and the occasional odd unit.

### 8.1 Three canonical units

Every item is measured in exactly one of `ml`, `g`, or `piece`. All storage and all math happen in canonical units. Display converts back out.

### 8.2 Fixed conversions

```
litre, L         → ml     × 1000
millilitre, ml   → ml     × 1
kilogram, kg     → g      × 1000
gram, g          → g      × 1
dozen            → piece  × 12
piece, pcs, nos  → piece  × 1
```

### 8.3 Pack labels are per-item and must be learned

A "packet" of bread and a "packet" of milk have nothing in common. The `item_packs` table holds each household's answer.

Resolution order for a parsed `(quantity, unit)` pair:

1. Unit is in the fixed table → convert. Done.
2. Unit matches an `item_packs.pack_label` for this item → `quantity × canonical_qty`. Done.
3. Unit matches a shipped seed default → create the `item_packs` row marked `source='default'`, convert, surface it in the UI as editable.
4. Otherwise → **ask, once.** Store the answer as `source='user'`.

Never guess silently, and never record a purchase with a fabricated quantity. A wrong pack size corrupts every prediction for that item indefinitely.

Seed defaults (India-oriented, all user-editable):

```
bread    packet / loaf    400 g
milk     packet           500 ml
milk     bottle          1000 ml
eggs     tray              30 piece
eggs     dozen             12 piece
rice     bag             5000 g
atta     bag             5000 g
oil      bottle          1000 ml
curd     cup              400 g
```

### 8.4 Display

Never render canonical units raw. `1450 ml` becomes "~1.5 L". `12 piece` of eggs becomes "12 eggs". Precision follows confidence: high confidence earns a decimal, low confidence earns a word.

---

## 9. The prediction engine

### 9.1 Why purchase intervals alone don't work

The obvious approach — measure the gap between purchases and call that the consumption rate — fails for two reasons.

**It's circular.** If the system tells you when to buy and you buy when told, the interval between purchases becomes a function of the system's own prediction. The model confirms itself forever with nothing to correct it, and accuracy metrics end up measuring the system against its own output.

**It's biased.** Even with no prompting, purchase interval is not consumption rate. People restock before running out, buy in bulk, stock up before travel, and throw things away. Interval-derived rate describes how fast someone *restocks* — systematically slower than how fast they *consume*.

The engine therefore ranks its evidence and treats purchase intervals as one weak signal among several.

### 9.2 Signals

| Signal | Source | What it yields | Trust |
|---|---|---|---|
| **S1 Depletion** | user says "finished it" | Exact consumption over a known window: `qty_at_window_start / days_elapsed` | **1.00** |
| **S2 Level assertion** | user says "about half left" | Partial consumption: `(qty_before − qty_asserted) / days_elapsed` | **0.80** |
| **S3 Unprompted purchase interval** | consecutive orders we did *not* suggest | Restock cadence, biased low: `qty_prev / interval_days` | **0.50** |
| **S4 Prompted purchase interval** | an order we asked for | **Excluded from rate estimation.** Recorded, used only for accuracy scoring. | **0.00** |
| **S5 Onboarding prior** | user says "milk, about every 4 days" at setup | Cold start only; dropped once two real signals exist | **0.25** |

The `purchases.prompted_by` column carries the S3/S4 distinction. When a user acts on a suggestion, that purchase is linked to the notification that prompted it and kept out of the rate math. This breaks the feedback loop.

A `discarded` event (thrown out, expired) reduces stock but contributes **nothing** to the rate — counting waste as consumption inflates the rate and causes over-ordering.

### 9.3 Rate estimate

A recency-weighted mean over S1, S2, S3 and S5 observations, half-life 30 days:

```
w_i   = trust(signal_i) × 2 ^ (−age_days_i / 30)
rate  = Σ(w_i × rate_i) / Σ(w_i)
```

Guards:

- Once three or more observations exist, discard any `rate_i` outside `[0.2 × median, 5 × median]`. One bulk party purchase should not reset the model.
- If only an S5 prior exists, confidence is `low` and never higher.
- If no signals exist, `rate` is null and status is `UNKNOWN`. **Never borrow a rate from another household or a category default.**

### 9.4 Confidence

```
n   = count of observations, excluding S5 priors
cv  = stddev(rate_i) / mean(rate_i)

high     : n ≥ 4  AND  cv < 0.30
medium   : n ≥ 2  AND  cv < 0.60
low      : n ≥ 1
unknown  : n = 0
```

Then demote one level if:

- Last purchase is older than `3 × (qty_at_purchase / rate)` — the model has lost the thread.
- The user has corrected this item more than twice in the last 30 days.

And cap at `low` permanently when `cv > 0.8` across four or more observations — bursty items (ice cream, party supplies) are not routine. For these, widen the window, avoid aggressive notifications, and lean on a manual threshold.

### 9.5 Cold start

Automatic ingestion largely solves cold start: connecting an account pulls **months of real order history in one shot**, so predictions have real signal from day one.

For anything not covered, onboarding also asks:

> What do you buy regularly? Roughly how often?
> `Milk  [ every 3–4 days ▾ ]`

Each answer creates an item and one S5 prior, marked low confidence, replaced by real signals as they arrive.

### 9.6 Stock, depletion, and status

```
qty(t)        = Σ purchases − Σ explicit consumption − (rate × days since last event)
                floored at 0

days_remaining = qty / rate

band           = { high: 0.15, medium: 0.35, low: 0.60 }[confidence]
days_low       = days_remaining × (1 − band)
days_high      = days_remaining × (1 + band)

buffer_days    = { high: 1, medium: 2, low: 3 }[confidence]
reorder_days   = item.reorder_lead_days + buffer_days
```

Status, evaluated top down:

```
UNKNOWN       rate is null or confidence is 'unknown'
LIKELY_OUT    days_low ≤ 0
BUY_SOON      days_low ≤ reorder_days
RUNNING_LOW   days_low ≤ reorder_days × 2
AVAILABLE     otherwise
```

Thresholds test `days_low` — the pessimistic end — so lower confidence produces *earlier* warnings. Being reminded early is cheap; running out is not.

**Superseded for the running-low list (2026-09-19, `ALGORITHM_VERSION` 5, `src/engine/due.ts`).** The backtest (§17) showed the stock-based status above flags too much on real history (23 items a day, 29% bought within 4 days) and never lets a flag go: once projected stock hits zero an item stays "likely out" for months (papad was flagged all 91 replayed days and never bought). The buying rhythm is irregular (onion gaps from 3 to 74 days), so one rate can't describe it. The status now answers the question the list is scored on — *will the household buy this in the next few days?* — from the household's own gaps between shopping trips:

```
trips       = purchases, with any within 12 h of a trip's first merged into it
gaps        = days at home between consecutive trips (gaps touching a prompted
              trip, or overlapping a coverage gap, are dropped; away days removed)
w_i         = 2 ^ (−age_days_i / 60)
s           = days at home since the last trip (prompted or not)
risk        = Σ w_i over gaps longer than s
P(h)        = Σ w_i over gaps in (s, s + h]  /  (risk + 1)

UNKNOWN      fewer than 2 gaps (never a borrowed rhythm)
STOPPED      no past gap is longer than s: stopped, or buys it elsewhere; never flagged
BUY_SOON     P(4 days) ≥ 0.25
RUNNING_LOW  P(8 days) ≥ 0.25
AVAILABLE    otherwise
```

On a household's Instamart history (about a year, 90 days replayed): 11.2 flags a day, 43% bought within 4 days, top 3 62%, recall 58%; on the merged Instamart + Blinkit spike history 15.0 a day, 40%, 68%, 54%; on two members' combined orders 17.9 a day, 45%, **81%**, 63% (it was 34.7, 29%, 73%, 71%). Each constant's measurement is in `src/engine/constants.ts`. §9.1's circularity rule holds: a gap that starts or ends at a prompted purchase never feeds the estimate, though the prompted purchase still counts as "last bought". The stock estimate above is unchanged and still gives "about X left"; corrections (§12.4), once stored, are expected to override the rhythm for an item. A line with an unknown pack now has a status too: its dates are real even when its quantity isn't.

`manual_reorder_qty`, when set, overrides everything: `BUY_SOON` fires when `qty ≤ manual_reorder_qty`, the escape hatch for irregular items.

### 9.7 Presenting uncertainty

| Confidence | What the user sees |
|---|---|
| high | "Runs out in about 2 days" |
| medium | "Runs out in 2–4 days" |
| low | "Probably runs out this week" |
| unknown | "Not enough history yet" |

Never render a number the model doesn't support.

### 9.8 Expiry

Optional, manually entered per purchase. When present:

```
effective_depletion = min(consumption_depletion, expiry_date)
```

When expiry binds first, say so: "Yogurt expires Friday — you probably won't finish it." Seed of the waste-reduction feature later.

### 9.9 Recompute

`algorithm_version` is an integer constant in the engine, bumped on any math change. Recompute runs on write (one item), nightly (all items, because `qty(t)` decays with wall-clock time), and on version bump (full rebuild from the event log).

### 9.10 Tolerance of gaps

Even with automatic ingestion, an adapter can break for days before it's noticed. The engine must degrade rather than lie: a missing order lowers confidence and widens ranges; it never silently halves the rate. This is why the engine ranks signals and floors confidence on stale data (§9.4) rather than trusting whatever it has.

**Coverage gaps (implemented, `src/engine/coverage.ts`).** Some stretches of history are known to be incomplete: vendors serve limited windows (Instamart: a rolling 12 months — Appendix C), and an adapter can be down. The engine takes these as input — `HistoryGap { from | null, to }`, half-open — and applies one rule:

- An interval between two consecutive (unprompted) purchases that **overlaps a gap is dropped**, not averaged in. Purchases may be hiding inside it, so it would read as slow consumption. An interval that merely touches a gap (ends at `from`, starts at `to`) is kept.
- Dropped intervals are counted (`Prediction.droppedForGaps`), so the degradation is visible. If none remain, the rate is `null` and the status `UNKNOWN` — never a rate borrowed from outside the covered window (§9.3).
- The household's history is complete only from the **latest** coverage start across its connected sources (`coverageGaps()`): before Instamart's window opens, Instamart orders exist but are invisible, even though Blinkit reaches further back. A source's coverage start is the oldest order it served.

On the real merged history this drops 1,121 intervals before 2025-09-20. Rates barely move (the 30-day half-life already down-weights old data) but intervals, confidence and the outlier filter stop being skewed by the invisible months — e.g. atta "every 148 days" → 45, eggs 14.6 → 8.1. Household-away periods reuse the idea with different semantics — §9.11.

### 9.11 Household away (vacation, out of town) — engine built (`src/engine/away.ts`); UI, table and notifications not yet

When the household goes away, nothing at home is consumed and nothing is ordered. Read naively that gap looks like slow consumption, and the app keeps nagging about restocks nobody can receive. Away is an input the engine honours, not a gap it has to guess around.

**How away differs from a coverage gap (§9.10).**

| | Coverage gap | Away period |
|---|---|---|
| Purchases in the window | happened, **invisible** | **none** (nobody home) |
| Consumption in the window | continued, unknown | **none** |
| Interval spanning it | **drop** — can't know what hid inside | **subtract** the away days — the pause is known |

So away is more informative than a gap, and the engine should use it rather than throw the interval away. Except for perishables:

**Rate — intervals that overlap an away period.**

- **Non-perishable** (rice, atta, detergent, toothpaste): the interval counts only days at home. `effective_interval = interval − away_days_inside_it`. A 30-day atta interval with a 10-day trip inside it is 20 days of use. If nothing is left (the purchases bracket the trip exactly), drop it.
- **Perishable** (milk, curd, paneer, bread, produce, meat): **drop** the interval. Milk bought the day before an 8-day trip mostly spoils, then the household rebuys on return — subtracting would turn "1 L over 9 days" into "1 L in 1 day" and inflate the rate eightfold. What spoiled was discarded, and discarded never feeds the rate (§9.2).
- Perishability is an item property: category default (`dairy`, `produce`, `bakery`, `meat` = perishable), overridable per item. The engine takes it as input (`ItemInput.perishable`); it never infers it.
- The pre-trip stock-up needs no extra rule: its purchases open an interval that spans the trip, handled above.

**Stock projection — while away and on return.**

- Stock decays by `rate × days at home`, not wall-clock days. While away, projected stock (and therefore status) is paused — nothing is being used.
- **Perishables spoil anyway.** If an away period between the last purchase and now is at least the item's shelf life, its stock is treated as **gone at the away end** (0), so it shows as LIKELY_OUT on return. Shelf life uses conservative category defaults (dairy/meat 3 days, bakery/produce 5 days), overridable per item. Assuming it spoiled leads to an earlier restock nudge — cheap if wrong. Assuming it survived leads to someone drinking week-old milk. This is computed in the projection — **no synthetic `discarded` events** are written to the log: the log holds only what really happened or what the user said.
- A perishable away for less than its shelf life is simply paused, like a non-perishable.

**What the user sees.**

- **While away:** a banner — "Away until 12 Oct — reminders paused". No restock notifications.
- **Before leaving** (a trip scheduled ahead): no "buy soon" for perishables projected to run out during the trip — they'd spoil before use. Non-perishables behave normally.
- **Welcome back:** the evening before the planned return (respecting quiet hours, §13.2), one notification: the restock list, perishables first — they're what's gone.
- An open-ended away ("until I'm back") ends when the user taps "I'm back", or automatically at the first order delivered to the tracked address — which is itself the signal the household is home.

**How away periods are known.**

- **Primarily, the user says so:** "I'm away from … until …", scheduled ahead or started now, open-ended allowed. Past trips can be added after the fact — rates then recompute retroactively (it's just an input to a rebuild).
- **The app may suggest, never assume:**
  - *Household-wide silence*: no order to the tracked address for longer than the household has ever normally gone (above ~P95 of its own gaps between orders). One item going quiet is normal; everything going quiet at once is not. → "No orders since 3 Oct — were you away?"
  - *Orders going elsewhere*: orders arriving at a non-tracked address (§7.9) while home gets none.
  - A confirmed suggestion becomes an away period like any other. An unconfirmed one changes nothing.
- An inferred-but-unconfirmed pause must never be applied silently: a wrong "away" would freeze a real depletion and let the household run out.

**Out of scope for v1** — explicitly, so they aren't half-built: **partial household** (one member travels — consumption drops but doesn't stop; later an occupancy factor), **guests** (the opposite spike), and trips shorter than a day (noise; ignore).

**Engine contract.** `analyze(item, now, { gaps, away })` with `away: { from: Date, to: Date | null }[]` (`to: null` = ongoing, treated as `now`), plus `ItemInput.perishable` and `ItemInput.shelfLifeDays`. Pure — the caller loads away periods. Bumps `ALGORITHM_VERSION`.

### 9.12 Household facts: who lives here, guests, pets, regular use (built 2026-09-19)

Order history can't know that the mother-in-law moved in, that friends arrive on Tuesday, or that the dogs eat two boiled eggs a day. The household can say so. Each thing it says is a **household fact**: dated, structured, kept with the person's own words, append-only (a change is a new fact; withdrawing one is recorded, never a delete), and read by the engine as input like away periods.

| Kind | Details | Engine effect |
|---|---|---|
| `people` | how many live here, from a date | people count from then on |
| `guests` | how many extra people, from a date to a date | people count + guests inside the window, **including future windows** |
| `pets` | dogs, cats, other, from a date | pet-food count from then on |
| `regular_use` | item, for people or pets, amount a day (or just "every day") | a minimum daily use of that item |
| `away` | from, to (§9.11) | the away rules |

**Size scaling.** A gap learned while 2 people lived here is rescaled to the household the gap is being used for: `gap × size(then) / size(ahead)`, where `size(ahead)` is the largest household in `[now, now + horizon]`, so guests arriving in two days flag items now. Pet food scales with pets, everything else with people. Unknown size at either end → no rescaling; never an invented head count. The stock estimate scales rates the other way (`rate × size(now) / size(then)`). Measured on the household's combined history (4 people from Aug 3): top 3 81% → 84%, recall 64% → 67%, precision 44% → 42%. A small gain on past changes, because the rhythm's 60-day half-life already adapts in weeks. The value is in future changes, which history cannot know.

**Regular use.** "The dogs eat 2 boiled eggs a day" is a known minimum: the last purchase lasts at most `qty / perDay` days, so the item is due once that is within the horizon, whatever the rhythm says; with no rhythm yet, the stated amount is the rate (it is the household's own statement, not a borrowed one, §9.3). Any regular use (even "every day", no amount) means the item is never treated as stopped. An amount is stored in canonical units; code computes it from its parts (quantity × measure × times a day × people) — "half a glass" needs the household's glass size first (`household_measures`), asked once, never guessed.

**Where facts come from.**
1. **Phase 1, forms** — the Household page: who lives here (people, pets, since when), who is staying (guests, from, to), regular use (item, for whom, how much a day, own words). The first import asks "How many people live here?" while it runs; Home asks until it's answered.
2. **Phase 2, the AI plumbing** (§7.8) — providers, key, allowance, the parse request, the accuracy set. No new screen but the AI settings.
3. **Phase 3, "Tell us what's changing"** — one box on Home; text → proposed fact cards → Confirm / Edit / Discard, with questions back when something is missing.
4. **Phase 4, the app asks** — code notices ("Milk use doubled since Aug 3. Did someone move in?", "Are your friends still staying?" the day a guest window ends); the model only words it, if at all. A suggestion changes nothing until confirmed.

**Phase 4 as built** (`src/lib/suggestions.ts`, `AskCards.tsx` on Home). No model: code notices, code words it.
- **Buying changed.** Over the last 20 full weeks, each of the 10 most-bought staples with a known pack gets its weekly amount (canonical units) over its own average, so milk and eggs weigh the same; the household index is their mean. The week with the biggest change in the last 8 weeks (≥ 6 weeks before, ≥ 3 after) is asked about if after/before ≥ 1.5 or ≤ 0.6. Amounts, not trips: on the household's own data trips rose ~1.3× after Aug 3 while the amount rose 2.1–2.7×. Not asked when a people/guests/away fact already covers that week, or when a new account's orders started then (a member joining reads as more buying). Answers: someone moved in/out (a people fact from that week, and always the count before it, which corrects an earlier undated count), guests or away (the Household page), "we buy more here / elsewhere now", or no.
- **Guests leaving.** A guests fact that ends today: "still staying?" → a new fact extending the stay.
- **Were you away?** No order for longer than the household's 95th-percentile gap (at least 7 days, 20 orders of history): asked, never assumed, because a wrong away freezes real use. While asked, "buying changed" is not.
- "No" is remembered in the browser: a buying change for 60 days by direction (its week shifts as weeks pass), the others for good.

**Engine contract.** `due(purchases, now, { gaps, away, sizes }, horizon, { scalesWith, regular })` and the same `sizes`/`scalesWith`/`regular` for `analyze`. `sizes` is the step timeline built from the facts (`sizeTimeline()`); `regular` is the item's regular-use facts. `ALGORITHM_VERSION` 6.

**Tests to write first:** non-perishable interval shortened by the away days; perishable interval spanning away dropped; interval exactly bracketing a trip dropped; projection paused while away (status unchanged between away start and end); perishable at 0 after an away ≥ shelf life, and paused after a shorter one; ongoing away (`to: null`) treated as until `now`; no away → identical output (regression).

---

## 10. Data model

### 10.1 Reference tables

**`households`**
```
id            uuid pk
name          text
timezone      text          -- IANA, e.g. 'Asia/Kolkata'. Required.
created_at    timestamptz
```

**`users`** — `id` is the Cognito `sub`.
```
id            text pk
email         text
name          text
created_at    timestamptz
```

**`household_members`**
```
household_id  uuid fk
user_id       text fk
role          text          -- 'owner' | 'member'
primary key (household_id, user_id)
```

**`household_invites`** (migration 012) — someone the owner asked to join (§19 "Multi-member households").
```
id            uuid pk
household_id  uuid fk
email         text          -- lowercased; matched against the invitee's VERIFIED email
invited_by    text fk users
created_at    timestamptz
expires_at    timestamptz   -- 14 days
unique (household_id, email)
```

**`items`** — canonical household products.
```
id                    uuid pk
household_id          uuid fk
name                  text          -- 'milk'
display_name          text
emoji                 text
category              text
canonical_unit        text          -- 'ml' | 'g' | 'piece'
preferred_brand       text null
preferred_pack_label  text null
reorder_lead_days     numeric default 1
perishable            boolean null  -- null = category default (§9.11)
shelf_life_days       numeric null  -- null = category default (§9.11)
manual_reorder_qty    numeric null
notify_enabled        boolean default true
snoozed_until         timestamptz null
archived              boolean default false
created_at            timestamptz
unique (household_id, name)
```

**`item_packs`**
```
id             uuid pk
item_id        uuid fk
pack_label     text
canonical_qty  numeric
source         text        -- 'user' | 'default' | 'inferred'
unique (item_id, pack_label)
```

### 10.2 Vendor connection tables

**`vendor_connections`** — one per user per retailer. The encrypted token vault.
```
id                 uuid pk
household_id       uuid fk
user_id            text fk
vendor             text          -- 'blinkit' | 'zepto' | 'instamart'
phone              text          -- the number used to log in
session_encrypted  bytea         -- AES-256-GCM under the vault key (§14.3)
vault_key_id       text          -- which key encrypted it, for rotation
device_id          text          -- synthetic, reused across fetches
status             text          -- 'active' | 'needs_reconnect' | 'error'
last_sync_at       timestamptz null
last_error         text null
created_at         timestamptz
unique (user_id, vendor)
```

**`raw_orders`** — every ingested order, deduped, before it becomes purchases. Kept for reprocessing.
```
id             uuid pk
vendor         text
vendor_order_id text         -- for dedup
household_id   uuid fk
connection_id  uuid fk
placed_at      timestamptz
payload        jsonb         -- normalized line items only, no PII
processed      boolean default false
created_at     timestamptz
unique (connection_id, vendor_order_id)  -- per connection: a second household (or a
                                         -- new account) on the same grocery account
                                         -- gets its own copy (migration 009)
```

### 10.3 Event tables — append-only

**`purchases`**
```
id             uuid pk
household_id   uuid fk
item_id        uuid fk
user_id        text fk
qty_canonical  numeric
raw_text       text null
raw_qty        numeric null
raw_unit       text null
purchased_at   timestamptz
expires_at     timestamptz null
source         text          -- 'blinkit' | 'zepto' | 'instamart' | 'manual' | 'chat'
vendor_order_id text null     -- links back to raw_orders
prompted_by    uuid null      -- fk notifications.id, when we suggested it
created_at     timestamptz
```

**`consumption_events`**
```
id             uuid pk
household_id   uuid fk
item_id        uuid fk
user_id        text fk
type           text
  -- 'depleted' | 'level_assert' | 'consumed' | 'discarded'
qty_canonical  numeric null
occurred_at    timestamptz
source         text
created_at     timestamptz
```

**`away_periods`** — when the household was / will be away (§9.11). User-stated facts, like corrections: editable, and any change triggers a household recompute.
```
id             uuid pk
household_id   uuid fk
created_by     text fk        -- user_id
starts_at      timestamptz
ends_at        timestamptz null   -- null = open-ended ("until I'm back")
origin         text          -- 'user' | 'suggestion_confirmed'
ended_by       text null     -- 'user' | 'first_home_order' (open-ended only)
created_at     timestamptz
```

### 10.4 Derived tables — safe to truncate and rebuild

**`inventory_state`**
```
item_id                uuid pk
household_id           uuid fk
qty_canonical          numeric
daily_rate             numeric null
rate_confidence        text
days_remaining_low     numeric null
days_remaining_high    numeric null
depletes_at_earliest   timestamptz null
depletes_at_latest     timestamptz null
status                 text
reorder_qty_threshold  numeric null
last_purchase_at       timestamptz null
signal_count           integer
algorithm_version      integer
computed_at            timestamptz
```

**`predictions`**
```
id                       uuid pk
item_id                  uuid fk
predicted_depletion_at   timestamptz
range_low                timestamptz
range_high               timestamptz
confidence               text
algorithm_version        integer
generated_at             timestamptz
actual_depletion_at      timestamptz null
actual_next_purchase_at  timestamptz null
```

**`notifications`**
```
id            uuid pk
household_id  uuid fk
user_id       text fk
item_ids      uuid[]
channel       text          -- 'push' | 'email' | 'in_app'
sent_at       timestamptz
opened_at     timestamptz null
outcome       text null     -- 'purchased' | 'dismissed' | 'snoozed' | 'corrected'
outcome_at    timestamptz null
```

### 10.5 What is built today (2026-09-19)

Vendor purchases are not yet written to `purchases`. The browser derives them on every load from `GET /api/orders` (delivered `raw_orders` with each line's `sku_packs` label): `src/catalog` classifies each line into a canonical item, `src/engine` turns pack labels into canonical quantities (`packs.ts`) and runs the predictions, and `src/lib/household.ts` words the result. This is the projection rule (§11 rule 2) taken literally: nothing derived is stored, so a catalog or engine fix shows up on the next page load with no migration. A line whose pack is unknown keeps its date but no quantity — it closes the interval before it and opens none (§8).

The `items`, `purchases`, `consumption_events` and `inventory_state` tables arrive with the features that need stored state: corrections and prompted purchases (which must survive a rebuild and exclude themselves from the rate, §9.2), and server-side notifications (the worker then runs the same engine). Until then, corrections and shopping-list ticks in the UI are not persisted.

---

## 11. Architecture

**Decided 2026-09-18: one Docker Compose stack, identical locally and in production, on an Oracle Cloud Always Free ARM VM behind a Cloudflare Tunnel.** It replaces the earlier S3 + CloudFront + Lambda + Neon + KMS plan (§14 explains why).

```
Browser
   │  https://<subdomain>.example.com   (subdomain TBD; DNS on Cloudflare)
   ▼
Cloudflare edge ── Tunnel (cloudflared dials OUT from the VM; no inbound ports,
   │                origin IP never published)
   ▼
Oracle Always Free ARM VM ── docker compose project "dhaniya"
   ├─ web       nginx: serves the built SPA; proxies /api and /auth to api
   ├─ api       Node: server-side Cognito sign-in (OIDC, own session cookie),
   │            households, inventory, corrections, connect flow, import jobs.
   │            Household membership checked on every route.
   ├─ worker    Node + installed Chrome, headless, attached over CDP (§7.10):
   │            OTP relay, first import, scheduled syncs, recompute,
   │            notifications. Own container, own memory cap.
   ├─ postgres  the event log + derived tables (§10). Loopback/compose-network only.
   └─ cloudflared   production only

api ⇄ worker: through Postgres — job rows plus LISTEN/NOTIFY. No shared memory,
no direct calls; either can restart without the other.
```

Locally the same compose file runs everything except `cloudflared`, on `http://localhost:<port>`.

Design rules:

1. **All state changes are events.** Purchases and consumption events are append-only. Nothing writes directly to a balance.
2. **Inventory is a projection.** `inventory_state` is a cache derived from events plus `algorithm_version`, truncatable and rebuildable. Engine fixes are recomputes, not migrations.
3. **The engine is pure TypeScript with no I/O**, in `src/engine/`, imported by both browser and worker. Same inputs, same outputs, fully testable with fixtures.
4. **The ingestion worker is isolated.** The heavy, fragile, security-sensitive part (headless browser, live tokens) runs in its own container with its own memory cap, talking to the API only through Postgres. If it falls over, the app keeps serving; if the app redeploys, the worker keeps syncing.
5. **No LLM on the ingestion path.** Vendor data is structured JSON. The LLM is only for optional typed entry.

---

## 12. Interface

### 12.1 Onboarding

1. Sign in with Google.
2. Create or join a household; set the timezone.
3. **Connect a retailer** — phone, then OTP. History backfills immediately.
4. Optionally add a few regular items with rough frequencies for anything not yet in history.

### 12.2 Shopping list

*As built (2026-09-20): there is no separate list page. The Stock page (§12.3) is the one place: its "Running low" filter is the list, and each suggested item carries "Add to cart" (§19 Ordering, stage 1; off until tested). The Unsure filter was removed; what to show for unknown items is open (PROGRESS).*

The main output. Generated from predictions, never hand-maintained. Grouped by status:

```
Buy now      LIKELY_OUT + BUY_SOON
Coming up    RUNNING_LOW
Not yet      AVAILABLE   (collapsed)
Not sure     UNKNOWN
```

Every line shows its reason and confidence. When a user marks a suggested item bought (or the next sync shows they bought it), the purchase records `prompted_by`, keeping it out of the rate math. Over time the list learns brand/pack preferences, so "Milk" becomes "Milk — Amul Taaza 1L".

### 12.3 Inventory view

Per item: estimated remaining, status, confidence, last bought, typical frequency, order history. Uncertainty is stated in words, never as a fake decimal.

### 12.4 Corrections

Three taps on every item — "I have more" (`level_assert`), "Finished it" (`depleted`), "Threw it out" (`discarded`) — plus free text. Corrections are the highest-value data the system gets; they must be effortless and never lost.

### 12.5 Connection health

A small, honest status per connected retailer: "Blinkit — synced 2h ago" or "Blinkit — reconnect needed" with a one-tap OTP re-entry. This is the only maintenance the user ever does, and only when a token dies.

### 12.6 Weekly summary

```
Your household this week
Likely to run out:     Milk, Eggs, Bread
Enough for 2 weeks:    Rice, Cooking oil
New items learned:     Greek yogurt
```

Fires on the household's observed most-common shopping day.

### 12.8 Header, footer, feedback (built 2026-09-19) — mobile first

The app is built mainly for phones; the laptop layout reuses it. Every page has a sticky **header**: the name on the left (tap = Home), the news bell (§13.3) and the profile photo on the right. Phones keep the bottom nav (six short labels: Home, Stock, List, History, Insights, Apps); laptops keep the sidebar under the header. The **footer** sits at the end of each page's own scroll, never pinned (the bottom nav already holds the bottom edge): **Buy me a coffee**, then **How it works** (four short steps and one line on what is kept from each order) and **Send feedback** (a bottom sheet; stored in `feedback`, read by the operator with `docker compose run --rm worker node dist/worker/main.js feedback [--days N]`; no email address on the site). The coffee button is the vendor's own image served from our origin (`public/buymeacoffee-button.svg`, as an earlier project does), so nothing loads from them until someone taps it; it opens buymeacoffee.com/gandalfturing.

### 12.7 Insights (built 2026-09-19, `src/lib/insights.ts`)

What the household's own orders say about how it shops, every number counted, none estimated by a model: spend by month (12 calendar months, the current one partial) and the last 30 days against the 30 before; orders by weekday and time of day, in the household's timezone; spend by kind (catalog categories); who orders, once several people's orders are combined; each item's usual gap (the engine's `due()`); pairs bought together far more often than chance (lift ≥ 2, ≥ 5 orders); new habits (first bought in the last 90 days, ≥ 4 orders, only with history from before that); and items no longer bought (the engine says `STOPPED`, ≥ 5 orders). Seasonality is left out until there are two years of history to prove it (Instamart serves 12 months; mango shows up correctly as "not bought lately" in September). Charts are single-hue (sage), every value is also in text, and bars show their numbers on hover and keyboard focus.

**What the apps charge on top (added 2026-09-21).** The order total less what the lines cost: delivery, handling and the rest. Over a household's year that adds up, and the part worth acting on is the second trip: on many days a household orders more than once, and those extra orders carried roughly half of it. Only orders whose lines carry prices are counted, and the section stays hidden below `INSIGHTS_FEES_MIN_ORDERS` or when fewer than 80% of orders could be counted: a figure covering a third of the orders would be a guess wearing a rupee sign. A discount never reads as a negative fee, and days are the household's own, not UTC.

**Three price insights were tested against the real data and rejected (2026-09-21).** They are recorded because each sounds obviously good and is not:

- *Which app is cheaper.* The household buys on both, so the comparison is available - and after normalising to price per kilo or litre, the two apps charge within a few percent for the same product (chicken 2%, milk 3%, rice 4%, paneer 11%). The dramatic gaps in the first cut - paneer "58% cheaper" - were pack sizes wearing a price tag, the same confusion that corrupted the sku earlier that day. A feature built on it would mostly display noise.
- *Cheaper brands of what you already buy.* Grouping by canonical item and comparing unit prices produces advice like "switch your Parmesan to Amul slices" or "stop buying organic milk": the items are not substitutes, and the price difference IS the choice the household made. Condescending and wrong.
- *Category price comparisons* (chocolate at ₹1,345/kg against ₹2,535/kg) compare muesli with dark chocolate. A canonical item is not a product.

What survives is what the household cannot see for itself and did not choose: the fees, and how much of them came from ordering twice in a day.

**The date range (added 2026-09-20).** The page had mixed windows without saying so: a 30-day spend stat above an all-time weekday chart, which read as one picture of the household and was not. It now carries one range - 30 days, 3 months, 12 months, all time - and every number on it is counted over that range, the page saying which in its own first line. The range is remembered per person in the browser. Purchase history carries the same control and opens on **3 months**, wide enough to hold a slow staple's rhythm (a 5 kg bag of atta bought every six weeks would vanish from a 30-day view); Insights opens on **12 months**, the widest window where two apps can be compared at all, since Instamart serves a rolling year (Appendix C) while Blinkit keeps years (Appendix A).

**The range never reaches the engine.** It filters what the household reads and nothing else. Rates, usual gaps and the running-low list are built from every order held, because narrowing the engine's inputs to a window would quietly make predictions worse - the silent degrading §9.4 forbids. `src/lib/ranges.ts` says so where the filtering happens.

**Uneven histories are said out loud.** With two apps whose records start years apart, a total or a change can be an artifact of how much history we could read rather than anything the household did. The first live case, 2026-09-20: a 12-month window fitted both apps, but the 12 months it was measured against held no Instamart at all, and the page showed "+154%" as though spending had leapt. `unevenHistoryNote()` names where each app's orders begin and says which of the two traps applies - the window itself reaching past an app's first order, or the period being compared against doing so.

---

## 13. Notifications

### 13.1 Delivery

Web Push with self-generated VAPID keys, sent from the nightly job via `web-push`. Subscriptions stored per user.

- Desktop Chrome / Edge / Firefox and Android Chrome — work directly.
- **iOS Safari 16.4+ — works only if the site is installed to the home screen as a PWA.** If a tester is on iPhone, onboarding must include an "Add to Home Screen" step.
- Fallback — SES email (the Google-verified address), plus an always-present in-app banner.

Built (2026-09-19) for the first-import notices ("Your household is ready", "Your Instamart history is in"): the import screen's **Notify me when it's done** registers `/sw.js`, asks permission, subscribes with `VAPID_PUBLIC_KEY` (`GET /api/push/key`) and stores the subscription (`POST /api/push/subscribe`, per user; the endpoint is a capability URL — never logged or echoed). On an iPhone not opened from the Home Screen it explains Add to Home Screen instead (`manifest.webmanifest` makes the site installable). The worker's import-loop sweep (`worker/notify.ts`) finds first imports that reached "ready" or "complete", claims the milestone (`import_jobs.*_notified_at`) before sending so it never goes twice, holds it through quiet hours, and forgets browsers the push service reports gone (404/410). Later syncs stay quiet. Verified: subscribing from a real Chrome and Google's push service accepting the signed, encrypted notice (201); the notice appearing on screen is still to be seen on a real device.

### 13.3 Announcements (planned 2026-09-19)

Now and then the operator tells every user something (a new feature, planned downtime). **Never automatic**: no release, deploy or commit sends one. The operator writes it and runs one command:

```
docker compose run --rm worker node dist/worker/main.js announce --title "…" --body "…" [--push] [--dry-run]
```

It stores the announcement (`announcements`). Every signed-in user sees it under a bell next to their profile photo, unread until opened (`announcement_reads`). With `--push` the worker also sends it once to each user's subscribed browsers (`announcement_deliveries`), holding it through their household's quiet hours. `--dry-run` prints who would get it and sends nothing. There is no web page for sending: the command needs shell access to the server, which is the operator's.

### 13.2 Rules

- One notification per household per day, maximum; all due items grouped.
- An item already notified does not re-notify until its state changes.
- `snoozed_until` and `notify_enabled` are per-item, one tap from the notification.
- Nothing fires 22:00–08:00 household-local time — why `households.timezone` is required.
- **Nothing restock-related fires while the household is away** (§9.11). The one exception is the "welcome back" restock list, sent the evening before a planned return. "Were you away?" suggestions are in-app only, never pushed.

---

## 14. Tech stack and cost

Target: **₹0/month at test-group scale, no 12-month cliff.** Decided 2026-09-18.

| Layer | Choice | Free tier | Cost here |
|---|---|---|---|
| Host | **Oracle Cloud Always Free ARM VM** (up to 4 OCPU / 24 GB) running the whole compose stack | always free | $0 |
| Edge, DNS, TLS | **Cloudflare** — a subdomain of the existing `example.com` zone, served through a **Cloudflare Tunnel** | free plan | $0 (domain already owned) |
| Auth | **Cognito** user pool + Google — the existing shared Cognito pool, **new app client** for this app | 10k MAU | $0. Advanced Security stays off. |
| App API | Node container (`api`) | — | $0 |
| Database | PostgreSQL container (`postgres`) on the VM | — | $0 |
| Ingestion worker | Node + installed Chrome, headless (`worker`) | — | $0 |
| Token vault | App-level AES-256-GCM, key in the server environment | — | $0 |
| Backups | `pg_dump` → encrypted → **Cloudflare R2** | 10 GB | $0 |
| Notifications | Web Push (VAPID) + email fallback | — | $0 |
| LLM (optional) | free tier on our key, else the household's own key (§19) | — | capped |

**Total: $0/month.**

### 14.1 Why one Oracle VM, not the serverless split

- **The worker already needs a VM.** It holds a persistent headless Chrome (§7.10) — impossible on Lambda, not free on Fargate/EC2. Once a free VM exists, the API and database fit on it too, and every serverless piece (CloudFront, Lambda, Neon's HTTP driver, KMS) becomes a moving part with nothing to gain at two households.
- **Local = production.** The same compose file runs on the laptop and the VM, so "works locally" means something.
- **Cloudflare Tunnel** means the VM opens **no inbound ports** and its IP is never published: `cloudflared` dials out to Cloudflare. TLS is Cloudflare's.
- **Two known risks, each with a fallback:**
  1. **Datacenter IP.** Headless scraping passed from a home IP only (§7.10). Oracle's IP may be challenged. Test it the day the VM exists (`npm run probe:headless` in both spikes). Fallback: run the `worker` container on a home machine — same image, pointed at the VM's Postgres through the tunnel — still $0.
  2. **Idle reclamation.** Oracle may reclaim Always Free instances that stay very idle for a week. Converting the account to Pay-As-You-Go stops this while usage stays inside the free limits.

### 14.2 Database — PostgreSQL in the stack

Plain PostgreSQL in its own container, reachable only on the compose network (and loopback locally). The `api` and `worker` use the ordinary `pg` driver. Migrations run as a one-shot `migrate` service before `api`/`worker` start. The api ⇄ worker hand-off (connect requests, import jobs) is rows plus `LISTEN/NOTIFY`. Backed up nightly to R2, encrypted — and the backup is only real once a restore has been tested.

### 14.3 App API and auth

**Server-side OIDC, the pattern proven in an earlier project** (its `docs/operations/SIGNIN-SETUP.md`): the browser goes to `/auth/start`; the `api` redirects to Cognito's hosted domain with `identity_provider=Google`; Cognito returns a code to `/auth/callback`; the `api` exchanges it with a **confidential** app client, validates the ID token (issuer, audience, signature against the pool's JWKS), and issues **its own** session cookie (HttpOnly, Secure in production). The SPA never sees a Cognito token.

Setup lessons carried over, because each one cost a debugging round there:
- the app client must have **Google ticked** under its login pages, or Cognito silently shows its email form;
- nginx must proxy `/auth/` to the `api`, or every auth route returns the SPA's `index.html` with a 200;
- the redirect URI is the origin the **browser** sees (nginx), never the `api`'s own address;
- `AUTH_ISSUER`/JWKS name the pool; the authorize/token URLs name the hosted domain — different hosts;
- Cognito accepts plain-http redirect URIs only on loopback, so local dev uses `http://localhost:<port>`.

**Only allowlisted emails get in.** The site is public (a tunnel, the real domain) and any Google account can reach Cognito, so `AUTH_ALLOWED_EMAILS` lists who may sign in — required whenever sign-in is on. The callback turns anyone else away before a user row exists (`?signin=not_allowed`), and every request re-checks the session's verified email against the list, so removing an email ends that person's sessions. Without it a stranger could sign in, make a household, and have the worker log in to *their* grocery account from our IP.

**There is no row-level security; household-membership authorization is checked in the handler on every route and must never be skipped** — it is the only thing separating two households' data, and it also gates the token vault.

**Token vault.** Vendor sessions are encrypted with AES-256-GCM under a key held in the server environment (`VAULT_KEY`, with a key id so it can rotate), decrypted only in the `worker` at fetch time. Never logged, never in an error, never sent to the browser. Generate secrets with `printf`/`openssl`, never an editor — a secret written on Windows can carry an invisible `\r` that silently breaks decryption (an earlier project lost backups to exactly this).

### 14.4 Frontend

React 18 + Vite + TypeScript + Tailwind, `lucide-react`, `@/` → `src/`. Built into static files served by the `web` (nginx) container. Engine in `src/engine/`, shared with the worker.

---

## 15. Existing code

`src/` holds a Bolt-generated prototype: React 18 + Vite + TS + Tailwind + lucide-react. All data is mocked in `src/data.ts`. Nothing is wired to a backend.

**The prototype is the UI.** Keep components, styling, layout; replace the mock data layer. Changes needed:

- `components/onboarding/Connect.tsx` — repurpose into the real retailer-connect flow (phone → OTP), which is now genuinely central rather than aspirational.
- `components/onboarding/Auth.tsx` — becomes "Continue with Google" (Cognito hosted flow) instead of an email/password form.
- `components/views/MealPlanView.tsx` — stays in the tree, nav entry hidden behind a flag.
- Remove the unused `@supabase/supabase-js` dependency.

---

## 16. Delivery phases

Risk is front-loaded: the automatic-ingestion premise is proven before anything is built on it.

### Phase 0 — Ingestion spike (the go/no-go)

A standalone Playwright script, run locally then from the Oracle ARM host: log into Blinkit with phone+OTP, capture the token, call `order_history` from the server, parse orders. Measure token lifetime; test replay from a non-home IP; test a synthetic deviceId.

**Outcome:** a yes/no on whether the whole product model works, and the token-lifetime answer that sets the reconnect cadence. Everything below assumes this passes; if it fails, the fallback (residential proxy or extension) is designed here instead.

### Phase 1 — Engine and a working app, no backend

- `src/engine/`: units, signals, rate, confidence, projection, status — with a fixture test suite.
- Repository interface backed by IndexedDB; Home/Inventory/Shopping/History wired to real engine output.
- Onboarding priors; meal-plan nav hidden.
- Runs in the local Docker Compose stack (§11), which is also what gets deployed.

**Outcome:** a real, working app you can start feeding order data into (via the spike script's output at first).

### Phase 2 — Backend, auth, households, token vault

- PostgreSQL schema and migrations (a one-shot `migrate` service), including `vendor_connections`, `raw_orders`, `import_jobs`.
- Server-side Cognito + Google sign-in (§14.3) behind `/auth`; `Auth.tsx` becomes "Continue with Google".
- The `api` service: session cookie, household authorization on every route.
- The token vault (AES-256-GCM, `VAULT_KEY`).
- Repository swapped from IndexedDB to the API; household invites.
- Deployed: the same stack on the Oracle VM behind a Cloudflare Tunnel.

**Outcome:** multi-user, multi-device, secure token storage in place.

### Phase 3 — Production ingestion: Blinkit

- The `worker` service: headless Chrome (§7.10 recipe), OTP relay, background first import with ETA, scheduler, encrypt/refresh, order fetch, dedup to `raw_orders`, map to purchases, trigger recompute.
- The `Connect.tsx` phone→OTP flow, end to end.
- Connection-health UI and the reconnect prompt.

**Outcome:** the core promise is live for Blinkit — connect once, orders flow in automatically.

### Phase 4 — More vendors

- Zepto and Instamart adapters behind the same interface.

**Outcome:** full coverage of the household's retailers.

### Phase 5 — Notifications

- Nightly recompute, Web Push (VAPID, PWA manifest + service worker), grouping, quiet hours, snooze, weekly summary.

**Outcome:** proactive replenishment nudges.

### Phase 6 — Refinement

- Prediction accuracy view; tune half-life, weights, thresholds against real data.
- Recurring-item detection surfaced in the UI.
- Optional typed NL entry via Haiku.
- Revisit meal planning ("cook from what you have").

---

## 17. Success metrics

| Metric | Computed from | Direction |
|---|---|---|
| Prediction accuracy | `predicted_depletion_at` vs `actual_depletion_at`, **restricted to non-prompted purchases** | ↑ |
| Range honesty | actual falls inside `[range_low, range_high]` | ~70–80% (near 100% = ranges too wide) |
| Ingestion uptime | successful syncs / expected syncs per vendor | ↑ — the product's lifeblood |
| Reconnect frequency | OTP re-entries per user per month | ↓ — the only user burden |
| Reminder action rate | notifications with `outcome='purchased'` / sent | ↑ |
| Correction rate | consumption events per item per week | ↓; a per-item spike flags a bad model |
| Coverage | items with a known rate / active items | ↑ |
| Retention | weekly active households | whether use survives the novelty |

---

## 18. Risks

**The token doesn't replay from a server.** The existential risk. *Mitigation:* the Phase 0 spike proves or kills it before investment; residential proxy or an extension as fallbacks.

**Too-frequent OTP re-entry.** If tokens die daily, the "zero effort" promise breaks. *Mitigation:* silent refresh where the vendor supports it; the spike measures the real cadence; a fast one-tap reconnect if it can't be avoided.

**Silent ingestion failure poisons the model.** A broken adapter that goes unnoticed feeds partial data, which is worse than none. *Mitigation:* per-adapter health tracking, `last_sync_at` surfaced in the UI, and an engine that lowers confidence on stale data rather than trusting it (§9.10).

**Security of stored sessions.** Live sessions to accounts with saved cards. *Mitigation:* vault encryption (§14.3), decrypt only in the worker, never logged, line-items-only persistence, scoped credentials.

**Adapters break on vendor changes.** Internal endpoints change without notice. *Mitigation:* isolated adapters, one vendor's break contained; expect periodic maintenance; the engine tolerates the gap.

**Terms of service.** Automated access violates retailer terms. *Mitigation:* accepted for a private test; not scaled publicly without legal review (§7.7).

**Prediction distrust / notification fatigue.** *Mitigation:* confidence everywhere, one-tap corrections, one grouped notification per day, no false precision.

---

## 19. Later

- **Ordering — in three stages, each gated on the one before.** We already hold the logged-in vendor session, so we can act on the user's behalf. What we will never do: store or see a card number, CVV or UPI PIN (PCI DSS forbids storing a CVV at all; RBI's card-on-file rules forbid third parties storing card numbers — consent changes neither), or place an order the user didn't just authorise.
  1. **Cart handoff (first).** Match the predicted list to real catalog items (the same exact-SKU matching as pack resolution, Appendix C) and add them to the user's cart through the vendor's own cart API (Instamart: `/api/instamart/checkout/v2/cart`). The cart lives on the vendor's side, so it should appear in the user's phone app — verify this. The user reviews and pays in the app as usual. No payment handling at all; most of the value.
     **Stage 1, first part: BUILT 2026-09-20.** Several items at a time, on Instamart: the card's "Add to cart" shows the product the household ranked first, its pack and how many it usually buys; Confirm queues a job; the worker opens the household's session in a fresh headless browser, picks the household's usual address, and taps the page's own buttons (Appendix C). The page then says what happened per line ("2 × Nandini Pasteurised Toned Milk added"), what the app will charge ("₹267 to pay in the app, including ₹30 delivery and ₹30 surge fee") and the delivery time. Everything added is written to `prompted_adds`, and `src/lib/prompted.ts` marks the purchase that follows within 10 days as prompted, so it never feeds the rate (§9.2). A tap only puts the item on a list (kept in the browser), and one Send fills them all in one trip; more may be sent while one is being filled, and a household's carts are filled one after another (`cart_jobs`, claimed so that two never share a cart). Speed came from measuring: a first-visit tip ("Got it!") cost 15 seconds an item to tap away and is now removed from the page; taps wait for the app's own cart answer instead of a fixed time; only the last tap of an item is waited for; the search box is reused instead of loading the page again. Three items take about 25 seconds, of which 9 is starting the browser. Still to build from the list below: the check-then-plan screen, splitting across apps, the usual basket and free-delivery top-ups.

     **Stage 1 in detail (designed with the user, 2026-09-20):**
     - *Which product* (**built**): an item ("milk") is the products the household bought for it (Nandini Toned Milk, Amul Taaza, Akshayakalpa). Default order: most bought in the last 60 days, then the one bought last. The household can reorder them and rule some out ("Don't add") in the item's details on Stock; saved per household (`item_product_prefs`), shared by every member. Add to cart tries #1, then #2, and never adds a product outside the list without asking.
     - *Check before adding*: a read-only check first, on every connected app: is the store open for the household's address, and is each wanted product in stock, at what price. Nothing is added until the person has seen the plan.
     - *The plan*: one line per item, saying which app and which product. It prefers one app for as many items as possible (fewer delivery fees), and puts only what that app lacks on the other ("Coriander: not on Instamart right now, on Blinkit"). The person can move an item, pick another of its products, or skip it.
     - *Out of stock*: the next product in the item's order is proposed and marked "your #1 is out of stock". If none of its products is in stock on any app, it says so and the item is left out; nothing unknown is added.
     - *An app not serving* (rain, high demand, closed for the night, the address outside its area): checked first, said plainly per app ("Instamart isn't delivering to your address right now"), nothing is sent to it, and the plan uses the other app if it can; otherwise "try again later". A failure half way (some items added) is reported item by item, never as a plain success.
     - *Your usual basket*: one tap adds the items the household buys on most trips (from its own orders), through the same check and plan.
     - *Free delivery*: after the plan, if an app's cart is under its free-delivery threshold, the top-up suggestions below, limited to items due soon that keep (never fresh produce, milk, bread).
     - Everything added this way is a **prompted purchase** (§9.1): recorded when added, kept out of the rate once it is bought.
  2. **One-tap ordering via wallet or UPI.** Our page shows the final cart and total — "Authorise ₹642 for these 9 items from Instamart?" — and only on an explicit yes does the worker check out, choosing a method that needs no secret relayed through us: the vendor wallet (e.g. Zomato/Blinkit Money, topped up by the user in the app), UPI collect (approved with the user's PIN in their own UPI app), or cash on delivery. Prices and stock can change between list and checkout, so the authorised total is re-checked at checkout and any difference goes back to the user first. The order it places is recorded as a **prompted purchase** (§9.1).
  **Recorded on the household's own checkout (2026-09-21, `spike/instamart/capture-checkout.ts`, watch-only; the OTP arrived and the window was closed without paying).** The chain, in order: `POST /api/instamart/checkout/v2/cart` → `POST /api/v3/payment/get-payment-options` → `GET /api/v3/juspay/get-customer-auth-token` → `POST /api/v3/instamart/checkout/order?cartType=INSTAMART` → `POST api.juspay.in/txns` → `POST api.juspay.in/v2/pay/start/...&cardIssuerBankName=Axis%20Bank` → `POST securegw.paytm.in/instaproxy/3ds2/captureform/v1` → the bank's ACS page on `secure-acs2ui-b1.wibmo.com`. So: Juspay orchestrates, Paytm is the gateway, Wibmo is the ACS, and **the saved card is challenged** - there is no frictionless path to automate around on this account.

  Two things that shape any build on top of it. **The order exists before the payment does**: the `checkout/order` call answers `status: PLACED` with `payment_status: PENDING` and the transaction amount, before Juspay is ever called. An abandoned payment therefore leaves a placed, unpaid order, which is the mirror of the paid-but-no-order state already feared here - both have to be detectable and shown, never assumed. And **the OTP page belongs to the bank, not to Swiggy** (wibmo.com), so relaying means typing into a third party's page whose markup nobody here controls, which is the fragility this stage accepts going in.

  **And the saved card asks for the CVV before it asks the bank.** The household typed the CVV, pressed Pay, and only then did the OTP arrive. That is the finding that decides this stage: a CVV is the one number nobody may store - not the vendor, not us - so a card order needs **two** things typed by a person every single time, the CVV and then the OTP. Relaying both is possible, but what it buys is a shorter checkout, not an automatic one, and it is worth being plain that "automatic payment on a saved card" is not a thing this vendor offers.

  If ordering without a person present is the goal, the paths that could actually deliver it are the ones built for repeat debits - a UPI AutoPay mandate, or money held in the vendor's own wallet - not a card. Neither has been recorded yet, and both should be before anything is built.

  **Pay on Delivery is offered, and it is the only method that needs nothing typed.** (An earlier note here said the opposite; it was written from a partial capture of the payment options and was wrong.) The account's checkout offers: saved and new cards, Wallets (PhonePe, Amazon Pay), Netbanking, and **Pay on Delivery - "pay in cash or pay online"**. Every one of those except the last needs a person mid-flow: a card wants the CVV and then the bank's OTP, a wallet wants its own app's approval, netbanking wants a bank login.

  **The payment question is signed too, exactly like adding to the cart** (probed 2026-09-21, `spike/instamart/payment-probe.ts`). `POST /api/v3/payment/get-payment-options` answers the cart page's own call with `statusCode: 0` and the account's methods; the identical path called from our own `fetch` inside the same signed-in page answers `statusCode: 999, "Session expired. Please login again."`. So the checkout is driven, and overheard, through the page - the same shape as the cart (Appendix C), and a server-side HTTP client is no more an option here than it was there. The page asks the question only when there is something to pay for, so an empty cart reads as no answer, never as "no way to pay".

  **The dry run is built and runs against the real account** (`server/src/worker/order.ts`, `worker order-dry-run <household> [--phone] [--add]`). It opens the household's cart, reads it, reads what the account can pay with, and stops at the call that would create the order. On 2026-09-21 it walked the household's own cart - 1 x milk, Rs 95, "Maple Residency", 12 min - and read five methods: **Pay on Delivery, Cards, Wallets, Netbanking and UPI**. UPI was missing from the earlier partial capture; Pay on Delivery is still the only one of the five that needs nobody. Whether a UPI autopay mandate could make an online payment unattended is open and unmeasured - nothing here claims it.

  That inverts the argument made when this was first discussed. Cash on delivery looked like the option that defeats the point of automating; it is in fact the only one that lets an order be placed without a human in the middle - which is what a voice conversation ("what do we need today?" ... "order it") requires in order to finish. The card path remains the right one when somebody is already holding the phone.

  **Built and tested, 2026-09-21: the household pays from the app, typing the two numbers itself.** The worker drives the vendor's own payment screen the way it drives the cart, because the payment call is signed exactly as the cart call is. The screen's controls all carry a `data-testid` (`spike/instamart/checkout-ui.ts` mapped them): `header_subtitle` is the total, `dav_addr_tag` the address, `pm_card_container` / `pm_card_name` / `pm_card_cvv` / `pm_card_pay_btn` a saved card's row, `pg_mo_cod` Pay on Delivery. `pm_card_pay_btn` is the only control anywhere in this code that spends money. **The tick is a toggle and the preferred card starts already ticked**, with its CVV box and Pay button on screen; tapping it closes the row rather than opening it, which cost a live attempt on 2026-09-22. A row is therefore left alone when it is already chosen, and "chosen" is read as "this row is showing a way to pay" rather than off the tick's own attribute. The CVV box and the Pay button are read from inside the chosen row, never from the page: two cards mean two of each. And the household is asked for a CVV only once that row is actually showing a box for one. The box is sized to the card - 4 for the American Express on this account, 3 for the others - so after typing it is read back: a CVV that did not go in whole is not sent, because sending half of one means the bank declines an order that by then already exists.

  The shape, in `server/src/worker/pay.ts` and `server/src/api/order.ts`:

  ```
  requested → running → awaiting_cvv → paying → awaiting_otp → done
                                     ↘ (on delivery) paying  ↗
  ```

  **Everything that can refuse an order happens while `running`, before Pay.** The vendor's own total is re-read and checked against the number the household saw when they tapped (`max_total`), against a hard cap (`ORDER_HARD_CAP_RUPEES`, held at **200 rupees** while this is being tested, since every live run spends real money), and refused outright if it cannot be read at all. The address on the screen is checked against the one the household chose for that cart. The card is found by the name the screen shows it under, never "the first one will do". Any of these stops the order, and at that point nothing has been ordered, so stopping is free.

  **After Pay the rules change**, because the order exists before the money moves. `pay_pressed_at` is written the moment the button is pressed; from then the job is never retried, because a retry is a second order. Any order id seen on the wire is recorded even when the payment then fails, and `unpaidOrder` on the api's answer is how the app says "an order was placed and not paid for" rather than "it failed".

  **The CVV and the OTP** are handled exactly as the connect OTP is (§7.10): the browser sends the digits over TLS, the api seals them to the vault's public key before anything is written, the worker opens them, types them, and the row is cleared in the same statement that reads it. Neither is logged, returned, or kept; a secret older than five minutes is refused rather than typed; one that is never sent before Pay ends the job with nothing ordered. What remains: the digits are in the api's memory for the length of one request. Sealing in the browser would close that, and a phone app driving the vendor's page on the household's own device would close it completely. Both are worth doing; neither is done.

  **The verdict cannot come from the order call.** It is answered before the money moves, so an earlier version read its own `PENDING` and would have reported every successful payment as a failure - a household told that pays twice. The vendor is asked afterwards instead, from its own list of the household's recent orders, matched by order id: still showing and not dead means it went through, failed or cancelled means it did not, and not found either way is `unconfirmed`, said as "we could not tell, check the app" and never as a failure (§9.4).

  **An order pays for a named cart.** `order_jobs.cart_job_id` records which cart, and two things follow from it. The worker pays through **that cart's own connection**, because a connection belongs to one person and the table allows one per person per vendor - so two accounts on one vendor means two members, and without the link one member's cart could be filled while the other's account is charged. And the payment screen's own item count is checked against the cart the household looked at (`cart_lines`), because the vendor's app pushes its own cart up whenever it has one: a different cart that happens to come to the same money is still not the one they agreed to. Compared only when both counts are known (§9.3).

  **The bank's page is chosen by shape, not by name.** The 3-D Secure screen belongs to the household's bank, differs between banks, and can change without warning, so the code's box is never simply the first input on it: never one hidden, disabled or read-only; one box per digit where the bank splits the code that way; otherwise a box named for the code and long enough to hold it. That choosing is a pure function (`chooseOtpBoxes`) with its own tests, because it is the one step here that cannot be exercised against the real thing on demand. The code is read back after typing, and a failure logs the shapes that were on the page - types, lengths, whether anything was named for a code - never a value.

  **An order belongs to the household, not to a page.** `GET /api/order/live` finds the one on the go from anywhere in the app, because a sheet closed while the bank's code is outstanding would otherwise strand a placed order. Each question it asks - the price, the CVV, the code - is pushed once, and quiet hours do not apply to them: for a code the order is already placed.

  Tested at three layers: the pure decisions (`server/tests/instamart-checkout.test.ts`), the whole state machine against a stand-in vendor (`server/tests/integration/worker-pay.test.ts`), and the door (`server/tests/integration/order-api.test.ts`). Two real bugs were caught by writing them: a read-and-clear whose `returning` handed back its own erasure so a CVV could never arrive, and a poll interval borrowed from a page constant that slept past its own deadline.

  **What this does not do.** It does not make paying automatic. A card needs its CVV and then the bank's OTP every single time, so the app shortens the checkout rather than removing the person from it. Pay on Delivery remains the only method on this account that needs nobody, and it takes payment online at the door.

  3. **Saved card with the bank OTP relayed (only if stage 2 isn't enough).** The vendor already holds cards as tokens and may allow CVV-less payment on them. But the OTP belongs to the user's **bank**, entered on the bank's own 3-D Secure page inside the checkout; relaying it means the user types it on our site and the worker types it into the bank's page. Build only after a recorded checkout shows it works headless. Accepted costs, stated up front: each bank's page differs and may block automation (fragile, fails quietly); a paid-but-no-order state must be detected and surfaced; it runs against banks' "never share your OTP" terms. Never store the OTP; seal it in transit like the connect OTP (§7.10) and drop it after use.
  - *First step for stages 2–3:* record a real small checkout on each vendor (the same capture approach as the order-history recon) to learn which payment methods complete without extra steps, and whether saved cards ask for a CVV.
- **Smart pack sizing** — suggest the pack that matches observed consumption.
- **Waste reduction** — "these will expire before you use them."
- **Meal planning** — "plan five dinners from what I already have."
- **Budget awareness** — monthly spend against a target (order history already carries prices).
- **Price tracking** — every ingested line already has the price paid (both spike extracts keep `pricePaid`; Instamart also has MRP and per-item discounts), but `purchases` (§10.3) has no price column, so it is dropped at ingest today. Add `price_paid` (and `mrp` where the vendor gives it) to `purchases`. Then: price history per item, **per-unit price** (₹/L, ₹/kg — comparable across pack sizes and vendors once in canonical units), price-hike alerts on staples, and "you paid less for this on the other app last month". Scope stays the household's *own* purchase history — live cross-retailer price comparison remains out of scope (§5). Price is display-only: it never feeds the consumption rate.
- **Free-delivery top-up suggestions** — when a cart falls short of a vendor's free-delivery threshold, suggest recurring items the household will need soon anyway, to cross it with things that get used instead of throwaway fillers.
  - *What to suggest*: items predicted to run low within a horizon (e.g. next 7–10 days), preferring non-perishables and long-shelf-life staples; **never perishables that would expire before use** (§9.8). Rank by closeness to depletion, then by how well the price fits the gap to the threshold.
  - *Thresholds* are per vendor and change over time. Learn them from order history rather than hard-coding: Instamart's bill carries the delivery charge (`bill.charges`), so orders with and without a delivery fee bound the threshold.
  - *Knowing the cart*: we can't see what the user is building in the app. Options: the user types the cart total; or the worker reads the cart through the existing session (Instamart exposes `GET /api/instamart/checkout/v2/cart` — another automated read, same ToS caveat as §7.7). Decide when building.
  - *Engine rule*: a top-up bought because we suggested it is a **prompted purchase** — set `purchases.prompted_by` and exclude it from rate estimation (§9.1). Otherwise the suggestions would confirm their own predictions.
  - *Already visible in the data*: the household tops up today. Look for orders landing just above a vendor's threshold, whose cheapest line looks like a filler. Those filler buys (chocolate, 114 buys across both apps, is a suspect) may be restocking behaviour rather than consumption — worth measuring before trusting those items' rates.
- **Bring your own LLM key, with a free tier** — so the household's LLM usage isn't billed to us. The LLM is only ever used for two things: turning typed text into structured JSON (§7.8) and turning computed state into a sentence. Ingestion and every number come from deterministic code, so **the product stays fully usable with no LLM at all** — that is what makes a hard free-tier cap safe.
  - *Free tier*: each household gets a monthly allowance of LLM calls on our key (a constant, e.g. `FREE_TIER_LLM_CALLS_PER_MONTH`). When it runs out, nothing breaks: typed entry falls back to a plain form (item, qty, unit), and summary sentences fall back to fixed templates filled from the same computed state. The page and the typed-entry box show "12 of 50 free AI uses left this month".
  - *Own key*: the user pastes an **OpenAI** or **Anthropic** API key and picks the provider. With a key, their household's calls use it and the allowance no longer applies. A provider adapter behind one interface (like vendor adapters, §7.4), each defaulting to that provider's small, cheap model tier — these tasks don't need a large model.
  - *The key is a secret, handled exactly like a vendor token (§7.6)*: encrypted at rest under the vault key, decrypted only server-side at call time, never logged, never in an error message, never sent back to the browser — the page shows only "sk-…a3F9" (last 4) and a "Remove key" button. Validated with one tiny test call when saved. Household-membership checks on every route that touches it (§14.3).
  - *Its own page* — "AI features" in Settings, separate from the vendor connections:
    1. **What uses AI here**, in two lines, and that everything else is free and unaffected.
    2. **Your free tier** — used / remaining this month, and when it resets.
    3. **Use your own key** — provider picker, paste box, status, remove.
    4. **Step-by-step: get an OpenAI key** (first) — create an account at platform.openai.com → Billing → add a small prepaid credit → API keys → "Create new secret key" → copy it once (it isn't shown again) → paste here. Advise a low monthly spend limit in their billing settings.
    5. **Step-by-step: get a Claude key** (second) — create an account at console.anthropic.com → Billing → add credit → API Keys → "Create Key" → copy → paste here. Same spend-limit advice.
    6. **What it will cost you, roughly** — computed on the page, not hard-coded prose: calls per month × typical tokens per call × the provider's current per-token price (prices held in a constants file and checked against the provider's pricing page whenever it's updated — they change). Estimate basis: a typed entry is ~400 input + ~150 output tokens; a summary sentence ~600 input + ~80 output; a busy household does ~30 of each a month → **~60 calls, ~40k tokens a month**. At small-model prices that is expected to be a trivial monthly amount; the page shows the real computed figure plus their own last-30-days actual usage once a key is in use.
    7. **Your real usage** (asked for 2026-09-19) — calls, tokens and cost this month and over the last 30 days, from the `ai_calls` log (counts and tokens only, never the text), shown next to the estimate above so the two can be compared.
    8. **What it did for you** — the value, counted: facts added from plain words, questions it asked back, proposals confirmed vs discarded ("12 facts from 9 messages this month; 2 discarded").
  - *Dashboards change*: the key-creation steps above are accurate as of writing; re-verify the click paths when building the page, and link to each provider's own key docs as the fallback.
  - *Rule unchanged*: whichever provider or key, **the LLM never does arithmetic** (§9) — it only reads text into JSON and phrases computed results.
- **"Cook something" — BUILT 2026-09-20** (`CookView.tsx`, `src/lib/meals.ts`, `server/src/ai/meal-schema.ts`, migration 020, `POST /api/ai/meal`). The household says what it wants to make ("chicken biryani for 6"); the model lists what the dish needs for that many people; code does the rest — the catalog matches each ingredient to the household's own items, the app's own estimates say what is at home, and what is left goes on the cart list. Salt and water are never put on a shopping list. An ingredient never bought here is added as a **search** want, so the worker takes what the store sells under that name (cheapest pack in stock) and the result says what it added. The answer is read strictly (at most 30 ingredients, amounts bounded per person, names that are names); a meal plan never feeds an estimate, and what it puts in a cart is a prompted purchase (§9.2). Same allowance, limits and fenced prompt as the rest of the AI layer (§7.8).
- **AI mode — tell it what you want** — the household says, in its own words, what it wants from the next days or weeks: "I want to eat healthy for a week", "I want chicken this week", "no ice cream for a while". The shopping list bends to it.
  - *The LLM only reads the request into a structured **intent**; deterministic code applies it* (§7.8, §9 — the LLM never computes). Intent shape: `{ kind: 'avoid' | 'want' | 'goal', target: item | category | tag, from, until }`. "No ice cream for a while" → `avoid ice cream`; "I want chicken" → `want chicken`; "eat healthy" → `goal healthy`.
  - *Durations*: taken from the text when given ("for a week"); vague ones ("for some days", "for a while") get a default length from constants and are **shown back for confirmation** — "Avoiding ice cream until 2 Oct — change?". Every active intent is listed and can be edited or cancelled; they expire on their own.
  - *Goals map through a deterministic table*, not the LLM's judgement at apply time: `healthy` → favour produce, dairy, staples; hold back snacks, ice cream, soft drinks, chocolate. The table lives in a constants file and is editable. Items need tags for this (category is a start; `snack`, `sugary`, `protein`, `fresh`… per item).
  - *How intents change the list*: `avoid` hides the item/category from "Buy now" and silences its notifications for the period. `want` adds it to the list even if stock looks fine. `goal` re-ranks and adds a short "fits your goal" section.
  - *Engine rules*:
    - An item under an `avoid` intent isn't being bought on purpose. Its purchase gap during the avoid period must not read as slow consumption — treat it like an item-level away period (§9.11): intervals overlapping the avoid window are dropped.
    - Anything bought because an intent added it to the list is a **prompted purchase** (`prompted_by`) — excluded from the rate (§9.1), same as top-ups.
  - *Where it lives*: an "AI mode" chat box on the home screen, plus the list of active intents. Uses the household's free-tier allowance or own key (entry above). With no LLM available, the same intents can be set from a simple form (item/category + avoid/want + until).
- **Product suggestions (opt-in)** — a setting, **off by default**, that shows a few products the household might want but doesn't buy today. A separate "You might like" section, never mixed into "Buy now", and never more than a handful at a time.
  - *Where candidates come from — deterministic sources first*:
    - **Lapsed items**: bought regularly before, not recently ("You used to buy paneer every week").
    - **Active intents**: a `healthy` goal suggests fruit, sprouts, curd from the catalog; `want chicken` suggests the cuts/packs the household has bought before.
    - **Better pack size**: ties into smart pack sizing — "You buy 500 ml every 2 days; the 1 L pack costs less per litre" (needs price tracking, above).
    - **Catalog complements** from the vendor catalog the adapters already read (e.g. Instamart search, Appendix C).
  - The LLM may rank candidates and phrase a one-line reason; it doesn't invent products — every suggestion is a real catalog item.
  - *Learning*: "not interested" hides that product (and damps similar ones); accepting one and buying it records a **prompted purchase** (excluded from the rate).
  - *No sponsored or paid placement* — suggestions exist only to help the household.
- **Multi-member households** — when more than one person in a household orders groceries, everyone's orders count toward one shared inventory. Most of this is already in the model: `household_members`, `vendor_connections` is per *user* (`unique (user_id, vendor)`), and every purchase carries `user_id`. **Invite + connect and attribution are built (2026-09-19, `server/src/api/members.ts`, migration 012);** the rest below is still open.
  - *Invite + connect* (built): the owner invites a verified Google email from the Household page (profile menu); the email must be on the sign-in allowlist. Signing in with it shows a join screen before Connect, then the person connects their own vendor accounts with their own phone + OTP — we never share one person's session with another, and only a connection's owner can reconnect it. Joining moves the person's connections and every order, import and connect attempt read through them into the household; leaving or being removed moves them back out into a fresh household of their own, so nothing is copied and nothing is left in two places. The worker reads the household from the connection on every stored order, so a move mid-sync is safe; a move waits for a connect attempt in flight. Only the owner invites, withdraws or removes; an owner with others in the household can't leave or join another. Up to 6 people, counting pending invites.
  - *Address filter (§7.9) becomes essential*: a member's orders to their own parents' house or office are not this household's stock. Only orders to the household's tracked address(es) count.
  - *No cross-member dedup*: two people buying milk on the same day are two purchases, not a duplicate. Dedup stays per `(vendor, vendor_order_id)`. A **shared** vendor account (both people log into one Instamart) is the one real duplicate risk — two connections to the same vendor account must be detected and merged into one.
  - *Attribution* (built for history and Insights): `/api/orders` carries `by`, the placing member's email; the history names who placed each order and Insights shows who orders, once more than one person's orders are there. The prediction is per household: two members' orders on one afternoon are one shopping trip to the rhythm estimate (`due.ts`), while quantities still add up. Notifications go to the members who opted in (§13), and a restock nudge shouldn't go to everyone at once (open).
  - *Privacy*: the goal was that a member sees the household's grocery inventory, not the other member's full order history (non-grocery orders, other addresses, spend). **Decision 2026-09-19:** the first shared household is a couple who asked for combined analytics, so members see each other's grocery orders and spend; only grocery orders are ever stored (§7.6). Revisit before households of flatmates or friends: a per-member "share my orders" switch is the likely shape.

---

## 20. Open questions

1. **Token replay + lifetime** — resolved by the Phase 0 spike. Everything hinges on it.
2. **Subdomain** — a subdomain of the already-owned `example.com` (Cloudflare); exact name TBD. It sets the tunnel hostname and the Cognito callback URL.
3. **Tester's phone platform** — an iPhone makes the PWA install step mandatory in Phase 5.
4. **Oracle region** — an India region (Mumbai/Hyderabad) for the VM, where free ARM capacity is available. Cognito stays in `ap-south-1` (the existing pool).
5. **One shared household or two separate?** Shared gives twice the signal on the same items; separate tests isolation and cold start twice.
6. **Instamart is the primary source, not Blinkit.** The user mostly orders on Instamart. Multi-vendor merge (§7.4) is therefore not optional polish — a single-source history badly understates real consumption. Instamart (Swiggy stack) needs its own recon; do not assume Blinkit's endpoints/shapes carry over.

---

## Appendix A — Blinkit reconnaissance (2026-09-18, login added 2026-09-20)

Findings from directly inspecting the logged-in Blinkit web app, which shaped the ingestion design.

**Endpoints.** Order history is `POST https://blinkit.com/v1/layout/order_history`, returning a page of ten order stubs as app widgets. An order's line items and its dated "placed on" line come from `POST /v1/layout/order_details/{orderId}?cart_id={cartId}` (probed 2026-09-20; the page at `/account/orders/{cartId}/{orderId}` makes that very call, so the adapter calls it directly instead of navigating). Auth is fronted by a Kong API gateway.

**Paging is by `next_url`, not by offset.** A JSON body of `{offset, limit}` is accepted and then ignored: offset 0 and offset 10 answered the *same* ten orders, and `limit: 50` answered ten (probed 2026-09-20 on the author's account). The only way through the history is the `pagination.next_url` and the `postback_params` each page hands back, which is therefore the import cursor. An adapter built on offsets would loop over page one forever and report a full import.

**Auth mechanism.** Cookies alone are **not** sufficient — a replay carrying only cookies returns **401**, while the page's own call (which attaches a header token held in `localStorage`) returns **200**. So authentication requires a header-borne token plus a `deviceId` and location (lat/lon/pincode). This is why a plain website cannot read the data client-side, and why server-side headless login is the chosen path.

**Data richness (excellent).** An order line renders as, e.g.:
```
Tresemme Hydra Matrix Sample
15 ml x 1
₹312 item total
Order id ORD89909661903
placed on Sun, 13 Sep'26, 9:58 PM
```
Every line item carries **product name, pack size, unit, count, price, and a precise timestamp** — everything the engine needs, already structured. No OCR or LLM required to read it.

**PII present, to be discarded.** Order pages also expose delivery address, phone-on-file, and card last-4. These are never persisted; only line items, quantities, and dates are stored.

**The login, recorded (2026-09-20).** `spike/blinkit/capture-login.ts` (`npm run capture:login`) watched a real login on a signed-out profile — the installed Chrome spawned and attached over CDP as the worker does it, never Playwright-launched (§7.5). 37 blinkit.com calls recorded. The two that matter:

*Send the code.* `POST https://blinkit.com/v2/accounts/`, `Content-Type: application/x-www-form-urlencoded`, body `user_phone=<10 digits>` (no country code, no `+91`). Answer:
```json
{"login": true, "action": "login", "sms_sent": true, "message_id": "<uuid>",
 "success": true, "message": "We have sent a verification code to you via SMS"}
```

*Verify the code.* `POST https://blinkit.com/v2/accounts/verify/phone/code/`, same content type, body `user_phone=<10 digits>&verify_code=<4 digits>` — the OTP is **4 digits**, not 6. Answer:
```json
{"access_token": "<40 chars, opaque>", "message": "Login Successful", "success": true,
 "verified": true,
 "user": {"id": 0, "phone": "<10 digits>", "verified": true, "country_code": "91",
          "is_international": false, "date_now": 0},
 "user_profile_data": {"cart_count": 0, "is_first_order_delivered": false,
                       "is_first_order_placed": false, "is_undelivered_order_present": false}}
```

*Headers both calls carry.* `app_client: consumer_web`, `platform: desktop_web`, `web_app_version: 1008010016`, `rn_bundle_version: 1009003012`, `app_version: 52434332` (order_history sends `1010101011` instead — the versions are per-service, not one client constant), plus three per-device values the page already holds before anyone logs in: `auth_key` (64 chars, `localStorage.authKey`), `device_id` (16 chars, `localStorage.deviceId`) and `session_uuid` (a v4 uuid). Send-OTP also carries `lat`/`lon`; verify does not. Because the adapter drives these from inside the page, it inherits all of them for free — it must not invent them.

*The trap: an anonymous token.* 19 calls carried an `access_token` header **before** the OTP was verified. A token being present does not mean the session is logged in. The verify answer's token replaces it, and is byte-identical to `localStorage.auth.accessToken` and to the `access_token` header on every later call, including the `order_history` that returned 200. So the login is confirmed by `success && verified` plus a real `order_history` page, never by the presence of a token.

*What the session is.* After login the page holds `localStorage.auth` (`{accessToken, phoneNumber}`), `user` (`{id, phone, verified, profile, properties, dateNow}`), `authKey`, `deviceId`, `merchant` (`{id}`), `location` (`{coords}`), `addresses`/`addressesV2`, and the cookie `gr_1_accessToken` alongside `gr_1_deviceId`, `gr_1_lat`, `gr_1_lon`, `gr_1_locality`, `city`. That is what `CapturedSession` must keep.

*First number on token lifetime.* The `gr_1_accessToken` cookie was written with a **7-day** expiry (login 2026-09-20, cookie expiring 2026-09-27). That is the client's view, not proof of the server-side TTL, which still has to be measured by replaying a captured session until it 401s (§7.3). It does mean a Blinkit reconnect is plausibly weekly, not daily.

*Saved addresses (corrected 2026-09-22).* The earlier note here said Blinkit exposed no addresses endpoint and that the recon account had none saved. Both were wrong, and the mistake was reading a cache instead of asking a question.

`localStorage.addressesV2` is the web client's own query slice. A session captured during the login flow holds it at `status: "idle"` - *never fetched* - and the adapter read that as "this household has saved no addresses". The household in fact has **39**, and the account had them all along.

The home page fetches them itself: `GET /v4/address?cur_lat=&cur_lon=`, which carries an `access_token` plus `lat`, `lon` and `platform` that the `/v1/` calls do not - so a bag picked off a `/v1/` request gets a 401 on it. The adapter therefore does not call it: it loads the home page (the one page measured to make no cart writes, which is why the import uses it) and reads the cache once it is warm. No headers invented, nothing posted.

The payload's field names are `label`, `line1`, `line2`, `location_info.postal_code`, `display_address`, `latitude`/`longitude`, and a second `corrected_location_info` pair the vendor prefers when `use_corrected_location` is true. The first parser was written against guessed names (`address_label`, `building`, `city`, `address_line1`), none of which exist, so every address came back with an empty label and no display text.

**Two things follow for any ordering work.** The 39 are a travel history, not a home address: counted on 2026-09-22, 19 are in Bengaluru, 8 in Delhi/NCR, 3 in Goa, 2 in Dehradun and 7 elsewhere, and even the Bengaluru ones include friends' flats and an office. By `address_meta.source`, 12 are `ZOMATO_IMPORT`, 9 `ZOMATO`, 2 `SHARED_ADDRESS` and 16 carry no source at all - so half the list arrived from food ordering, and two of them were **shared to this account from another account** (both Delhi; the household's own explanation is that a member was living there). An earlier version of this paragraph said 38 of the 39 were Delhi imports. That was wrong, and the household said so.

So an address cannot be picked blindly; the household must choose, exactly as Instamart's `cart_address` does. A list like this cannot be filtered down to one by any rule we could write: it holds several entries labelled "Home", in four cities, and some of them are not even this person's. And the merchant follows the *location*, not the address list: after a restore, `localStorage.location` still held the vendor's Gurugram default (`isDefault: true`) and `merchant` stayed 31719. Setting the chosen address's coordinates is what moves the store.

**The cart, and why Blinkit cannot have one (recon 2026-09-20/21, the household's real account, `spike/blinkit/cart-*.ts`).** Nothing was ordered; checkout was never opened.

Filling a Blinkit cart is technically easy and practically useless, and the second half is what matters. `POST /v5/carts` accepts our own fetch - unlike Instamart, which signs its page's requests and forces button-driving (Appendix C) - and a product's search result hands over its own `atc_action.cart_item`, carrying `product_id`, `merchant_id`, price and the pack as `unit`. Items go in and come out reliably.

**But a cart belongs to a device, not to an account.** The same account with a different `device_id` header gets a different `cart_id` (3944693001 against 3944693073, measured). The household's phone has its own device id and therefore its own cart, which we can never write to: the author put an item in from here and saw nothing in the app, twice, once per store.

**And the store is chosen by the `lat`/`lon` headers.** A session restored from the vault carried Gurugram's default coordinates (`isDefault: true`), so the first attempts filled a cart at merchant 31719, a city away from the household. Resolving the household's pincode through `/location/autoSuggest` then `/location/info` gives real coordinates, and the same search then answers with merchant 36730 and that store's products. Any future cart work must set these headers, and the connect adapter captures no address for Blinkit today.

**There is no way to read a cart, either.** Ten endpoint shapes answered 404, 405, 500, or 200 without the cart in them, and the official web client never reads: it posts its whole local list, so `{"items":[]}` is not a question but an instruction to empty. Loading `blinkit.com/cart` does exactly that by itself. The home page does not (zero cart posts, measured), which is why the import is safe.

**Confirmed on the household's own devices (2026-09-21).** The measurement above says a cart follows the device; the household checked it without us: an item added in the phone app did not appear at blinkit.com in the phone's own browser, signed into the same account at the same moment. Two devices, one account, two carts. Nothing we hold can reach the one the app shows.

The only route left would be capturing the app's `device_id` by proxying the phone's own traffic (easy enough on iOS, awkward on modern Android), and it is not worth it: even holding the right id, the app may announce its own list when it opens - the web client does - and overwrite whatever we put there. That is a coin flip discovered only after the work, on a path that breaks silently whenever Blinkit changes anything.

**Conclusion:** Blinkit is a read-only vendor. Its history is imported; its cart is left alone. The nearest honest feature is a per-item "Open in Blinkit" link, which costs the household one tap per item and needs none of this machinery. `shared_cart_key` exists in the cart payload and is null; the share flow appears to need a key minted inside the app, and six body shapes against `/v1/layout/shared_cart` all answered 400.

**The checkout, recorded end to end (2026-09-22, the household's real account, watch-only).** The household drove; the script recorded; no OTP was typed and the payment was cancelled at the bank's page. The whole chain:

```
PUT  /v5/carts/{cartId}                       fill it (our own fetch is accepted)
POST /v5/carts/{cartId}/validate              {channel_address_id, items[], promo_codes[]}
GET  /createOrder/{cartId}                    -> {access_token, orderHash, expires_in: 2895}
POST /zomato_payment_hash                     {cart_id, payment_info_data:{payment_method_id, payment_method_type}}
                                              -> {payment_hash, order_id, payable_amount}
POST zomato.com/zpaykit/makePayment           form: order_id, amount, card_token, card_vault,
                                              payment_method_id, payments_hash, phone, email
                                              -> {status: pending, is_3d_secure_payment: 1, checkout_url}
GET  zpay.zomato.com/v2/razorpay/3dsecure/initiate   -> 302
GET  api.razorpay.com/pg_router/v1/payments/{id}/authenticate   <- the bank's own page
```

**Blinkit is not Instamart, and the difference is the one that matters.** Instamart's `checkout/order` answers `PLACED` with `payment_status: PENDING` before the gateway is called, so a failed payment leaves a real unpaid order. Blinkit mints an `order_id` at `zomato_payment_hash` - before the money moves - but the order does **not** appear. Measured twice on the real account: cancel at the bank page, sync, the same order count before and after, both times. The id is allocated, the order is not placed. An adapter here is therefore safer than the Instamart one, though `pay.ts`'s rule still holds on both: record any order id seen on the wire, and ask the vendor afterwards rather than trusting the call that placed it.

**Payment is Zomato's, not Blinkit's.** `zpaykit` on zomato.com holds the cards and does the work; Razorpay is the gateway; the 3-D Secure page is Razorpay's own host. Nothing here is a Blinkit endpoint, so a Blinkit payment adapter is really a zpaykit one - and that is the part most likely to be shared with Zomato and District, and least likely to change when Blinkit's own app does.

**The card is a vault token and the CVV is exchanged before the payment call.** `makePayment` carries `card_token` and `card_vault: winecellar` and **no CVV at all**. The CVV is taken by the zpaykit UI first - `getPaymentMethods` carries `cvv_length`, `cvv_specific_details`, `cvv_details_popup` and `show_old_cvv_page` - so the adapter must still type it into that page, exactly as Instamart's does, and then type the bank's OTP into Razorpay's. Two typed secrets, two different hosts, neither ever ours to keep.

**What the cart survives, and what it does not (2026-09-22).** Three things were measured while building the dry run, because each one decides whether a server-filled cart can be paid for at all:

- **There is no read-only look at a cart.** `GET /v5/carts` is a 405 and `GET /v5/carts/{id}` a 500. `POST` replaces. So asking what is in the cart *is* the act of replacing it, and any code that wants to know must already know.
- **A page load does not wipe it.** The web client `PATCH`es `/v5/carts` when it opens, which looked like the client announcing its own list over ours. It does not: a cart filled through our own fetch, then a full page load of blinkit.com on the same account, then `validate` on the same cart id - one line before, one line after, same bill. The cart is the account's on the server; what the page renders is its own state, which is why blinkit.com/cart can show "You don't have any items in your cart" while the server cart holds milk. The two disagreeing is normal and is not a failure to fix.
- **`createOrder` does not carry the cards.** Its `payments_info` is `{country_id: 1, service_type: "BLINKIT"}` - the context zpaykit is called *with*, not a list of ways to pay. The card list is a separate zpaykit call, and `/config/main` does not name its endpoint. So the zpaykit URLs can only come from watching a real checkout, which is what `spike/blinkit/capture-checkout.ts` is for.

**The payment chain, every call named (capture 2026-09-22, the household drove, cancelled at the bank).** The earlier recording gave the shape; this one gives the endpoints, and they are not guessable - `/config/main` does not name them and the page HTML yields only `https://www.zomato.com`.

```
GET  blinkit.com/createOrder/{cartId}          -> {access_token, orderHash, expires_in}
GET  zomato.com/zpaykit/init
POST zomato.com/zpaykit/userDefaultPayment     {country_id, service_type, phone, amount,
                                                criteria: last_used_global, online_payments_flag}
                                               -> the preferred card, and the CVV rules
POST zomato.com/zpaykit/countryInfo            {country_id, service_type, phone_number}
POST zomato.com/zpaykit/getPaymentMethods      {country_id, service_type}   <- every saved card
POST zomato.com/zpaykit/getCardValidationData  {country_id, service_type}
POST blinkit.com/zomato_payment_hash           {cart_id, payment_info_data}
                                               -> {payment_hash, order_id, payable_amount, cart_id}
POST zomato.com/zpaykit/makePayment            payment_method_id, payment_method_type, card_token,
                                               card_vault, service_type, order_type, country_id,
                                               order_id, amount, host_redirect_url, payments_hash,
                                               phone, email, gateway_info, additional_params,
                                               payments_config_params     (form-urlencoded)
                                               -> {status: pending, gateway_type: razorpay,
                                                   is_3d_secure_payment: 1, transaction: {track_id,
                                                   checkout_url, response_url}}
GET  zpay.zomato.com/v2/razorpay/3dsecure/initiate?track_id=…   -> 302
GET  api.razorpay.com/pg_router/v1/payments/{id}/authenticate  <- the bank's own page
```

**`userDefaultPayment` is the only call an ordinary payment needs.** It answers with the household's last-used method and everything required to pay with it: `payment_method_id`, `payment_method_type: card`, `card_token`, `vault: winecellar`, `display_text` ("Amex American Express Card"), `subtitle` ("****** 1111"), `issuing_bank`, `card_type`, `card_expiry_month`/`_year`. `getPaymentMethods` is only needed to offer a *different* card. Both carry the card's own CVV rules.

**The CVV length is per card and must be read, never assumed.** This household's preferred card is an Amex: `cvv_length: 4`. Three is the common case and the wrong one here, and a four-digit code typed into a box validated for three is a declined payment on an order that already has an id. `disable_cvv_page: 0` and `show_old_cvv_page: 0` say whether the code is wanted at all and which screen asks for it - both are read, neither is guessed.

**`zomato_payment_hash` is where the price is settled and the order id is minted.** It answers `{payment_hash, order_id, payable_amount, cart_id}` - a real `order_id` (1000000001 in this capture) before any money moves, and the `payable_amount` (379) that the gateway will actually be asked for. That number is the one to put in front of the household, exactly as Instamart's payment screen total is: the cart's own bill is not what the checkout charges. Nothing may be paid until the household has agreed to this figure.

**How zpaykit is authorised, and where every secret travels (capture 2026-09-23, a payment that went through).** This is the answer to the question two earlier captures did not survive long enough to answer.

- **`createOrder`'s `access_token` is carried as the `x-client-pas-token` header**, on every zpaykit call: getStaticLangKeys, countryInfo, userDefaultPayment, getPaymentMethods, getCardValidationData and makePayment. Not a bearer, not a form field, not a query parameter - all three were tried against the live endpoint and answered `403 {"status":"failed","message":"Empty Access token"}`.
- **zpaykit will not answer a blinkit.com page at all**: the fetch fails at CORS before it is sent. The calls are made from a zomato.com page, which is safe here because a different origin cannot touch the Blinkit cart.
- **`/zpaykit/init` is a page, not a session.** It answers 200 with the SDK's HTML whatever it is given, and changes nothing.
- **`createOrder`'s `orderHash` goes to `getPaymentMethods`,** in the body.
- **The card's `card_token` goes to `makePayment`** as `card_token`, and **`zomato_payment_hash`'s `payment_hash` goes to `makePayment` as `payments_hash`** - the request field is plural where the response field is singular, which is exactly the sort of thing that is silently wrong.

**The card fields are two levels deep.** What the household is SHOWN sits on the method (`payment_method_id`, `payment_method_type`, `display_text`, `subtitle`); what is needed to PAY sits under it in `default_payment_object.card` (`card_token`, `vault`, `cvv_length`, `disable_cvv_page`, `issuing_bank`, `last_four_digits`, `valid_for_payment`, `card_status`). A reader that takes only the top level gets a method with no token and no CVV length, which is what the first one did. `getPaymentMethods` lists cards directly, so the same reader has to take either shape.

**`first_six_digits` is in that answer and is deliberately not read.** With `last_four_digits` it is ten digits of a fifteen digit card, and nothing here has any use for it (§7.6).

**The verdict is matched by the CART, not by the payment's order id (2026-09-23).** A real payment went through and made this measurable. Three ids are involved:

```
zomato_payment_hash answered order_id  1000000002   (and 1000000001 on a cancelled attempt)
the vendor's own order list calls it   1000000003
the cart both attempts were for        3900000001
```

The payment's order id appears **nowhere** in `order_history`. What ties the order to us is the cart: the history stub identifies itself as `order_<orderId>_<cartId>`, and that cart id is the one id we have held since before any money moved. So §19's "ask the vendor afterwards, matched by order id" is right in spirit and wrong in the field it names - on Blinkit it is matched by `cart_id`, which `stubsFromList` already returns.

**A just-paid order is not a row in that list for some minutes.** While it is on its way it is a tracking card: `ENROUTE` appears in the answer, but not on any object carrying both an `order_id` and an `order_status`. So the honest answer in that window is `unconfirmed` - "we could not tell yet" - and the caller asks again. Never "failed": telling a household a payment failed when it did not is how they pay twice.

**And the day's own orders were invisible to the app entirely.** The detail page writes "placed today, 12:03 AM" for a fresh order and only rewords it to "placed on Sun, 13 Sep'26, 9:58 PM" a day or so later. `placedFromDetail` required the dated wording, so it returned null and the order was skipped - every sync reported `newOrders: 0` while the order sat at the top of page one. For a replenishment app the day of purchase is the day that matters most, so "today" and "yesterday" are now resolved against the moment of reading, which is passed in rather than taken from the clock. This is not the guess this appendix warns about: that one is inferring a YEAR onto an absolute date, which lost most of the orders. The day is taken in IST, because at 19:00 UTC it is already tomorrow in India and a worker reading UTC would misfile every late-night order.

**The CVV is real, and it forces the page-driven route (2026-09-23).** The household watched themselves pay: the payment page showed their cards, the CVV box was blank, and Pay only became live once the code was in. No request in the recorded checkout carries a CVV - not `makePayment`, not `gateway_info`, which is `{}` - so it is handed over somewhere the recording never saw, most likely to Razorpay during 3-D Secure. Reading that absence as "no CVV is needed" was wrong, and would have spent real money on a call the card was going to decline, after an order id had already been minted.

That box belongs to the vendor's own checkout, which rules out paying for a cart we built by API: **the page cannot see such a cart**. Filled through our own call and then the cart page loaded fresh, it renders "You don't have any items in your cart" while the server cart holds the item. The page keeps its own copy.

**Driving the page works for the cart, and stops at a login gate.** Clicking the vendor's own ADD button puts the item in the page's cart, and `/cart` then shows it with a far better bill than the API gives: `Sub total 35, Delivery 30, Handling 12, Late night convenience 15, Small cart 30` against the API's single opaque `additional_charge`. But the cart page's own control reads **"Login to Proceed"**.

It is not that the session is dead. `/account` on the same browser shows the household's address, Order History and Address Book, and every API call is answered. The gate is client-side: `localStorage.user` comes back as `{"properties":{},"profile":{}}` - captured empty at connect time, because the adapter writes the token into the page rather than letting the page sign itself in, so the page never fetched a profile. The cart page checks that profile, finds nothing, and offers a login.

Filling `user` by hand does not open it. Written in with the account's real phone and a name, the cart page still says "Login to Proceed", so the checkout is testing something else as well. `/account` calls `GET /layout/profile_layout/`, which answers 500 to a plain GET, and six guessed profile endpoints are all 404. Loading `/account`, `/account/profile` and `/` leaves `user` untouched.

**The cause is in how the connect adapter signs in, and it is written in that file's own header:** the login is done with our own `fetch` and the token is then written into the page. The page's own login JavaScript never runs, so whatever else it writes - the profile, and evidently some other mark the checkout looks for - was never written. A session restored this way is authenticated for every API call and is not, to the page's own checkout, a signed-in browser.

**So the fix is to sign in through the vendor's own form**: type the phone into the page, let it send its own OTP, type the code into the page, and let the vendor's JavaScript establish whatever it establishes. That is what Instamart's adapter effectively does, and it is the difference between a session that can read and one that can check out. It costs the household one reconnect.

Until that is done the page-driven checkout cannot be reached, and Blinkit payment stays refused - which is what the code does.

**Settled: a populated `user` is what opens the checkout (2026-09-23).** Not a page login, and not more captured keys. Proved by capturing a real login and restoring it the way the worker does - into a clean browser profile, with only the eight `BLINKIT_SESSION_KEYS` - after which the vendor's own cart page says **"Proceed To Pay"**. The single thing that session had and a connected one did not was a populated `localStorage.user`.

A real login writes no new keys and no `httpOnly` cookie. It fills four: `auth` 39 to 85 bytes, `cart` gaining `cart_state`, `location`, and `user` 30 to 157 gaining `dateNow`, `id`, `phone`, `verified` and `properties{cancelledOrders,deliveredOrders,liveOrders}`. Only `user` matters to the checkout. All of it is ours to write: the verify answer already carries `user.id`, `user.phone`, `user.verified` and `user.date_now`, and connecting was throwing them away.

**Timing is the whole trick, and it is what made this look impossible for an evening.** `user` must be written BEFORE the page's own scripts run - which is what `addInitScript` does on a restore, and what the connect adapter now does before capturing. Written after the page has booted it is silently discarded: the app persists its own in-memory state back over it. An experiment that wrote `user` into a loaded page and then navigated therefore showed it "reset to empty on every boot", and led to the wrong conclusion that no amount of storage-writing could work.

**The login form was recorded too**, and is simple if it is ever needed: a `div` reading "Login" (`ProfileButton__Container`), then one `input[type=tel][maxlength=10]` placeholdered "Enter mobile number" (`login-phone__input`), then **four** `input[type=tel][maxlength=1]` boxes (`otp__input`) - a four digit code, one digit per box, which is the shape `chooseOtpBoxes` already handles. It is not needed for this fix.

**Cost: one reconnect per household**, because a session captured before this has an empty `user` and cannot be repaired in place - the page keeps whatever it is given at boot, and what it was given is empty.

**Choosing a card** is possible without ever seeing a number: `getPaymentMethods` gives `card_id`, `card_token`, `last_four_digits`, `issuing_bank`, `card_name`, `card_type` and the expiry. The household picks by the words their own screen shows, as it already does on Instamart.

**The address is chosen at `validate`**, as `channel_address_id` - the `id` from `GET /v4/address`. So the address work above is not optional groundwork for ordering; it is the field the cart is validated with.

**The edge challenges on pace, and what that means for the code (2026-09-20).** A probe fetching order details every 250 ms was answered with Cloudflare's `Just a moment...` page instead of JSON - a non-interactive challenge, `cRay a3e19417ecaf83f3`. The real import, a few hundred orders at `IMPORT_CALL_DELAY_MS` apart, was never challenged, so the pace is the thing being judged, not the account. Two consequences worth holding on to:

- **A challenge is not a logout.** `classifyListResponse` reads any non-JSON answer as `unreachable` and retryable; reading it as `unauthorized` would tell a household to reconnect - costing them an OTP - because an edge hiccuped. This is the same reasoning as Appendix C's classifier and it was tested for real here.
- **Our fetch cannot solve one.** The in-page `fetch` takes the response without running the challenge's JavaScript, so it sees the HTML and stops. The worker drives a real Chrome: navigating the page to the same URL lets Chrome solve a non-interactive challenge in a few seconds and carry on. That is the recovery to build, and it matters more for ordering (§19) than for reading, where a retry is free and a half-placed order is not.

**Tested in the spike (Appendix B).** The token does not replay from a raw HTTP client at all — the edge blocks it by client fingerprint before auth. It works only from a real browser engine. Remaining questions (headless, datacenter IP, opaque-token lifetime) are in Appendix B.

---

## Appendix B — Spike results (2026-09-18)

The `spike/blinkit/` scripts (`capture` → `replay`/`probe`) were run against the author's real account. What they found reshaped §7.

**The decisive experiment.** The identical `order_history` POST — same account, same freshly-captured token, same home residential IP, byte-identical headers — sent two ways:

| Client | Result |
|---|---|
| Node `fetch` (raw HTTP) | **403**, 561 KB HTML block page. Never reaches the auth layer. |
| `fetch` inside logged-in Chrome (Playwright) | **200**, full order JSON. |

Same token, same IP, same headers — only the client differs. So the blocker is **client-fingerprint bot detection at the edge** (TLS/JA3-class), not the token and not the IP.

**Consequences, now baked into the design:**

1. **The worker must drive a real browser engine** and call `order_history` from the page context. A lightweight server-side HTTP client is not usable — it is blocked outright. This makes the persistent-Playwright-on-Oracle-ARM choice (§14.1) a requirement, not a preference.
2. **The token is opaque, not a JWT.** Lifetime cannot be read from it; it must be measured by replaying a captured session until it 401s. That cadence sets how often the user re-enters an OTP (§7.3). Not yet measured.

**Still open (both gate full GO):**

- **Headless Chrome** — the 200 was headful. Headless has a distinct fingerprint and may be blocked. Test: `HEADLESS=1 npm run probe`. Fallback if blocked: headful Chromium under Xvfb.
- **Datacenter IP** — the 200 was from a home IP. The Oracle datacenter IP may be challenged even with a real browser. Test: run the probe on the Oracle box. Fallback if blocked: residential proxy, else the extension path.

**Full extraction works end to end.** `extract.ts` paginates the list and pulls each order's detail, producing clean records. First run: 10 orders → 57 line items, every one parsed to name + pack + unit + count, all `DELIVERED`. This is real engine test data and proves the entire read path, not just auth.

Structure learned (drives the real adapter's parser):

- **List** (`order_history`): a widget tree; each order is an `order_history_container_vr` snippet carrying `order_id`, `cart_id` (from `identity.id = "order_{orderId}_{cartId}"`), status, date text, and total. **No line items in the list.**
- **Detail** (`/account/orders/{cartId}/{orderId}`): also a widget tree; line items are `z_v3_image_text_snippet_type_30` snippets with `widget_name = "order_details_list"` — `title.text` = product name, `subtitle1.text` = quantity, `subtitle3.text` = MRP/paid price (markdown). Delivery address is the `order_summary_details` card (feeds §7.9 address scoping).
- **Quantity text has two orders** the parser must handle: pack-first (`"500 g x 1"`) and count-first (`"2 x 75 g"`, multipacks). Rule: the number adjacent to a weight/volume unit is the pack; the other is the count. The first parser assumed pack-first and mis-read multipacks — caught by eyeballing the extract output, fixed.

**Method note.** `capture.ts` uses a persistent Chromium profile so re-runs skip the OTP. `session.json` and `orders.json` hold a live token / real purchase data and are gitignored; treat them as secrets.

**Two silent-corruption bugs found in session 2 (2026-09-18), both fixed.** Both are exactly the failure mode §9 warns about — partial or wrong data that doesn't error, it just skews the model:

- **Undated orders.** The list's date text ("13 Sep, 9:58 pm") has **no year** and is **absent entirely on older orders**, so most orders had `placedAt: null` and were silently dropped — the first predictions ran on a fraction of the history, not two years. The detail page carries the year ("placed on Sun, 13 Sep'26, 9:58 PM", IST); `extract` now takes `placedAt` from there. Re-run: **every order dated, about three years of history.**
- **Unit fabrication in the engine.** `toCanonical` treated a quantity in the wrong dimension as base units — "1 bunch" of coriander became 1 g, a pumpkin "1 piece" became 1 g. 120 Blinkit lines were affected, and merging Instamart (bunches) with Blinkit (grams) would have made it worse. It now returns `null`; the line is skipped and reported as a pack to learn (§8). The same report also exposed **misclassified products** (normalize rules matching ingredient words: "Pepsi Zero **Sugar**" → sugar, "Pineapple **Juice**" → pineapple, "Smoot**hing**" conditioner → spices) — a cheap, useful consistency check.

---

## Appendix C — Instamart reconnaissance + extraction (2026-09-18)

The household orders mostly from Instamart, so this was the highest-value adapter. The `spike/instamart/` scripts (`capture` → `extract`) were run against the author's real account.

**Instamart has its own domain: `instamart.in`.** It serves the same app bundle as `swiggy.com/instamart`, but the login does not carry across domains. swiggy.com's account page lists **food orders only** (`/dapi/order/all`, `restaurant_type: F`) — Instamart history is not there. On instamart.in, signed out, `/account-details` shows a generic "We'll be back shortly" page rather than a login prompt.

**Bot detection is stricter than Blinkit's.**

| Client | Result |
|---|---|
| Playwright-launched Chromium (`launchPersistentContext`) | **Blocked at the first page load** — "Your request looks automated". Never reaches login. |
| Installed Chrome started as a plain process, Playwright attached over CDP (`connectOverCDP`) | Works — login, OTP, and every API call below. |

instamart.in also loads an **AWS WAF challenge** (`*.edge.sdk.awswaf.com/.../challenge.js`). So the worker must not let Playwright launch the browser (the automation flags are what's detected); it spawns Chrome itself and attaches (§7.5). All API calls are `fetch` from inside the logged-in page — no custom headers were needed.

**Order list — `GET /api/instamart/orders?order_type=DASH&count=20&from_time=<epoch ms>`.**

- Newest first. `count` is capped at **20** server-side (50/100 still return 20). Some pages come back short (9–17) mid-history; that is server-side filtering, not the end.
- Cursor: `from_time` = the oldest `created_at` on the previous page. The extractor uses `oldest + 1` and dedups by `order_id`, so an order sharing the boundary millisecond is never skipped. End of history = a page with no new ids.
- **Line items are embedded** — no per-order detail call needed. `order_data.orders[].order_jobs[].metadata` is a JSON **string**; inside it `bill.billedItems[]` has `item.{itemId (SKU), storeId, name, quantity}` and `bill.{itemBasePrice, totalCost, …}`. The same metadata holds the delivery address (with flat no., phone, name, lat/lng — PII, dropped at extraction; only `annotation · area` is kept for §7.9).
- `history_status`: `DELIVERED`, `FAILED`, `CANCELLED`. Only `DELIVERED` is a purchase.
- Per-order detail also exists — `GET /api/order/v3/getOrderDetails/{orderId}` — but adds nothing the list lacks.

**History depth: exactly one year**, with no gaps (8 random mid-history pages re-fetched, all already captured). Instamart appears to serve a rolling 12 months. Consequence: **our `purchases` log is the only long-term copy of the history** — the first sync must happen early, and nothing may assume old orders can be re-fetched from the vendor.

**Pack size is NOT in the order payload** — the key difference from Blinkit. A line reads "Amul Gold Pasteurised Full Cream Milk × 2", with no "500 ml". The catalog has it:

- Catalog variations carry `skuId`, `spinId`, `quantityDescription` ("500 ml", "330 ml x 2", "1 Bunch", "75 Pieces"), `weightInGrams`, category.
- **SKUs are store-specific** (the same milk is `QVRYGM487P` at one store, `RXVG2GNW9P` at another); `spinId` is the product-variant key.
- Resolution rule: `POST /api/instamart/search/v2?storeId=S&primaryStoreId=S` (S = the line's own `storeId` — mixing stores returns no match) with body `{query: <item name>, page_type: "INSTAMART_SEARCH_PAGE", …}`, then accept **only the variation whose `skuId` equals the ordered SKU**. No exact match → pack unknown, never guessed (§8).
- Result: **1,196 of 1,281 delivered line items (93%)** get an exact pack. The misses are mostly non-grocery (vouchers, bandages, medicine) plus loose produce whose SKU is currently unlisted — notably **ginger (20 buys)**, sold at ₹21–₹55 for the same SKU, so no pack can be inferred. These are exactly the "unknown pack → ask once" case.
- Guessing the spinId from product image filenames was tried and rejected: only ~50% of lines carry one, and the pattern is heuristic.
- `GET /api/instamart/item/v2/spin/{spinId}` returns a product with all variants — useful once a spinId is known.
- Pack labels parse to canonical units; multipacks fold in ("330 ml x 2" → 660 ml). Countable catalog units — "1 Bunch" (coriander, curry leaves, mint), "1 Pack", "1 Small" (coconut) — are pieces.

**Rate limiting:** none hit at ~1.2 s between calls, across 13 list pages and ~600 searches. Search responses are large (~160 KB) and slow (~5 s).

**The cart (recon 2026-09-20, the household's real account, `spike/instamart/cart-recon*.ts`).** Nothing was ordered; checkout was never opened.

- **The store depends on the address.** A session with no address shows "Share location to find the closest Instamart store"; picking a saved address calls `POST /api/instamart/home/select-location/v2` and sets the store (`storeId`/`podId`, here 1392421). Stock and price are per store.
- **Search** (`POST /api/instamart/search/v2`, the page calls it for `/search?query=…`) gives, per pack (`variations[]`): `skuId` (the cart's `itemId`), `spinId`, `displayName`, `quantityDescription` ("500 ml"), `price.offerPrice`, `inventory.inStock`, `skuAvailable`, `cartAllowedQuantity.allowedQuantity` (20), `podId`. Out of stock is visible before adding.
- **Add** is `POST /api/instamart/checkout/v2/cart?pageType=…` with `{data: {items: [{quantity, productId, spin, itemId, meta: {storeId}, serviceLine}], cartMetaData: {preferredAddressId, primaryStoreId, storeIds, …}, cartType}}`. **It sends the whole cart**: adding a second product sent both lines. A call carrying only the new item would drop everything else in the household's cart.
- **Our own call cannot add.** The same body sent by our in-page `fetch` gets `statusCode 101 "Spin Id for all items not present"`, with or without the page's device and build headers; the page's own request also carries a per-request signature (`matcher`). Reading the cart and `POST …/cart/clear` do work from our fetch. **So the worker adds through the page's own buttons** (search page → the product's + → the pack picker's ADD for the wanted pack → Confirm), which also leaves merging the cart to the page. We don't reverse-engineer the signature.
- **Products with several packs open a picker** (500 ml ×4, ×2, single) with an ADD per pack and a Confirm. The pack must be chosen by its label and price, never by position: the order changed between two runs and the wrong pack was added once.
- **The page pushes its local copy of the cart on load** (`actionType: CREATE_CART_FROM_LOCAL_CACHE`). A browser profile that remembers an old cart puts those items back after they were removed elsewhere; this happened in the recon. **The worker must use a profile with no stored cart** (a fresh one per run, with only the session restored) and read the cart first.
- **The bill tells what the app is charging now:** the cart response has `bill.itemTotal`, `toPay`, `deliveryCharges`, `smallCartCharges` (₹20 under a minimum), and `surgeFee` (₹30 during the recon: Instamart's high-demand or weather charge). The page shows "FREE DELIVERY on orders above ₹X". These drive the free-delivery top-up and a plain "Instamart is charging a ₹30 surge fee right now".
- **Serving or not:** the cart's `storesInfo`/`shipmentDetails` carry `serviceabilityDetails: {serviceabilityStatus: 2, sla: "23 Mins"}` and an `unavailableErrorMsg`. Status 2 with an SLA is serving; the not-serving value (rain, closed) couldn't be forced. The worker treats anything else, or no SLA, as not serving and shows Instamart's own message when it gives one.
- **The cart lives on Instamart's side:** items added on the web showed up in the household's phone app (checked by the household, 2026-09-20).
- **Filling a cart through the page** (`spike/instamart/cart-fill.ts`, done on the real account: 2 × Nandini Pasteurised Toned Milk 500 ml + 1 × Milky Mist Set Curd 1 kg, every line checked against the cart afterwards):
  - *Find the exact pack in the search data*, by product name and pack label (`displayName`, `quantityDescription`); stock and price from the same place.
  - *Find the card by its image, not its name.* Instamart scrambles product names in the page text ("Nandini Pa teuri ed Toned Milk"), and one product can have several listings with the same name (Milky Mist Set Curd: 1 kg, and 200 g). The card whose image files match the listing's `imageIds` is the right one.
  - *The pack picker is labelled:* each row is `variants-container` with `variants-name` ("500 ml", "x 2"), `variants-price` ("24"), and `add_buttons_center` / `add_buttons_plus` / `add_buttons_minus`. The row is the one whose name is exactly the pack and whose price matches. (The ₹ sign is an icon, so the row's text reads "500 ml244.8/100 ml".)
  - *Set the amount, don't add it:* count what is already in the cart and add or remove only the difference; adding 2 to a cart that had 2 made 4 once.

**Other endpoints seen** (from the web bundle, not needed yet): `/api/instamart/reorder` (previously bought items, with variations), `/api/instamart/auth/{send-otp,verify-otp,signin-check}` — the OTP flow the adapter's `requestOtp`/`submitOtp` will drive.

**Still open for Instamart** (same as Blinkit, likelier to bite given the stricter detection): headless, datacenter IP, token lifetime.

## Appendix D — Zepto reconnaissance (2026-09-24)

Recorded, not guessed: the household drove zepto.com by hand while `spike/zepto/record.ts` wrote down every request and response (headers and bodies), every click and field touched, and a screenshot, DOM and storage snapshot after each step. Two runs: login → 3-item cart → saved card → Pay, stopped at the bank's OTP page; then the whole order history. `spike/zepto/probe-history.ts` then measured what our own code may call. The recordings stay in `spike/zepto/runs/` (gitignored) until Zepto is finished.

**Where it lives.** `zeptonow.com` 301s to **`www.zepto.com`**. The api is **`bff-gateway.zepto.com`**, cross-origin from the page. The page carries an AWS WAF token (`*.token.awswaf.com`). Chrome was spawned as a plain process and attached over CDP, as for Instamart; whether a Playwright-launched browser is refused was not tried.

**Login.** `POST bff-gateway…/api/v1/user/customer/send-otp-sms/` `{mobileNumber, countryCode: "+91"}` → "OTP Sent."; then `POST www.zepto.com/api/auth/verify-otp` `{mobileNumber, countryCode, otpToken}`, which answers the user's profile and sets three cookies: **`accessToken`, `refreshToken`, `isAuth`**. From then on every api call rides on cookies (`auth_from_cookie: true`), not a header token. A refresh token means the session may renew itself; how long it lasts is still to be measured (§7.3).

**Every api call is signed, and reads do not need the signature.** The site sends `request-signature` (64 hex, new on every call) and a hashed `x-timezone` on each bff-gateway call, besides device, session, store and xsrf headers. From our own `fetch` inside the signed-in page:

| Headers sent | Order list | Order detail |
|---|---|---|
| none (cookies only) | fails at CORS | fails at CORS |
| the site's plain headers, no signature | 200 | 200 |
| the same plus a signature from an earlier call | 200 | 200 |
| only `app_version`, `appversion`, `auth_from_cookie: true` | 200 | 200 |

Without an app version the gateway fails the call at CORS; without `auth_from_cookie` it answers 401. The version is the web build's own (`16.31.8` on the day); the adapter reads it from a request the page makes on load rather than pinning it. Whether writes (cart, order) check the signature was **not** tested: the lesson of Instamart (Appendix C) is that they may.

**Order list — `GET /api/v2/order/?page_number=N`.** 8 orders a page, newest first, `endOfList: true` on the last. Page 1 also carries 38 recommended products (240 KB; the rest are ~20 KB). The site's own list is a Load More button pressed once per page; the adapter walks `page_number` itself. Per order: `id` (uuid), `code` ("OHRMRBCMH86338"), `status`, `placedTime`, `arrivedTime`, `grandTotalAmount` (paise), `storeId`, and `productsNamesAndCounts[]` = `{name, count, id (storeProductId), productVariantId, image}`. **No pack size and no line price in the list.**

**History depth: all of it**, back to the account's first order. Statuses seen: `DELIVERED`, `ARRIVED`, `CANCELLED`. Not a rolling year like Instamart. A purchase is `DELIVERED` or `ARRIVED`.

**Order detail — `POST /pfs-postorder/api/v1/get-page/ORDER_DETAILS`** `{orderId, page_size: 8, isArchived: false, enforce_platform_type: "DESKTOP"}`. A widget page, itself paged: a second call adds `last_widget_id` and `page_number: 1` from `nextPageParams`, until `endOfPage: true`. The products are at `pageLayout.widgets[].data.items[].orderProductsV2.sectionData[].orderProducts[]`, each with:

- `storeProduct.product.name`, `storeProduct.productVariant.{id, formattedPacksize ("500 g", "1 pack (500 ml)"), packsize, unitOfMeasure, weightInGms}`
- `quantityOrdered`, `quantityFulfilled`, `quantityRejected`: only the fulfilled count is a purchase
- `unitMrp`, `unitSellingPrice`, `unitFinalSellingPrice`, `totalFinalSellingPrice` (paise)

The bill (item total, delivery, fees, grand total) is in later widgets as display text ("₹640.35"). So the pack is in the order itself, as with Blinkit, and no catalog lookup is needed (contrast Instamart, Appendix C). A first import is ~12 list calls plus 1-2 detail calls per order; later syncs need only the new orders.

**The cart lives in the page until it is opened.** Pressing ADD makes **no network call**: the items sit in the page's `localStorage` under `cart`. Opening the cart sends it all at once, `POST /cfs/api/v1/cart/create` `{storeId, cartId: "", cartProducts: [{storeProductId, productVariantId, mrp, quantity, …}]}`, and the answer is the server's cart: `cartId`, `userAddressId`, `isDeliverable`, `itemTotalAmount`, `deliveryFee` with `deliveryFeeBreakdown {surgeFee, rainFee, lateNightFee, distanceInMeters}`, `deliveryFeeMessage` ("Add products worth ₹80 to get free delivery"), `grandTotalAmount`. Later edits are `PUT /cfs/api/v1/cart`. Whether a cart written into localStorage by us is taken up by the page, and whether the household's phone then shows it, is untested; Blinkit's cart turned out to be bound to one browser (Appendix A), so this must be measured before it is built on.

**Paying, and the order before the money.** The run: ₹119 items + ₹30 delivery = ₹149.

1. `POST /payment-service/payment-listing-api/v1/ipp` lists the ways to pay: `amountToPay` (paise), the saved card (`AMEX_AXIS_CREDIT`), UPI, Pluxee, BNPL, net banking, and **COD** (Pay on Delivery).
2. The saved Amex is **"CVV Less"** (`isCardCvvLess: true`): only the bank's OTP stands between Pay and the charge.
3. Make Payment → **`POST /api/v3/order/`**, with the card chosen and `previousCartDetails.toPay`, answers **201 `status: INITIATED`, `isOrderCreated: true`** with the order's `id` and `code` (`LUVKBCMT36553`). The order exists before the gateway is called, exactly as on Instamart (§19): nothing may be retried after this call, and its id is recorded whatever follows.
4. Juspay `POST api.juspay.in/txns` (card token, not the number) → `PENDING_VBV` → Easebuzz (`pay.easebuzz.in`) → Amex 3-D Secure → **Axis bank's ACS page** (`secureaxis-acs2ui…axis.bank.in`, Wibmo). The OTP was delivered to the household's phone and not typed; CANCEL was pressed.
5. Back to `www.zepto.com/ProcessOrder?status=AUTHENTICATION_FAILED&order_id=…&signature=…`, then **`GET /api/v1/order/{id}/payment-status/`** → `paymentStatus: FAILED, failureReason: AUTHORIZATION_FAILED`. That call is the verdict, read afterwards, never the reply to the order call.
6. The unpaid order is closed by Zepto itself: it appears in the order list as `CANCELLED`.

**The adapter, and what building it measured (2026-09-24).** Connect and import are built (`server/src/worker/adapters/zepto.ts`, `zepto-import.ts`, `import/zepto-parse.ts`) and were run against the household's account through the website: connected at the first OTP, the whole history imported in about 4 minutes, every product with a pack.

- **Connect drives Zepto's own login form** (`button[aria-label="login"]` → phone box → Continue → one `aria-label="OTP"` box that submits itself at the sixth digit), and reads each step's answer off the wire. A login is a write, and only reads were measured to work unsigned.
- **The session is two cookies.** `accessToken` and `refreshToken` alone read orders in a fresh browser. Sealed: those two plus `isAuth`, `user_id`, `device_id`; never the `latitude`, `longitude`, `user_position` and `serviceability` cookies, nor localStorage (cart, addresses, profile).
- **`accessToken` is a JWT that lasts one hour**, and **the site renews it on page load by itself** (server-side: no call is visible in the page). **The refresh token rotates each time.** So a refusal reloads the page once before it is called a logout, and the import runner seals the session the job ends with after every sync that opened one, whether or not the sync then worked: a renewal lost with a failed sync would leave the vault with a refresh token Zepto no longer honours. How long a refresh token lives unused is still unmeasured.
- **The first answer to a page load is a 202**, AWS WAF's challenge, which the page solves and reloads past. Headless passes (`worker probe`, Linux Chromium in the worker container, home IP); the probe and the adapter accept any 2xx, and what proves the site came up is its own first api call carrying the build version.
- **Pack labels** take forms the other vendors do not: "1 pack (500 ml)" (contents stated), "500 g or 534 g" (either size), "900 g - 1 kg", "200 - 300 g" (loose produce). §8's parser reads a stated pack as its contents and a loose size as its smaller (engine version 8). 144 of 152 read; the rest are café food and combos ("Serves 1", "1 combo") and "3 pcs (750 - 900 g)", unknown.
- `ARRIVED` is a delivery: seen on a five-month-old order with an arrival time.
- **Zepto Cafe food rides in the same orders.** 102 of the household's 271 delivered lines were the vendor's own kitchen (puffs, samosas, chai), and read by name "Chicken Puff" was chicken. The detail marks them (`product.brand = "Zepto Cafe"`, and a `unitRestaurantCharge`), so the line carries `prepared` and becomes one item, café food: counted wherever money is, never in Supplies, the running-low list or advice (`classifyLine`, `isStock`). Zepto also slips promotional inserts into orders (a postcard, a newspaper, flyers); the catalog excludes them.

**The cart belongs to the device, not the account (2026-09-24, `spike/zepto/probe-cart.ts`).** Measured without writing anything:

- A three-item cart (banana, tomato, carrot, ₹149) made on the web the day before is still on Zepto's server: the web page's own `PUT cfs/api/v1/cart` is answered with that cart's id and bill.
- **The household's phone does not show it** (checked in the Zepto app, same account).
- **A fresh browser signed in to the same account starts empty and fetches no cart.** Loaded with only the login cookies, the page made no cart call at all and its local cart stayed at 0 lines.

So each client keeps its own cart in its own storage and pushes it whole; the server prices what it is sent and never hands a cart back to another client. That is Blinkit's shape (Appendix A): a cart we fill would be ours, never the one the household opens. Not yet ruled out, and worth one check before closing this for good: that the phone was on a different delivery address, and so a different store's cart (as on Instamart). A cart added on the phone and then looked for from a fresh web session would settle it. Whether our own unsigned `PUT` is accepted was not tried: with the cart unreachable from the phone, it would only matter for paying from a cart the worker fills and pays in one browser, as on Blinkit.

**Still open for Zepto:** the address check above; the datacenter IP; how long an unused refresh token lasts.
