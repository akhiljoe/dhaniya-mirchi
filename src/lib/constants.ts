// Every tunable number and fixed name the web app's client code uses
// (CLAUDE.md "All constants in one file per module").

import type { SourceId } from '../types';

// Grocery apps with a working connect adapter on the server (design §7.10).
// Keep in step with CONNECTABLE_VENDORS in server/src/constants.ts.
export const CONNECTABLE_SOURCES: SourceId[] = ['instamart', 'blinkit', 'zepto'];

// The household created automatically on the first connect (renamable later).
export const DEFAULT_HOUSEHOLD_NAME = 'Home';

// Home's "Likely running low": how many items show before "Show N more".
export const HOME_LOW_ITEMS_VISIBLE = 3;

// How often the connect screen asks the api how an attempt is going.
export const CONNECT_POLL_MS = 1_000;

// Plain sentences for the codes a connect attempt can end with.
export const CONNECT_ERROR_TEXT: Record<string, string> = {
  otp_invalid: "That code didn't work. Check the SMS and try again.",
  vendor_rejected: "The app didn't accept that number. Check it's the one you use to order, and try again.",
  vendor_unreachable: "We couldn't reach the app just now. Please try again in a few minutes.",
  expired: 'That took too long and the code expired. Please start again.',
  interrupted: 'Our server restarted while connecting. Please start again.',
  internal: 'Something went wrong on our side. Please try again.',
};
export const CONNECT_ERROR_FALLBACK = 'Something went wrong. Please try again.';

// Import progress (design §7.10): how often the page asks while an import
// runs, and — once nothing runs — how often it checks for a new one (a sync,
// or a retry started in another tab).
export const IMPORT_POLL_MS = 5_000;
export const IMPORT_IDLE_POLL_MS = 60_000;

// ---- The household from real orders (src/lib/household.ts) -----------------

// Which items the inventory lists: bought at least this many times, or at all
// within this many days. Older one-offs aren't household stock.
export const INVENTORY_MIN_PURCHASES = 2;
export const INVENTORY_RECENT_DAYS = 30;
// "You shop about N times a week": measured over at most this many weeks,
// and only with at least this many orders.
export const INSIGHT_WEEKS = 8;
export const INSIGHT_MIN_ORDERS = 3;
// A weekday is named only if at least this share of trips fall on it.
export const INSIGHT_DAY_SHARE = 0.3;
export const INSIGHT_TOP_ITEMS = 3;
// The history page's spend summary covers this many days.
export const HISTORY_SPEND_DAYS = 30;
// While an import runs, the pages rebuild from the orders after every this
// many newly learned pack sizes (and whenever the import's phase changes).
export const HOUSEHOLD_REFRESH_SKUS = 50;

// ---- The Insights page (src/lib/insights.ts) ------------------------------------

// Spend by month: this many calendar months, the current one included.
export const INSIGHTS_MONTHS = 12;
// "Spent ₹X in the last N days, up Y% on the N days before."
// A usual gap this short means the household buys it most days: milk at 1.1
// days, bread, curd. "Will you buy this within the next few days?" is always
// yes for those, so they sat at the top of the buy-now list every single day
// and said nothing - the morning after three packets of milk came in, it
// still read "buy milk". They are shown in their own group instead: nothing
// is hidden, no flag is suppressed (suppressing them was measured and lost a
// fifth of the recall - engine holdback.ts), and the alerts that do carry
// information are no longer buried under them.
export const EVERYDAY_GAP_DAYS = 1.5;

