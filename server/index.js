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

// Global error handlers
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
  bankroll: 1000, // cents ($10.00)
  maxBetPercent: 25,
  minBetAmount: 100, // $1 minimum
  minEdge: 5, // Minimum 5% edge to bet
  autoBetEnabled: false,
  autoBetInterval: null
};

let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// ============================================
// CRYPTO PRICE TRACKING
// ============================================

const cryptoPrices = {
  BTC: { price: 0, timestamp: 0, history: [], volatility: 0 },
  ETH: { price: 0, timestamp: 0, history: [], volatility: 0 }
};

// Fetch current prices from Binance (free, no API key needed)
async function fetchCryptoPrices() {
  try {
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
    ]);

    const btcData = await btcRes.json();
    const ethData = await ethRes.json();

    const now = Date.now();

    if (btcData.price) {
      const btcPrice = parseFloat(btcData.price);
      cryptoPrices.BTC.price = btcPrice;
      cryptoPrices.BTC.timestamp = now;

      // Keep 60 price points (about 10 minutes of data at 10s intervals)
      cryptoPrices.BTC.history.push({ price: btcPrice, time: now });
      if (cryptoPrices.BTC.history.length > 60) {
        cryptoPrices.BTC.history.shift();
      }

      // Calculate 15-minute volatility from recent price movements
      cryptoPrices.BTC.volatility = calculateVolatility(cryptoPrices.BTC.history);
    }

    if (ethData.price) {
      const ethPrice = parseFloat(ethData.price);
      cryptoPrices.ETH.price = ethPrice;
      cryptoPrices.ETH.timestamp = now;

      cryptoPrices.ETH.history.push({ price: ethPrice, time: now });
      if (cryptoPrices.ETH.history.length > 60) {
        cryptoPrices.ETH.history.shift();
      }

      cryptoPrices.ETH.volatility = calculateVolatility(cryptoPrices.ETH.history);
    }

    return { BTC: cryptoPrices.BTC.price, ETH: cryptoPrices.ETH.price };
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return null;
  }
}

// Calculate annualized volatility from price history
// Then convert to 15-minute volatility
function calculateVolatility(history) {
  if (history.length < 10) {
    // Default volatility estimates (annual): BTC ~60%, ETH ~80%
    return 0.02; // ~2% for 15 minutes (conservative)
  }

  // Calculate log returns
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const logReturn = Math.log(history[i].price / history[i-1].price);
    returns.push(logReturn);
  }

  // Standard deviation of returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Scale to 15-minute volatility
  // If data is ~10 second intervals, scale up
  const avgInterval = (history[history.length-1].time - history[0].time) / (history.length - 1);
  const intervalsIn15Min = (15 * 60 * 1000) / avgInterval;
  const volatility15Min = stdDev * Math.sqrt(intervalsIn15Min);

  // Cap volatility at reasonable bounds (0.5% to 5% for 15 min)
  return Math.max(0.005, Math.min(0.05, volatility15Min));
}

// Calculate probability that price will be above/below target in given time
// Using log-normal distribution assumption
function calculateProbability(currentPrice, targetPrice, volatility, timeMinutes) {
  // Time in years (for annualized volatility)
  const timeYears = timeMinutes / (365 * 24 * 60);

  // For 15-minute volatility, we already have it scaled
  const sigma = volatility;

  // Log of price ratio
  const logRatio = Math.log(targetPrice / currentPrice);

  // Standard normal CDF approximation
  // d = (ln(target/current) - drift) / (sigma * sqrt(t))
  // Assuming zero drift for short timeframes
  const d = logRatio / sigma;

  // Probability price will be BELOW target
  const probBelow = normalCDF(d);

  // Probability price will be ABOVE target
  const probAbove = 1 - probBelow;

  return { probAbove, probBelow };
}

// Standard normal CDF approximation (Zelen & Severo)
function normalCDF(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  return 0.5 * (1.0 + sign * y);
}

// Start price tracking (every 10 seconds)
let priceInterval = setInterval(fetchCryptoPrices, 10000);
fetchCryptoPrices(); // Initial fetch

// ============================================
// KALSHI API
// ============================================

