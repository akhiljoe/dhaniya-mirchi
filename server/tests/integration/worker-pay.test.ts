// Paying for a household's cart (design §19 stages 2-3). The vendor is a
// stand-in; the payment screen it imitates was read off the real one on
// 2026-09-21 (spike/instamart/checkout-ui.ts).
//
// Every test here is about one of two things: what has to be true before the
// button that spends money is pressed, and what the household is told when
// something goes wrong after it. The second matters because the vendor
// creates the order before the money moves, so "it failed" and "there is an
// order you have not paid for" are different sentences.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CartSession } from '../../src/worker/adapters/instamart-cart.js';
import { CartError } from '../../src/worker/adapters/instamart-cart.js';
import type { PaymentScreen, PayResult } from '../../src/worker/adapters/instamart-checkout.js';
import type { VendorAddress } from '../../src/worker/adapters/instamart-catalog.js';
import type { CapturedSession } from '../../src/worker/connect.js';
import { claimNextOrderJob, failStaleOrderJobs, runOrderJob, waitForSecret, type PayDeps } from '../../src/worker/pay.js';
import { ORDER_HARD_CAP_RUPEES, ORDER_STALE_SECONDS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, seal } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
const vault = { publicKey: keys.publicKey, privateKeys: [keys.privateKey] };
const SESSION: CapturedSession = { cookies: [], localStorage: {}, headers: {} } as unknown as CapturedSession;
const CARD = 'Alex Bank Card 1111';
const ADDRESS: VendorAddress = { id: 'a1', label: 'Maple Residency', display: '', lat: 0, lng: 0, name: '' };

let db: Db;
let householdId: string;
let connectionId: string;

interface FakeOpts {
  screen?: Partial<PaymentScreen>;
  openThrows?: CartError;
  pay?: (cvv: string | null) => Promise<PayResult>;
  outcome?: { orderId: string | null; paid: boolean; unknown?: boolean };
  placedOrderId?: string | null;
  // Whether the chosen card's row asks for a CVV. The real screen decides
  // this; a card that is not asked for one must not have the household asked.
  cvvNeeded?: boolean;
}

// Records every step, and in particular whether the money-spending one was
// ever reached.
function fakeAdapter(over: FakeOpts = {}) {
  const calls: string[] = [];
  const typed: { kind: string; value: string }[] = [];
  const screen: PaymentScreen = { total: 94, items: 1, address: 'Maple Residency', cards: [CARD], onDelivery: true, ...over.screen };
  let last: PayResult | null = null;
  const checkout = {
    placedOrderId: over.placedOrderId ?? null,
    open: async () => {
      calls.push('open');
      if (over.openThrows) throw over.openThrows;
      return screen;
    },
    read: async () => screen,
    chooseCard: async (label: string) => {
      calls.push(`chooseCard:${label}`);
      if (!screen.cards.includes(label)) throw new CartError('card_not_found');
    },
    cvvNeeded: async () => {
      calls.push('cvvNeeded');
      return over.cvvNeeded ?? true;
    },
    pay: async (cvv: string | null) => {
      calls.push('pay');
      if (cvv !== null) typed.push({ kind: 'cvv', value: cvv });
      last = over.pay ? await over.pay(cvv) : { pressedAt: new Date(), orderId: 'ord_1', paid: true, bankAsked: false, bankTotal: null };
      return last;
    },
    payOnDelivery: async () => {
      calls.push('payOnDelivery');
      last = { pressedAt: new Date(), orderId: 'ord_cod', paid: true, bankAsked: false, bankTotal: null };
      return last;
    },
    submitOtp: async (otp: string) => {
      calls.push('submitOtp');
      typed.push({ kind: 'otp', value: otp });
    },
    // The vendor's last word. Unless a test says otherwise, it agrees with
    // whatever pressing Pay reported.
    // The real one asks the vendor what became of the order; unless a test
    // says otherwise, assume the vendor is showing it and it went through.
    outcome: async () => over.outcome ?? { orderId: last?.orderId ?? null, paid: true, unknown: false },
  };
  return {
    calls,
    typed,
    checkout,
    open: async (_s: CapturedSession, _to: VendorAddress | string | null): Promise<CartSession> =>
      ({
        address: ADDRESS,
        addresses: async () => [ADDRESS],
        useAddress: async () => true,
        paymentOptions: async () => [],
        state: async () => ({ lines: [], bill: {}, serving: true, eta: null, message: null, statuses: [] }),
        set: async () => {
          throw new Error('a payment never fills a cart');
        },
        checkout: () => checkout,
        close: async () => {
          calls.push('close');
        },
      }) as unknown as CartSession,
  };
}