export const INSIGHTS_TREND_DAYS = 30;
// Orders needed before the page says anything about what the apps charge on
// top. Below this the figure is an anecdote, not a pattern.
export const INSIGHTS_FEES_MIN_ORDERS = 20;
// The month's spend, projected (insights.ts `forecastMonth`). It works the
// way a maps app does: what is spent so far is known, what is left is
// estimated from the household's own past, and the estimate narrows on its
// own as the month runs out.
//
// How much history before it will say anything at all. Below this there is
// no rhythm to read and it says nothing rather than guessing (§9.3).
export const FORECAST_MIN_HISTORY_DAYS = 75;
// How many past windows of the same length it wants before it will quote a
// range. Fewer than this and the spread is noise.
export const FORECAST_MIN_WINDOWS = 30;
// The spread quoted, as quantiles of those past windows: the middle is the
// figure shown, the outer two are the range.
export const FORECAST_LOW_QUANTILE = 0.25;
export const FORECAST_MID_QUANTILE = 0.5;
export const FORECAST_HIGH_QUANTILE = 0.75;
// Recent months count for more than old ones: a household's spending drifts.
// Halving every this many days.
export const FORECAST_HALF_LIFE_DAYS = 120;
// The day a household's spending month starts. 1 is the calendar month; a
// credit card billed on the 16th makes it 16, and the forecast then answers
// about the 16th to the 15th instead.
export const BILLING_DAY_DEFAULT = 1;
// Where the browser remembers the cart whose "ready" line has been pushed
// away. Per browser and per person, never anything the app needs back.
export const SEEN_CART_KEY = 'dm.seenCart';
// The list whose line at the bottom was pushed away, by its items. A changed
// list is a new line (lib/seen.ts).
export const SEEN_LIST_LINE_KEY = 'dm.seenListLine';
// How long a filled cart is still offered as ready to pay for. A grocery
// app's cart from yesterday is a cart the store has long since re-priced or
// emptied; one from this morning is still the household's. Six hours is
// well inside a shopping day and well outside "yesterday".
export const READY_CART_MAX_AGE_MS = 6 * 60 * 60_000;
// Home's ready-to-send basket. Items the app is this sure about are ticked
// for the household; anything less sure is listed unticked, so the app never
// puts something in a cart it is only guessing about.
export const HOME_PREFILL_CONFIDENCE: ReadonlyArray<'high' | 'medium' | 'low'> = ['high', 'medium'];
// Below this many priced purchases behind an estimate, the total is shown as
// "about" with a note rather than as a figure to trust.
export const HOME_ESTIMATE_MIN_PRICED = 0.6;
// How many things Home names before it says "and 3 more". A summary that
// lists everything is the list it was meant to replace.
export const HOME_BASKET_NAMES_SHOWN = 4;
// How many of a filled cart's items are named before "and 3 more".
export const CART_NAMES_SHOWN = 5;
// How many rows Supplies shows of each group before "Show all". The page is a
// glance at what to buy, not a walk through 235 things; the search and the
// button are there for the rest (2026-09-23).
export const SUPPLIES_ROWS_SHOWN = 4;
// The most of one thing that can be put on the list from a card.
export const BASKET_MAX_QTY = 20;
// Searching, on any page that offers it. Below this many characters it
// matches nearly everything, which is worse than matching nothing.
export const SEARCH_MIN_CHARS = 2;
// What the household last said no to. Home fills the basket for them, so
// emptying it has to mean something: without this, a reload filled it again
// and the bar came back every single time.
export const BASKET_DECLINED_KEY = 'dm.basketDeclined';
// The list Home last offered. Kept because the household turns the list down
// from the cart bar, which can only see what is still ticked in it - and
// what has to be remembered is the list that was OFFERED, or a list of 17
// is compared against the 6 that survived and never matches.
export const BASKET_OFFERED_KEY = 'dm.basketOffered';
// The list that was sent, so it is not offered back on the next load.
export const BASKET_SENT_KEY = 'dm.basketSent';
// The date ranges the Insights page can be read over (design §12.7). Before
// this, the page mixed windows without saying so - a 30-day spend stat above
// an all-time weekday chart - and a household with two apps could not tell a
// real difference from a difference in how much history each app keeps.
// 12 months is the default because Instamart serves only a rolling year
// (design Appendix C) while Blinkit has no cap: a longer window compares a
// full Blinkit history against a truncated Instamart one.
export const RANGE_OPTIONS: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '3 months' },
  { days: 365, label: '12 months' },
  { days: null, label: 'All time' },
];
export const INSIGHTS_DEFAULT_RANGE_DAYS: number | null = 365;
// Purchase history answers "when did I last buy this", so it opens on a window
// wide enough to hold a slow staple's rhythm: 30 days would hide a 5 kg bag of
// atta bought every six weeks, and three months covers about two cycles of
// most of them.
export const HISTORY_DEFAULT_RANGE_DAYS: number | null = 90;
// Where each page's remembered range is kept in this browser.
export const RANGE_STORAGE_KEYS = { insights: 'dm.range.insights', history: 'dm.range.history' };
// Times of day, in the household's timezone: [from, to) hours.
export const INSIGHTS_DAYPARTS = [
  { label: 'Morning', hours: '5 to 11 am', from: 5, to: 11 },
  { label: 'Midday', hours: '11 am to 2 pm', from: 11, to: 14 },
  { label: 'Afternoon', hours: '2 to 6 pm', from: 14, to: 18 },
  { label: 'Evening', hours: '6 to 10 pm', from: 18, to: 22 },
  { label: 'Night', hours: '10 pm to 5 am', from: 22, to: 5 },
];
// Categories listed by name; the rest are summed as "Everything else".
export const INSIGHTS_CATEGORIES_SHOWN = 8;
// Items named on "where the money goes". Eight covers the household's real
// spenders - paneer, chocolate, chicken, olive oil - without turning the
// section into a receipt.
export const INSIGHTS_ITEMS_SHOWN = 8;
// Inside one item, the products the money actually went on: "noodles" is not
// an answer when the question is which noodles.
export const INSIGHTS_PRODUCTS_PER_ITEM = 4;
// The same thing on both apps, compared. Each side needs this many purchases
// before a difference is worth calling a difference rather than a coincidence
// of what was on offer that week.
export const INSIGHTS_COMPARE_MIN_BUYS = 2;
// And the difference has to be at least this much of the cheaper price, or it
// is noise dressed up as a saving.
export const INSIGHTS_COMPARE_MIN_GAP = 0.08;
export const INSIGHTS_COMPARE_SHOWN = 6;

