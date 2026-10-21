# Instamart ingestion spike

Instamart (Swiggy) is where most of the household's orders are placed, so the
Blinkit-only history was partial. This spike finds where Instamart exposes order
history and pulls all of it into the same lean shape as `spike/blinkit/`, ready
to merge. Findings are recorded in `docs/product/design.md` Appendix C.

Nothing here is production code — it is the proving ground for
`worker/adapters/instamart`.

## Why the browser is launched the way it is

A Playwright-**launched** Chrome is blocked at the first page load
("Your request looks automated"), before any login. So Playwright never launches
the browser here: `shared.ts` starts your installed Google Chrome as a plain
process with a debugging port and a dedicated profile (`.chromedata/`), and the
scripts only **attach** over CDP. All API calls are `fetch`es made inside the
logged-in instamart.in page.

Instamart has its own domain, **instamart.in**, separate from swiggy.com —
same app bundle, but the login does not carry across. Use instamart.in.

## Setup

```
cd spike/instamart
npm install
```

Uses `C:/Program Files/Google/Chrome/Application/chrome.exe`; override with
`CHROME_PATH=...`.

## 1. capture — log in and record

```
npm run capture
```

Chrome opens on instamart.in. Sign in (phone + OTP), open your orders, open a
couple of orders, close the window. Every JSON response from swiggy.com /
instamart.in is written to `net_log.jsonl` and a summary of endpoints prints.
The login persists in `.chromedata/` for the next step.

## 2. extract — pull the full history

```
npm run extract                  # everything
MAX_ORDERS=100 npm run extract   # stop once 100 orders are cached
```

Attaches to the spike Chrome (launching it if needed), then:

1. **Orders** — pages `GET /api/instamart/orders` (20 per page, cursor =
   oldest `created_at`) → `orders_raw.json`.
2. **Packs** — the order payload has no pack size, so each distinct SKU is
   looked up via catalog search at its own store; only an **exact skuId match**
   is accepted → `packs.json`. No match → pack `unknown` (never guessed).
3. Writes `orders.json` (lean, same shape as Blinkit's plus `sku`) and
   `distinct_products.json` (names only, for normalization).

Both stages cache, so a re-run after a 429, a crash, or a closed window resumes
where it stopped, and a later re-run only fetches new orders.

## Files — all gitignored, all real data

| File | Holds |
|---|---|
| `.chromedata/` | a logged-in Chrome profile (live session) |
| `net_log.jsonl` | recorded traffic incl. session headers + address |
| `orders_raw.json` | raw orders incl. delivery address + phone |
| `orders.json` | lean purchase history (address reduced to label · area) |
| `packs.json` | SKU → catalog pack label |
| `distinct_products.json` | product names + counts |

Treat them as secrets. Delete `.chromedata/` to log out.