// A real household gets four minutes to type a number; a test gets two
// seconds, so a test that means "they never sent it" takes two seconds.
const deps = (a: ReturnType<typeof fakeAdapter>): PayDeps => ({ db, logger, vault, adapters: { instamart: a }, secretWaitMs: 2000 });

const queue = async (fields: { method?: 'card' | 'on_delivery'; maxTotal?: number; cardLabel?: string | null } = {}) => {
  const { rows } = await db.query<{ id: string }>(
    `insert into order_jobs (household_id, connection_id, user_id, vendor, method, card_label, max_total, status)
     values ($1, $2, 'sub_a', 'instamart', $3, $4, $5, 'requested') returning id`,
    [householdId, connectionId, fields.method ?? 'card', fields.cardLabel === undefined ? CARD : fields.cardLabel, fields.maxTotal ?? 100],
  );
  return rows[0].id;
};

const row = async (id: string) =>
  (
    await db.query<{ status: string; error_code: string | null; vendor_order_id: string | null; paid: boolean; pay_pressed_at: Date | null; vendor_total: string | null; agreed_total: string | null; secret_sealed: string | null }>(
      'select status, error_code, vendor_order_id, paid, pay_pressed_at, vendor_total, agreed_total, secret_sealed from order_jobs where id = $1',
      [id],
    )
  ).rows[0];

// Puts the number in the row the way the api does.
const send = async (id: string, kind: 'cvv' | 'otp', value: string) =>
  db.query(`update order_jobs set secret_sealed = $2, secret_kind = $3, secret_at = now() where id = $1`, [id, seal(vault.publicKey, value, `order_jobs:${id}:${kind}`), kind]);

// Answers whatever the job asks for, and stops as soon as the job is over.
// Deterministic on purpose: no timers left running between tests, and a test
// that means "they never sent it" simply does not list that answer.
async function respond(id: string, answers: { cvv?: string; otp?: string; agree?: boolean }): Promise<void> {
  for (;;) {
    const r = await row(id).catch(() => null);
    if (!r || r.status === 'done' || r.status === 'failed') return;
    // Saying yes to the app's own total, the way the api does: only ever the
    // exact figure the payment screen showed.
    if (r.status === 'awaiting_ok' && answers.agree && r.agreed_total === null) {
      await db.query('update order_jobs set agreed_total = vendor_total where id = $1', [id]);
    }
    if (!r.secret_sealed) {
      if (r.status === 'awaiting_cvv' && answers.cvv) await send(id, 'cvv', answers.cvv);
      if (r.status === 'awaiting_otp' && answers.otp) await send(id, 'otp', answers.otp);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

// The job and the household, running at the same time, as they really do.
const runWith = (a: ReturnType<typeof fakeAdapter>, id: string, answers: { cvv?: string; otp?: string; agree?: boolean } = {}) =>
  Promise.all([runOrderJob(deps(a), id), respond(id, answers)]);

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  await db.query(`insert into users (id, email) values ('sub_a', 'a@x.com')`);
  householdId = (await db.query<{ id: string }>(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  connectionId = (
    await db.query<{ id: string }>(
      `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed, cart_address)
       values ($1, 'sub_a', 'instamart', 'active', '4567', 'x', $2) returning id`,
      [householdId, JSON.stringify(ADDRESS)],
    )
  ).rows[0].id;
  await db.query('update vendor_connections set session_sealed = $2 where id = $1', [connectionId, seal(vault.publicKey, JSON.stringify(SESSION), `vendor_connections:${connectionId}:session`)]);
});

describe('the app asks for more than the cart said', () => {
  // The cart's bill is not what the checkout charges: on the real account a
  // cart billed at 130 reached the payment screen as 147. Paying the
  // difference silently would be paying a number nobody saw; refusing it
  // outright would mean no order ever completes. So it asks.
  it('asks rather than refusing, and pays only what was agreed', async () => {
    const a = fakeAdapter({ screen: { total: 147 } });
    const id = await queue({ maxTotal: 130 });
    await runWith(a, id, { agree: true, cvv: '456' });
    expect(a.calls).toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'done', paid: true, vendor_total: '147', agreed_total: '147' });
  });

  it('orders nothing when the price is not agreed', async () => {
    const a = fakeAdapter({ screen: { total: 147 } });
    const id = await queue({ maxTotal: 130 });
    await runOrderJob(deps(a), id);
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'not_agreed', vendor_order_id: null, pay_pressed_at: null });
  }, 30_000);

  // Above the cap there is nothing to ask about.
  it('never asks about a price above the hard cap', async () => {
    const a = fakeAdapter({ screen: { total: ORDER_HARD_CAP_RUPEES + 1 } });
    const id = await queue({ maxTotal: 130 });
    await runWith(a, id, { agree: true, cvv: '456' });
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'total_changed' });
  });

  it('does not ask at all when the app wants no more than the cart said', async () => {
    const a = fakeAdapter({ screen: { total: 94 } });
    const id = await queue({ maxTotal: 130 });
    await runWith(a, id, { cvv: '456' });
    expect(await row(id)).toMatchObject({ status: 'done', agreed_total: null });
  });
});

