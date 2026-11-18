# btc-race-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/dikrimuhammad291-ship-it/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/dikrimuhammad291-ship-it/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours"
bounty. It trades Coinbase Wrapped BTC (CBBTC) against USDC on 1-minute bars,
long only, starting from 1,000 USDC of paper money.

Strategy: a regime-filtered trend rider. It buys only when three EMAs
(12 / 48 / 144 bars) stack upward, the close prints a fresh 24-bar high, and
RSI(14) shows positive but not overheated momentum. Position size scales down
as 60-bar ATR volatility rises. Exits come from a 1% hard stop, a 0.7%
trailing stop under the highest close since entry, a fast-EMA trend flip, or
RSI falling under 42, with a 30-bar cooldown after every exit. Fully
deterministic: no clock, no network, no randomness.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout: the harness sends
`hello`, one `batch` per 1-minute bar, then `done`, and the bot answers each
batch with exactly one reply carrying its orders. Node 22 or later, standard
library only, no install step.

## Grade it locally

From the unpacked competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path to this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=hkq9vbrs&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
