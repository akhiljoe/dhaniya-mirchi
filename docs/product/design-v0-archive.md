# Household Inventory & Replenishment Assistant

## 1. Product Overview

### Working name
Household Inventory Assistant

### One-line description

A lightweight household inventory system that learns what a person buys and consumes, maintains an estimated view of what is currently at home, and proactively tells them what they are likely to need and when.

### Core idea

People repeatedly buy the same household items, but keeping track of what is available at home is annoying.

The product removes the need to constantly think:

- Do I still have milk?
- When will the eggs run out?
- Did I already buy detergent?
- What should I add to my next grocery order?
- What am I likely to run out of this week?

Instead, the system maintains an estimated inventory based primarily on purchase and consumption history.

The goal is not to maintain perfectly accurate physical stock. The goal is to provide a sufficiently accurate estimate that is useful for everyday purchasing decisions.

---

# 2. Problem

## 2.1 Current experience

A typical household repeatedly purchases:

- Milk
- Eggs
- Bread
- Rice
- Vegetables
- Fruits
- Snacks
- Cleaning supplies
- Toiletries
- Pet supplies
- Other recurring household products

The current process is mostly manual:

1. Notice something is running low.
2. Check the fridge, kitchen, bathroom, etc.
3. Remember what was already purchased.
4. Create a shopping list.
5. Open a delivery/shopping app.
6. Search for the items.
7. Place the order.

The problem becomes more noticeable when several items are running low simultaneously.

## 2.2 Core pain point

The underlying problem is not grocery shopping itself.

It is:

> Maintaining awareness of household inventory and knowing when something needs to be replenished.

The product should therefore focus on inventory awareness and replenishment intelligence rather than trying to become another grocery marketplace.

---

# 3. Product Goal

Build a system that answers three questions:

### 1. What do I probably have at home?

Maintain an estimated inventory based on purchases, consumption, corrections, and expiry.

### 2. What am I likely to run out of soon?

Use historical consumption patterns to estimate depletion.

### 3. What should I buy and when?

Generate a replenishment list based on predicted depletion, user preferences, and configurable thresholds.

---

# 4. Non-Goals for V1

The first version should deliberately avoid unnecessary complexity.

### Not included initially

- Automatically placing grocery orders
- Payment processing
- Fully autonomous shopping
- Perfect computer-vision inventory detection
- Exact measurement of physical quantities
- Complex machine-learning forecasting
- Integration with every grocery retailer
- Automatic product substitution
- Household accounting/budgeting
- Recipe generation as the primary product
- Nutrition tracking

These can be considered later.

---

# 5. Target User

## Primary user

Individuals or households that frequently order groceries and household supplies online.

Typical characteristics:

- Orders groceries at least weekly
- Buys recurring products
- Uses services such as Blinkit, Zepto, Instamart, Amazon, etc.
- Does not want to manually maintain a shopping list
- Wants reminders before items run out

## Example user

A user regularly purchases:

- 2L milk every 4-5 days
- 12 eggs every week
- 5kg rice every 3-4 weeks
- Bread every 4 days
- Toothpaste every 6-8 weeks

The system gradually learns these patterns.

---

# 6. Core User Experience

The ideal experience should require very little manual input.

## Initial setup

User creates a household.

They can optionally add commonly purchased items.

Example:

```text
Milk
Eggs
Bread
Rice
Cooking Oil
Toothpaste
Detergent
```

The user does not need to enter everything.

The inventory can build over time.

---

# 7. Adding Purchases

The most important initial input is purchase information.

## Option A: Manual entry

User says:

> I bought 2 litres of milk, 12 eggs and 1kg rice.

The application converts this into structured transactions.

Example:

```json
{
  "items": [
    {
      "name": "milk",
      "quantity": 2,
      "unit": "litre"
    },
    {
      "name": "eggs",
      "quantity": 12,
      "unit": "piece"
    },
    {
      "name": "rice",
      "quantity": 1,
      "unit": "kg"
    }
  ]
}
```

## Option B: Quick purchase form

```text
Item       Quantity       Unit

Milk       2              L
Eggs       12             pcs
Rice       1              kg

[ Add purchase ]
```

## Option C: Future integrations

Potential future inputs:

- Grocery order history
- Email receipts
- SMS/order notifications
- Retailer APIs
- Uploaded invoices
- Receipt photos

The product should be designed so these can become additional data sources later.

---

# 8. Inventory Model

The inventory should represent an estimate rather than pretending to know exact physical quantities.

