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
  maxBetPercent: 15,
  minBetAmount: 100, // $1 fixed bets
  fixedBetAmount: 100, // Always bet $1
  minEdge: 1, // Lowered to 1% for more volume
  autoBetEnabled: false
};

let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// ============================================
// CRYPTO PRICE TRACKING - EXPANDED TOKENS
// ============================================

// All tokens we track - Binance symbols
const TRACKED_TOKENS = {
  BTC: { symbol: 'BTCUSDT', name: 'Bitcoin', minPrice: 10000, maxPrice: 500000 },
  ETH: { symbol: 'ETHUSDT', name: 'Ethereum', minPrice: 100, maxPrice: 20000 },
  SOL: { symbol: 'SOLUSDT', name: 'Solana', minPrice: 1, maxPrice: 1000 },
  XRP: { symbol: 'XRPUSDT', name: 'XRP', minPrice: 0.1, maxPrice: 100 },
  DOGE: { symbol: 'DOGEUSDT', name: 'Dogecoin', minPrice: 0.01, maxPrice: 10 },
  ADA: { symbol: 'ADAUSDT', name: 'Cardano', minPrice: 0.1, maxPrice: 50 },
  AVAX: { symbol: 'AVAXUSDT', name: 'Avalanche', minPrice: 1, maxPrice: 500 },
  LINK: { symbol: 'LINKUSDT', name: 'Chainlink', minPrice: 1, maxPrice: 200 },
  MATIC: { symbol: 'MATICUSDT', name: 'Polygon', minPrice: 0.1, maxPrice: 50 },
  DOT: { symbol: 'DOTUSDT', name: 'Polkadot', minPrice: 1, maxPrice: 200 },
  SHIB: { symbol: 'SHIBUSDT', name: 'Shiba Inu', minPrice: 0.000001, maxPrice: 0.001 },
  LTC: { symbol: 'LTCUSDT', name: 'Litecoin', minPrice: 10, maxPrice: 1000 },
  UNI: { symbol: 'UNIUSDT', name: 'Uniswap', minPrice: 1, maxPrice: 100 },
  ATOM: { symbol: 'ATOMUSDT', name: 'Cosmos', minPrice: 1, maxPrice: 100 },
  APT: { symbol: 'APTUSDT', name: 'Aptos', minPrice: 1, maxPrice: 100 }
};

// Price data storage
const cryptoPrices = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  cryptoPrices[token] = { price: 0, timestamp: 0, history: [], volatility: 0.02 };
});

// Fetch all prices from Binance in one call
async function fetchCryptoPrices() {
  try {
    // Fetch all prices at once
    const res = await fetch('https://api.binance.com/api/v3/ticker/price');
    const allPrices = await res.json();

    const now = Date.now();
    const priceMap = {};
    allPrices.forEach(p => { priceMap[p.symbol] = parseFloat(p.price); });

    // Update each tracked token
    for (const [token, config] of Object.entries(TRACKED_TOKENS)) {
      const price = priceMap[config.symbol];
      if (price && price > 0) {
        cryptoPrices[token].price = price;
        cryptoPrices[token].timestamp = now;

        // Keep 60 price points for volatility calculation
        cryptoPrices[token].history.push({ price, time: now });
        if (cryptoPrices[token].history.length > 60) {
          cryptoPrices[token].history.shift();
        }

        // Calculate volatility
        cryptoPrices[token].volatility = calculateVolatility(cryptoPrices[token].history, token);
      }
    }

    return cryptoPrices;
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return null;
  }
}

// Calculate 15-minute volatility from price history
function calculateVolatility(history, token) {
  // Default volatilities by token type (15-min estimate)
  const defaultVol = {
    BTC: 0.015, ETH: 0.02, SOL: 0.03, XRP: 0.025, DOGE: 0.04,
    ADA: 0.03, AVAX: 0.03, LINK: 0.025, MATIC: 0.03, DOT: 0.025,
    SHIB: 0.05, LTC: 0.02, UNI: 0.03, ATOM: 0.025, APT: 0.035
  };

  if (history.length < 10) {
    return defaultVol[token] || 0.025;
  }

  // Calculate log returns
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const logReturn = Math.log(history[i].price / history[i-1].price);
    returns.push(logReturn);
  }

  // Standard deviation
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Scale to 15-minute volatility
  const avgInterval = (history[history.length-1].time - history[0].time) / (history.length - 1);
  const intervalsIn15Min = (15 * 60 * 1000) / avgInterval;
  const volatility15Min = stdDev * Math.sqrt(intervalsIn15Min);

  // Cap at reasonable bounds
  return Math.max(0.005, Math.min(0.08, volatility15Min));
}

// Calculate probability using log-normal distribution
function calculateProbability(currentPrice, targetPrice, volatility) {
  const sigma = volatility;
  const logRatio = Math.log(targetPrice / currentPrice);
  const d = logRatio / sigma;

  // Probability price will be BELOW target
  const probBelow = normalCDF(d);
  const probAbove = 1 - probBelow;

  return { probAbove, probBelow };
}

