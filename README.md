# SHIMI - Kalshi Betting Optimizer

A real-time Kalshi prediction market analyzer that finds high-probability bets with the best potential payouts. Built for degenerates who want action.

## Features

- **Real-time Market Data**: Auto-refreshes every 15 seconds from Kalshi API
- **Degen Score**: Custom algorithm combining win probability and profit potential
- **Quick Picks**: Curated categories for fast decision-making:
  - Safe-ish Bets (75%+ win chance)
  - Value Plays (good risk/reward ratio)
  - Closing Soon (expiring within 24 hours)
  - Moonshots (highest profit potential)
- **Advanced Filtering**: Sort by probability, profit, time remaining, volume
- **Time-Based Sorting**: Find bets closing soon for quick action
- **Direct Links**: One-click to place bets on Kalshi

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Install all dependencies
npm run install:all
```

### Running the App

```bash
# Start both server and client in development mode
npm run dev
```

Or run them separately:

```bash
# Terminal 1 - Start the server (port 3001)
npm run dev:server

# Terminal 2 - Start the client (port 3000)
npm run dev:client
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## How It Works

### Degen Score Algorithm

The "Degen Score" combines:
- **Win Probability**: How likely the bet is to win (based on current market prices)
- **Profit Potential**: How much you'd make per dollar risked if you win

```
Degen Score = Probability * Profit Potential
```

Higher scores indicate opportunities where you have a good chance of winning AND decent returns.

### Market Analysis

For each market, Shimi analyzes:
- YES and NO positions
- Current bid/ask prices
- Time until expiration
- Trading volume
- Calculates the best direction to bet (YES or NO)

## API Endpoints

### GET /api/markets

Returns analyzed markets with filtering and sorting.

Query params:
- `sortBy`: `bestDegenScore` | `bestProbability` | `bestProfitPotential` | `timeRemaining` | `volume`
- `sortOrder`: `asc` | `desc`
- `minProbability`: Minimum win probability (0-100)
- `minProfit`: Minimum profit potential percentage
- `maxTimeHours`: Maximum time until close (in hours)
- `search`: Search term for market titles

### GET /api/quick-bets

Returns curated bet categories:
- `safeishBets`: High probability plays (75%+)
- `valueBets`: Good risk/reward ratio
- `closingSoon`: Expiring within 24 hours
- `moonshots`: Highest profit potential

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React, Vite
- **API**: Kalshi REST API

## Disclaimer

This tool is for entertainment and informational purposes only. Gambling involves risk. Please gamble responsibly and never bet more than you can afford to lose.

## License

MIT
