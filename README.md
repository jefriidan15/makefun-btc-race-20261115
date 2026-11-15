# makefun-btc-race-20261115

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/jefriidan15/makefun-btc-race-20261115/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/jefriidan15/makefun-btc-race-20261115/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

Meridian Dip-Catcher — a long-only BTC trading bot for the [make.fun BTC race](https://make.fun/bounty/btc-race-24h-20261115-0828) (bars-replay/v1, CBBTC/USDC, 1-minute bars).

## Strategy

BTC's 1-minute tape grinds and only pays on sharp V-shaped bounces. A round trip
costs ~26–42 bps in fee + slippage + pool impact, so the bot sits in cash almost
all day and only fires when a sell-off is exhausted:

- **Entry (momentum exhaustion):** close ≥ 1.1% below EMA(48), RSI(14) ≤ 30, and
  the 60-bar return under −1% — a fast, deep, oversold drop, not a slow drift.
- **Volatility regime:** ATR(14)/price must sit inside [0.05%, 0.40%]. Too flat to
  pay the round trip below the band; panic chop above it.
- **ATR-based sizing:** $400 × clamp(0.20% / ATR%, 0.5, 1.0). Calm tape gets the
  full stake, wild tape half. Small stakes matter: at this pool's depth a $1,000
  fill pays ~15 bps of impact a side, a $400 fill ~6 bps.
- **Exits (whole position):** +4% take-profit, −1.5% stop, a 0.8% trailing stop
  that arms once the trade is +1% in profit, or 300 bars max hold.
- **Hard drawdown brake:** no new entries while equity is more than 3% below its
  peak. 60-bar cooldown after any exit.

Everything is float64 on `+ - * /` alone — no clock, no randomness, no
environment — so two runs over the same bars answer byte for byte alike.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout via
`vendor/makefun-bars.ts` (a byte-identical copy of the kit's SDK shim).

## Local dev grade

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Dev window (24h, 1,440 bars): **net PnL +7.35 USDC, 4 trades, max drawdown
1.35%** — passes the dev gate (PnL > 0).

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
