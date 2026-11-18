// BTC trend rider for the make.fun bars-replay race (agent-fun/bars-replay/v1).
//
// One asset, CBBTC, long only, on 1-minute bars. The bot speaks the protocol
// through the vendored shim: hello once, then one batch per bar, then done.
// Every batch carries the bar that just closed plus the fills of the orders
// the previous batch decided; orders decided on a bar fill at the next bar's
// open, so every decision is made on closes only and pays the next open.
//
// Strategy (original design, written for this race):
//   - Regime filter: three EMAs of the closes (12 / 48 / 144 bars). An entry
//     needs them stacked upward (fast above mid above long) with the close
//     above the fast one, so the bot only buys into an established uptrend
//     and sits in cash through downtrends.
//   - Breakout trigger: the close must be the highest close of the last 24
//     bars, so entries happen on fresh strength, not in the middle of a
//     drift.
//   - Momentum confirmation: Wilder's RSI(14) between 52 and 78 — positive
//     momentum, but not a parabolic spike — and the close no more than 2%
//     above the mid EMA, so the bot does not chase an extended move.
//   - Volatility-scaled sizing: the stake is the whole equity in calm
//     markets and scales down as the 60-bar ATR rises, so a wild hour
//     cannot put the full account on one trade.
//   - Exits: a 1% hard stop under the entry cost, a 0.7% trailing stop
//     under the highest close since entry once the trade is 0.7% in
//     profit, a trend exit when the fast EMA crosses back under the mid
//     EMA, and a momentum exit when RSI falls under 42. After an exit the
//     bot waits 30 bars before it may enter again, so a whipsaw does not
//     flip it straight back in.
//   - No entries before 120 bars of history, so the indicators are real
//     numbers before the first order is ever decided.
//
// Determinism: float64 arithmetic on + - * / alone, no clock, no network,
// no environment reads, no randomness at all, so two runs on the same bars
// produce the same orders byte for byte.

import { runBars, type Bar, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Indicator spans, in bars.
const FAST_SPAN = 12;
const MID_SPAN = 48;
const LONG_SPAN = 144;
const RSI_SPAN = 14;
const ATR_SPAN = 60;
const BREAKOUT_BARS = 24;

// Entry gates.
const MIN_BARS_BEFORE_ENTRY = 120;
const COOLDOWN_BARS = 30;
const RSI_ENTER_LOW = 52;
const RSI_ENTER_HIGH = 78;
const MAX_EXTENSION = 1.02;

// Exits.
const RSI_EXIT = 42;
const HARD_STOP = 0.99;
const TRAIL_ARM = 1.007;
const TRAIL = 0.993;

// Sizing: stake fraction = clamp(45 / atrBps, 0.4, 1.0).
const SIZE_NUMERATOR_BPS = 45;
const SIZE_MIN_FRACTION = 0.4;

const BUY_SLIPPAGE_BPS = 100;
const SELL_SLIPPAGE_BPS = 250;

/** One exponential moving average, seeded with the first close it sees. */
class Ema {
  value: number | null = null;
  constructor(private readonly span: number) {}
  push(close: number): void {
    if (this.value === null) {
      this.value = close;
      return;
    }
    this.value += (2 / (this.span + 1)) * (close - this.value);
  }
}

/** Wilder's RSI: the first average is the mean of the first span of changes, then smoothed. */
class Rsi {
  private gains: number[] = [];
  private losses: number[] = [];
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private prev: number | null = null;
  value: number | null = null;
  constructor(private readonly span: number) {}
  push(close: number): void {
    if (this.prev === null) {
      this.prev = close;
      return;
    }
    const change = close - this.prev;
    this.prev = close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (this.avgGain === null || this.avgLoss === null) {
      this.gains.push(gain);
      this.losses.push(loss);
      if (this.gains.length === this.span) {
        this.avgGain = this.gains.reduce((a, x) => a + x, 0) / this.span;
        this.avgLoss = this.losses.reduce((a, x) => a + x, 0) / this.span;
        this.gains = [];
        this.losses = [];
        this.update();
      }
      return;
    }
    this.avgGain = (this.avgGain * (this.span - 1) + gain) / this.span;
    this.avgLoss = (this.avgLoss * (this.span - 1) + loss) / this.span;
    this.update();
  }
  private update(): void {
    const g = this.avgGain as number;
    const l = this.avgLoss as number;
    this.value = g + l === 0 ? 50 : (100 * g) / (g + l);
  }
}

/** Wilder's average true range over the bars' high, low and previous close. */
class Atr {
  private ranges: number[] = [];
  private avg: number | null = null;
  private prevClose: number | null = null;
  value: number | null = null;
  constructor(private readonly span: number) {}
  push(high: number, low: number, close: number): void {
    let tr = high - low;
    if (this.prevClose !== null) {
      tr = Math.max(tr, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose));
    }
    this.prevClose = close;
    if (this.avg === null) {
      this.ranges.push(tr);
      if (this.ranges.length === this.span) {
        this.avg = this.ranges.reduce((a, x) => a + x, 0) / this.span;
        this.ranges = [];
        this.value = this.avg;
      }
      return;
    }
    this.avg = (this.avg * (this.span - 1) + tr) / this.span;
    this.value = this.avg;
  }
}

