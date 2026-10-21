// Paying, at the door (design §19 stages 2-3): what a page may ask for, whose
// order it is, and the rules about the two numbers a card needs. The paying
// itself happens in the worker (worker-pay.test.ts).
//
// The tests that matter most here are the ones about the CVV and the OTP:
// that neither can be posted into an order that is not waiting for it, that
// neither can be posted into somebody else's order, and that neither ever
// comes back out.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { validateOrder, validateSecret } from '../../src/api/order.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ORDER_HARD_CAP_RUPEES } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, openSealed, seal } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false', VAULT_PUBLIC_KEY: keys.publicKey });
const CARD = 'Alex Bank Card 1111';

let db: Db;
let server: Server;
let base: string;
let cookie: string;
let householdId: string;

const post = (path: string, body: unknown, as = cookie) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie: as, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, as = cookie) => fetch(`${base}${path}`, { headers: { cookie: as } });
const order = (body: unknown = { vendor: 'instamart', method: 'card', cardLabel: CARD, maxTotal: 94 }, as = cookie) => post('/api/order', body, as);

async function member(subject: string, email: string) {
  await userForSubject(db, logger, subject, email);
  const c = `dm_session=${await mintSession(db, logger, subject)}`;
  const res = await post('/api/households', { name: 'Home', timezone: 'Asia/Kolkata' }, c);
  return { cookie: c, householdId: (await res.json()).household.id as string };
}
// A connection belongs to a person, and the table allows one per person per
// vendor - so a household with two accounts on one vendor is a household with
// two members, which is exactly the case this file has to cover.
async function connect(household: string, status = 'active', subject = 'sub_a') {
  await userForSubject(db, logger, subject, `${subject}@x.com`);
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed)
     values ($1, $2, 'instamart', $3, '4321', 'x') returning id`,
    [household, subject, status],
  );
  await db.query('update vendor_connections set session_sealed = $2 where id = $1', [rows[0].id, seal(keys.publicKey, '{}', `vendor_connections:${rows[0].id}:session`)]);
  return rows[0].id;
}
const at = (id: string, status: string) => db.query(`update order_jobs set status = $2 where id = $1`, [id, status]);
// The worker reaches the payment screen, finds the app wants more than the
// cart said, and stops to ask.
const asking = async (id: string, vendorTotal: number) =>
  db.query(`update order_jobs set status = 'awaiting_ok', vendor_total = $2 where id = $1`, [id, vendorTotal]);
const agreedOn = async (id: string) =>
  (await db.query<{ agreed_total: string | null }>('select agreed_total from order_jobs where id = $1', [id])).rows[0].agreed_total;
const secretIn = async (id: string) =>
  (await db.query<{ secret_sealed: string | null; secret_kind: string | null }>('select secret_sealed, secret_kind from order_jobs where id = $1', [id])).rows[0];

beforeAll(async () => {
  db = await freshTestDb();
  server = createServer(createApp({ config, logger, db, oidc: null }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  const a = await member('sub_a', 'a@x.com');
  cookie = a.cookie;
  householdId = a.householdId;
  await connect(householdId);
});

describe('what a page may ask to pay', () => {
  it('reads a card order', () => {
    expect(validateOrder({ vendor: 'instamart', method: 'card', cardLabel: '  Alex  Bank Card 1111 ', maxTotal: 94 })).toEqual({
      vendor: 'instamart',
      method: 'card',
      cardLabel: CARD,
      maxTotal: 94,
      cartJobId: null,
    });
  });

  it('reads an order paid at the door, which needs no card', () => {
    expect(validateOrder({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94 })).toEqual({
      vendor: 'instamart',
      method: 'on_delivery',
      cardLabel: null,
      maxTotal: 94,
      cartJobId: null,
    });

    // A cart id that is not one is ignored rather than refused: the order
    // still stands, it simply has no cart to check against.
    expect(validateOrder({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId: 'nonsense' }).cartJobId).toBeNull();
  });

  it('refuses an order with no amount agreed, or no card to pay with', () => {
    expect(() => validateOrder({ vendor: 'instamart', method: 'card', cardLabel: CARD })).toThrow();
    expect(() => validateOrder({ vendor: 'instamart', method: 'card', cardLabel: CARD, maxTotal: 0 })).toThrow();
    // No card named is allowed now: the page may not know the cards on an
    // app whose checkout has never been opened, and the worker takes the one
    // card the screen shows (pay.ts). It is null, not an empty string.
    expect(validateOrder({ vendor: 'instamart', method: 'card', maxTotal: 94 }).cardLabel).toBeNull();
    expect(() => validateOrder({ vendor: 'instamart', method: 'gold', maxTotal: 94 })).toThrow();
  });

  // Whatever a page sends, there is a ceiling.
  it('refuses more than the hard cap', () => {
    expect(() => validateOrder({ vendor: 'instamart', method: 'on_delivery', maxTotal: ORDER_HARD_CAP_RUPEES + 1 })).toThrow();
  });

  it('checks the shape of the two numbers a card needs', () => {
    expect(validateSecret('cvv', ' 123 ')).toBe('123');
    expect(validateSecret('cvv', '1234')).toBe('1234'); // American Express
    expect(() => validateSecret('cvv', '12')).toThrow();
    expect(() => validateSecret('cvv', 'abc')).toThrow();
    expect(validateSecret('otp', '778899')).toBe('778899');
    expect(() => validateSecret('otp', '7')).toThrow();
  });
});

describe('POST /api/order', () => {
  it('queues an order and tells the worker', async () => {
    const res = await order();
    expect(res.status).toBe(202);
    const { id } = await res.json();
    const { rows } = await db.query('select status, method, card_label, max_total from order_jobs where id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'requested', method: 'card', card_label: CARD });
  });

  it('needs the app connected, and connected properly', async () => {
    await db.query('delete from vendor_connections');
    expect((await order()).status).toBe(409);
    await connect(householdId, 'needs_reconnect');
    expect((await order()).status).toBe(409);
  });

  // Two at once would race on the same cart and could pay twice for the same
  // food.
  it('allows only one live order per household', async () => {
    expect((await order()).status).toBe(202);
    expect((await order()).status).toBe(409);
  });

  it('allows another once the first is over', async () => {
    const { id } = await (await order()).json();
    await at(id, 'done');
    expect((await order()).status).toBe(202);
  });

  it('is 401 signed out', async () => {
    expect((await order(undefined, '')).status).toBe(401);
  });
});

describe('the CVV and the OTP', () => {
  it('is sealed before it is written, so the row never holds the digits', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' })).status).toBe(204);
    const row = await secretIn(id);
    expect(row.secret_sealed).not.toBeNull();
    expect(row.secret_sealed).not.toContain('456');
    expect(row.secret_kind).toBe('cvv');
    // And only the vault can open it.
    expect(openSealed([keys.privateKey], row.secret_sealed!, `order_jobs:${id}:cvv`)).toBe('456');
  });

  it('never comes back out of the api', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' });
    const body = await (await get(`/api/order/${id}`)).text();
    expect(body).not.toContain('456');
    expect(body).not.toContain('secret');
  });

  // An order that is not waiting for a number is not given one.
  it('is refused when the order is not asking for it', async () => {
    const { id } = await (await order()).json();
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' })).status).toBe(409);
    await at(id, 'awaiting_otp');
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' })).status).toBe(409);
    expect((await post(`/api/order/${id}/secret`, { kind: 'otp', value: '778899' })).status).toBe(204);
  });

  it('is refused a second time while the first is still waiting to be used', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' })).status).toBe(204);
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '999' })).status).toBe(409);
  });

  it('cannot be posted into another household’s order', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    const b = await member('sub_b', 'b@x.com');
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: '456' }, b.cookie)).status).toBe(409);
    expect((await get(`/api/order/${id}`, b.cookie)).status).toBe(404);
  });

  it('refuses a number that is not one', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    expect((await post(`/api/order/${id}/secret`, { kind: 'cvv', value: 'nope' })).status).toBe(400);
    expect((await post(`/api/order/${id}/secret`, { kind: 'what', value: '456' })).status).toBe(400);
    expect(await secretIn(id)).toMatchObject({ secret_sealed: null });
  });
});

describe('agreeing to the app s own price', () => {
  // The cart's bill is not what the checkout charges: a cart billed at 130
  // reached the payment screen as 147 on the real account. The household is
  // asked with the app's own figure, and agrees to exactly that.
  it('takes yes to the price the payment screen showed', async () => {
    const { id } = await (await order()).json();
    await asking(id, 147);
    expect((await post(`/api/order/${id}/agree`, { total: 147 })).status).toBe(204);
    expect(Number(await agreedOn(id))).toBe(147);
  });

  // A page cannot agree on the household's behalf to some other number.
  it('refuses any figure but the one being asked about', async () => {
    const { id } = await (await order()).json();
    await asking(id, 147);
    expect((await post(`/api/order/${id}/agree`, { total: 130 })).status).toBe(409);
    expect((await post(`/api/order/${id}/agree`, { total: 1 })).status).toBe(409);
    expect(await agreedOn(id)).toBeNull();
  });

  it('refuses a price above the hard cap', async () => {
    const { id } = await (await order()).json();
    await asking(id, ORDER_HARD_CAP_RUPEES + 1);
    expect((await post(`/api/order/${id}/agree`, { total: ORDER_HARD_CAP_RUPEES + 1 })).status).toBe(400);
    expect(await agreedOn(id)).toBeNull();
  });

  it('refuses when the order is not asking about a price', async () => {
    const { id } = await (await order()).json();
    expect((await post(`/api/order/${id}/agree`, { total: 94 })).status).toBe(409);
    await at(id, 'awaiting_cvv');
    expect((await post(`/api/order/${id}/agree`, { total: 94 })).status).toBe(409);
  });

  it('cannot agree to another household s price', async () => {
    const { id } = await (await order()).json();
    await asking(id, 147);
    const b = await member('sub_b', 'b@x.com');
    expect((await post(`/api/order/${id}/agree`, { total: 147 }, b.cookie)).status).toBe(409);
    expect(await agreedOn(id)).toBeNull();
  });

  it('says what is being asked about', async () => {
    const { id } = await (await order()).json();
    await asking(id, 147);
    expect(await (await get(`/api/order/${id}`)).json()).toMatchObject({ status: 'awaiting_ok', vendorTotal: 147, agreedTotal: 94 });
  });
});

describe('the cart an order pays for', () => {
  // A household with two accounts on one vendor (the real one has four
  // connections) filled the cart through whichever was oldest and paid
  // through whichever was oldest, agreeing only by luck. The order now uses
  // the cart's own connection.
  const cartOn = async (connectionId: string, lines: number, result?: Record<string, unknown>, vendor = 'instamart') => {
    const { rows } = await db.query<{ id: string }>(
      `insert into cart_jobs (household_id, connection_id, user_id, vendor, wanted, status, result)
       values ($1, $2, 'sub_a', $4, '[]'::jsonb, 'done', $3) returning id`,
      [
        householdId,
        connectionId,
        JSON.stringify(result ?? { cartLines: lines, lines: Array.from({ length: lines }, () => ({ state: 'added', inCart: 1 })) }),
        vendor,
      ],
    );
    return rows[0].id;
  };

  // The cart decides the vendor. The page once sent every order as Instamart
  // whatever cart it was for, and the lookup filtered by that vendor, found
  // nothing, and queued an order with no cart link at all - which is exactly
  // how one app's cart would be "paid for" through the other's account with
  // nothing checked against it.
  it('refuses to pay for a cart that is on a different app', async () => {
    const conn = (await db.query<{ id: string }>('select id from vendor_connections limit 1')).rows[0].id;
    const cartJobId = await cartOn(conn, 2, undefined, 'blinkit');
    const res = await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/blinkit/);
    expect((await db.query('select count(*)::int as n from order_jobs')).rows[0].n).toBe(0);
  });

  it('refuses a cart this household never filled, rather than dropping the link', async () => {
    const res = await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('refuses pay on delivery on an app whose checkout has none', async () => {
    // Blinkit is not a PAY_VENDOR yet either, so this is refused for that
    // first; the method check is kept for the day it is.
    const res = await order({ vendor: 'blinkit', method: 'on_delivery', maxTotal: 94 });
    expect(res.status).toBe(400);
  });

  it('pays through the connection the cart was filled on', async () => {
    // A second member of the same household, with their own Instamart account.
    const second = await connect(householdId, 'active', 'sub_partner');
    const cartJobId = await cartOn(second, 2);
    const { id } = await (await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId })).json();
    const { rows } = await db.query<{ connection_id: string; cart_job_id: string; cart_lines: number }>(
      'select connection_id, cart_job_id, cart_lines from order_jobs where id = $1',
      [id],
    );
    expect(rows[0].connection_id).toBe(second);
    expect(rows[0].cart_job_id).toBe(cartJobId);
    expect(rows[0].cart_lines).toBe(2);
  });

  // A cart of seven things where the store did not stock one of them is six
  // lines in the app. Counting our seven made the payment screen look like a
  // cart that had changed underneath, and stopped two real orders.
  it('counts the cart the vendor has, not the things we asked for', async () => {
    const cartJobId = await cartOn(await connect(householdId, 'active', 'sub_c'), 0, {
      cartLines: 6,
      lines: [
        ...Array.from({ length: 6 }, () => ({ state: 'added', inCart: 1 })),
        { state: 'not_listed', inCart: 0 },
      ],
    });
    const { id } = await (await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId })).json();
    const { rows } = await db.query<{ cart_lines: number }>('select cart_lines from order_jobs where id = $1', [id]);
    expect(rows[0].cart_lines).toBe(6);
  });

  // Carts filled before the worker recorded the vendor's own count: the
  // lines that landed are the best we have, and are still not our seven.
  it('falls back to what landed on a cart filled before we kept the count', async () => {
    const cartJobId = await cartOn(await connect(householdId, 'active', 'sub_d'), 0, {
      lines: [
        { state: 'added', inCart: 1 },
        { state: 'added', inCart: 2 },
        { state: 'out_of_stock', inCart: 0 },
      ],
    });
    const { id } = await (await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId })).json();
    const { rows } = await db.query<{ cart_lines: number }>('select cart_lines from order_jobs where id = $1', [id]);
    expect(rows[0].cart_lines).toBe(2);
  });

  // Without a cart named it still works, on the household's first account.
  it('falls back to the household s own first connection', async () => {
    const { id } = await (await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94 })).json();
    const { rows } = await db.query<{ cart_job_id: string | null; cart_lines: number | null }>('select cart_job_id, cart_lines from order_jobs where id = $1', [id]);
    expect(rows[0].cart_job_id).toBeNull();
    expect(rows[0].cart_lines).toBeNull();
  });

  it('refuses a cart that is not this household s, and queues nothing', async () => {
    // This used to "ignore" the foreign cart and queue an order with no cart
    // link, which is an order checked against nothing. A cart id the household
    // cannot see is answered the way any other unknown id is: not found.
    const b = await member('sub_b', 'b@x.com');
    const otherConn = await connect(b.householdId, 'active', 'sub_b');
    const theirs = await db.query<{ id: string }>(
      `insert into cart_jobs (household_id, connection_id, user_id, vendor, wanted, status)
       values ($1, $2, 'sub_b', 'instamart', '[]'::jsonb, 'done') returning id`,
      [b.householdId, otherConn],
    );
    const res = await order({ vendor: 'instamart', method: 'on_delivery', maxTotal: 94, cartJobId: theirs.rows[0].id });
    expect(res.status).toBe(404);
    expect((await db.query('select count(*)::int as n from order_jobs')).rows[0].n).toBe(0);
  });
});

describe('finding an order that is still going', () => {
  // Without this an order lives only in the page that started it. Close that
  // page while it waits for a bank's code and the code can never be given,
  // while the order it belongs to is already placed - which is what happened
  // on 2026-09-22.
  it('finds the order this household has on the go', async () => {
    expect(await (await get('/api/order/live')).json()).toEqual({ id: null });
    const { id } = await (await order()).json();
    expect(await (await get('/api/order/live')).json()).toEqual({ id });
    await at(id, 'awaiting_otp');
    expect(await (await get('/api/order/live')).json()).toEqual({ id });
  });

  it('forgets it once it is over', async () => {
    const { id } = await (await order()).json();
    await at(id, 'done');
    expect(await (await get('/api/order/live')).json()).toEqual({ id: null });
  });

  it('never hands one household another household s order', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    const b = await member('sub_b', 'b@x.com');
    expect(await (await get('/api/order/live', b.cookie)).json()).toEqual({ id: null });
  });

  it('is 401 signed out', async () => {
    expect((await get('/api/order/live', '')).status).toBe(401);
  });
});

describe('stopping an order', () => {
  it('can be stopped while nothing has been ordered', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    expect((await post(`/api/order/${id}/cancel`, {})).status).toBe(204);
    const { rows } = await db.query('select status, error_code from order_jobs where id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'cancelled' });
  });

  // Once Pay has been pressed there is an order at the vendor. Marking our
  // own row cancelled would be a lie.
  it('cannot be stopped once Pay has been pressed', async () => {
    const { id } = await (await order()).json();
    await db.query(`update order_jobs set status = 'paying', pay_pressed_at = now() where id = $1`, [id]);
    expect((await post(`/api/order/${id}/cancel`, {})).status).toBe(409);
  });
});

describe('GET /api/order/:id', () => {
  it('says what it is waiting for and what it agreed to', async () => {
    const { id } = await (await order()).json();
    await at(id, 'awaiting_cvv');
    expect(await (await get(`/api/order/${id}`)).json()).toMatchObject({
      status: 'awaiting_cvv',
      method: 'card',
      cardLabel: CARD,
      agreedTotal: 94,
      paid: false,
      unpaidOrder: false,
    });
  });

  // The state this whole flow exists to be able to show.
  it('says plainly when an order exists that was never paid for', async () => {
    const { id } = await (await order()).json();
    await db.query(`update order_jobs set status = 'failed', error_code = 'no_secret', vendor_order_id = 'ord_9', pay_pressed_at = now() where id = $1`, [id]);
    expect(await (await get(`/api/order/${id}`)).json()).toMatchObject({ unpaidOrder: true, orderId: 'ord_9', paid: false });
  });

  // And says it even when the order could not be named. The vendor creates
  // the order before the money moves, so once Pay has been pressed an order
  // may exist whether or not we caught its id - which is exactly what
  // happened on 2026-09-22. Saying nothing would let them find out at the
  // door.
  it('says so even when the order could not be named', async () => {
    const { id } = await (await order()).json();
    await db.query(`update order_jobs set status = 'failed', error_code = 'no_secret', pay_pressed_at = now() where id = $1`, [id]);
    expect(await (await get(`/api/order/${id}`)).json()).toMatchObject({ unpaidOrder: true, orderId: null, paid: false });
  });

  // Nothing was pressed, so nothing was ordered, so nothing to warn about.
  it('never warns about an order that was never placed', async () => {
    const { id } = await (await order()).json();
    await db.query(`update order_jobs set status = 'failed', error_code = 'total_changed' where id = $1`, [id]);
    expect(await (await get(`/api/order/${id}`)).json()).toMatchObject({ unpaidOrder: false });
  });

  it('is 404 for an order that is not this household’s', async () => {
    expect((await get(`/api/order/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });
});
