// Every tunable number and fixed name the server uses, in one place (CLAUDE.md
// "All constants in one file per module"). Environment-specific values —
// URLs, secrets, ports that differ per deploy — come from config.ts instead.

// ---- HTTP -----------------------------------------------------------------

// A person's display name (users.display_name): what the pages call them.
// Long enough for a first name and a nickname, short enough to sit in a row.
export const DISPLAY_NAME_MAX = 40;
// A canonical item name as the catalog gives it ("pet pads"), for routes keyed by item.
export const ITEM_KEY_MAX = 60;

export const DEFAULT_API_PORT = 8080;
// Largest request body the API will read, in bytes.
export const MAX_BODY_BYTES = 64 * 1024;

// ---- Households (design §10.1) ------------------------------------------------

export const HOUSEHOLD_NAME_MAX = 60; // matches the households.name check
// A member who leaves or is removed gets a fresh household of their own, named
// like the one the web app creates on first connect (src/lib/constants.ts).
export const DEFAULT_HOUSEHOLD_NAME = 'Home';

// ---- Household facts (design §9.12) ----------------------------------------------

export const FACT_KINDS = ['people', 'guests', 'pets', 'regular_use', 'away'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
// Sanity bounds on what a form or the AI may say about a household.
export const FACT_MAX_PEOPLE = 30;
export const FACT_MAX_PETS = 20;
// A regular-use amount a day, in canonical units (ml, g, pieces).
export const FACT_MAX_PER_DAY = 100_000;
export const FACT_ITEM_MAX = 60;
export const FACT_SAID_MAX = 1000;
// How far back or ahead a fact's dates may reach, in days.
export const FACT_MAX_DAYS_BACK = 3 * 365;
export const FACT_MAX_DAYS_AHEAD = 365;

// ---- Product preferences (design §19 Ordering, "which product") -------------------

// Products a household may rank (or rule out) for one item, and the longest
// product name kept.
export const PRODUCT_PREFS_MAX = 30;
export const PRODUCT_NAME_MAX = 200;

// ---- The AI layer (design §7.8, §19) ------------------------------------------------

// Guests with no end said: the page proposes this many days and asks.
export const AI_DEFAULT_STAY_DAYS = 7;
// The longest text one request may send.
export const AI_TEXT_MAX = 1000;
// The household's item names sent as context, at most.
export const AI_CONTEXT_ITEMS_MAX = 200;
// Free calls a month on our key, per household (design §19). Their own key
// has no limit here.
export const AI_FREE_CALLS_PER_MONTH = 50;
// Longest answer the model may write (a handful of facts as JSON, ~300
// tokens; the cap bounds the cost of a runaway answer).
export const AI_MAX_OUTPUT_TOKENS = 1_500;
// Model calls: time limit, and how often the worker sweeps for requests
// besides NOTIFY wake-ups.
export const AI_CALL_TIMEOUT_MS = 60_000;
export const AI_SWEEP_MS = 5_000;
export const AI_MAX_CONCURRENT = 2;
// Requests left running this long by a stopped worker are failed, not retried
// (the person is waiting on the page, and can simply send again).
export const AI_STALE_SECONDS = 2 * 60;
// Default models (small, cheap tiers; LLM model env vars override).
// OpenAI for users; Claude for our own testing (design §7.8).
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';
// Prices in USD per 1M tokens [input, output], for the settings page's
// estimate and real cost. Checked 2026-09-19 against
// developers.openai.com/api/docs/pricing and Anthropic's model table; they
// change — re-check when touching this.
export const AI_PRICES_USD_PER_MTOK: Record<string, [number, number]> = {
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-5-nano': [0.05, 0.4],
  'claude-opus-5': [5.0, 25.0],
  'claude-opus-4-8': [5.0, 25.0], // the Claude fallback, when opus-5 declines
  'claude-haiku-4-5': [1.0, 5.0],
};
// The estimate's basis (design §19): a busy household sends ~30 messages a
// month, each ~1,500 tokens in (the instructions and item names) and ~300 out.
export const AI_ESTIMATE_CALLS_PER_MONTH = 30;
export const AI_ESTIMATE_INPUT_TOKENS = 1_500;
export const AI_ESTIMATE_OUTPUT_TOKENS = 300;
// ---- AI guardrails (design §7.8 "Guardrails") ---------------------------------------

// Rate limits, on every key (a household's own key too: they protect its
// bill from a stuck page or a stolen session). One note in flight per
// household; per person an hour; per household a day.
export const AI_NOTES_PER_USER_HOUR = 20;
export const AI_NOTES_PER_HOUSEHOLD_DAY = 60;
// Key saves a day per household (each one is a check call: not a way to test
// stolen keys against us).
export const AI_KEY_CHECKS_PER_DAY = 5;
// Our key's budget across the whole site, a month: every household's free
// allowance together can't pass it (≈ ₹50 on gpt-4.1-mini at the estimate).
export const AI_SITE_FREE_CALLS_PER_MONTH = 500;
// What the model's answer may carry back to the page.
export const AI_QUESTIONS_MAX = 3;
export const AI_QUESTION_MAX_CHARS = 200;
// A household's words are kept only as long as they are needed: the note is
// cleared once read; the proposals (which quote it) after this many days.
export const AI_RESULT_KEEP_DAYS = 40;

// Rupees per US dollar, for showing costs in ₹ (about 96 on 2026-09-18,
// tradingeconomics.com; it moves, and the page says "about").
export const INR_PER_USD = 96;

// ---- Household members and invites (design §19) --------------------------------

// People in one household, counting pending invites.
export const HOUSEHOLD_MAX_MEMBERS = 6;
// An invite nobody answers lapses after this many days.
export const INVITE_TTL_DAYS = 14;
// What an invite may be addressed to. Loose on purpose: the real check is that
// the invitee later signs in with this verified Google email.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Connecting grocery apps (design §7.10) ------------------------------------

// Vendors with a working connect adapter. Others are refused until built.
export const CONNECTABLE_VENDORS = ['instamart', 'blinkit', 'zepto'] as const;
export type ConnectableVendor = (typeof CONNECTABLE_VENDORS)[number];
// Vendors whose cart we can also fill (design §19 stage 1). Narrower than
// CONNECTABLE_VENDORS on purpose: reading a vendor's history needs only its
// import adapter, while filling its cart needs a cart adapter driving the
// vendor's own buttons. A vendor we can read but not fill is connected and
// synced, and its carts are refused rather than queued for a worker that has
// no adapter for them.
// Blinkit's cart and the road to an order (Appendix A, recorded 2026-09-22).
// `/v5/carts` REPLACES the cart on every post: there is no read-only look.
export const BLINKIT_SEARCH_PATH = '/v1/layout/search';
export const BLINKIT_CARTS_PATH = '/v5/carts';
export const BLINKIT_CREATE_ORDER_PATH = '/createOrder';

// Paying for that cart (design §19 stages 2-3, Appendix A). Only the first of
// these is a Blinkit endpoint: the cards, and the payment itself, belong to
// Zomato's zpaykit, and the gateway after that is Razorpay's. None is
// guessable - they were recorded from a real checkout on 2026-09-22, because
// `/config/main` does not name them and the page html yields only the host.
//
// `zomato_payment_hash` is the one that matters most: it mints a real order
// id and settles the price before any money moves.
export const BLINKIT_PAYMENT_HASH_PATH = '/zomato_payment_hash';
export const ZPAYKIT_ORIGIN = 'https://www.zomato.com';
export const ZPAYKIT_DEFAULT_PAYMENT_PATH = '/zpaykit/userDefaultPayment';
export const ZPAYKIT_METHODS_PATH = '/zpaykit/getPaymentMethods';
export const ZPAYKIT_MAKE_PAYMENT_PATH = '/zpaykit/makePayment';
// Who zpaykit is asked on behalf of: India, and Blinkit rather than Zomato or
// District, which share the same payment stack.
export const ZPAYKIT_COUNTRY_ID = 1;
export const ZPAYKIT_SERVICE_TYPE = 'BLINKIT';

// Blinkit joined on 2026-09-23, and it is not the same kind of member.
//
// Instamart's cart is the household's own: they open the app and see what we
// put there. A Blinkit cart belongs to a `device_id`, not to an account, so
// the one we fill is the worker's and the household can never open it
// (Appendix A, confirmed from their own two devices). It is here only because
// we pay for it in the same job, and because the ORDER that results does show
// up in their own order list afterwards.
//
// So a Blinkit cart that is filled and not paid for helps nobody, and the UI
// must never offer one as "we put it in your app for you".
export const CART_VENDORS = ['instamart', 'blinkit'] as const;
export type CartVendor = (typeof CART_VENDORS)[number];
// Vendors whose checkout offers Pay on Delivery. Blinkit's does not, on this
// account: offering it would create an order nobody can pay for. Checked at
// the api so the household hears it as a sentence, not as a worker crash.
export const ON_DELIVERY_VENDORS: readonly CartVendor[] = ['instamart'];
// Vendors an order may be started on. Blinkit's cart fills and its checkout
// is mapped end to end, but its card wants a CVV that no call in its payment
// chain has ever carried (design Appendix A), so a payment there cannot go
// through yet. Refused at the api with a sentence, rather than queued for a
// worker that will mint an order id and then stop.
export const PAY_VENDORS: readonly CartVendor[] = ['instamart', 'blinkit'];
// A connect attempt (phone → OTP → session) must finish within this long;
// the vendors' OTPs expire within minutes anyway.
export const CONNECT_REQUEST_TTL_SECONDS = 10 * 60;
// Indian mobile numbers: 10 digits starting 6–9 (after dropping +91 / 0).
export const PHONE_PATTERN = /^[6-9]\d{9}$/;
export const OTP_PATTERN = /^\d{4,6}$/;
// A card's security code: 3 digits, 4 on an American Express. Checked only
// so a typo is caught before a payment screen is driven - it is never stored
// and never logged (design §19 stage 3).
export const CVV_PATTERN = /^\d{3,4}$/;
// Wrong codes allowed before an attempt fails.
export const CONNECT_MAX_OTP_ATTEMPTS = 3;
// Statuses the user may cancel from. Not `verifying`: the typed code is
// already with the vendor and the result is seconds away — cancelling then
// would race a connection being saved.
export const CONNECT_CANCELLABLE_STATUSES = ['requested', 'sending_otp', 'otp_sent'] as const;
// An attempt still running (matches the connect_requests_one_in_flight index).
export const CONNECT_IN_FLIGHT_STATUSES = ['requested', 'sending_otp', 'otp_sent', 'verifying'] as const;
// How often the worker checks for a typed code, and sweeps for new attempts
// (LISTEN/NOTIFY wakes it sooner; the sweep catches anything missed).
export const CONNECT_POLL_MS = 1_000;
export const CONNECT_SWEEP_MS = 5_000;
// The grocery-apps page lists this many recent syncs per app.
export const CONNECTION_SYNCS_SHOWN = 5;

// ---- Importing order history (design §7.10) ------------------------------------

// Promotional add-ons that are not purchases ("Sample - Nivea Soft Sachet",
// "Flyer - Sid's Farm", free gifts) — dropped at parse time.
export const PROMO_ITEM_PATTERN = /^\s*(sample|flyer)\b|\b(trial|free gift|freebie)\b/i;
// Hex characters of the one-way address reference kept per order (design §7.9):
// enough to group orders by delivery address, reveals nothing about it.
export const ADDRESS_REF_CHARS = 16;
// Blinkit line items carry no product id (Appendix A), so the sku is a hash of
// the product name. Same name, same sku, every household — which is what makes
// a pack size learned once useful to everyone (design §8).
export const BLINKIT_SKU_CHARS = 16;
// ETA (design §7.10). One pack lookup (the call itself, without the
// IMPORT_CALL_DELAY_MS pause after it) before any import on this server has
// timed one: the mean of the two real imports (0.78 s and 1.73 s, 2026-09-19).
export const IMPORT_DEFAULT_LOOKUP_MS = 1_250;
// The ETA averages this many most recent step durations.
export const IMPORT_ETA_WINDOW = 20;
// "Ready to use": this many most-bought SKUs resolved — they drive most
// predictions, and take ~10 minutes (design §7.10).
export const IMPORT_READY_SKUS = 100;
// A job in progress with no update for this long was left by a worker that
// stopped; it is claimed again (re-running is idempotent).
export const IMPORT_STALE_SECONDS = 10 * 60;
// Pause between vendor calls during an import — the spike hit Blinkit's rate
// limit after ~40 rapid calls; ~1.2 s kept Instamart quiet (design §7.10).
export const IMPORT_CALL_DELAY_MS = 1_200;
// Whether a vendor's pack lookup is a call to that vendor, and so needs the
// pause above. Instamart's is a catalog search; Blinkit's pack is written on
// the order line and learned while listing, so its lookups touch nothing.
// Pausing between them cost about 20 minutes of pure waiting on a first
// import (1,005 skus, measured 2026-09-20) for calls that never happen.
// Zepto's pack is in each order's detail (Appendix D), learned the same way.
export const VENDOR_PACK_LOOKUP_CALLS: Record<string, boolean> = { instamart: true, blinkit: false, zepto: false };
// How far back each vendor serves order history, in days; null = all of it.
// Instamart serves a rolling 12 months (design Appendix C); before that the
// household's history has a gap the engine must know about (design §9.10).
export const MS_PER_DAY = 86_400_000;
// Zepto served all 91 of one account's orders back to 2023 (Appendix D).
export const VENDOR_HISTORY_DAYS: Record<string, number | null> = { instamart: 365, blinkit: null, zepto: null };
// Only these orders count as purchases (not FAILED / CANCELLED).
export const DELIVERED_STATUS = 'DELIVERED';
// Orders that never arrived: never shown. Anything else not yet DELIVERED is
// on its way (Instamart: ACTIVE) and shows in the history as such.
export const DEAD_ORDER_STATUSES = ['FAILED', 'CANCELLED'];
// Syncs that run by themselves: every connected app this often, and more
// often while one of its orders is on its way (so it counts once delivered).
export const IMPORT_AUTO_SYNC_HOURS = 6;
export const IMPORT_ON_THE_WAY_SYNC_MINUTES = 30;
// Instamart caps its order list at 20 per page (Appendix C).
export const INSTAMART_ORDERS_PAGE_SIZE = 20;
// Back-off before retrying a transient vendor failure (bot challenge, 5xx,
// rate limit) — the spike's schedule. After the last, the job fails and is
// resumed later; a logout is never retried.
export const IMPORT_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000] as const;
// A hard stop on how many pages of history one listing run will read. An
// ordinary sync stops at the first page with nothing new, and a first import
// stops when the vendor offers no next page - but a relist has neither brake,
// so a vendor that always answers with another cursor would page forever,
// making real calls the whole time. The spike carried the same guard.
export const IMPORT_MAX_PAGES = 500;
// Imports run one at a time (each holds a browser for minutes); the loop
// sweeps for queued or abandoned jobs this often besides NOTIFY wake-ups.
export const IMPORT_MAX_CONCURRENT = 1;
export const IMPORT_SWEEP_MS = 10_000;