Example:

```text
Milk
Purchased: 2L
Estimated remaining: ~650ml
Estimated consumption: ~450ml/day
Estimated remaining time: ~1.5 days
Status: BUY SOON
```

The system should communicate uncertainty.

Use terms such as:

- Plenty
- Available
- Running low
- Buy soon
- Likely finished
- Unknown

Avoid false precision.

---

# 9. Inventory States

Each inventory item can have a state.

### AVAILABLE

The item is comfortably above its reorder threshold.

### RUNNING_LOW

The predicted remaining quantity is approaching the user's normal reorder point.

### BUY_SOON

The predicted depletion date is close.

### LIKELY_OUT

The estimated quantity has reached zero or the expected depletion date has passed.

### UNKNOWN

There is insufficient data to make a reliable estimate.

---

# 10. Consumption Tracking

The system should initially use simple statistical calculations rather than machine learning.

## Example

Purchases:

```text
Sep 1:  2L milk
Sep 5:  2L milk
Sep 9:  2L milk
Sep 13: 2L milk
```

Observed purchase interval:

```text
4 days
4 days
4 days
```

Estimated consumption:

```text
2L / 4 days = 500ml/day
```

The system can use a moving average so that recent behavior matters more.

For example:

```text
Recent consumption:
450ml/day
500ml/day
500ml/day
550ml/day

Estimated:
~500ml/day
```

This is sufficient for the first version.

---

# 11. Consumption Events

There are two possible ways to model consumption.

## Model A: Implicit consumption

The system infers consumption from the next purchase.

Example:

```text
Purchase:
2L milk on Sep 1

Next purchase:
2L milk on Sep 5
```

Therefore:

```text
Estimated consumption ≈ 500ml/day
```

This requires very little user effort.

## Model B: Explicit consumption

User can say:

> Finished the milk.

or:

> We used half the milk.

This provides additional information and allows the user to correct the estimate.

V1 should primarily use implicit consumption, with optional explicit corrections.

---

# 12. Replenishment Prediction

For each item:

```text
estimated_remaining_quantity
/
estimated_daily_consumption
=
estimated_days_remaining
```

Example:

```text
Milk

Estimated remaining: 700ml
Consumption: 500ml/day

Days remaining:
1.4 days
```

If the user's normal reorder lead time is 0-1 days:

```text
Recommendation:
Buy soon
```

---

# 13. Reorder Threshold

Do not wait until an item reaches zero.

Each item can have a reorder threshold.

Example:

```text
Milk:
Reorder when remaining < 1L

Eggs:
Reorder when remaining < 4 eggs

Rice:
Reorder when remaining < 1kg
```

The threshold can initially be automatically derived from purchasing behavior.

For example, if a user normally consumes 500ml milk per day and usually purchases every 4 days, the system may target approximately 2 days of remaining stock as the reorder point.

The user should be able to override this.

---

# 14. Confidence

Every prediction should have a confidence level.

Example:

```text
Milk
Runs out in ~2 days
Confidence: High
```

For a newly added item:

```text
Olive oil
Runs out in ~21-35 days
Confidence: Low
```

Confidence can depend on:

- Number of historical purchases
- Consistency of purchase intervals
- Quantity consistency
- Explicit user corrections
- Time since last purchase

This prevents the system from presenting weak predictions as facts.

---

# 15. Handling New Items

The system will frequently encounter an item it has never seen before.

Example:

> Bought 1kg almonds.

There is no consumption history.

The system should store:

```text
Item: Almonds
Quantity: 1kg
Consumption history: None
Prediction: Not enough data
```

After subsequent purchases, it can begin estimating consumption.

The system should not invent a consumption rate just because another household typically consumes almonds at a certain rate.

---

# 16. Recurring Items

Some products have predictable replenishment cycles.

Examples:

```text
Milk        every 4 days
Eggs        every 7 days
Bread       every 4 days
Rice        every 25 days
Toothpaste  every 55 days
Detergent   every 35 days
```

The system can identify these automatically.

Potential UI:

```text
Your recurring items

Milk          ~every 4 days
Eggs          ~every 7 days
Bread         ~every 4 days
Rice          ~every 27 days
```

---

# 17. Shopping List

The main user-facing output should be a dynamic shopping list.

Example:

```text
SHOP THIS WEEK

High priority
☐ Milk
☐ Eggs
☐ Bread

Coming soon
☐ Bananas
☐ Detergent

Not needed yet
☐ Rice
☐ Cooking oil
```

