// Meridian Dip-Catcher: a long-only BTC bot for make.fun bars-replay/v1.
//
// Idea: BTC's 1-minute tape spends most of its time grinding in one direction and
// only pays on sharp V-shaped bounces. Chasing every wiggle pays ~26-42 bps a round
// trip in fee + slippage + pool impact, so this bot sits in cash almost all day and
// only fires when a sell-off is exhausted, then lets the bounce run under a trailing
// stop instead of snatching a few ticks.
//
//   - Momentum exhaustion (entry): the close sits at least 1.1% below EMA(48), RSI(14)
//     is at or under 30, and the 60-bar return is under -1%: a fast, deep, oversold
//     drop, not a slow drift. The signal must hold on the bar it fires on.
//   - Confirmation (entry): the signal bar must close ABOVE the previous bar's
//     close. A dip that is still falling bar after bar keeps falling: the first
//     trade of the dev window fired on RSI 7 with the tape still sliding and
//     never bounced at all (peak after entry +0.02%), dying on the stop for
//     -7.76 USDC. Waiting for one green close skips that knife-catch and keeps
//     only the bounce that actually turned. It costs at most one bar of the move.
//   - Volatility regime (entry): ATR(14) / price must sit inside [0.05%, 0.40%]. Below
//     the band the tape is too flat to pay the round trip; above it the tape is in
//     panic chop where dip-buys keep catching falling knives.
//   - ATR-based sizing: notional = $400 * clamp(0.20% / ATR%, 0.5, 1.0), capped by
//     cash and the weight cap. Calm tape gets the full stake; wild tape gets half.
//     Small stakes matter: at this pool's depth a $1,000 fill pays ~15 bps of impact
//     a side, a $400 fill ~6 bps.
//   - Exits, whole position: +4% take-profit, -1.5% stop, a 0.8% trailing stop that
//     arms once the trade is +1% in profit, or 300 bars max hold. No exit on a fast
//     EMA wiggle: the bounce is the trade, cutting it at the first EMA touch throws
//     the edge away.
//   - Hard drawdown brake: while equity is more than 3% below its peak, no new
//     entries. After any exit, a 60-bar cooldown before the next entry.
//
// Everything is float64 on + - * / alone, no clock, no randomness, no environment,
// so two runs over the same bars answer byte for byte alike. Warm-up batches only
// seed the indicators; no order is ever sent on one.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts` with
// this directory mounted at /bot; vendor/makefun-bars.ts is a byte-identical copy of
// the kit's sdk/makefun-bars.ts.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
const ATR_SPAN = 14;
const RSI_SPAN = 14;
const RETURN_BARS = 60;
/** Entry: close at least this far below EMA(48). */
const DIP = 0.011;
/** Entry: RSI(14) at or under this. */
const RSI_MAX = 30;
/** Entry: 60-bar return under this (a fast drop, not a drift). */
const DROP = -0.01;
/** Volatility regime: ATR(14) / price inside this band. */
const ATR_LO = 0.0005;
const ATR_HI = 0.004;
/** Base stake in USDC; scaled by the ATR sizing rule. */
const BASE_STAKE_USDC = 400;
/** ATR% the full stake is sized at; above it the stake shrinks toward half. */
const ATR_FULL = 0.002;
/** Exits, as fractions of the entry fill price. */
const TAKE_PROFIT = 0.04;
const STOP_LOSS = 0.015;
const TRAIL_ARM = 0.01;
const TRAIL_GIVEBACK = 0.008;
/** Max bars to hold one position; bars of cooldown after an exit. */
const MAX_HOLD_BARS = 300;
const COOLDOWN_BARS = 60;
/** Drawdown brake: halt entries while equity is this far below its peak. */
const BRAKE_NUM = 97n;
const BRAKE_DEN = 100n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema { span: number; warm: number[]; value: number | null; }

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
/** Closes in the order received (raw price-scale units), for the 60-bar return. */
const closes: number[] = [];
/** One-bar true ranges, oldest first, capped at ATR_SPAN. */
const trueRanges: number[] = [];
/** One-bar gains and losses, oldest first, capped at RSI_SPAN. */
const gains: number[] = [];
const losses: number[] = [];
let prevClose: number | null = null;
/** Peak equity seen (quote units), for the drawdown brake. */
let peakEquity: bigint | null = null;
/** Seq of the last exit; -1e9 until the first. */
let lastExitSeq = -1e9;
/** The open position's entry fill price (raw units), peak close since entry, entry seq. */
let entryPrice: number | null = null;
let peakSinceEntry = 0;
let heldSinceSeq = 0;
/** Fallback entry price if a buy's fill line is ever missed: the decision close. */
let decisionClose = 0;