// ---- Database (design §14.2) ---------------------------------------------------

// Arbitrary but fixed: identifies "the migration lock" to pg_advisory_lock.
export const MIGRATION_LOCK_ID = 7_310_001;

// ---- Sign-in (design §14.3) -------------------------------------------------

// Carries state, nonce and the PKCE verifier across the provider redirect.
// `__Host-` needs Secure, so the insecure local variant drops the prefix.
export const FLOW_COOKIE_SECURE = '__Host-dm_flow';
export const FLOW_COOKIE_INSECURE = 'dm_flow';
// A sign-in must complete within this long of starting.
export const FLOW_TTL_SECONDS = 10 * 60;

export const SESSION_COOKIE_SECURE = '__Host-dm_session';
export const SESSION_COOKIE_INSECURE = 'dm_session';
// Absolute session lifetime — never extended on use, so a stolen cookie ages out.
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Session tokens are 256 random bits; anything longer than this is not ours
// and is refused before it is hashed.
export const SESSION_TOKEN_MAX_LENGTH = 512;
export const RANDOM_TOKEN_BYTES = 32;

// OIDC provider calls. Generous: on a home connection a cold call to Cognito
// measured up to 10.7 s (slow DNS and connect), and a 10 s limit failed a real
// sign-in. The token call is never retried instead: the code is single-use,
// and a slow first attempt may already have redeemed it.
export const JWKS_TIMEOUT_MS = 30_000;
export const TOKEN_TIMEOUT_MS = 30_000;
// Chrome on Android was seen requesting /auth/callback twice with the same
// code, under a second apart. The code is single-use, so the second request
// failed and the browser showed that failure over the first's success. A
// repeat of the same callback (same flow cookie, same code) within this window
// gets the first request's result instead of a second redemption.
export const CALLBACK_REPEAT_WINDOW_MS = 60_000;
// An unknown `kid` refetches the JWKS at most this often, so forged tokens
// can't turn sign-in into a request amplifier aimed at the provider.
export const JWKS_MIN_REFETCH_MS = 60_000;
// Clock drift tolerated between this host and the provider.
export const CLOCK_SKEW_SECONDS = 60;
// Only these scopes are requested: identity and a verified email, nothing else.
export const OIDC_SCOPES = 'openid email';
// Added when AUTH_PROFILE_PICTURE is on, for the Google profile photo.
export const OIDC_PROFILE_SCOPE = 'profile';