// Standard normal CDF
function normalCDF(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  return 0.5 * (1.0 + sign * y);
}

// Start price tracking (every 10 seconds)
let priceInterval = setInterval(fetchCryptoPrices, 10000);
fetchCryptoPrices();

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
// MARKET ANALYSIS
// ============================================

let marketCache = { data: null, lastFetch: 0, ttl: 15000 };

async function fetchCryptoMarkets() {
  const now = Date.now();

  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  try {
    const data = await kalshiRequest('GET', '/markets?limit=1000&status=open');
    const markets = data.markets || [];

    // Filter for crypto markets closing within 2 hours
    const cryptoMarkets = markets.filter(m => {
      const ticker = (m.ticker || '').toUpperCase();
      const title = (m.title || '').toUpperCase();

      // Check if it's a crypto market
      let isCrypto = false;
      for (const [token, cfg] of Object.entries(TRACKED_TOKENS)) {
        if (ticker.includes(token) || title.includes(token) || title.includes(cfg.name.toUpperCase())) {
          isCrypto = true;
          break;
        }
      }

      // Also check for common crypto ticker patterns
      if (!isCrypto) {
        isCrypto = ticker.includes('INX') || // Kalshi crypto index
                   title.includes('CRYPTO') ||
                   title.includes('COIN');
      }

      // Check time - within 4 hours for more opportunities
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      const isShortTerm = timeRemaining && timeRemaining > 30000 && timeRemaining < 4 * 60 * 60 * 1000;

      return isCrypto && isShortTerm;
    });

    marketCache.data = cryptoMarkets;
    marketCache.lastFetch = now;

    return cryptoMarkets;
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
}

// Parse market to extract token, strike price, and determine both sides
function parseMarket(market) {
  const ticker = (market.ticker || '').toUpperCase();
  const title = (market.title || '').toLowerCase();

  // Find which token this market is for
  let cryptoType = null;
  for (const [token, cfg] of Object.entries(TRACKED_TOKENS)) {
    if (ticker.includes(token) || title.includes(token.toLowerCase()) || title.includes(cfg.name.toLowerCase())) {
      cryptoType = token;
      break;
    }
  }

  // Extract strike price from title
  let strikePrice = null;
  const priceMatches = title.match(/\$?([\d,]+(?:\.\d+)?)/g);
  if (priceMatches && cryptoType) {
    const cfg = TRACKED_TOKENS[cryptoType];
    for (const match of priceMatches) {
      const price = parseFloat(match.replace(/[$,]/g, ''));
      if (price >= cfg.minPrice && price <= cfg.maxPrice) {
        strikePrice = price;
        break;
      }
    }
  }

  // Determine market type (above/below/between)
  let marketType = null;
  if (title.includes('above') || title.includes('>=') || title.includes('higher') ||
      title.includes('or more') || title.includes('over')) {
    marketType = 'above'; // YES = price above strike
  } else if (title.includes('below') || title.includes('<=') || title.includes('lower') ||
             title.includes('or less') || title.includes('under')) {
    marketType = 'below'; // YES = price below strike
  } else if (title.includes('between')) {
    marketType = 'between';
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
    marketType,
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

// Analyze market and find the best side to bet (YES or NO)
function analyzeCryptoMarket(parsed) {
  if (!parsed.cryptoType || !parsed.strikePrice || !parsed.marketType || parsed.marketType === 'between') {
    return null;
  }

  const priceData = cryptoPrices[parsed.cryptoType];
  if (!priceData || !priceData.price) {
    return null;
  }

  const currentPrice = priceData.price;
  const volatility = priceData.volatility;
  const timeMinutes = parsed.timeRemainingMinutes || 15;

  // Calculate probabilities
  const { probAbove, probBelow } = calculateProbability(currentPrice, parsed.strikePrice, volatility);

  // For "above" markets: YES wins if price > strike
  // For "below" markets: YES wins if price < strike
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = probAbove;
    probNoWins = probBelow;
  } else { // below
    probYesWins = probBelow;
    probNoWins = probAbove;
  }

  // Market implied probabilities from prices
  // YES ask = price to buy YES, implies market thinks YES probability is roughly YES ask
  // NO ask = price to buy NO, implies market thinks NO probability is roughly NO ask
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge for both sides
  // Edge = our probability - market's implied probability
  const edgeYes = (probYesWins - marketProbYes) * 100;
  const edgeNo = (probNoWins - marketProbNo) * 100;

  // Pick the side with better edge (if either has positive edge)
  let betSide = null;
  let betPrice = 0;
  let ourProbability = 0;
  let marketImpliedProb = 0;
  let edge = 0;

  if (edgeYes > edgeNo && edgeYes > 0 && parsed.yesAsk > 0 && parsed.yesAsk < 0.98) {
    betSide = 'YES';
    betPrice = parsed.yesAsk;
    ourProbability = probYesWins;
    marketImpliedProb = marketProbYes;
    edge = edgeYes;
  } else if (edgeNo > 0 && parsed.noAsk > 0 && parsed.noAsk < 0.98) {
    betSide = 'NO';
    betPrice = parsed.noAsk;
    ourProbability = probNoWins;
    marketImpliedProb = marketProbNo;
    edge = edgeNo;
  }

  // Show opportunities with any positive edge (filtering happens at API level)
  if (!betSide || edge < 0.5) {
    return null;
  }

  // Profit potential if we win
  const profitPotential = ((1 - betPrice) / betPrice) * 100;

  // Fixed bet amount ($1) for sustainable growth
  const recommendedBet = config.fixedBetAmount || config.minBetAmount;

  return {
    ...parsed,
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    probYesWins: probYesWins * 100,
    probNoWins: probNoWins * 100,
    ourProbability: ourProbability * 100,
    marketImpliedProb: marketImpliedProb * 100,
    edgeYes,
    edgeNo,
    edge,
    betSide,
    betPrice,
    profitPotential,
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

// Get current prices for all tokens
app.get('/api/crypto/prices', (req, res) => {
  const prices = {};
  for (const [token, data] of Object.entries(cryptoPrices)) {
    if (data.price > 0) {
      prices[token] = {
        price: data.price,
        volatility: (data.volatility * 100).toFixed(2) + '%',
        lastUpdate: data.timestamp,
        dataPoints: data.history.length
      };
    }
  }

  res.json({
    success: true,
    prices,
    trackedTokens: Object.keys(TRACKED_TOKENS),
    timestamp: Date.now()
  });
});

// Get betting opportunities
app.get('/api/crypto/opportunities', async (req, res) => {
  try {
    const markets = await fetchCryptoMarkets();

    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => m !== null && m.edge >= config.minEdge)
      .sort((a, b) => b.edge - a.edge);

    // Get simplified price object for display
    const priceDisplay = {};
    for (const token of Object.keys(cryptoPrices)) {
      if (cryptoPrices[token].price > 0) {
        priceDisplay[token] = cryptoPrices[token].price;
      }
    }

    res.json({
      success: true,
      count: opportunities.length,
      minEdge: config.minEdge,
      prices: priceDisplay,
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
        scanned: markets.length
      });
    }

    const best = opportunities[0];

    // Fixed $1 bets
    let betAmount = config.fixedBetAmount || 100;
    betAmount = Math.min(betAmount, config.bankroll);

    if (config.bankroll < 100) {
      return res.json({
        success: true,
        message: 'Bankroll too low (need $1 minimum)',
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
      cryptoType: best.cryptoType,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost: count * priceCents,
      edge: best.edge,
      ourProbability: best.ourProbability,
      currentPrice: best.currentPrice,
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

// Toggle auto-betting
let autoBetInterval = null;

async function runAutoBet() {
  try {
    console.log('🤖 Scanning for opportunities...');

    const markets = await fetchCryptoMarkets();
    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => m !== null && m.edge >= config.minEdge)
      .sort((a, b) => b.edge - a.edge);

    console.log(`📊 Found ${markets.length} markets, ${opportunities.length} with edge`);

    if (opportunities.length === 0) {
      return;
    }

    const best = opportunities[0];
    console.log(`💰 Best: ${best.cryptoType} | ${best.betSide} | Edge: +${best.edge.toFixed(1)}%`);

    // Fixed $1 bets for sustainable growth
    let betAmount = config.fixedBetAmount || 100;
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
      cryptoType: best.cryptoType,
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
      console.log(`🎰 Simulated: ${betRecord.side.toUpperCase()} on ${best.cryptoType} | $${(betRecord.totalCost/100).toFixed(2)}`);
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

    console.log(`🎰 Placed: ${betRecord.side.toUpperCase()} on ${best.cryptoType}`);

  } catch (error) {
    console.error('Auto-bet error:', error.message);
  }
}

app.post('/api/crypto/auto-bet/toggle', (req, res) => {
  const { enabled, intervalSeconds = 15 } = req.body; // Check every 15 seconds

  if (enabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;

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
      maxBetPercent: config.maxBetPercent,
      autoBetEnabled: config.autoBetEnabled
    }
  });
});

app.post('/api/settings', (req, res) => {
  const { bankroll, minEdge, maxBetPercent } = req.body;

  if (bankroll !== undefined) config.bankroll = Math.round(bankroll * 100);
  if (minEdge !== undefined) config.minEdge = minEdge;
  if (maxBetPercent !== undefined) config.maxBetPercent = maxBetPercent;

  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      minEdge: config.minEdge,
      maxBetPercent: config.maxBetPercent
    }
  });
});

app.get('/api/health', (req, res) => {
  const activePrices = Object.entries(cryptoPrices)
    .filter(([_, d]) => d.price > 0)
    .map(([t, d]) => `${t}: $${d.price.toFixed(2)}`);

  res.json({
    status: 'ok',
    trackedTokens: Object.keys(TRACKED_TOKENS).length,
    activePrices: activePrices.length,
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
  console.log(`📊 Tracking ${Object.keys(TRACKED_TOKENS).length} tokens: ${Object.keys(TRACKED_TOKENS).join(', ')}`);
  console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
