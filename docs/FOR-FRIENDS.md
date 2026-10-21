# DhaniyaMirchi, for friends trying it

Dhaniya and mirchi: coriander and green chilli, the two things every Indian
kitchen always needs and always runs out of. That is what this is for.
**Never run out of the everyday stuff, without ever writing a shopping list.**

This is a personal project, used by two households so far. It works. It also
has rough edges, and a few things it will never do. Both are written down
here so nothing surprises you.

---

## What it does, in one paragraph

You connect your grocery apps once (Instamart, Blinkit). From then on it
reads your **order history** from those apps by itself, works out how fast
your house goes through each thing, and tells you what is about to run out.
When you agree, it puts those things in your cart on the app, and if you
want, pays for the cart from here. You never type in what you bought. The
orders already know.

---

## Getting in

- Sign in with Google. Only emails on the allow list can get in; if yours is
  not on it, ask the person who invited you.
- Use it on your **phone**, at https://app.dev.example.com. It is built
  for phones first.
- On iPhone, "Add to Home Screen" if you want notifications. Safari only
  delivers them to an installed app.
- **Connecting an app**: you type your phone number, the app sends you an
  OTP, you type it here. We log in on our side and read your orders in the
  background. You will see a progress bar; you can close the page. A big
  history (a few hundred orders) takes a few minutes.
- You may be asked to reconnect now and then. The apps' logins expire; we
  do not know exactly how often yet. When it happens there is a "Reconnect
  this app" button on the Grocery apps page.

---

## The pages

**Supplies** is the landing page and the whole point. It opens on **Running
low**: things your house is probably out of or about to be. Tabs: Running
low · Coming up · Not due · All items. Search at the top finds one thing among
a couple of hundred. Each row says why it thinks so ("Probably used up",
"Low by tomorrow", "About 347 g left"). Tap a row for its details and the
products you buy for it.

The **line at the bottom** is your cart. Same idea as in Blinkit or Instamart:
one line with the amount, tap it for the items. It changes as things happen:

- **"5 things · about ₹1.1k"** with a **Send to Instamart** button: the list
  you are making. The app fills this list itself when you arrive, from what
  is running low. Take things off, add more from the rows, tap Send.
- **"Filling your Instamart cart · 5 things"**: it is putting them in, one by
  one, in the background. You can leave. Stop is there if you change your
  mind.
- **"Instamart cart ready · ₹608"** with **Pay on Instamart**: the cart is
  filled at the store. Tap the line to see exactly what went in, what it
  costs, and what did not go in and why.
- **×** on the list's line throws away the list the app made up (anything you
  added yourself stays). A ready cart has no ×: it leaves through **Done** in
  the sheet, so you cannot lose the way to pay by accident.

Inside the sheet there is a tab per thing: **Your list**, then one per app.
An app's tab shows its cart, its bill, what it could not add and why ("Milk ·
packs here: 1 ltr"), what was already in your cart from the app itself, and,
if the other app sells what this one lacked, those items with a **Send to
Blinkit** button.

**Cook** turns a dish into a shopping list. Needs an AI key (see below).

**History** is your orders across both apps, with what was in them.

**Insights** is what you spend and how you shop: the month ahead (spent so
far, heading for), the cycle you budget in (set it to your card's billing
date), spend by month and by category, how often you order, what you order
together, what went up in price, and a "What to do" list with a verb in each
line.

**Apps** is where the apps are connected, synced and reconnected. Also two
settings for carts: which app carts go to by default, and whether the other
app is offered for what that one does not have.

**Household**: who lives here, guests, pets, time away. This changes the
predictions. You can invite the others in your house; each connects their
own apps and Insights reads everyone's orders together.

---

## Paying from here

This is the part to read slowly.

**What happens when you tap Pay:** we open the app's own checkout in a
browser on our side, choose your saved card, and stop. The screen shows you
the app's own total. If it is higher than the cart said (the apps add fees
at checkout), it asks you to agree to that exact number. Then it asks you
for your **CVV**, types it, presses Pay, and when your bank asks for its
**OTP**, asks you for that and types it. Your CVV and OTP travel encrypted,
are typed once, and are never kept.

**Things you must know:**