// Profile pictures are fetched server-side and served from our own origin
// (the browser never gets the provider URL). Only this host may be fetched —
// a stored URL can never point the server at an arbitrary address (SSRF).
export const PICTURE_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//;
export const PICTURE_MAX_BYTES = 512 * 1024;
export const PICTURE_TIMEOUT_MS = 5_000;
// How long the browser may cache the relayed picture.
export const PICTURE_CACHE_SECONDS = 60 * 60;

// ---- Vault (design §14.3) -----------------------------------------------------

export const VAULT_FORMAT = 'v1';
// Domain separation for the HKDF step — changes only with the format.
export const VAULT_HKDF_INFO = 'dhaniya-mirchi vault v1';
export const VAULT_NONCE_BYTES = 12; // AES-GCM standard nonce
// Hex characters of sha256(public key) used as the key id in sealed values.
export const VAULT_KEY_ID_CHARS = 12;

// ---- Notifications (design §13) --------------------------------------------------

// VAPID keys: an uncompressed P-256 public point and a P-256 private scalar.
export const VAPID_PUBLIC_KEY_BYTES = 65;
export const VAPID_PRIVATE_KEY_BYTES = 32;
// A browser push subscription: an https endpoint (capped — real ones are a
// few hundred characters) and its keys: an uncompressed P-256 point and a
// 16-byte auth secret (RFC 8291).
export const PUSH_ENDPOINT_MAX = 2048;
export const PUSH_P256DH_BYTES = 65;
export const PUSH_AUTH_BYTES = 16;
// Nothing fires from 22:00 to 08:00 household-local time (design §13.2); a
// notice due then goes out on the first sweep after.
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 8;
// How long a push service keeps an undelivered notice (the phone is off).
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