function signRequest(method, path, timestamp) {
  if (!config.privateKey) throw new Error('Private key not configured');

  try {
    const pathWithoutQuery = path.split('?')[0];
    const message = `${timestamp}${method}${pathWithoutQuery}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    return sign.sign({
      key: config.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, 'base64');
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

  if (config.isAuthenticated && config.apiKeyId && config.privateKey) {
    const signature = signRequest(method, path, timestamp);
    headers['KALSHI-ACCESS-KEY'] = config.apiKeyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signature;
  }

  const options = { method, headers };
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
// CRYPTO MARKET ANALYSIS
// ============================================

let marketCache = { data: null, lastFetch: 0, ttl: 15000 };

async function fetchCryptoMarkets() {
  const now = Date.now();

  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  try {
    // Fetch markets and filter for crypto
    const data = await kalshiRequest('GET', '/markets?limit=1000&status=open');
    const markets = data.markets || [];

    // Filter for BTC and ETH markets (tickers usually contain INXB for BTC, INXE for ETH)
    const cryptoMarkets = markets.filter(m => {
      const ticker = (m.ticker || '').toUpperCase();
      const title = (m.title || '').toUpperCase();

      // Look for Bitcoin/BTC or Ethereum/ETH markets
      const isBTC = ticker.includes('BTC') || ticker.includes('INXB') ||
                    title.includes('BITCOIN') || title.includes('BTC');
      const isETH = ticker.includes('ETH') || ticker.includes('INXE') ||
                    title.includes('ETHEREUM') || title.includes('ETH');

      // Check if it's a short-term market (within 1 hour)
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      const isShortTerm = timeRemaining && timeRemaining > 0 && timeRemaining < 60 * 60 * 1000;

      return (isBTC || isETH) && isShortTerm;
    });

    marketCache.data = cryptoMarkets;
    marketCache.lastFetch = now;

    return cryptoMarkets;
  } catch (error) {
    console.error('Error fetching crypto markets:', error.message);
    return [];
  }
}

// Parse market to extract strike price and direction
function parseMarket(market) {
  const ticker = (market.ticker || '').toUpperCase();
  const title = (market.title || '').toLowerCase();

  // Determine crypto type
  let cryptoType = null;
  if (ticker.includes('BTC') || ticker.includes('INXB') || title.includes('bitcoin') || title.includes('btc')) {
    cryptoType = 'BTC';
  } else if (ticker.includes('ETH') || ticker.includes('INXE') || title.includes('ethereum') || title.includes('eth')) {
    cryptoType = 'ETH';
  }

  // Extract strike price from title
  // Common formats: "Bitcoin above $95,000", "BTC >= 95000", etc.
  let strikePrice = null;
  const priceMatches = title.match(/\$?([\d,]+(?:\.\d+)?)/g);
  if (priceMatches) {
    for (const match of priceMatches) {
      const price = parseFloat(match.replace(/[$,]/g, ''));
      // Sanity check: BTC should be 10k-500k, ETH should be 100-20k
      if (cryptoType === 'BTC' && price > 10000 && price < 500000) {
        strikePrice = price;
        break;
      } else if (cryptoType === 'ETH' && price > 100 && price < 20000) {
        strikePrice = price;
        break;
      }
    }
  }

  // Determine direction (above/below)
  let direction = null;
  if (title.includes('above') || title.includes('>=') || title.includes('higher') || title.includes('or more')) {
    direction = 'above';
  } else if (title.includes('below') || title.includes('<=') || title.includes('lower') || title.includes('or less')) {
    direction = 'below';
  } else if (title.includes('between')) {
    direction = 'between'; // Skip these for now
  }

  // Time remaining
  const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
  const timeRemaining = closeTime ? closeTime - Date.now() : null;
  const timeRemainingMinutes = timeRemaining ? timeRemaining / (60 * 1000) : null;

  return {
    ticker: market.ticker,
    title: market.title,
    cryptoType,
    strikePrice,
    direction,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk: parseFloat(market.yes_ask) || 0,
    noAsk: parseFloat(market.no_ask) || 0,
    yesBid: parseFloat(market.yes_bid) || 0,
    noBid: parseFloat(market.no_bid) || 0,
    volume: parseInt(market.volume) || 0
  };
}

// Analyze a crypto market with real probability calculation
function analyzeCryptoMarket(parsed) {
  if (!parsed.cryptoType || !parsed.strikePrice || !parsed.direction || parsed.direction === 'between') {
    return null;
  }

  const priceData = cryptoPrices[parsed.cryptoType];
  if (!priceData || !priceData.price) {
    return null;
  }

  const currentPrice = priceData.price;
  const volatility = priceData.volatility || 0.02;
  const timeMinutes = parsed.timeRemainingMinutes || 15;

  // Calculate actual probability
  const { probAbove, probBelow } = calculateProbability(
    currentPrice,
    parsed.strikePrice,
    volatility,
    timeMinutes
  );

  // Market's implied probability (from ask price)
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Our calculated probability based on which side the market is about
  let ourProbability, marketImpliedProb, betSide, betPrice;

  if (parsed.direction === 'above') {
    ourProbability = probAbove;
    marketImpliedProb = marketProbYes;
    // If we think probability is higher than market, bet YES
    // If we think probability is lower than market, bet NO
    if (probAbove > marketProbYes && marketProbYes > 0) {
      betSide = 'YES';
      betPrice = marketProbYes;
    } else if (probAbove < (1 - marketProbNo) && marketProbNo > 0) {
      betSide = 'NO';
      betPrice = marketProbNo;
      ourProbability = probBelow;
      marketImpliedProb = 1 - marketProbNo;
    }
  } else { // below
    ourProbability = probBelow;
    marketImpliedProb = marketProbYes;
    if (probBelow > marketProbYes && marketProbYes > 0) {
      betSide = 'YES';
      betPrice = marketProbYes;
    } else if (probBelow < (1 - marketProbNo) && marketProbNo > 0) {
      betSide = 'NO';
      betPrice = marketProbNo;
      ourProbability = probAbove;
      marketImpliedProb = 1 - marketProbNo;
    }
  }

  if (!betSide || !betPrice || betPrice <= 0 || betPrice >= 1) {
    return null;
  }

  // Calculate edge: our probability - market's implied probability
  const edge = (ourProbability - marketImpliedProb) * 100;

  // Only return if edge is meaningful (> 2%)
  if (edge < 2) {
    return null;
  }

  // Profit potential if we win
  const profitPotential = ((1 - betPrice) / betPrice) * 100;

  // Expected value per dollar
  const expectedValue = ourProbability * (1 / betPrice) - 1;

  // Recommended bet (Kelly-lite: edge / odds, capped at 15%)
  const odds = (1 - betPrice) / betPrice;
  const kellyFraction = Math.max(0, (odds * ourProbability - (1 - ourProbability)) / odds);
  const betPercent = Math.min(kellyFraction * 0.25, 0.15); // Quarter Kelly, max 15%
  const recommendedBet = Math.floor(config.bankroll * betPercent);

  return {
    ...parsed,
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    ourProbability: ourProbability * 100,
    marketImpliedProb: marketImpliedProb * 100,
    edge,
    betSide,
    betPrice,
    profitPotential,
    expectedValue: expectedValue * 100,
    recommendedBet,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining)
  };
}

function formatTimeRemaining(ms) {
  if (!ms || ms < 0) return 'Expired';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ============================================
// API ENDPOINTS
// ============================================

// Get current crypto prices and status
app.get('/api/crypto/prices', (req, res) => {
  res.json({
    success: true,
    prices: {
      BTC: {
        price: cryptoPrices.BTC.price,
        volatility: (cryptoPrices.BTC.volatility * 100).toFixed(2) + '%',
        lastUpdate: cryptoPrices.BTC.timestamp,
        dataPoints: cryptoPrices.BTC.history.length
      },
      ETH: {
        price: cryptoPrices.ETH.price,
        volatility: (cryptoPrices.ETH.volatility * 100).toFixed(2) + '%',
        lastUpdate: cryptoPrices.ETH.timestamp,
        dataPoints: cryptoPrices.ETH.history.length
      }
    },
    timestamp: Date.now()
  });
});

// Get analyzed crypto betting opportunities
app.get('/api/crypto/opportunities', async (req, res) => {
  try {
    const markets = await fetchCryptoMarkets();

    const opportunities = markets
      .map(m => {
        const parsed = parseMarket(m);
        return analyzeCryptoMarket(parsed);
      })
      .filter(m => m !== null)
      .sort((a, b) => b.edge - a.edge);

    res.json({
      success: true,
      count: opportunities.length,
      prices: {
        BTC: cryptoPrices.BTC.price,
        ETH: cryptoPrices.ETH.price
      },
      opportunities
    });
  } catch (error) {
    console.error('Error getting opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Place a bet
app.post('/api/bet', async (req, res) => {
  try {
    const { ticker, side, amount } = req.body;

    if (!ticker || !side || !amount) {
      return res.status(400).json({ success: false, error: 'ticker, side, and amount required' });
    }

    const amountCents = Math.round(amount * 100);
    const markets = await fetchCryptoMarkets();
    const market = markets.find(m => m.ticker === ticker);

    if (!market) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }

    const price = side.toLowerCase() === 'yes'
      ? parseFloat(market.yes_ask)
      : parseFloat(market.no_ask);

    if (!price || price <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid market price' });
    }

    const priceCents = Math.round(price * 100);
    const count = Math.floor(amountCents / priceCents);

    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: `Amount too small. Min: $${(priceCents / 100).toFixed(2)}`
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

    // Real bet
    const orderRequest = {
      ticker,
      action: 'buy',
      side: side.toLowerCase(),
      type: 'limit',
      count,
      ...(side.toLowerCase() === 'yes' ? { yes_price: priceCents } : { no_price: priceCents })
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
      bet: betRecord,
      newBalance: portfolio.balance / 100
    });

  } catch (error) {
    console.error('Error placing bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto-bet on best opportunity
app.post('/api/crypto/auto-bet', async (req, res) => {
  try {
    const markets = await fetchCryptoMarkets();

    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => m !== null && m.edge >= config.minEdge)
      .sort((a, b) => b.edge - a.edge);

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: 'No opportunities with sufficient edge',
        bet: null,
        prices: { BTC: cryptoPrices.BTC.price, ETH: cryptoPrices.ETH.price }
      });
    }

    const best = opportunities[0];

    // Calculate bet amount
    let betAmount = best.recommendedBet;
    betAmount = Math.max(betAmount, config.minBetAmount);
    betAmount = Math.min(betAmount, config.bankroll);

    if (betAmount < config.minBetAmount) {
      return res.json({
        success: true,
        message: 'Bankroll too low for minimum bet',
        bet: null
      });
    }

    const priceCents = Math.round(best.betPrice * 100);
    const count = Math.floor(betAmount / priceCents);

    if (count < 1) {
      return res.json({ success: true, message: 'Bet size too small', bet: null });
    }

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      edge: best.edge,
      ourProbability: best.ourProbability,
      cryptoPrice: best.currentPrice,
      strikePrice: best.strikePrice,
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
        opportunity: best,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet
    const orderRequest = {
      ticker: best.ticker,
      action: 'buy',
      side: best.betSide.toLowerCase(),
      type: 'limit',
      count,
      ...(best.betSide.toLowerCase() === 'yes'
        ? { yes_price: priceCents }
        : { no_price: priceCents })
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
      bet: betRecord,
      opportunity: best,
      newBalance: portfolio.balance / 100
    });

  } catch (error) {
    console.error('Error in auto-bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle continuous auto-betting
let autoBetInterval = null;

async function runAutoBet() {
  try {
    console.log('🤖 Checking for crypto opportunities...');

    const markets = await fetchCryptoMarkets();
    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => m !== null && m.edge >= config.minEdge)
      .sort((a, b) => b.edge - a.edge);

    if (opportunities.length === 0) {
      console.log('📊 No opportunities found');
      return;
    }

    const best = opportunities[0];
    console.log(`💰 Found opportunity: ${best.ticker} | Edge: ${best.edge.toFixed(1)}% | ${best.betSide}`);

    // Place bet logic (similar to auto-bet endpoint)
    let betAmount = Math.max(best.recommendedBet, config.minBetAmount);
    betAmount = Math.min(betAmount, config.bankroll);

    const priceCents = Math.round(best.betPrice * 100);
    const count = Math.floor(betAmount / priceCents);

    if (count < 1) {
      console.log('⚠️ Bet size too small');
      return;
    }

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      edge: best.edge,
      timestamp: new Date().toISOString(),
      status: config.isAuthenticated ? 'pending' : 'simulated',
      auto: true
    };

    if (!config.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;
      console.log(`🎰 Simulated bet: ${betRecord.side} on ${betRecord.ticker} | $${(betRecord.totalCost/100).toFixed(2)}`);
      return;
    }

    // Real bet
    const orderRequest = {
      ticker: best.ticker,
      action: 'buy',
      side: best.betSide.toLowerCase(),
      type: 'limit',
      count,
      ...(best.betSide.toLowerCase() === 'yes'
        ? { yes_price: priceCents }
        : { no_price: priceCents })
    };

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
    betRecord.status = 'placed';
    betRecord.orderId = orderResponse.order?.order_id;
    betHistory.unshift(betRecord);

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    config.bankroll = balanceData.balance || 0;

    console.log(`🎰 Bet placed: ${betRecord.side} on ${betRecord.ticker}`);

  } catch (error) {
    console.error('Auto-bet error:', error.message);
  }
}

app.post('/api/crypto/auto-bet/toggle', (req, res) => {
  const { enabled, intervalSeconds = 60 } = req.body;

  if (enabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;

    // Run immediately, then on interval
    runAutoBet();
    autoBetInterval = setInterval(runAutoBet, intervalSeconds * 1000);

    res.json({
      success: true,
      message: `Auto-betting enabled (every ${intervalSeconds}s)`,
      enabled: true
    });
  } else if (!enabled && config.autoBetEnabled) {
    config.autoBetEnabled = false;
    if (autoBetInterval) {
      clearInterval(autoBetInterval);
      autoBetInterval = null;
    }

    res.json({ success: true, message: 'Auto-betting disabled', enabled: false });
  } else {
    res.json({
      success: true,
      message: `Auto-betting ${config.autoBetEnabled ? 'running' : 'stopped'}`,
      enabled: config.autoBetEnabled
    });
  }
});

// Auth endpoints
app.post('/api/auth/configure', async (req, res) => {
  try {
    const { apiKeyId, privateKey } = req.body;

    if (!apiKeyId || !privateKey) {
      return res.status(400).json({ success: false, error: 'apiKeyId and privateKey required' });
    }

    config.apiKeyId = apiKeyId.trim();
    config.privateKey = privateKey.trim();
    config.isAuthenticated = true;

    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      res.json({
        success: true,
        message: 'Connected to Kalshi',
        balance: portfolio.balance / 100
      });
    } catch (authError) {
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;
      res.status(401).json({ success: false, error: 'Invalid credentials: ' + authError.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    isAuthenticated: config.isAuthenticated,
    hasApiKey: !!config.apiKeyId
  });
});

app.get('/api/portfolio', (req, res) => {
  res.json({
    success: true,
    simulated: !config.isAuthenticated,
    balance: config.bankroll / 100,
    betHistory: betHistory.slice(0, 50)
  });
});

app.get('/api/settings', (req, res) => {
  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      minEdge: config.minEdge,
      autoBetEnabled: config.autoBetEnabled
    }
  });
});

app.post('/api/settings', (req, res) => {
  const { bankroll, minEdge } = req.body;

  if (bankroll !== undefined) config.bankroll = Math.round(bankroll * 100);
  if (minEdge !== undefined) config.minEdge = minEdge;

  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      minEdge: config.minEdge
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cryptoPrices: {
      BTC: cryptoPrices.BTC.price,
      ETH: cryptoPrices.ETH.price
    },
    autoBetEnabled: config.autoBetEnabled,
    authenticated: config.isAuthenticated
  });
});

// Serve static frontend
const clientDistPath = path.join(__dirname, '../client/dist');
try {
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
  }
} catch (err) {}

app.get('*', (req, res) => {
  try {
    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend not built');
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎰 Shimi Crypto Bot running on port ${PORT}`);
  console.log(`📊 Tracking BTC & ETH prices in real-time`);
  console.log(`💰 Crypto opportunities: http://localhost:${PORT}/api/crypto/opportunities`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
