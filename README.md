```
     _____ __    _           _
    / ___// /_  (_)___ ___  (_)
    \__ \/ __ \/ / __ `__ \/ /
   ___/ / / / / / / / / / / /
  /____/_/ /_/_/_/ /_/ /_/_/

```

# Shimi

An automated crypto betting bot for [Kalshi](https://kalshi.com) 15-minute prediction markets. Shimi monitors BTC, ETH, and SOL price movements, estimates win probabilities using empirical data and machine learning, and places bets when it finds a statistical edge after accounting for fees, spread, and slippage.

---

## How It Works

Kalshi offers 15-minute crypto markets — "Will BTC be above $X at time Y?" Shimi watches these markets continuously and looks for situations where the price has moved far enough from the strike that the outcome is statistically predictable, but the orderbook hasn't fully priced it in yet.

### The Model

Shimi uses a **three-layer prediction system**:

#### 1. Empirical Win Rate Tables

The foundation. Trained on 2,400+ historical market settlements, these tables map distance-from-strike to win probability for the favored side:

| Distance from Strike | Win Rate | What It Means |
|---------------------|----------|---------------|
| 0.1% | 62% | Barely moved — slight edge |
| 0.2% | 68% | Small move — moderate edge |
| 0.3% | 73% | Decent move — good edge |
| 0.5% | 78% | Solid move — strong edge |
| 0.75% | 82% | Big move — very strong |
| 1.0% | 86% | Large move — near certain |
| 1.5%+ | 89-95% | Massive move — max confidence |

These caps are intentionally conservative. Raw historical rates are 99%+, but those measure settlement-time distance. At betting time, prices can still reverse — the caps account for that uncertainty.

#### 2. ML Model (Logistic Regression)

A 19-feature model layered on top of the empirical tables. Features include:

- Distance from strike and time remaining
- Price momentum (1min, 3min, 5min windows)
- Current volatility regime
- Token-specific patterns (BTC vs ETH vs SOL)
- Time-of-day effects

The ML model blends with empirical estimates at up to 30% weight, scaled by its accuracy. Safety guards keep it inactive until it has 200+ training samples and 55%+ accuracy — if it can't beat a coin flip, it stays off.

Retrain anytime via **Settings > Model Monitoring > Retrain Model**.

#### 3. Volatility Regime Adjustment

Real-time volatility is compared against historical averages:

- **Low vol** — prices are predictable, small confidence boost
- **Normal** — standard conditions, no adjustment
- **High vol** — prices are erratic, confidence reduced
- **Spike** (2%+ move in 5 min) — bot sits out entirely

### Edge Calculation

```
Gross Edge  = Empirical Win Rate - Market Implied Probability
Net Edge    = Gross Edge - Fees - Spread - Slippage
```

Every cost is converted to the same units (percentage of market price) before subtraction:

- **Fees**: Kalshi charges `ceil(0.07 * contracts * price * (1 - price))`, capped at 2c/contract
- **Spread**: Half the bid-ask spread, converted to percentage
- **Slippage**: Fill buffer (default 3c above ask), converted to percentage

The bot only bets when **net edge exceeds 3%** after all costs.

### Signal Strength

Each opportunity gets a 0-100 signal strength score combining net edge, win rate, and distance. Must pass all filters to trigger a bet:

- **Distance**: 0.1-5% from strike (too close = coin flip, too far = no liquidity)
- **Time**: 2-10 minutes remaining (enough to enter, not too early)
- **Volatility**: No betting during spike regimes
- **Exposure**: Per-token and total portfolio caps

### Bet Sizing

Conservative fractional Kelly criterion: `f = edge / odds`, scaled down and capped by risk limits. The bot never risks more than configured maximums regardless of edge.

---

## Dashboard

**Dashboard** — Live scanner showing opportunities, signal strength, edge, risk exposure, and auto-bet controls. Place bets with one click or enable auto-betting.

**History** — Full trade log with P/L, win rate, and ROI. Every bet tracks entry price, contracts, outcome, and payout.

**Settings** — Risk limits, selectivity thresholds, take-profit/stop-loss, model monitoring, and retraining.

---

## Position Management

Open positions are monitored every 15 seconds. The bot can exit early based on:

- **Stop-loss** — exit if position drops below threshold (off by default)
- **Easy profit** — lock in gains above target
- **Momentum reversal** — exit if price flips against you
- **Time-critical** — exit near expiry with unfavorable movement
- **EV comparison** — exit when selling EV exceeds holding EV
- **Coin-flip prevention** — exit if position drifts to 50/50

---

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL
- Kalshi account with API access

### Install

```bash
git clone https://github.com/JamesxFarris/Shimi.git
cd Shimi

cd server && npm install
cd ../client && npm install
```

### Configure

Create `server/.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/shimi
JWT_SECRET=your-secret-key
PORT=3001
```

Database tables are created automatically on first run.

### Run

```bash
# Terminal 1 - server
cd server && npm run dev

# Terminal 2 - client
cd client && npm run dev
```

- Server: `http://localhost:3001`
- Client: `http://localhost:3000`

### Connect Kalshi

1. Go to [kalshi.com/account/api](https://kalshi.com/account/api)
2. Create a new API key
3. Open Shimi > **Settings** > enter your Key ID and Private Key
4. The bot switches from simulation mode to live trading

---

## Configuration

All adjustable from the Settings tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Max per bet | $5.00 | Maximum single bet size |
| Max per token | $3.00 | Max exposure to BTC, ETH, or SOL |
| Max total exposure | $10.00 | Total portfolio risk cap |
| Min edge after fees | 3% | Minimum net edge to place a bet |
| Min signal strength | 60 | Score threshold (0-100) |
| Min win rate | 62% | Empirical probability floor |
| Max bets per hour | 6 | Rate limiting |
| Fill slippage | 3c | Limit price buffer above ask |

---

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React, Vite
- **Database**: PostgreSQL (user accounts, persistent state)
- **Price Data**: CoinGecko API
- **Markets**: Kalshi API v2 (RSA-PSS signed requests)
- **Auth**: JWT tokens, bcrypt password hashing

---

## Architecture

```
server/
  index.js              API + betting engine + model (~10k lines)
  learned_params.json   Empirical tables (2,400 settlements)
  ml_model.json         Trained logistic regression weights

client/
  src/App.jsx           React dashboard
  vite.config.js        Dev server + API proxy
```

The server runs the auto-bet scan loop every 10 seconds, evaluating all active 15-minute markets. The client polls for opportunities, portfolio state, and scan status.

---

## Disclaimer

This is experimental software. Prediction markets involve real money and real risk. The model estimates probabilities — it does not guarantee wins. Past performance of the empirical tables does not guarantee future results.

**Only bet what you can afford to lose.**

---

## License

Private repository. Not for redistribution.