// ---- Announcements (design §13.3) --------------------------------------------------

// Match the announcements table's checks.
export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_BODY_MAX = 500;
// The bell lists this many of the newest.
export const ANNOUNCEMENTS_SHOWN = 20;
// Quiet hours for someone with no household yet (no timezone of their own).
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// ---- Feedback (design §12.8) ------------------------------------------------------

// Match the feedback table's checks.
export const FEEDBACK_MAX = 2000;
export const FEEDBACK_PAGE_MAX = 40;
// `worker feedback` prints this many days back by default.
export const FEEDBACK_DEFAULT_DAYS = 30;
// How a vendor is named in a notification.
export const VENDOR_NAMES: Record<string, string> = { instamart: 'Instamart', blinkit: 'Blinkit', zepto: 'Zepto' };

// ---- Logging --------------------------------------------------------------

// Field names that must never reach a log line (CLAUDE.md: tokens, OTPs and
// vendor sessions are never logged). Outside production, logging one throws,
// so the mistake surfaces in development instead of in a log store.
export const LOG_DENIED_FIELDS = [
  'token',
  'id_token',
  'access_token',
  'refresh_token',
  'code',
  'code_verifier',
  'secret',
  'client_secret',
  'password',
  'otp',
  'cookie',
  'authorization',
  'session',
  'phone',
  'endpoint', // a push subscription is a capability URL
  'p256dh',
];