The list should be generated from inventory predictions rather than manually maintained.

---

# 18. Notifications

The product should proactively notify the user.

Example:

> You're likely to run out of milk tomorrow.

Or:

> 4 household items are likely to need replenishment this week.

Clicking the notification opens:

```text
Shopping list

Milk
Eggs
Bread
Bananas
```

Notifications should avoid becoming noisy.

Possible rules:

- Notify only when an item crosses its reorder threshold.
- Do not notify again until the user acts on it.
- Group multiple items into one notification.
- Allow per-item notification settings.

---

# 19. Weekly Summary

A useful recurring experience:

```text
Your household this week

Likely to run out:
• Milk
• Eggs
• Bread

Probably enough for another 2 weeks:
• Rice
• Cooking oil

New items learned:
• Greek yogurt
```

The system can optionally say:

> You usually buy groceries around Saturday. Here is your predicted shopping list.

---

# 20. User Corrections

Predictions will sometimes be wrong.

The user needs very simple correction mechanisms.

Examples:

```text
Milk
Predicted: 0.5L remaining

[ I have more ]
[ I already finished it ]
```

Or:

> “I still have plenty of milk.”

The system updates the inventory estimate.

These corrections are valuable because they provide direct feedback about the model.

---

# 21. Expiry

Expiry should be considered separately from consumption.

Example:

```text
Milk
Estimated consumption: 3 days
Expiry: 5 days

Consumption is the limiting factor.
```

Another example:

```text
Yogurt
Estimated consumption: 10 days
Expiry: 4 days

Likely to expire before normal consumption.
```

V1 can keep expiry optional and manually entered.

Later, expiry dates could come from product/barcode data.

---

# 22. Household vs Individual Inventory

The initial version can support a single household.

Later:

```text
Household
 ├── Alex
 ├── Jennifer
 └── Inventory
```

Multiple users can update the same inventory.

Example:

> Jennifer bought 2L milk.

The household inventory automatically updates.

This requires authentication and shared household permissions.

---

# 23. Product Normalization

Different purchases may refer to the same underlying item.

Examples:

```text
Amul Taaza 1L
Amul milk 1 litre
1L Amul Taaza
milk - Amul - 1L
```

The system should normalize these into a product identity.

Possible structure:

```text
canonical_item:
    milk

brand:
    Amul

variant:
    Taaza

quantity:
    1

unit:
    litre
```

For V1, exact brand/variant matching can be simplified.

The important part is identifying that multiple transactions represent the same household inventory item.

---

# 24. AI Usage

AI should primarily handle natural-language understanding, not core inventory arithmetic.

## Good AI use cases

### Parse purchases

Input:

> Bought 2 packets of bread and 6 eggs.

Output:

```json
[
  {
    "item": "bread",
    "quantity": 2,
    "unit": "packet"
  },
  {
    "item": "egg",
    "quantity": 6,
    "unit": "piece"
  }
]
```

### Understand corrections

Input:

> I still have enough rice, don't remind me about it.

AI converts this into structured preferences/state changes.

### Explain predictions

Input:

> Why are you asking me to buy eggs?

Response:

> You usually buy 12 eggs every 7-8 days. You bought 12 eggs 6 days ago, so the system expects you to be running low.

### Conversational queries

User:

> What do I need to buy today?

System:

> Milk and bread are likely to run out tomorrow. Eggs are probably enough for another 3 days.

---

# 25. What Should NOT Be AI

Do not ask an LLM to calculate inventory every time.

Use deterministic backend logic for:

- Quantity calculations
- Dates
- Consumption averages
- Reorder thresholds
- Depletion estimates
- Confidence calculations
- Inventory transactions

This makes the system cheaper, faster, predictable, and testable.

---

# 26. Potential Tech Stack

A simple implementation is enough.

## Frontend

React + Vite

or

Next.js if server-side functionality is useful.

## Backend

Node.js / TypeScript

or Python/FastAPI.

## Database

PostgreSQL.

Potential tables:

```text
users
households
household_members
items
inventory
purchases
consumption_events
replenishment_predictions
notification_preferences
```

## AI

Use a low-cost/free-tier LLM API for natural-language parsing.

Gemini can be used for early prototyping if its current free-tier limits are sufficient.

The AI should return structured JSON rather than free-form text wherever possible.

---

# 27. Database Design

## users

```text
id
name
email
created_at
```

## households

```text
id
name
created_at
```

## household_members

```text
household_id
user_id
role
```

