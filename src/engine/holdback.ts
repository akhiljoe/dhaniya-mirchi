// What is in the house explains the flag (design §9.6, §9.7).
//
// The "running low" list is scored on the household's buying rhythm: when do
// they usually buy this again (due.ts)? That question ignores what is in the
// kitchen, and the card sat beside it saying "About 972 ml left" while the
// list said buy milk. The household that bought three packets yesterday is
// right to find that odd.
//
// The first attempt at this let the stock LOWER the flag: a day's worth in the
// house turned "buy soon" into "coming up". Measured on 91 days of the
// household's own history (spike/db/backtest.ts) it was clearly worse -
// recall fell from 58% to 45% and precision did not improve, at every
// threshold from one day to seven. Households buy before they run out, so the
// flags it suppressed were mostly right. Being reminded early is cheap;
// running out is not (design §9.4).
//
// So the stock changes nothing about the flag. It only says why the flag can
// stand while there is still something in the fridge: enough for today, and
// low tomorrow. The engine's job here is the test, not the sentence.
import { STOCK_ENOUGH_FOR_TODAY_DAYS } from './constants';

// What the rule needs from the stock estimate: the pessimistic end of "days
// left", or null when the pack size or the rate is unknown.
export interface StockLeft {
  daysRemainingLow: number | null;
}

// True when what is in the house covers today, on the pessimistic end of the
// range (design §9.4: less confidence widens it, and this stops being true).
// Unknown quantity is never read as "there is some": null answers false.
export function stockCoversToday(stock: StockLeft, days: number = STOCK_ENOUGH_FOR_TODAY_DAYS): boolean {
  return stock.daysRemainingLow !== null && stock.daysRemainingLow >= days;
}