// ---- Worker (design §7.10) --------------------------------------------------

// Each browser's DevTools port is chosen by Chrome (port 0) and bound to
// loopback, so concurrent browsers never collide.
export const CHROME_ATTACH_ATTEMPTS = 40;
export const CHROME_ATTACH_INTERVAL_MS = 500;
// After SIGKILL, wait up to this long for the browser to exit before its
// profile directory is deleted, then retry the delete a few times.
export const CHROME_EXIT_TIMEOUT_MS = 5_000;
export const PROFILE_RM_RETRIES = 5;
export const PROFILE_RM_RETRY_DELAY_MS = 200;
// ---- Add to cart (design §19 Ordering stage 1, Appendix C) --------------------------

// Each tap in the cart is answered by the app's own cart call, so the worker
// waits for that answer rather than for a fixed time; these are only the
// limits. CART_STEP_SETTLE_MS is what it waits when a tap changes nothing on
// the server (opening the pack picker).
export const CART_STEP_SETTLE_MS = 700;
// Between taps that are not waited for (stepping a count up): just long
// enough for the page to register each one.
export const CART_TAP_MS = 250;
export const CART_STEP_TIMEOUT_MS = 20_000;
export const CART_ADDRESS_WAIT_MS = 10_000;
// A cart job left running this long by a stopped worker is failed, not
// retried: the person is watching the page and can send it again.
export const CART_STALE_SECONDS = 5 * 60;
export const CART_SWEEP_MS = 5_000;
// How long the shared browser is kept warm after the last job gives it back
// (starting one costs about nine seconds).
export const CHROME_WARM_IDLE_MS = 3 * 60_000;
export const CART_MAX_CONCURRENT = 1;
// Most items one job may carry, and how many carts a household may have
// waiting. Filling one takes a few seconds an item, so people add more while
// one runs: those queue, and the worker takes a household's carts in turn.
export const CART_MAX_ITEMS = 30;
export const CART_QUEUE_MAX = 5;
// Recent carts the page may list, so it can pick up what it was waiting for
// after a reload.
export const CART_RECENT_JOBS = 10;
// How far back the pages read what the app put in carts. A purchase the app
// prompted is kept out of the rate (design §9.2), so this must cover the time
// between a suggestion and the order that follows it, with room to spare.
export const PROMPTED_KEEP_DAYS = 120;