// ---- Your products for an item (design §19 Ordering, "which product") -------

// Products before the sheet offers a search. Below this the list fits on the
// screen and a search box is clutter; above it, a household with 30 kinds of
// chocolate cannot find the one it means.
export const PRODUCTS_SEARCH_FROM = 6;
// How many of an item's products the sheet shows before "All N products".
export const PRODUCTS_SHOWN = 3;
// "How often you buy it": this many items, the most bought first.
export const INSIGHTS_RHYTHM_SHOWN = 8;
// Bought together: at least this many orders with both, and at least this
// many times more often than chance (lift).
export const INSIGHTS_TOGETHER_MIN_TIMES = 5;
export const INSIGHTS_TOGETHER_MIN_LIFT = 2;
export const INSIGHTS_TOGETHER_SHOWN = 5;
// New habit: first bought within this many days, and bought on at least this
// many trips since.
export const INSIGHTS_NEW_HABIT_DAYS = 90;
export const INSIGHTS_NEW_HABIT_MIN_TRIPS = 4;
// Stopped buying: the engine says stopped (past every gap it has had, by
// half a usual gap), and it was bought on at least this many trips.
export const INSIGHTS_STOPPED_MIN_TRIPS = 5;
export const INSIGHTS_STOPPED_SHOWN = 5;

// The meal planner is still the prototype's mock (CLAUDE.md), and it fed the
// shopping list, which is gone: its page stays in the code, hidden from the
// navigation and Home until it is rebuilt around the cart.
export const SHOW_MEAL_PLAN = false;

// "Add to cart" on suggested items (design §19 Ordering, stage 1 "cart
// handoff"). Off until it has been tested end to end on a real account.
export const ADD_TO_CART_ENABLED = true;
// The apps a cart can be filled in, and how each one behaves afterwards.
//
// The two are not the same kind of thing, and the difference has to reach the
// screen. An Instamart cart is the household's own: they open the app and
// their items are there, so the app can hand off and say "open Instamart". A
// Blinkit cart belongs to a `device_id` rather than to an account, so the one
// we fill is the worker's and the household will never see it, whatever they
// open. Telling them to go and look would send them to an empty cart.
//
// So `theirsToOpen` decides the words. Where it is false the cart is only
// ever a thing we fill and pay for in one go, and there is nothing to hand
// off - which also means it must never be offered as "we put it in your app".
export interface CartVendorInfo {
  id: string;
  name: string;
  // Where the household opens the cart themselves, or null when there is no
  // such place.
  url: string | null;
  theirsToOpen: boolean;
  // Whether its checkout offers Pay on Delivery. Blinkit's does not on this
  // account, and offering it anyway made an order nobody could pay for.
  payOnDelivery: boolean;
  // Whether paying from here works on it at all. Mirrors PAY_VENDORS in
  // server/src/constants.ts, and is only so the page can say so before the
  // household taps rather than after; the api is what enforces it.
  canPay: boolean;
}

