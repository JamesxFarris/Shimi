import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.use(cors());
app.use(express.json());

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// ============================================
// CONFIGURATION
// ============================================

let config = {
  apiKeyId: null,
  privateKey: null,
  isAuthenticated: false,

  // Betting settings
  bankroll: 1000, // cents ($10.00)
  maxBetPercent: 25, // Max 25% of bankroll per bet (conservative Kelly)
  minBetAmount: 100, // Minimum $1 bet
  maxTimeDays: 3, // Only bet on markets closing within 3 days
  minProbability: 60, // Minimum 60% win probability
  minProfit: 25, // Minimum 25% profit potential required
  autoBetEnabled: false,
  autoBetInterval: null
};

// Bet history tracking
let betHistory = [];
let portfolio = {
  balance: 0,
  positions: [],
  totalDeposited: 0,
  totalWithdrawn: 0,
  totalWon: 0,
  totalLost: 0
};

// ============================================
// KALSHI API AUTHENTICATION
// ============================================

function signRequest(method, path, timestamp) {
  if (!config.privateKey) {
    throw new Error('Private key not configured');
  }

  try {
    // Strip query params from path for signing
    const pathWithoutQuery = path.split('?')[0];
    const message = `${timestamp}${method}${pathWithoutQuery}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign({
      key: config.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, 'base64');

    return signature;
  } catch (err) {
    console.error('Crypto signing error:', err.message);
    throw new Error('Failed to sign request: ' + err.message);
  }
}

async function kalshiRequest(method, endpoint, body = null) {
  const timestamp = Date.now().toString();
  const path = `/trade-api/v2${endpoint}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Shimi/1.0'
  };

  // Add auth headers if configured
  if (config.isAuthenticated && config.apiKeyId && config.privateKey) {
    const signature = signRequest(method, path, timestamp);
    headers['KALSHI-ACCESS-KEY'] = config.apiKeyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signature;
  }

  const options = {
    method,
    headers
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${KALSHI_API_BASE}${endpoint}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ============================================
// MARKET DATA
// ============================================

let marketCache = {
  data: null,
  lastFetch: 0,
  ttl: 10000
};

async function fetchKalshiMarkets() {
  const now = Date.now();

  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  const allMarkets = [];
  let cursor = null;
  let pageCount = 0;
  const maxPages = 10;

  try {
    do {
      let endpoint = `/markets?limit=1000&status=open`;
      if (cursor) {
        endpoint += `&cursor=${cursor}`;
      }

      const data = await kalshiRequest('GET', endpoint);
      allMarkets.push(...(data.markets || []));
      cursor = data.cursor;
      pageCount++;

    } while (cursor && pageCount < maxPages);

    marketCache.data = allMarkets;
    marketCache.lastFetch = now;

    return allMarkets;
  } catch (error) {
    console.error('Error fetching markets:', error);
    throw error;
  }
}

// ============================================
// BETTING STRATEGY
// ============================================

/**
 * Simple bet sizing based on probability and bankroll
 * Higher probability = can bet more (lower risk)
 * We use conservative sizing: 5-15% of bankroll based on probability
 */
function calculateBetSize(probability, profitPotential, bankroll) {
  // Base bet: higher probability = larger bet allowed
  // 50% prob = 5% of bankroll, 90% prob = 15% of bankroll
  const probFactor = Math.max(0, (probability - 0.5) / 0.4); // 0-1 scale
  const betPercent = 5 + (probFactor * 10); // 5-15%

  let betAmount = Math.floor(bankroll * (betPercent / 100));

  // Cap at max bet percent
  const maxBet = Math.floor(bankroll * (config.maxBetPercent / 100));
  betAmount = Math.min(betAmount, maxBet);
  betAmount = Math.max(betAmount, config.minBetAmount);

  // Don't bet more than bankroll
  betAmount = Math.min(betAmount, bankroll);

  return betAmount;
}

/**
 * Score combines probability and profit potential
 * We want: high probability + decent profit
 * Score = probability * sqrt(profitPotential)
 * This favors high probability but rewards good profit potential
 */
function calculateScore(probability, profitPotential) {
  // probability: 0-1, profitPotential: percentage (e.g., 33 for 33%)
  return probability * Math.sqrt(Math.max(profitPotential, 1));
}

function analyzeMarket(market) {
  const yesBid = parseFloat(market.yes_bid) || 0;
  const yesAsk = parseFloat(market.yes_ask) || 0;
  const noBid = parseFloat(market.no_bid) || 0;
  const noAsk = parseFloat(market.no_ask) || 0;
  const lastPrice = parseFloat(market.last_price) || 0;
  const volume = parseInt(market.volume) || 0;
  const openInterest = parseInt(market.open_interest) || 0;

  // Probability = price (market's implied probability)
  // YES at $0.70 = 70% implied chance of YES winning
  const yesProbability = yesAsk > 0 ? yesAsk : lastPrice;
  const noProbability = noAsk > 0 ? noAsk : (1 - lastPrice);

  // Profit potential (if you win)
  // Buy YES at $0.70, win = $1.00, profit = $0.30 = 42.8% return
  const yesProfitPotential = yesAsk > 0 && yesAsk < 1 ? ((1 - yesAsk) / yesAsk) * 100 : 0;
  const noProfitPotential = noAsk > 0 && noAsk < 1 ? ((1 - noAsk) / noAsk) * 100 : 0;

  // Time calculations
  const closeTime = market.close_time ? new Date(market.close_time) : null;
  const expirationTime = market.expiration_time ? new Date(market.expiration_time) : closeTime;
  const timeRemaining = expirationTime ? expirationTime.getTime() - Date.now() : null;
  const timeRemainingDays = timeRemaining ? timeRemaining / (24 * 60 * 60 * 1000) : null;

  // Score for each side (probability * sqrt(profit potential))
  const yesScore = calculateScore(yesProbability, yesProfitPotential);
  const noScore = calculateScore(noProbability, noProfitPotential);

  // Pick the better side (higher probability with decent profit)
  // For turning $10 into $100, we want high probability bets
  const bestBet = yesProbability >= noProbability ? 'YES' : 'NO';
  const bestProbability = bestBet === 'YES' ? yesProbability : noProbability;
  const bestProfitPotential = bestBet === 'YES' ? yesProfitPotential : noProfitPotential;
  const bestAskPrice = bestBet === 'YES' ? yesAsk : noAsk;
  const bestScore = bestBet === 'YES' ? yesScore : noScore;

  // Calculate recommended bet size
  const recommendedBet = calculateBetSize(bestProbability, bestProfitPotential, config.bankroll);

  // Expected value per dollar bet (if market probability is correct)
  // EV = (prob * payout) - cost = (prob * $1) - price
  // Positive EV only if we think probability is higher than market price
  // Since we're using market price as probability, EV = 0 by definition
  // But we show "expected profit" assuming the bet wins
  const expectedProfit = recommendedBet * (bestProfitPotential / 100);

  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title || market.ticker,
    subtitle: market.subtitle || '',
    status: market.status,
    closeTime: market.close_time,
    expirationTime: market.expiration_time || market.close_time,
    timeRemaining,
    timeRemainingDays,
    timeRemainingFormatted: formatTimeRemaining(timeRemaining),

    yesBid, yesAsk, noBid, noAsk, lastPrice,
    volume, openInterest,

    yesProbability: yesProbability * 100,
    yesProfitPotential,

    noProbability: noProbability * 100,
    noProfitPotential,

    bestBet,
    bestProbability: bestProbability * 100,
    bestProfitPotential,
    bestAskPrice,
    bestScore,

    // Betting recommendation
    recommendedBet,
    expectedProfit,

    // For display: what you'd win if bet hits
    potentialWin: (recommendedBet / 100) * (1 + bestProfitPotential / 100),

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

// ============================================
// TRADING ENDPOINTS
// ============================================

// Configure API credentials
app.post('/api/auth/configure', async (req, res) => {
  try {
    const { apiKeyId, privateKey } = req.body;

    if (!apiKeyId || !privateKey) {
      return res.status(400).json({
        success: false,
        error: 'Both apiKeyId and privateKey are required'
      });
    }

    // Validate the key by trying to get balance
    config.apiKeyId = apiKeyId;
    config.privateKey = privateKey;
    config.isAuthenticated = true;

    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      res.json({
        success: true,
        message: 'API credentials configured successfully',
        balance: portfolio.balance / 100 // Convert cents to dollars
      });
    } catch (authError) {
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;

      res.status(401).json({
        success: false,
        error: 'Invalid API credentials: ' + authError.message
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get authentication status
app.get('/api/auth/status', (req, res) => {
  res.json({
    isAuthenticated: config.isAuthenticated,
    hasApiKey: !!config.apiKeyId
  });
});

// Get portfolio balance and positions
app.get('/api/portfolio', async (req, res) => {
  try {
    if (!config.isAuthenticated) {
      return res.json({
        success: true,
        simulated: true,
        balance: config.bankroll / 100,
        positions: [],
        betHistory
      });
    }

    const [balanceData, positionsData] = await Promise.all([
      kalshiRequest('GET', '/portfolio/balance'),
      kalshiRequest('GET', '/portfolio/positions')
    ]);

    portfolio.balance = balanceData.balance || 0;
    portfolio.positions = positionsData.market_positions || [];
    config.bankroll = portfolio.balance;

    res.json({
      success: true,
      simulated: false,
      balance: portfolio.balance / 100,
      portfolioValue: (balanceData.portfolio_value || 0) / 100,
      positions: portfolio.positions,
      betHistory
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update betting settings
app.post('/api/settings', (req, res) => {
  const {
    bankroll,
    maxBetPercent,
    minBetAmount,
    maxTimeDays,
    minProbability,
    minProfit
  } = req.body;

  if (bankroll !== undefined) config.bankroll = Math.round(bankroll * 100);
  if (maxBetPercent !== undefined) config.maxBetPercent = maxBetPercent;
  if (minBetAmount !== undefined) config.minBetAmount = Math.round(minBetAmount * 100);
  if (maxTimeDays !== undefined) config.maxTimeDays = maxTimeDays;
  if (minProbability !== undefined) config.minProbability = minProbability;
  if (minProfit !== undefined) config.minProfit = minProfit;

  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      maxBetPercent: config.maxBetPercent,
      minBetAmount: config.minBetAmount / 100,
      maxTimeDays: config.maxTimeDays,
      minProbability: config.minProbability,
      minProfit: config.minProfit
    }
  });
});

// Get current settings
app.get('/api/settings', (req, res) => {
  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      maxBetPercent: config.maxBetPercent,
      minBetAmount: config.minBetAmount / 100,
      maxTimeDays: config.maxTimeDays,
      minProbability: config.minProbability,
      minEdge: config.minEdge,
      autoBetEnabled: config.autoBetEnabled
    }
  });
});

// Place a bet
app.post('/api/bet', async (req, res) => {
  try {
    const { ticker, side, amount } = req.body;

    if (!ticker || !side || !amount) {
      return res.status(400).json({
        success: false,
        error: 'ticker, side, and amount are required'
      });
    }

    const amountCents = Math.round(amount * 100);

    // Calculate number of contracts based on current price
    const markets = await fetchKalshiMarkets();
    const market = markets.find(m => m.ticker === ticker);

    if (!market) {
      return res.status(404).json({
        success: false,
        error: 'Market not found'
      });
    }

    const price = side.toLowerCase() === 'yes'
      ? parseFloat(market.yes_ask)
      : parseFloat(market.no_ask);

    if (!price || price <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid market price'
      });
    }

    const priceCents = Math.round(price * 100);
    const count = Math.floor(amountCents / priceCents);

    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: `Amount too small. Minimum bet: $${(priceCents / 100).toFixed(2)}`
      });
    }

    const betRecord = {
      id: Date.now().toString(),
      ticker,
      title: market.title,
      side: side.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    if (!config.isAuthenticated) {
      // Simulated bet
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet via Kalshi API
    const orderRequest = {
      ticker,
      action: 'buy',
      side: side.toLowerCase(),
      type: 'limit',
      count,
      ...(side.toLowerCase() === 'yes'
        ? { yes_price: priceCents }
        : { no_price: priceCents }
      )
    };

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);

    betRecord.status = 'placed';
    betRecord.orderId = orderResponse.order?.order_id;
    betRecord.orderResponse = orderResponse;
    betHistory.unshift(betRecord);

    // Refresh balance
    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    portfolio.balance = balanceData.balance || 0;
    config.bankroll = portfolio.balance;

    res.json({
      success: true,
      simulated: false,
      bet: betRecord,
      order: orderResponse,
      newBalance: portfolio.balance / 100
    });

  } catch (error) {
    console.error('Error placing bet:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get optimal bets - high probability with good profit potential
app.get('/api/optimal-bets', async (req, res) => {
  try {
    const { maxTimeDays = config.maxTimeDays } = req.query;

    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    // Filter for good betting opportunities
    analyzed = analyzed.filter(m => {
      // Must have valid prices
      if (m.bestAskPrice <= 0 || m.bestAskPrice >= 1) return false;

      // Must be within time limit
      if (m.timeRemainingDays === null || m.timeRemainingDays > parseFloat(maxTimeDays)) return false;
      if (m.timeRemainingDays < 0) return false;

      // Must meet minimum probability
      if (m.bestProbability < config.minProbability) return false;

      // Must have some profit potential (at least 10%)
      if (m.bestProfitPotential < 10) return false;

      return true;
    });

    // Sort by score (probability * sqrt(profit potential))
    // This balances safety with reward
    analyzed.sort((a, b) => b.bestScore - a.bestScore);

    // Take top opportunities
    const optimalBets = analyzed.slice(0, 15);

    res.json({
      success: true,
      count: optimalBets.length,
      totalAvailable: analyzed.length,
      settings: {
        maxTimeDays: parseFloat(maxTimeDays),
        minProbability: config.minProbability,
        bankroll: config.bankroll / 100
      },
      bets: optimalBets
    });

  } catch (error) {
    console.error('Error getting optimal bets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Auto-bet: place the single best bet
app.post('/api/auto-bet', async (req, res) => {
  try {
    const { maxTimeDays = config.maxTimeDays, dryRun = false } = req.body;

    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    // Filter for valid opportunities
    analyzed = analyzed.filter(m => {
      if (m.bestAskPrice <= 0 || m.bestAskPrice >= 1) return false;
      if (m.timeRemainingDays === null || m.timeRemainingDays > parseFloat(maxTimeDays)) return false;
      if (m.timeRemainingDays < 0) return false;
      if (m.bestProbability < config.minProbability) return false;
      if (m.bestProfitPotential < 10) return false;
      return true;
    });

    if (analyzed.length === 0) {
      return res.json({
        success: true,
        message: 'No optimal bets found matching criteria',
        bet: null
      });
    }

    // Get the best opportunity by score
    analyzed.sort((a, b) => b.bestScore - a.bestScore);
    const bestOpportunity = analyzed[0];

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        recommendation: {
          ticker: bestOpportunity.ticker,
          title: bestOpportunity.title,
          side: bestOpportunity.bestBet,
          probability: bestOpportunity.bestProbability,
          profitPotential: bestOpportunity.bestProfitPotential,
          recommendedBet: bestOpportunity.recommendedBet / 100,
          timeRemaining: bestOpportunity.timeRemainingFormatted
        }
      });
    }

    // Place the bet
    const betAmount = bestOpportunity.recommendedBet / 100;
    const priceCents = Math.round(bestOpportunity.bestAskPrice * 100);
    const count = Math.floor(bestOpportunity.recommendedBet / priceCents);

    if (count < 1) {
      return res.json({
        success: false,
        error: 'Calculated bet size too small'
      });
    }

    const betRecord = {
      id: Date.now().toString(),
      ticker: bestOpportunity.ticker,
      title: bestOpportunity.title,
      side: bestOpportunity.bestBet.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      profitPotential: bestOpportunity.bestProfitPotential,
      probability: bestOpportunity.bestProbability,
      timestamp: new Date().toISOString(),
      status: 'pending',
      auto: true
    };

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: config.bankroll / 100
      });
    }

    // Real order
    const orderRequest = {
      ticker: bestOpportunity.ticker,
      action: 'buy',
      side: bestOpportunity.bestBet.toLowerCase(),
      type: 'limit',
      count,
      ...(bestOpportunity.bestBet.toLowerCase() === 'yes'
        ? { yes_price: priceCents }
        : { no_price: priceCents }
      )
    };

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);

    betRecord.status = 'placed';
    betRecord.orderId = orderResponse.order?.order_id;
    betHistory.unshift(betRecord);

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    portfolio.balance = balanceData.balance || 0;
    config.bankroll = portfolio.balance;

    res.json({
      success: true,
      simulated: false,
      bet: betRecord,
      order: orderResponse,
      newBalance: portfolio.balance / 100
    });

  } catch (error) {
    console.error('Error in auto-bet:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Internal auto-bet logic (called directly, not via HTTP)
async function executeAutoBet() {
  try {
    console.log('🤖 Auto-bet check running...');

    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    // Filter for valid opportunities
    analyzed = analyzed.filter(m => {
      if (m.bestAskPrice <= 0 || m.bestAskPrice >= 1) return false;
      if (m.timeRemainingDays === null || m.timeRemainingDays > config.maxTimeDays) return false;
      if (m.timeRemainingDays < 0) return false;
      if (m.bestProbability < config.minProbability) return false;
      if (m.bestProfitPotential < 10) return false;
      return true;
    });

    if (analyzed.length === 0) {
      console.log('🤖 No optimal bets found');
      return { success: true, bet: null };
    }

    // Get the best opportunity by score
    analyzed.sort((a, b) => b.bestScore - a.bestScore);
    const bestOpportunity = analyzed[0];

    const priceCents = Math.round(bestOpportunity.bestAskPrice * 100);
    const count = Math.floor(bestOpportunity.recommendedBet / priceCents);

    if (count < 1) {
      console.log('🤖 Bet size too small');
      return { success: false, error: 'Bet size too small' };
    }

    const betRecord = {
      id: Date.now().toString(),
      ticker: bestOpportunity.ticker,
      title: bestOpportunity.title,
      side: bestOpportunity.bestBet.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      profitPotential: bestOpportunity.bestProfitPotential,
      probability: bestOpportunity.bestProbability,
      timestamp: new Date().toISOString(),
      status: 'pending',
      auto: true
    };

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;
      console.log(`🎰 Auto-bet (simulated): ${betRecord.side} on ${betRecord.ticker}`);
      return { success: true, simulated: true, bet: betRecord };
    }

    // Real order
    const orderRequest = {
      ticker: bestOpportunity.ticker,
      action: 'buy',
      side: bestOpportunity.bestBet.toLowerCase(),
      type: 'limit',
      count,
      ...(bestOpportunity.bestBet.toLowerCase() === 'yes'
        ? { yes_price: priceCents }
        : { no_price: priceCents }
      )
    };

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);

    betRecord.status = 'placed';
    betRecord.orderId = orderResponse.order?.order_id;
    betHistory.unshift(betRecord);

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    portfolio.balance = balanceData.balance || 0;
    config.bankroll = portfolio.balance;

    console.log(`🎰 Auto-bet placed: ${betRecord.side} on ${betRecord.ticker}`);
    return { success: true, bet: betRecord };

  } catch (error) {
    console.error('Auto-bet execution error:', error.message);
    return { success: false, error: error.message };
  }
}

// Toggle continuous auto-betting
app.post('/api/auto-bet/toggle', (req, res) => {
  const { enabled, intervalMinutes = 5 } = req.body;

  if (enabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;

    // Use direct function call instead of HTTP request to self
    config.autoBetInterval = setInterval(() => {
      executeAutoBet().catch(err => {
        console.error('Auto-bet interval error:', err.message);
      });
    }, intervalMinutes * 60 * 1000);

    res.json({
      success: true,
      message: `Auto-betting enabled (every ${intervalMinutes} minutes)`,
      enabled: true
    });
  } else if (!enabled && config.autoBetEnabled) {
    config.autoBetEnabled = false;
    if (config.autoBetInterval) {
      clearInterval(config.autoBetInterval);
      config.autoBetInterval = null;
    }

    res.json({
      success: true,
      message: 'Auto-betting disabled',
      enabled: false
    });
  } else {
    res.json({
      success: true,
      message: `Auto-betting already ${enabled ? 'enabled' : 'disabled'}`,
      enabled: config.autoBetEnabled
    });
  }
});

// ============================================
// EXISTING ENDPOINTS
// ============================================

app.get('/api/markets', async (req, res) => {
  try {
    const {
      sortBy = 'bestDegenScore',
      sortOrder = 'desc',
      minProbability = 0,
      maxProbability = 100,
      minProfit = 0,
      maxTimeHours = null,
      maxTimeDays = null,
      search = ''
    } = req.query;

    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    analyzed = analyzed.filter(m => m.bestAskPrice > 0 && m.bestAskPrice < 1);

    analyzed = analyzed.filter(m => {
      if (m.bestProbability < parseFloat(minProbability)) return false;
      if (m.bestProbability > parseFloat(maxProbability)) return false;
      if (m.bestProfitPotential < parseFloat(minProfit)) return false;

      if (maxTimeHours && m.timeRemaining) {
        const maxTimeMs = parseFloat(maxTimeHours) * 60 * 60 * 1000;
        if (m.timeRemaining > maxTimeMs) return false;
      }

      if (maxTimeDays && m.timeRemainingDays !== null) {
        if (m.timeRemainingDays > parseFloat(maxTimeDays)) return false;
      }

      if (search) {
        const searchLower = search.toLowerCase();
        return m.title.toLowerCase().includes(searchLower) ||
               m.ticker.toLowerCase().includes(searchLower) ||
               m.subtitle.toLowerCase().includes(searchLower);
      }

      return true;
    });

    const order = sortOrder === 'asc' ? 1 : -1;
    analyzed.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];
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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/quick-bets', async (req, res) => {
  try {
    const { maxTimeDays = 3 } = req.query;

    const markets = await fetchKalshiMarkets();
    let analyzed = markets.map(analyzeMarket);

    analyzed = analyzed.filter(m =>
      m.bestAskPrice > 0 &&
      m.bestAskPrice < 1 &&
      m.bestProbability >= 60 &&
      m.bestProfitPotential >= 10 &&
      (m.timeRemainingDays === null || m.timeRemainingDays <= parseFloat(maxTimeDays))
    );

    analyzed.sort((a, b) => b.bestDegenScore - a.bestDegenScore);

    const quickBets = {
      safeishBets: analyzed
        .filter(m => m.bestProbability >= 75)
        .sort((a, b) => b.bestProfitPotential - a.bestProfitPotential)
        .slice(0, 5),

      valueBets: analyzed
        .filter(m => m.bestProbability >= 60 && m.bestProbability < 75 && m.bestProfitPotential >= 30)
        .sort((a, b) => b.bestDegenScore - a.bestDegenScore)
        .slice(0, 5),

      closingSoon: analyzed
        .filter(m => m.timeRemaining && m.timeRemaining < 24 * 60 * 60 * 1000 && m.timeRemaining > 0)
        .sort((a, b) => a.timeRemaining - b.timeRemaining)
        .slice(0, 5),

      kellyPicks: analyzed
        .filter(m => m.edge >= 5 && m.recommendedBet >= config.minBetAmount)
        .sort((a, b) => b.edge - a.edge)
        .slice(0, 5)
    };

    res.json({ success: true, quickBets });

  } catch (error) {
    console.error('Error in /api/quick-bets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    authenticated: config.isAuthenticated,
    autoBetEnabled: config.autoBetEnabled
  });
});

// ============================================
// SERVE STATIC FRONTEND IN PRODUCTION
// ============================================

const clientDistPath = path.join(__dirname, '../client/dist');

// Serve static files from the React app
try {
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
  }
} catch (err) {
  console.log('Static files not available:', err.message);
}

// Handle React routing - return index.html for all non-API routes
app.get('*', (req, res) => {
  try {
    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend not built. Run: npm run build');
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎰 Shimi server running on port ${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/markets`);
  console.log(`💰 Trading: http://localhost:${PORT}/api/optimal-bets`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