export const PAGE_LOAD_TIMEOUT_MS = 45_000;
// Let a vendor's bot challenge and app bootstrap settle after page load.
export const PAGE_SETTLE_MS = 3_000;
export const INSTAMART_ORIGIN = 'https://instamart.in';

// ---- Zepto (design Appendix D, recorded 2026-09-24) ------------------------------

// The site (zeptonow.com redirects here) and its api, which is cross-origin
// from the page: calls from our in-page fetch go to the api's own host.
export const ZEPTO_ORIGIN = 'https://www.zepto.com';
export const ZEPTO_API_ORIGIN = 'https://bff-gateway.zepto.com';
// Order history. The list is 8 a page, newest first, `endOfList` on the last;
// the detail is a widget page of its own, paged by `nextPageParams` until
// `endOfPage`. Both answer our own fetch without the site's per-call
// signature, given the three headers below (probed 2026-09-24).
export const ZEPTO_ORDERS_PATH = '/api/v2/order/';
export const ZEPTO_ORDER_DETAIL_PATH = '/pfs-postorder/api/v1/get-page/ORDER_DETAILS';
export const ZEPTO_DETAIL_PAGE_SIZE = 8;
// An order's detail has had two pages (items, then the bill). A guard, not a
// size: a detail that keeps offering another page is read no further.
export const ZEPTO_DETAIL_MAX_PAGES = 6;
// Without an app version the api fails the call at CORS; without
// auth_from_cookie it answers 401. The version is the site's own build,
// read off a request the page makes, never pinned here.
export const ZEPTO_APP_VERSION_HEADERS = ['app_version', 'appversion'] as const;
export const ZEPTO_AUTH_FROM_COOKIE_HEADER = 'auth_from_cookie';
// The cookies a restored session keeps. accessToken and refreshToken alone
// read orders in a fresh browser (tested 2026-09-24); the rest are the
// account's and the browser's own ids, kept so the restored browser is the
// same one each time. Not kept: latitude, longitude, user_position,
// serviceability - the household's location, which no import needs.
export const ZEPTO_SESSION_COOKIES = ['accessToken', 'refreshToken', 'isAuth', 'user_id', 'device_id'];
// Zepto's words for an order that reached the household. ARRIVED is one:
// seen on a five-month-old order with an arrival time, never moved on.
export const ZEPTO_DELIVERED_STATUSES = ['DELIVERED', 'ARRIVED'];
// Zepto's own kitchen. Its puffs, samosas and chai sit in the same orders as
// the groceries, and "Chicken Puff" read by name is chicken (30 buys on one
// account). The detail names the brand, and bills a restaurant charge on
// every such line; either marks the line as food made to eat now.
export const ZEPTO_PREPARED_BRANDS = ['Zepto Cafe'];
// The login form (recorded 2026-09-24). Driven through the page, because the
// site signs its own calls and a login is not a read.
export const ZEPTO_LOGIN_BUTTON = 'button[aria-label="login"]';
export const ZEPTO_PHONE_INPUT = 'input[placeholder="Enter Phone Number"]';
export const ZEPTO_OTP_INPUT = 'input[aria-label="OTP"]';
export const ZEPTO_SEND_OTP_PATH = '/api/v1/user/customer/send-otp-sms/';
export const ZEPTO_VERIFY_OTP_PATH = '/api/auth/verify-otp';
// How long to wait for the site to answer a login step.
export const ZEPTO_LOGIN_STEP_TIMEOUT_MS = 20_000;
// The cart page. Its own scripts ask what the account can pay with, and that
// call is signed, so it can only be read by watching the page be answered
// (probed 2026-09-21: our own fetch of the same path is told "Session
// expired", exactly as an add to cart is refused - design Appendix C).
export const INSTAMART_CART_PAGE = '/cart';
export const INSTAMART_PAYMENT_OPTIONS_PATH = '/api/v3/payment/get-payment-options';
// How long to wait for the cart page to ask that question after it loads.
export const INSTAMART_PAYMENT_WAIT_MS = 12_000;