1. **The app creates the order before the money moves.** If something goes
   wrong after Pay is pressed, an order can exist at the store that is not
   paid for. The page tells you when that happens, with the order number.
   Open the app and pay for it or cancel it there. Do not tap Pay again here.
2. **Look at the amount in your bank's OTP message.** It is the only number
   that cannot be stale. The apps sometimes change a cart between you
   agreeing and the bank being asked (an item goes out of stock and is
   dropped). If the bank's number is not what you agreed to, you can stop:
   there is a **Cancel payment** button under the OTP box.
3. **Per order cap: ₹2,000** while paying is being tested. Bigger carts, pay
   in the app.
4. **Cash on Delivery** works on Instamart. On Blinkit it does not yet.
5. If the page says **"we could not read the order back"**, the payment
   most likely went through; check the app. It is never a reason to pay
   again. (The app would refuse a second payment for that cart anyway.)
6. A **Blinkit** cart is filled by us and cannot be seen in your Blinkit app.
   You pay for it from here or not at all. An **Instamart** cart is your real
   cart: you will see it in the Instamart app and can pay there too.

---

## What it cannot do, and why

- **It cannot know what you bought elsewhere.** A shop, a mandi, Zepto (not
  connected yet). If half your dal comes from somewhere it cannot see, its
  idea of your dal will be wrong. It only ever says what the orders say.
- **It will not guess.** A thing you have bought once or twice has "not
  enough history yet". No number is better than a wrong number. Give it a
  month.
- **It does not know your fridge.** "Probably used up" means "by your
  rhythm, you would have bought this by now". If you bought a kilo at a
  wedding sale, it will be wrong for a while. Tap the row and tell it ("I
  have more"); it learns.
- **Blinkit cannot be filled by API.** Every item is added by clicking the
  store's own buttons, one by one, in a browser. It takes a few seconds per
  item. Instamart is quicker.
- **Blinkit Money cannot be spent from here.** The web checkout does not
  offer it. Card only, for now.
- **Zepto** is not connected yet.
- **The app's search is not ours.** If Blinkit's search does not find your
  brand of foil under the name on your old orders, we cannot add it. The
  sheet will say "not sold here" or "packs here: 1 ltr" so you know why.
- **A different pack means a different count.** If your 500 ml milk is not
  sold and you also buy the 1 ltr, it will take the 1 ltr, but it keeps the
  count: 2 × 500 ml becomes 2 × 1 ltr. Check the row before paying.

---

## The AI parts, and money

- **Cook** and "tell us in your own words" (Household) use an AI model. They
  need an API key, which you add on the AI settings page (under your account
  menu). Your key, your bill, roughly ₹30 to ₹50 a month for a busy
  household. Without a key those two features are off; everything else
  works. Nothing else in the app uses AI. The predictions, prices, totals
  and lists are plain arithmetic, and the AI is never allowed to do
  arithmetic.
- **Nothing is charged for using the app.** It runs on a free server.

---

## Privacy, plainly

- We hold a login to your grocery account. It is encrypted at rest and only
  ever decrypted, on the server, when reading your orders or filling a cart.
  It is never shown to a browser or written to a log.
- From your orders we keep **what, how much, when and what it cost**. Your
  delivery address, phone number and card digits are seen on the page and
  thrown away. They are not stored.
- Your CVV and OTP are typed once and never kept.
- Your household's data is yours: only people you invite see it.

---

## Things that will look odd, and are not bugs

- The app fills your list by itself when you arrive. Once per list. If you
  bin the whole thing, it stays gone until something new goes low; then only
  the new thing is offered.
- The bill on a cart tab can be more than the rows above it. The rows are
  what **we** added; the bill is the whole cart, including what you already
  had in it from the app. The sheet lists those under "Already in your cart".
- "Not added at Instamart · Milk · packs here: 1 ltr" is the store talking,
  not us. It means: they have milk, not in the pack you buy.
- A ready cart disappears after six hours. The store's cart will have
  moved on by then anyway.
- "Running low" shows only what is low. "Coming up" has its own tab.

---

## When something breaks

Tell the person who invited you what the screen said, word for word, and roughly when. Every
step is logged on the server (never your codes, never your card), and the
log usually says exactly what happened. Two Blinkit orders were placed and
not paid for during testing; that is the kind of thing worth saying out
loud the moment you see it.

Thank you for trying it.