describe('runOrderJob: before any money moves', () => {
  // A total that cannot be read is not a price to ask about: it is a refusal.
  it('refuses when the total cannot be read at all', async () => {
    const a = fakeAdapter({ screen: { total: null } });
    const id = await queue();
    await runWith(a, id, { agree: true, cvv: '456' });
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'total_changed', vendor_order_id: null, paid: false, pay_pressed_at: null });
  });

  // A vendor keeps one cart per store and the store follows from the address.
  // Agreeing to a price cannot make a wrong address right.
  it('refuses when the order would go to another address', async () => {
    const a = fakeAdapter({ screen: { address: "Friend's" } });
    const id = await queue();
    await runWith(a, id, { agree: true, cvv: '456' });
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'wrong_address' });
  });

  it('refuses a card the payment screen does not show', async () => {
    const a = fakeAdapter({ screen: { cards: ['Alex Bank 2222'] } });
    const id = await queue({ cardLabel: 'Some Other Card 9999' });
    await runOrderJob(deps(a), id);
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'card_not_found' });
  });

  // Waiting costs nothing here: nothing has been ordered, so giving up is
  // free and silent.
  it('orders nothing at all when the CVV never comes', async () => {
    const a = fakeAdapter();
    const id = await queue();
    await runOrderJob({ ...deps(a), vault }, id);
    expect(a.calls).not.toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'no_secret', vendor_order_id: null, pay_pressed_at: null });
  }, 30_000);

  it('records the vendor’s own total before deciding', async () => {
    const a = fakeAdapter({ screen: { total: 94 } });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '123' });
    expect(Number((await row(id)).vendor_total)).toBe(94);
  }, 30_000);
});

describe('runOrderJob: paying', () => {
  it('types the CVV the household sent and presses Pay exactly once', async () => {
    const a = fakeAdapter();
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(a.typed).toEqual([{ kind: 'cvv', value: '456' }]);
    expect(a.calls.filter((c) => c === 'pay')).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: 'done', paid: true, vendor_order_id: 'ord_1' });
    expect((await row(id)).pay_pressed_at).not.toBeNull();
  }, 30_000);

  it('relays the bank’s OTP when the bank asks', async () => {
    const a = fakeAdapter({ pay: async () => ({ pressedAt: new Date(), orderId: 'ord_2', paid: false, bankAsked: true, bankTotal: null }), outcome: { orderId: 'ord_2', paid: true } });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456', otp: '778899' });
    expect(a.typed).toEqual([
      { kind: 'cvv', value: '456' },
      { kind: 'otp', value: '778899' },
    ]);
    expect(await row(id)).toMatchObject({ status: 'done', paid: true, vendor_order_id: 'ord_2' });
  }, 30_000);

  // The state this whole design exists to be able to report.
  it('says an order was left unpaid when the OTP never comes', async () => {
    const a = fakeAdapter({
      pay: async () => ({ pressedAt: new Date(), orderId: 'ord_3', paid: false, bankAsked: true, bankTotal: null }),
      placedOrderId: 'ord_3',
    });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'failed', error_code: 'no_secret', vendor_order_id: 'ord_3' });
    expect(r.paid).toBe(false);
    expect(r.pay_pressed_at).not.toBeNull();
  }, 30_000);

  it('says not paid rather than done when the vendor calls the order dead', async () => {
    const a = fakeAdapter({ pay: async () => ({ pressedAt: new Date(), orderId: 'ord_4', paid: false, bankAsked: false, bankTotal: null }), outcome: { orderId: 'ord_4', paid: false, unknown: false } });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'not_paid', vendor_order_id: 'ord_4', paid: false });
  }, 30_000);

  // The answer that matters most. Telling a household a payment failed when
  // the vendor will not say either way sends them to pay a second time for an
  // order that may already have gone through.
  it('says it cannot tell, rather than saying it failed', async () => {
    const a = fakeAdapter({
      pay: async () => ({ pressedAt: new Date(), orderId: 'ord_5', paid: false, bankAsked: false, bankTotal: null }),
      outcome: { orderId: 'ord_5', paid: false, unknown: true },
    });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'unconfirmed', vendor_order_id: 'ord_5', paid: false });
  }, 30_000);

  it('pays on delivery without asking for anything', async () => {
    const a = fakeAdapter();
    const id = await queue({ method: 'on_delivery', cardLabel: null, maxTotal: 94 });
    await runOrderJob(deps(a), id);
    expect(a.typed).toEqual([]);
    expect(a.calls).toContain('payOnDelivery');
    expect(await row(id)).toMatchObject({ status: 'done', paid: true, vendor_order_id: 'ord_cod' });
  }, 30_000);
});