// The payment screen's own controls (design §19 stages 2-3), read off the
// real screen on 2026-09-21 (spike/instamart/checkout-ui.ts). The vendor
// gives every one of them a data-testid, which is steadier than its text:
// the text is localised and the amounts change.
export const INSTAMART_CHECKOUT = {
  proceed: /proceed to pay/i, // on the cart page; opens the payment screen
  screenTitle: '[data-testid="header_title"]', // "Payment Options"
  total: '[data-testid="header_subtitle"]', // "1 item. Total: ₹94"
  addressTag: '[data-testid="dav_addr_tag"]', // "Maple Residency"
  cardRow: '[data-testid="pm_card_container"]',
  cardName: '[data-testid="pm_card_name"]',
  cardTick: '[data-testid="pm_card_tick"]',
  cardCvv: '[data-testid="pm_card_cvv"]',
  // The ONLY control in this file that spends money.
  cardPay: '[data-testid="pm_card_pay_btn"]',
  onDelivery: '[data-testid="pg_mo_cod"]',
} as const;
// "1 item. Total: ₹94" → 94. A total that cannot be read stops the order: it
// is the number checked against what the household agreed to.
export const INSTAMART_TOTAL_PATTERN = /(?:₹|rs\.?\s*)\s*([\d,]+(?:\.\d+)?)/i;
// How long the payment screen has to appear after "Proceed to Pay".
export const CHECKOUT_SCREEN_TIMEOUT_MS = 30_000;
// How long the household has to type a CVV or an OTP before the job gives up.
// Before Pay this is free: nothing has been ordered. After Pay it is not, so
// the job says an order was left unpaid rather than pretending nothing
// happened.
export const CHECKOUT_SECRET_WAIT_MS = 4 * 60_000;
// How often the worker looks to see whether it has arrived. Small, because
// the household is sitting there waiting: this is the delay between them
// tapping Send and the payment screen moving.
export const CHECKOUT_SECRET_POLL_MS = 400;
// A secret the household sent more than this long ago is refused rather than
// typed: they have moved on, and an OTP that old has expired anyway.
export const CHECKOUT_SECRET_MAX_AGE_MS = 5 * 60_000;
// How long to wait for the bank's own page after Pay, and for its verdict
// after the OTP is typed.
export const CHECKOUT_BANK_WAIT_MS = 60_000;
// The hosts a 3-D Secure challenge is served from. Not ours and not the
// vendor's: the household's own bank, through the gateway's ACS.
// The bank's own 3-D Secure page, recognised by its HOST and nothing else.
//
// These words are matched against the hostname alone. Tested against a whole
// URL they match half the internet: an ad pixel carries "conversion",
// "secure" and "authenticate" in its query string, and Google's own ad host
// is literally `securepubads.g.doubleclick.net`. A checkout page carries
// several of those frames, so a whole-URL test reports the bank before the
// bank has said anything - and a payment that waits for an OTP nobody sent
// is a payment reported wrongly.
// How long the cart page gets to draw the control that opens the checkout.
// Both vendors draw it late, after their own serviceability check, and a
// glance right after the page load finds nothing on a cart that is perfectly
// full (seen on both, 2026-09-23).
export const PROCEED_WAIT_MS = 30_000;

// How many of a household's other products for an item the worker will try
// when the store has not got the first. Each is a page it may have to open,
// and past the first few the ranking is things bought once, long ago.
export const CART_MAX_ALTERNATIVES = 4;

// How long the browser that filled a cart stays open waiting to be paid in
// (design §19 stages 1-2). Long enough for a household to read the cart and
// decide, short enough that a signed-in browser is never sitting there
// forgotten. Past it, paying rebuilds the cart as it always did.
export const LIVE_CART_TTL_MS = 10 * 60_000;
// How many of those may be open at once. Each is a headless Chrome.
export const LIVE_CART_MAX = 3;

