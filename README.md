# SHIMI - Kalshi Kelly Criterion Betting Engine

An automated Kalshi trading system that uses the Kelly Criterion to find mathematically optimal bets. Start with $10 and let math do the work.

## Features

### Kelly Criterion Strategy
The [Kelly Criterion](https://en.wikipedia.org/wiki/Kelly_criterion) is a formula that determines the optimal bet size to maximize long-term growth:

```
f* = (bp - q) / b

where:
  f* = fraction of bankroll to bet
  b  = odds (profit per $1 wagered)
  p  = probability of winning
  q  = probability of losing (1 - p)
```

Shimi uses **fractional Kelly (25%)** to reduce variance while maintaining positive expected value.

### Automated Trading
- **Connect your Kalshi account** with API keys for real trading
- **Auto-bet mode**: Automatically places the best bet every 5 minutes
- **One-click betting**: Place Kelly-optimized bets instantly
- **Simulated mode**: Test strategies without risking real money

### Smart Filtering
- **Time-based filtering**: Focus on bets closing within X days (default: 3 days)
- **Minimum probability**: Only bet when win chance exceeds threshold (default: 60%)
- **Minimum edge**: Only bet when mathematical edge exceeds threshold (default: 5%)
- **Real-time updates**: Data refreshes every 15 seconds

### Views
- **Optimal Bets**: Top Kelly Criterion picks sorted by edge
- **Quick Picks**: Curated categories (Kelly Picks, Closing Soon, Safe-ish, Value Plays)
- **All Markets**: Full market browser with advanced filtering

## Quick Start

### Prerequisites
- Node.js 18+
- npm
- Kalshi account (optional, for real trading)

### Installation

```bash
# Install dependencies
npm run install:all
```

### Running Locally

```bash
# Start both server and client
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000)

## Deploy to Cloud (Access from Phone)

### Option 1: Render.com (Recommended - Free)

1. Fork/push this repo to your GitHub
2. Go to [render.com](https://render.com) and sign up with GitHub
3. Click **"New +"** → **"Web Service"**
4. Connect your Shimi repository
5. Render auto-detects settings from `render.yaml`
6. Click **"Create Web Service"**
7. Wait ~3 minutes for build
8. Access your app at `https://shimi-xxxx.onrender.com`

### Option 2: Railway.app (Free Credits)

1. Go to [railway.app](https://railway.app)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your Shimi repository
4. Railway auto-deploys using `railway.json`
5. Click **"Generate Domain"** to get your URL

### After Deploying

Your Shimi app will be live at a URL like:
- **Render**: `https://shimi-xxxx.onrender.com`
- **Railway**: `https://shimi-xxxx.up.railway.app`

Open this URL on your phone and start betting!

## Configuration

### Connecting Your Kalshi Account

1. Go to [kalshi.com/account/api-keys](https://kalshi.com/account/api-keys)
2. Create a new API key
3. Save your **Key ID** and **Private Key** (RSA format)
4. Click "Connect Kalshi Account" in Shimi
5. Enter your credentials

### Betting Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Max Time (days) | 3 | Only show bets closing within this timeframe |
| Min Win % | 60 | Minimum probability to consider a bet |
| Min Edge % | 5 | Minimum mathematical edge required |
| Max Bet % | 25 | Maximum % of bankroll per bet (Kelly fraction) |

## API Endpoints

### Trading

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/configure` | POST | Configure Kalshi API credentials |
| `/api/auth/status` | GET | Check authentication status |
| `/api/portfolio` | GET | Get balance, positions, bet history |
| `/api/settings` | GET/POST | Get/update betting settings |
| `/api/bet` | POST | Place a bet |
| `/api/auto-bet` | POST | Place the best available bet |
| `/api/auto-bet/toggle` | POST | Enable/disable continuous auto-betting |
| `/api/optimal-bets` | GET | Get top Kelly Criterion opportunities |

### Market Data

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/markets` | GET | Get all markets with filtering |
| `/api/quick-bets` | GET | Get curated bet categories |
| `/api/health` | GET | Server health check |

## How It Works

### Edge Calculation

For each market, Shimi calculates:

1. **Implied Probability**: From current ask price (e.g., $0.70 = 70% implied probability)
2. **Odds**: Profit potential = (1 - price) / price
3. **Kelly Bet**: Optimal bet size using the Kelly formula
4. **Edge**: Expected return = p(1 + b) - 1

Example:
- Ask price: $0.75 (75% implied probability)
- Odds: 0.25 / 0.75 = 0.333 (33% profit if you win)
- If true probability is 80%, edge = 0.80 * 1.333 - 1 = 6.7%

### Bet Selection

Shimi filters for opportunities that meet ALL criteria:
- Closing within your max time setting
- Win probability >= your minimum
- Mathematical edge >= your minimum
- Kelly recommends a bet >= minimum bet size

Then ranks by edge (highest first) to find the best mathematical opportunities.

## Security Notes

- API credentials are stored in server memory only (not persisted)
- Private keys are never logged or transmitted elsewhere
- Use a dedicated API key with limited permissions
- Consider setting deposit/withdrawal limits on Kalshi

## Disclaimer

This software is for educational and entertainment purposes. Prediction market trading involves risk. The Kelly Criterion assumes you know the true probabilities, which you don't - you're estimating based on market prices.

**Gamble responsibly. Never bet more than you can afford to lose.**

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React, Vite
- **API**: Kalshi REST API with RSA-PSS authentication

## License

MIT

## Sources

- [Kalshi API Documentation](https://docs.kalshi.com)
- [Kalshi API Keys Guide](https://docs.kalshi.com/getting_started/api_keys)
- [Create Order API](https://docs.kalshi.com/api-reference/orders/create-order)