export const CART_VENDOR_INFO: Record<string, CartVendorInfo> = {
  instamart: { id: 'instamart', name: 'Instamart', url: 'https://instamart.in/', theirsToOpen: true, payOnDelivery: true, canPay: true },
  blinkit: { id: 'blinkit', name: 'Blinkit', url: null, theirsToOpen: false, payOnDelivery: false, canPay: true },
};

// Where a cart goes when the household has not said otherwise. Instamart,
// because that cart is one they can open.
export const CART_VENDOR = 'instamart';

export function cartVendorInfo(id: string | null | undefined): CartVendorInfo {
  return CART_VENDOR_INFO[id ?? ''] ?? CART_VENDOR_INFO[CART_VENDOR];
}
// Paying from the app (design §19 stages 2-3). How often the page asks how
// the order is going: small, because the household is watching it.
export const ORDER_POLL_MS = 1_000;
// Paying is off until it has been through a real order end to end. With it
// off, the cart still fills and the household pays in the app as before.
export const PAY_ENABLED = true;
// The most one order may come to. Keep in step with ORDER_HARD_CAP_RUPEES in
// server/src/constants.ts - the api refuses anything above it, and this is
// only so the page can say so before the household taps rather than after.
export const ORDER_MAX_RUPEES = 2_000;
// Following a cart job: every item is a real search and tap in the app, so a
// few items take about a minute.
export const CART_POLL_MS = 1_500;
export const CART_WAIT_MS = 5 * 60_000;
// What filling a cart takes, for the "about 20 seconds left" line: the
// browser is started once (less when it is still warm), then a few seconds an
// item. Measured on the household's own account, 2026-09-20.
// A notice that only reports what already happened goes by itself, or on a
// swipe right of this far.
// An app can hold dozens of saved addresses (a household had 65): the
// picker shows this many, with the rest behind a search.
// "What do you want to make?" (design §19 "AI mode"): a few to tap instead
// of typing.
export const COOK_EXAMPLES = ['Chicken biryani for 6', 'Pasta tonight', 'Something with paneer', 'Dosa for breakfast'];
export const ADDRESSES_SHOWN = 6;
// What a vendor calls the origin of a saved address (`address_meta.source` on
// Blinkit), and what the picker says about it. An address shared to the
// account from somebody else's is the one worth saying out loud: this
// household has two, both in a city they do not live in. The Zomato ones
// matter less but explain why a list of grocery addresses holds restaurants
// and hotels. A source we have not seen before is not shown at all, rather
// than shown raw.
export const ADDRESS_SOURCE_NOTES: Record<string, string> = {
  SHARED_ADDRESS: 'Shared from another account',
  ZOMATO_IMPORT: 'Saved from Zomato',
  ZOMATO: 'Saved from Zomato',
};
export const NOTICE_SHOWN_MS = 10_000;
export const NOTICE_SWIPE_PX = 60;
export const CART_START_SECONDS = 9;
export const CART_SECONDS_PER_ITEM = 5;
// Which product to add first (design §19 Ordering): with no saved order, the
// one bought most in this many days.
export const PRODUCT_RECENT_DAYS = 60;
// A purchase that follows one of our own cart adds within this many days is
// the purchase we prompted (design §9.2): it is kept out of the rate.
export const PROMPTED_MATCH_DAYS = 10;

// ---- Household facts (design §9.12) ------------------------------------------------

// "How many live here?" answered without a date holds for as long as we
// know: this many days back, the furthest the api accepts (server
// FACT_MAX_DAYS_BACK is 3 × 365; one day less, so today's date never trips it).
export const FACT_ALWAYS_DAYS_BACK = 3 * 365 - 1;

// ---- Header and footer (design §12.8) -------------------------------------------------

// Where the footer's "Buy me a coffee" goes (the same page as an earlier project's).
export const SUPPORT_URL = 'https://www.buymeacoffee.com/gandalfturing';
// Matches the api's FEEDBACK_MAX.
export const FEEDBACK_MAX = 2000;

// ---- The AI layer (design §7.8) ------------------------------------------------------

// How often the page asks whether a note has been read, and how long it waits.
export const AI_POLL_MS = 1_000;
export const AI_WAIT_MS = 90_000;
// Where "get a key" starts (design §19; re-check the click path when OpenAI
// changes its dashboard).
export const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