## items

Canonical household products.

```text
id
household_id
name
category
brand
unit
created_at
```

## inventory

Current estimated state.

```text
id
household_id
item_id
estimated_quantity
unit
status
reorder_threshold
last_purchase_at
estimated_depletion_at
confidence
updated_at
```

## purchases

Immutable transaction history.

```text
id
household_id
item_id
quantity
unit
purchased_at
source
created_at
```

Possible sources:

```text
manual
chat
receipt
email
retailer
```

## consumption_events

Optional explicit consumption.

```text
id
household_id
item_id
quantity
unit
consumed_at
source
```

## prediction_history

Useful for debugging and improving the algorithm.

```text
id
item_id
predicted_depletion_at
actual_next_purchase_at
prediction_generated_at
algorithm_version
```

---

# 28. Inventory Calculation Model

Do not directly mutate inventory without recording the underlying event.

For example:

```text
Purchase +2L milk
```

creates a purchase transaction.

The inventory projection then becomes:

```text
previous estimated inventory
+ purchase
- estimated consumption
= current estimated inventory
```

This provides an audit trail.

If the algorithm changes later, inventory can be recalculated from historical transactions.

---

# 29. Simple Prediction Algorithm

V1 can use:

```text
consumption_rate =
weighted average of historical consumption rates
```

Example:

```text
Purchase quantity: 2L

Historical intervals:

4 days
5 days
4 days
5 days
```

Average:

```text
4.5 days
```

Estimated consumption:

```text
2L / 4.5
≈ 444ml/day
```

Current inventory:

```text
1L
```

Estimated depletion:

```text
1000 / 444
≈ 2.25 days
```

Then:

```text
if depletion <= reorder_window:
    add to shopping list
```

The algorithm can become more sophisticated later.

---

# 30. Handling Irregular Consumption

Not everything is consumed at a consistent rate.

Example:

Ice cream.

The user might buy it:

```text
May 1
May 3
May 20
June 1
June 2
```

A simple average may be misleading.

For these items:

- Lower confidence
- Use broader prediction windows
- Avoid aggressive notifications
- Allow the user to set a manual reorder threshold

---

# 31. Shopping Behavior Learning

The system should learn purchasing preferences separately from consumption.

Example:

The user always buys:

```text
Milk → Amul Taaza 1L
Eggs → 12-pack
Rice → India Gate 5kg
```

Eventually the shopping list can contain:

```text
Milk
Amul Taaza 1L
```

rather than just:

```text
Milk
```

This creates an opportunity for future retailer/product integrations.

---

# 32. Retailer Integration Later

Once the inventory engine works, retailer integrations become an output layer.

Example:

```text
Inventory Engine
       ↓
Shopping List
       ↓
Retailer Adapter
   ┌───┼────┐
Blinkit Zepto Instamart
```

The core system should not depend on any one retailer.

If a retailer integration disappears, inventory prediction should continue working.

---

# 33. Future Shopping Experience

Eventually:

```text
Predicted shopping list
        ↓
Find matching products
        ↓
Compare retailers
        ↓
Show:
  price
  availability
  delivery
  pack size
        ↓
User chooses retailer
        ↓
Open retailer/cart
```

Automatic ordering can remain outside the initial scope.

---

# 34. Optional Fridge/Receipt Features

These should be considered secondary input mechanisms.

## Fridge photo

```text
Photo
  ↓
Vision model
  ↓
Possible items
  ↓
User confirmation
  ↓
Inventory correction
```

Important limitation:

A photo may identify:

> Milk

but not reliably determine:

> 643ml remaining.

Therefore, vision should be treated as an inventory-assistance tool, not the source of truth.

## Receipt photo

Potentially more reliable for purchase information:

```text
Receipt
  ↓
OCR / vision
  ↓
Products + quantities
  ↓
User confirmation
  ↓
Purchase transactions
```

---

# 35. MVP

The first working version should contain only:

### User

- Create account
- Create household

### Inventory

- Add item
- Add purchase
- View inventory
- Manually correct inventory

### AI

- Natural-language purchase entry
- Natural-language inventory questions

### Prediction

- Estimate consumption
- Estimate depletion
- Mark items as running low
- Generate shopping list

### Notifications

- Basic replenishment notification

That is enough to test the central hypothesis.

---

# 36. Example End-to-End Flow

User:

> I bought 2L milk, 12 eggs and 1kg bread.

AI parser:

```text
Milk: +2L
Eggs: +12
Bread: +1kg
```