export const CHECKOUT_BANK_HOSTS =/wibmo|acs|3ds|threeds|secure|paytm|juspay|razorpay|payu|billdesk|cashfree/i;
// Hosts that are never the bank, however much they look like it. Ads and
// analytics sit on every checkout page and several carry the words above.
export const CHECKOUT_NOT_BANK_HOSTS = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'googletagmanager.com',
  'google-analytics.com',
  'googleapis.com',
  'gstatic.com',
  'google.com',
  'facebook.com',
  'facebook.net',
  'clarity.ms',
  'hotjar.com',
  'segment.io',
  'segment.com',
  'branch.io',
  'appsflyer.com',
  'moengage.com',
  'clevertap.com',
  'amplitude.com',
  'sentry.io',
  'newrelic.com',
  'cloudflareinsights.com',
];
// The call that creates the order. Watched, never called by us directly: the
// moment it is answered an order exists whether or not the money moved.
export const INSTAMART_ORDER_PATH = '/api/v3/instamart/checkout/order';
// The household's own recent orders, as the import reads them. After paying,
// this is what says whether the order the worker placed is alive or dead: the
// order call itself cannot, because it answers before the money moves.
export const INSTAMART_RECENT_ORDERS_PATH = '/api/instamart/orders?order_type=DASH&count=5';
// The vendor's words for an order that did not survive. Anything else that
// the vendor is still showing is an order that is going ahead.
export const ORDER_DEAD_STATUSES = /^(FAILED|CANCELLED|CANCELED|EXPIRED|PAYMENT_FAILED)$/i;
// How long to keep asking the vendor what became of the order. A payment that
// has just been authorised takes a few seconds to show.
export const ORDER_CONFIRM_WAIT_MS = 45_000;
export const ORDER_CONFIRM_POLL_MS = 3_000;
// "1 item. Total: 94" -> 1. How many things the payment screen is about to
// charge for, which has to match the cart the household looked at.
export const INSTAMART_ITEM_COUNT_PATTERN = /(\d+)\s*items?/i;
// The bank's own 3-D Secure page is nobody's to control, so its box is found
// by shape rather than by name. These are the words banks put on it when they
// name it at all; a box named none of them is still usable, just less certain.
export const OTP_BOX_WORDS = /otp|passcode|password|pin|code|token/i;
// How long to wait for that page to put a box on screen after the bank has
// been reached.
export const OTP_BOX_WAIT_MS = 30_000;
// The most any single order may come to, whatever the household typed. A
// runaway list, a wrong cart or a mis-read total stops here.
//
// Held low while paying from the app is being tested: every live run is a
// real order with real money. Raised from 200 to 2,000 on 2026-09-22, at the
// household's word, so a real shop can go through rather than a carton of
// milk. Still a ceiling: nothing this app does can spend more than this in
// one order, whatever a page asks for (design §19 stages 2-3).
export const ORDER_HARD_CAP_RUPEES = 2_000;
export const ORDER_STALE_SECONDS = 10 * 60;
export const ORDER_SWEEP_MS = 5_000;
export const ORDER_MAX_CONCURRENT = 1;
export const BLINKIT_ORIGIN = 'https://blinkit.com';
// The localStorage keys a restored Blinkit session actually needs. Blinkit
// keeps 22 keys, and capturing all of them sealed 201 KB per connection -
// including `searchHistory`, `recommendations`, `cart` and `checkout`, which
// are the household's own business and no use to us (design §7.6: we keep
// what the job needs, not what the page happens to hold). Keeping only these
// eight seals 3 KB and reads orders identically, checked against the live
// account on 2026-09-20 by restoring both and listing a page from each.
export const BLINKIT_SESSION_KEYS = ['auth', 'authKey', 'authKeyITS', 'deviceId', 'user', 'merchant', 'location', 'addressesV2'];
// Most connect attempts run at once — each holds a headless browser
// (~200–400 MB) inside the worker's memory cap.
export const CONNECT_MAX_CONCURRENT = 2;

// What `worker probe` loads: a vendor that blocks this browser/IP answers the
// page load itself with 403 (design §7.10).
export const PROBE_TARGETS = [
  { vendor: 'blinkit', url: 'https://blinkit.com/' },
  { vendor: 'instamart', url: 'https://instamart.in/' },
  { vendor: 'zepto', url: 'https://www.zepto.com/' },
] as const;

// How often the worker records that it is alive.
export const WORKER_HEARTBEAT_MS = 30_000;
// The api reports the worker dead after this long without a heartbeat —
// three missed beats, so one slow beat is not an alarm.
export const WORKER_STALE_AFTER_MS = 3 * WORKER_HEARTBEAT_MS;
