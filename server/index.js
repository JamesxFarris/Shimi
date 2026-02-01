import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Cache for market data
let marketCache = {
  data: null,
  lastFetch: 0,
  ttl: 10000 // 10 seconds cache
};

// Fetch all open markets from Kalshi
async function fetchKalshiMarkets() {
  const now = Date.now();

  // Return cached data if still valid
  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  const allMarkets = [];
  let cursor = null;
  let pageCount = 0;
  const maxPages = 10; // Limit pages to avoid too many requests

  try {
    do {
      const url = new URL(`${KALSHI_API_BASE}/markets`);
      url.searchParams.set('limit', '1000');
      url.searchParams.set('status', 'open');
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Shimi/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Kalshi API error: ${response.status}`);
      }

      const data = await response.json();
      allMarkets.push(...(data.markets || []));
      cursor = data.cursor;
      pageCount++;

    } while (cursor && pageCount < maxPages);

    marketCache.data = allMarkets;
    marketCache.lastFetch = now;

    return allMarkets;
  } catch (error) {
    console.error('Error fetching Kalshi markets:', error);
    throw error;
  }
}

// Calculate opportunity score and potential gains
function analyzeMarket(market) {
  const yesBid = parseFloat(market.yes_bid) || 0;
  const yesAsk = parseFloat(market.yes_ask) || 0;
  const noBid = parseFloat(market.no_bid) || 0;
  const noAsk = parseFloat(market.no_ask) || 0;

  const lastPrice = parseFloat(market.last_price) || 0;
  const volume = parseInt(market.volume) || 0;
  const openInterest = parseInt(market.open_interest) || 0;

  // Calculate probabilities (price represents implied probability)
  const yesProbability = yesAsk > 0 ? yesAsk : lastPrice;
  const noProbability = noAsk > 0 ? noAsk : (1 - lastPrice);

  // Calculate potential returns
  // If you buy YES at ask price and it wins, you get $1
  const yesPayoutMultiplier = yesAsk > 0 ? (1 / yesAsk) : 0;
  const noPayoutMultiplier = noAsk > 0 ? (1 / noAsk) : 0;

  // Expected value calculation
  const yesEV = yesProbability > 0 ? (yesProbability * (1 - yesAsk)) - ((1 - yesProbability) * yesAsk) : 0;
  const noEV = noProbability > 0 ? (noProbability * (1 - noAsk)) - ((1 - noProbability) * noAsk) : 0;

  // Profit potential (how much you make per dollar risked if you win)
  const yesProfitPotential = yesAsk > 0 ? ((1 - yesAsk) / yesAsk) * 100 : 0;
  const noProfitPotential = noAsk > 0 ? ((1 - noAsk) / noAsk) * 100 : 0;

  // Time until close
  const closeTime = market.close_time ? new Date(market.close_time) : null;
  const expirationTime = market.expiration_time ? new Date(market.expiration_time) : closeTime;
  const timeRemaining = expirationTime ? expirationTime.getTime() - Date.now() : null;

  // Calculate a "degen score" - high probability + decent payout
  // We want bets that are likely to win but still have good returns
  const yesDegenScore = yesProbability > 0.5 ? yesProbability * yesProfitPotential : 0;
  const noDegenScore = noProbability > 0.5 ? noProbability * noProfitPotential : 0;

  // Best bet direction
  const bestBet = yesDegenScore >= noDegenScore ? 'YES' : 'NO';
  const bestProbability = bestBet === 'YES' ? yesProbability : noProbability;
  const bestProfitPotential = bestBet === 'YES' ? yesProfitPotential : noProfitPotential;
  const bestDegenScore = bestBet === 'YES' ? yesDegenScore : noDegenScore;
  const bestAskPrice = bestBet === 'YES' ? yesAsk : noAsk;

  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title || market.ticker,
    subtitle: market.subtitle || '',
    status: market.status,
    closeTime: market.close_time,
    expirationTime: market.expiration_time || market.close_time,
    timeRemaining,
    timeRemainingFormatted: formatTimeRemaining(timeRemaining),

    // Raw prices
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice,

    // Volume metrics
    volume,
    openInterest,

    // YES analysis
    yesProbability: yesProbability * 100,
    yesProfitPotential,
    yesDegenScore,

    // NO analysis
    noProbability: noProbability * 100,
    noProfitPotential,
    noDegenScore,

    // Best bet recommendation
    bestBet,
    bestProbability: bestProbability * 100,
    bestProfitPotential,
    bestDegenScore,
    bestAskPrice,

    // Category
    category: market.category || 'Other'
  };
}

function formatTimeRemaining(ms) {
  if (!ms || ms < 0) return 'Expired';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// API endpoint to get analyzed markets
app.get('/api/markets', async (req, res) => {
  try {
    const {
      sortBy = 'bestDegenScore',
      sortOrder = 'desc',
      minProbability = 0,
      maxProbability = 100,
      minProfit = 0,
      maxTimeHours = null,
      search = ''
    } = req.query;

    const markets = await fetchKalshiMarkets();

    // Analyze all markets
    let analyzed = markets.map(analyzeMarket);

    // Filter out markets with no valid prices
    analyzed = analyzed.filter(m => m.bestAskPrice > 0 && m.bestAskPrice < 1);

    // Apply filters
    analyzed = analyzed.filter(m => {
      // Probability filter
      if (m.bestProbability < parseFloat(minProbability)) return false;
      if (m.bestProbability > parseFloat(maxProbability)) return false;

      // Profit potential filter
      if (m.bestProfitPotential < parseFloat(minProfit)) return false;

      // Time filter
      if (maxTimeHours && m.timeRemaining) {
        const maxTimeMs = parseFloat(maxTimeHours) * 60 * 60 * 1000;
        if (m.timeRemaining > maxTimeMs) return false;
      }

      // Search filter
      if (search) {
        const searchLower = search.toLowerCase();
        return m.title.toLowerCase().includes(searchLower) ||
               m.ticker.toLowerCase().includes(searchLower) ||
               m.subtitle.toLowerCase().includes(searchLower);
      }

      return true;
    });

    // Sort
    const order = sortOrder === 'asc' ? 1 : -1;
    analyzed.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      // Handle null values
      if (aVal === null) aVal = sortOrder === 'asc' ? Infinity : -Infinity;
      if (bVal === null) bVal = sortOrder === 'asc' ? Infinity : -Infinity;

      return (aVal - bVal) * order;
    });

    res.json({
      success: true,
      count: analyzed.length,
      markets: analyzed
    });

  } catch (error) {
    console.error('Error in /api/markets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Quick action bets - the best opportunities right now
app.get('/api/quick-bets', async (req, res) => {
  try {
    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    // Filter for actionable bets
    analyzed = analyzed.filter(m =>
      m.bestAskPrice > 0 &&
      m.bestAskPrice < 1 &&
      m.bestProbability >= 60 && // At least 60% chance
      m.bestProfitPotential >= 10 // At least 10% profit potential
    );

    // Sort by degen score
    analyzed.sort((a, b) => b.bestDegenScore - a.bestDegenScore);

    // Return top opportunities
    const quickBets = {
      // High confidence plays (75%+ probability)
      safeishBets: analyzed
        .filter(m => m.bestProbability >= 75)
        .sort((a, b) => b.bestProfitPotential - a.bestProfitPotential)
        .slice(0, 5),

      // Best risk/reward (60-75% probability with high profit)
      valueBets: analyzed
        .filter(m => m.bestProbability >= 60 && m.bestProbability < 75 && m.bestProfitPotential >= 30)
        .sort((a, b) => b.bestDegenScore - a.bestDegenScore)
        .slice(0, 5),

      // Closing soon (within 24 hours)
      closingSoon: analyzed
        .filter(m => m.timeRemaining && m.timeRemaining < 24 * 60 * 60 * 1000 && m.timeRemaining > 0)
        .sort((a, b) => a.timeRemaining - b.timeRemaining)
        .slice(0, 5),

      // Highest potential profit
      moonshots: analyzed
        .filter(m => m.bestProbability >= 50)
        .sort((a, b) => b.bestProfitPotential - a.bestProfitPotential)
        .slice(0, 5)
    };

    res.json({
      success: true,
      quickBets
    });

  } catch (error) {
    console.error('Error in /api/quick-bets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🎰 Shimi server running on port ${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api/markets`);
});