Database records purchase transactions.

The prediction engine recalculates:

```text
Milk
Consumption: ~450ml/day
Remaining: ~2L
Predicted depletion: ~4.4 days

Eggs
Consumption: ~1.5/day
Remaining: 12
Predicted depletion: ~8 days

Bread
Consumption: ~250g/day
Remaining: 1kg
Predicted depletion: ~4 days
```

Three days later:

```text
Milk → ~1 day remaining
Bread → ~1 day remaining
Eggs → ~5 days remaining
```

Notification:

> You are likely to need milk and bread soon.

Shopping list:

```text
☐ Milk
☐ Bread
```

The user orders them externally.

Once they tell the system:

> Bought 2L milk and 2 loaves of bread.

The cycle starts again.

---

# 37. Success Metrics

The most important metric is not number of AI messages.

Measure whether the system actually reduces mental effort.

Potential metrics:

### Prediction accuracy

How often does an item actually need replenishment around the predicted date?

### Reminder usefulness

Percentage of replenishment reminders that users act on.

### Correction rate

How often do users correct the inventory prediction?

A high correction rate may indicate poor prediction.

### Manual effort

How many inventory updates does the user have to make per week?

The goal should be to reduce this over time.

### Retention

Do users continue using the system after the initial novelty?

### Household coverage

How many recurring household items have enough history to make predictions?

---

# 38. Key Product Risks

## Risk 1: Inventory becomes inaccurate

If predictions are wrong too often, users stop trusting the system.

Mitigation:

- Show confidence
- Allow corrections
- Avoid false precision
- Preserve transaction history

## Risk 2: Too much manual input

If users have to update every consumption event, the product becomes another chore.

Mitigation:

- Infer consumption from purchase history
- Support natural-language updates
- Eventually ingest receipts/order history

## Risk 3: Users don't care until something runs out

The product needs proactive value.

Mitigation:

- Notifications
- Weekly shopping list
- Clear “running low” state

## Risk 4: Too many notifications

Mitigation:

- Group items
- Configurable notification frequency
- Don't repeatedly notify about the same item

## Risk 5: Cold start

The system knows nothing about a new user's consumption.

Mitigation:

- Start with simple reminders
- Learn from the first few purchases
- Use confidence levels
- Don't pretend to know more than it does

---

# 39. Product Philosophy

The product should follow three principles.

### 1. Low effort

The user should not have to maintain a spreadsheet.

### 2. Useful uncertainty

The system should say:

> “Probably running low”

rather than pretending:

> “You have exactly 423ml.”

### 3. Learn silently

Every purchase and correction should improve future predictions without requiring the user to configure a complicated system.

---

# 40. Potential Future Expansion

Once the basic inventory engine works, the same system could expand into:

### Meal planning

> “Plan five dinners using what I already have.”

### Budget awareness

> “My grocery budget is ₹8,000 this month.”

### Waste reduction

> “These three items are likely to expire before you use them.”

### Household routines

> “You usually buy detergent every 35 days.”

### Multi-person households

Family members contribute purchases and corrections.

### Retailer comparison

Match predicted shopping lists to available products across retailers.

### Smart shopping

Suggest pack sizes based on historical consumption.

### Receipt/order ingestion

Automatically update inventory from purchases.

---

# 41. Suggested Development Phases

## Phase 1: Inventory engine

Build:

- PostgreSQL schema
- Purchase transactions
- Inventory projection
- Basic consumption estimation
- Replenishment prediction

No AI required initially.

## Phase 2: AI interface

Add:

- Natural-language purchase entry
- Natural-language queries
- Natural-language corrections

## Phase 3: Notifications

Add:

- Replenishment alerts
- Weekly shopping summary

## Phase 4: Learning

Add:

- Confidence
- Better consumption estimates
- User-specific reorder thresholds
- Recurring purchase detection

## Phase 5: External data

Investigate:

- Email receipt ingestion
- Retailer order history
- Receipt scanning
- Barcode/product databases

## Phase 6: Shopping assistance

Add:

- Product matching
- Price comparison
- Availability
- Delivery estimates
- Links to retailer checkout

Automatic ordering remains optional and outside the core product.

---

# 42. Core MVP Statement

The simplest version of the product can be described as:

> **Tell us what you bought. We'll remember what you usually consume, estimate what's left, and tell you what you're likely to need next.**

The long-term product is not a grocery ordering app.

It is a **household inventory and replenishment layer** that can eventually sit on top of grocery retailers.