const fast = new Ema(FAST_SPAN);
const mid = new Ema(MID_SPAN);
const long = new Ema(LONG_SPAN);
const rsi = new Rsi(RSI_SPAN);
const atr = new Atr(ATR_SPAN);

/** The last BREAKOUT_BARS closes, oldest first, for the breakout check. */
const recentCloses: number[] = [];
let barsSeen = 0;
let priceScale = 5;
/** Highest close since the current position opened (0 while flat). */
let peakClose = 0;
/** Seq of the batch where the last exit was decided (-1e9 before any exit). */
let lastExitSeq = -1_000_000_000;

function toDollars(raw: string): number {
  return Number(raw) / 10 ** priceScale;
}

/** The position's average cost per unit, in dollars, from the account's own books. */
function entryPrice(state: BarsState, held: { qty: bigint; cost: bigint }): number {
  const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL);
  if (sym === undefined || held.qty === 0n) return 0;
  const scale = BigInt(sym.qty_scale + sym.price_scale - state.hello.capital.quote_scale);
  const raw = (held.cost * 10n ** scale) / held.qty;
  return Number(raw) / 10 ** sym.price_scale;
}

function indicatorsReady(): boolean {
  return (
    fast.value !== null &&
    mid.value !== null &&
    long.value !== null &&
    rsi.value !== null &&
    atr.value !== null &&
    barsSeen >= MIN_BARS_BEFORE_ENTRY
  );
}

function breakoutHigh(close: number): boolean {
  for (const c of recentCloses) if (close < c) return false;
  return true;
}

await runBars({
  onHello(state) {
    const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL);
    if (sym !== undefined) priceScale = sym.price_scale;
  },

  onBatch(state, batch) {
    let close: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = toDollars(bar.c);
      fast.push(c);
      mid.push(c);
      long.push(c);
      rsi.push(c);
      atr.push(toDollars(bar.h), toDollars(bar.l), c);
      recentCloses.push(c);
      if (recentCloses.length > BREAKOUT_BARS) recentCloses.shift();
      barsSeen++;
      close = c;
    }
    if (close === null) return [];
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held !== undefined && held.qty > 0n) {
      // Holding: track the peak close and check every exit.
      if (peakClose === 0 || close > peakClose) peakClose = close;
      const cost = entryPrice(state, held);
      const trendDown = fast.value !== null && mid.value !== null && fast.value < mid.value;
      const momentumGone = rsi.value !== null && rsi.value < RSI_EXIT;
      const stop = peakClose >= cost * TRAIL_ARM ? peakClose * TRAIL : cost * HARD_STOP;
      const stoppedOut = close <= stop;
      if (trendDown || momentumGone || stoppedOut) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS };
        orders.push(sell);
        lastExitSeq = state.seq;
        peakClose = 0;
      }
      return orders;
    }

    // Flat: reset the peak and look for an entry.
    peakClose = 0;
    if (!indicatorsReady()) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const f = fast.value as number;
    const m = mid.value as number;
    const l = long.value as number;
    const r = rsi.value as number;
    const a = atr.value as number;
    const stacked = f > m && m > l;
    const aboveFast = close > f;
    const notExtended = close <= m * MAX_EXTENSION;
    const momentumOk = r >= RSI_ENTER_LOW && r <= RSI_ENTER_HIGH;
    if (!stacked || !aboveFast || !notExtended || !momentumOk) return [];
    if (!breakoutHigh(close)) return [];

    // Volatility-scaled stake: full equity in calm markets, down to 40%.
    const atrBps = (a / close) * 10_000;
    let fraction = atrBps > 0 ? SIZE_NUMERATOR_BPS / atrBps : 1;
    if (fraction > 1) fraction = 1;
    if (fraction < SIZE_MIN_FRACTION) fraction = SIZE_MIN_FRACTION;
    const room = state.weightRoom(SYMBOL);
    const affordable = state.cash < room ? state.cash : room;
    const notional = (affordable * BigInt(Math.floor(fraction * 1_000_000))) / 1_000_000n;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    };
    orders.push(buy);
    return orders;
  },
});
