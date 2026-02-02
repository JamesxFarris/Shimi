```
     _____ __    _           _
    / ___// /_  (_)___ ___  (_)
    \__ \/ __ \/ / __ `__ \/ /
   ___/ / / / / / / / / / / /
  /____/_/ /_/_/_/ /_/ /_/_/

  //SHIMI — Neural Trading System
```

# //Shimi

An automated crypto prediction market bot for [Kalshi](https://kalshi.com). It watches real-time price movements and places bets when the math says you have an edge.

---

## What It Does

Shimi monitors 15-minute crypto markets (BTC, ETH, SOL) and automatically detects betting opportunities by analyzing:

- **Price momentum** — Is the price moving consistently in one direction?
- **Position relative to strike** — How far is current price from the target?
- **Market mispricing** — Is Kalshi's price lower than the true probability?

When all signals align, it places a bet. When they don't, it waits.

---

## Features

- **Auto-Betting** — Set it and forget it. Runs 24/7 on the cloud.
- **Momentum Detection** — Tracks price movement across multiple timeframes
- **Smart Filtering** — Only bets when there's a real mathematical edge
- **Risk Controls** — Configurable limits per bet, per token, and total exposure
- **Live Dashboard** — Cyberpunk UI showing opportunities in real-time
- **Performance Tracking** — See your win rate, P&L, and model accuracy

---

## The Algorithm

Shimi uses a **momentum-following strategy** combined with **edge-based filtering**.

**Step 1: Watch prices**
Track BTC, ETH, and SOL prices every 10 seconds.

**Step 2: Detect momentum**
If price is moving consistently up (or down) across 1, 2, and 3 minute windows — that's a signal.

**Step 3: Check the market**
Compare our calculated win probability against Kalshi's current price. The difference is our "edge."

**Step 4: Bet or wait**
If edge > 3% and momentum is aligned — place the bet. Otherwise, wait for a better opportunity.

---

## Quick Start

### Prerequisites
- Node.js 18+
- Kalshi account with API keys

### Run Locally

```bash
# Install everything
npm run install:all

# Start the app
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## Connect Kalshi

1. Go to [kalshi.com/account/api-keys](https://kalshi.com/account/api-keys)
2. Create a new API key
3. Save your **Key ID** and **Private Key**
4. Click "Connect Kalshi" in Shimi and enter your credentials

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Max per Bet | $8 | Maximum dollars per single bet |
| Max Exposure | $35 | Maximum total dollars at risk |
| Max per Token | $15 | Maximum exposure per crypto (BTC/ETH/SOL) |
| Min Edge | 3% | Minimum edge required to place a bet |

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** React + Vite
- **Data:** CoinGecko (prices) + Kalshi API (markets)
- **Auth:** RSA-PSS signatures for Kalshi API

---

## Disclaimer

This is experimental software for educational purposes. Prediction markets involve real money and real risk. The algorithm estimates probabilities — it doesn't guarantee wins.

**Only bet what you can afford to lose.**

---

## License

MIT

---

<p align="center">
  <code>//SHIMI</code> — Built for degens who appreciate good math.
</p>