describe('the CVV is asked for only when the screen asks', () => {
  // The screen opens with the preferred card already chosen and its CVV box
  // showing. The first version tapped the tick anyway, which CLOSED the row:
  // the household typed a CVV live on 2026-09-22 and there was nowhere left
  // to put it. Asking the screen first is the guard against that whole class.
  it('asks the screen before asking the household', async () => {
    const a = fakeAdapter();
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(a.calls.indexOf('cvvNeeded')).toBeGreaterThan(a.calls.indexOf('chooseCard:' + CARD));
    expect(a.calls.indexOf('cvvNeeded')).toBeLessThan(a.calls.indexOf('pay'));
  });

  // A household told to type a CVV into a screen that never wanted one waits,
  // types, and watches it fail for no reason they can see.
  it('never asks for a CVV the screen does not want, and still pays', async () => {
    const a = fakeAdapter({ cvvNeeded: false });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(a.typed).toEqual([]);
    expect(a.calls).toContain('pay');
    expect(await row(id)).toMatchObject({ status: 'done', paid: true });
  });

  it('waits for the household when the screen does want one', async () => {
    const a = fakeAdapter({ cvvNeeded: true });
    const id = await queue({ maxTotal: 94 });
    await runWith(a, id, { cvv: '456' });
    expect(a.typed).toEqual([{ kind: 'cvv', value: '456' }]);
  });
});

describe('runOrderJob: the secret itself', () => {
  it('is gone from the row the moment it has been read', async () => {
    const id = await queue();
    await db.query(`update order_jobs set status = 'awaiting_cvv' where id = $1`, [id]);
    await send(id, 'cvv', '321');
    expect(await waitForSecret({ db, logger, vault, adapters: {} }, id, 'cvv', 2000)).toBe('321');
    expect((await row(id)).secret_sealed).toBeNull();
    // And it cannot be read a second time.
    expect(await waitForSecret({ db, logger, vault, adapters: {} }, id, 'cvv', 200)).toBeNull();
  });

  it('is refused when it is too old to be worth typing', async () => {
    const id = await queue();
    await db.query(`update order_jobs set status = 'awaiting_cvv' where id = $1`, [id]);
    await send(id, 'cvv', '321');
    await db.query(`update order_jobs set secret_at = now() - interval '1 hour' where id = $1`, [id]);
    expect(await waitForSecret({ db, logger, vault, adapters: {} }, id, 'cvv', 2000)).toBeNull();
  });

  it('is never left behind, however the job ended', async () => {
    const a = fakeAdapter({ screen: { total: 9_999 } });
    const id = await queue({ maxTotal: 100 });
    await send(id, 'cvv', '321');
    await runOrderJob(deps(a), id);
    expect((await row(id)).secret_sealed).toBeNull();
  });

  it('will not hand a CVV to a job that is waiting for an OTP', async () => {
    const id = await queue();
    await db.query(`update order_jobs set status = 'awaiting_otp' where id = $1`, [id]);
    await send(id, 'cvv', '321');
    expect(await waitForSecret({ db, logger, vault, adapters: {} }, id, 'otp', 300)).toBeNull();
  });
});

describe('order jobs that were interrupted', () => {
  // Before Pay nothing was ordered, so it is simply over.
  it('is abandoned when it never got as far as paying', async () => {
    const id = await queue();
    await db.query(`update order_jobs set status = 'awaiting_cvv', updated_at = now() - make_interval(secs => $2) where id = $1`, [id, ORDER_STALE_SECONDS + 60]);
    await failStaleOrderJobs(db);
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
  });

  // After Pay an order may exist. Saying "interrupted" would be a guess.
  it('says it does not know when Pay had already been pressed', async () => {
    const id = await queue();
    await db.query(`update order_jobs set status = 'paying', pay_pressed_at = now(), updated_at = now() - make_interval(secs => $2) where id = $1`, [id, ORDER_STALE_SECONDS + 60]);
    await failStaleOrderJobs(db);
    expect(await row(id)).toMatchObject({ status: 'failed', error_code: 'unknown_after_pay' });
  });

  it('claims one job at a time, oldest first', async () => {
    const first = await queue();
    expect(await claimNextOrderJob(db)).toBe(first);
    expect(await claimNextOrderJob(db)).toBeNull();
  });
});