// ---- The app asks (src/lib/suggestions.ts, design §9.12 Phase 4, §9.11) ----------------

// Buying changed: weeks looked at, the most-bought items counted (as trips a
// week), and the least weeks before and after a change.
export const SUGGEST_CHANGE_WEEKS = 20;
export const SUGGEST_STAPLES = 10;
export const SUGGEST_CHANGE_BEFORE_WEEKS = 6;
export const SUGGEST_CHANGE_AFTER_WEEKS = 3;
// Only a change that started within this many weeks is asked about.
export const SUGGEST_CHANGE_RECENT_WEEKS = 8;
// A dismissed "buying changed" isn't asked again, in the same direction, for
// this many days (the week it points at shifts as weeks pass).
export const SUGGEST_DISMISS_DAYS = 60;
// Staples bought in a week before the change, on average at least (too few
// = noise).
export const SUGGEST_CHANGE_MIN_BEFORE = 3;
// Asked when buying since is at least this many times (or at most this
// fraction of) what it was.
export const SUGGEST_CHANGE_UP = 1.5;
export const SUGGEST_CHANGE_DOWN = 0.6;
// Not asked when who lives here was told within this many days of it, or
// when an account's orders started within this many days (a member joined).
export const SUGGEST_CHANGE_TOLD_DAYS = 21;
export const SUGGEST_CHANGE_NEW_SOURCE_DAYS = 21;
// Were you away: no order for longer than this share of the household's gaps
// between order days, and at least this many days; only with this many order
// days to judge from.
export const SUGGEST_AWAY_GAP_PERCENTILE = 0.95;
export const SUGGEST_AWAY_MIN_DAYS = 7;
export const SUGGEST_AWAY_MIN_ORDERS = 20;

// Topping a cart up to free delivery (lib/topup.ts).
// How many things to offer: enough to have a choice, few enough to read.
export const TOPUP_PICKS = 3;
// The most a suggestion may cost, as a share of the delivery fee it saves.
// At 1 it never suggests spending more than the fee, which is the point of
// suggesting anything at all.
export const TOPUP_SPEND_FRACTION = 1;
// How many one-tap suggestions the empty list offers before "See all".
export const EMPTY_LIST_PICKS = 4;
// Light, dark, or the phone's own setting (lib/theme.ts).
export const THEME_KEY = 'dm.theme';
// How many things a History row names before "and 4 more".
export const HISTORY_ROW_NAMES = 3;

// ---- What to do (lib/advice.ts) -----------------------------------------------
// Ahead of usual this cycle: an item is named when this cycle's spend so far
// is at least this many rupees AND this many times the usual by the same
// day, over at least this many earlier cycles.
export const ADVICE_AHEAD_MIN_RUPEES = 300;
export const ADVICE_AHEAD_MIN_RATIO = 1.4;
export const ADVICE_AHEAD_MIN_CYCLES = 3;
export const ADVICE_AHEAD_SHOWN = 3;
// The second order of the day: an extra order with at most this many items is
// a stray trip; a thing named when it was the stray at least this many times.
export const ADVICE_SOLO_MAX_ITEMS = 2;
export const ADVICE_SOLO_MIN_TIMES = 5;
export const ADVICE_SOLO_SHOWN = 3;
// The bigger pack: at least this many times bigger, bought at least this many
// times, and at least this much cheaper per unit.
export const ADVICE_PACK_MIN_RATIO = 1.5;
export const ADVICE_PACK_MIN_BUYS = 2;
export const ADVICE_PACK_MIN_SAVING = 0.15;
export const ADVICE_PACK_SHOWN = 3;
// Prices that moved: the last N days against the year before them.
export const ADVICE_PRICE_RECENT_DAYS = 60;
export const ADVICE_PRICE_RECENT_MIN = 2;
export const ADVICE_PRICE_BEFORE_MIN = 3;
export const ADVICE_PRICE_MIN_RISE = 0.15;
export const ADVICE_PRICE_SHOWN = 3;
// Bought once, long ago: how old the one buy has to be, and how many to name.
export const ADVICE_ONCE_MIN_DAYS = 120;
export const ADVICE_ONCE_SHOWN = 8;
// How many "what to do" lines the page shows before "Show N more".
export const ADVICE_SHOWN = 3;