function atr(): number | null {
  if (trueRanges.length < ATR_SPAN) return null;
  return trueRanges.reduce((a, x) => a + x, 0) / ATR_SPAN;
}

function rsi(): number | null {
  if (gains.length < RSI_SPAN) return null;
  const avgGain = gains.reduce((a, x) => a + x, 0) / RSI_SPAN;
  const avgLoss = losses.reduce((a, x) => a + x, 0) / RSI_SPAN;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pushBar(bar: Bar): void {
  const c = Number(bar.c);
  const h = Number(bar.h);
  const l = Number(bar.l);
  stepEma(fast, c);
  stepEma(slow, c);
  closes.push(c);
  if (prevClose !== null) {
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trueRanges.push(tr);
    if (trueRanges.length > ATR_SPAN) trueRanges.shift();
    const d = c - prevClose;
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
    if (gains.length > RSI_SPAN) gains.shift();
    if (losses.length > RSI_SPAN) losses.shift();
  }
  prevClose = c;
}

await runBars({
  onBatch(state, batch) {
    // Learn our entry fill price from the fills this batch carries, before deciding.
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entryPrice = Number(fill.price);
        peakSinceEntry = entryPrice;
      }
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushBar(bar);
    }
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const held = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);

    // --- exits: whole position, sells first ---
    if (held !== undefined) {
      const entry = entryPrice !== null ? entryPrice : decisionClose;
      if (entry > 0) {
        if (c > peakSinceEntry) peakSinceEntry = c;
        const up = peakSinceEntry >= entry * (1 + TRAIL_ARM) && c <= peakSinceEntry * (1 - TRAIL_GIVEBACK);
        const tp = c >= entry * (1 + TAKE_PROFIT);
        const sl = c <= entry * (1 - STOP_LOSS);
        const stale = state.seq - heldSinceSeq >= MAX_HOLD_BARS;
        if (up || tp || sl || stale) {
          lastExitSeq = state.seq;
          entryPrice = null;
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [sell];
        }
      }
      return [];
    }

    // --- entries: all filters must hold on this bar ---
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (peakEquity !== null && state.equity * BRAKE_DEN < peakEquity * BRAKE_NUM) return [];
    if (slow.value === null) return [];
    const a = atr();
    const r = rsi();
    if (a === null || r === null) return [];
    const atrPct = a / c;
    if (atrPct < ATR_LO || atrPct > ATR_HI) return [];
    if ((slow.value - c) / slow.value < DIP) return [];
    if (r > RSI_MAX) return [];
    if (closes.length > RETURN_BARS && c >= closes[closes.length - 1 - RETURN_BARS] * (1 + DROP)) return [];
    // Confirmation: the dip must have paused — this bar closes above the
    // previous bar's close. closes[] already holds this bar (pushBar ran above),
    // so the previous close is the second-to-last entry.
    if (closes.length < 2 || c <= closes[closes.length - 2]) return [];

    // ATR-based sizing: full $400 stake at ATR_FULL, half when twice as wild.
    const scale = Math.max(0.5, Math.min(1.0, ATR_FULL / atrPct));
    let notional = BigInt(Math.floor(BASE_STAKE_USDC * scale * 1_000_000));
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    if (notional > byWeight) notional = byWeight;
    if (notional > state.cash) notional = state.cash;
    if (notional === 0n || notional < BigInt(fees.min_notional_quote_units)) return [];
    decisionClose = c;
    heldSinceSeq = state.seq;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
