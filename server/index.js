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
  minEdge: 5, // 5% minimum - model has uncertainty, need buffer
  autoBetEnabled: false
};

let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// ============================================
// AUTO-LOAD CREDENTIALS FROM ENVIRONMENT
// ============================================
// Set these in Render dashboard under Environment Variables:
//   KALSHI_API_KEY_ID = your API key ID
//   KALSHI_PRIVATE_KEY = your private key (replace newlines with \n)
//
// For the private key, you can either:
//   1. Replace actual newlines with literal \n characters
//   2. Or base64 encode it and set KALSHI_PRIVATE_KEY_BASE64 instead

async function loadCredentialsFromEnv() {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  let privateKey = process.env.KALSHI_PRIVATE_KEY;

  // Support base64-encoded private key (easier to paste in Render)
  if (!privateKey && process.env.KALSHI_PRIVATE_KEY_BASE64) {
    try {
      privateKey = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    } catch (e) {
      console.error('Failed to decode KALSHI_PRIVATE_KEY_BASE64:', e.message);
    }
  }

  // Handle escaped newlines (common when pasting in env var UIs)
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (apiKeyId && privateKey) {
    console.log('🔑 Found Kalshi credentials in environment variables');
    config.apiKeyId = apiKeyId.trim();
    config.privateKey = privateKey.trim();
    config.isAuthenticated = true;

    // Verify credentials by fetching balance
    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;
      console.log(`✅ Kalshi authenticated! Balance: $${(portfolio.balance / 100).toFixed(2)}`);
    } catch (error) {
      console.error('❌ Kalshi credentials invalid:', error.message);
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;
    }
  } else {
    console.log('ℹ️ No Kalshi credentials in environment. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_BASE64) in Render dashboard.');
  }
}

// Track markets we've already bet on to avoid duplicate bets
// Key: ticker, Value: { timestamp, side }
const recentBets = new Map();

// Edge requirements - lower for "obvious" high-probability bets
// Strategy: Safe growth from $10 → $100 by taking high-probability bets
const AUTO_BET_MIN_EDGE = 3;      // 3% edge for auto (lower for safe bets)
const MANUAL_BET_MIN_EDGE = 2;    // 2% edge for manual
const OBVIOUS_BET_MIN_EDGE = 1;   // 1% edge OK if probability is >90% (free money)

// ============================================
// CRYPTO PRICE TRACKING - EXPANDED TOKENS
// ============================================

// All tokens we track - with price ranges for strike detection
const TRACKED_TOKENS = {
  BTC: { name: 'Bitcoin', minPrice: 10000, maxPrice: 500000 },
  ETH: { name: 'Ethereum', minPrice: 100, maxPrice: 20000 },
  SOL: { name: 'Solana', minPrice: 1, maxPrice: 1000 },
  XRP: { name: 'XRP', minPrice: 0.1, maxPrice: 100 },
  DOGE: { name: 'Dogecoin', minPrice: 0.01, maxPrice: 10 },
  ADA: { name: 'Cardano', minPrice: 0.1, maxPrice: 50 },
  AVAX: { name: 'Avalanche', minPrice: 1, maxPrice: 500 },
  LINK: { name: 'Chainlink', minPrice: 1, maxPrice: 200 },
  MATIC: { name: 'Polygon', minPrice: 0.1, maxPrice: 50 },
  DOT: { name: 'Polkadot', minPrice: 1, maxPrice: 200 },
  SHIB: { name: 'Shiba Inu', minPrice: 0.000001, maxPrice: 0.001 },
  LTC: { name: 'Litecoin', minPrice: 10, maxPrice: 1000 },
  UNI: { name: 'Uniswap', minPrice: 1, maxPrice: 100 },
  ATOM: { name: 'Cosmos', minPrice: 1, maxPrice: 100 },
  APT: { name: 'Aptos', minPrice: 1, maxPrice: 100 }
};

// Price data storage
const cryptoPrices = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  cryptoPrices[token] = { price: 0, timestamp: 0, history: [], volatility: 0.02 };
});

// CoinGecko ID mapping
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin',
  ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink', MATIC: 'matic-network',
  DOT: 'polkadot', SHIB: 'shiba-inu', LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos', APT: 'aptos'
};

// Fetch all prices from CoinGecko (works globally, no restrictions)
async function fetchCryptoPrices() {
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const data = await res.json();

    if (data.error) {
      console.error('CoinGecko error:', data.error);
      return null;
    }

    const now = Date.now();

    // Update each tracked token
    for (const [token, geckoId] of Object.entries(COINGECKO_IDS)) {
      const priceData = data[geckoId];
      if (priceData && priceData.usd > 0) {
        const price = priceData.usd;
        cryptoPrices[token].price = price;
        cryptoPrices[token].timestamp = now;

        // Keep 60 price points for volatility calculation
        cryptoPrices[token].history.push({ price, time: now });
        if (cryptoPrices[token].history.length > 60) {
          cryptoPrices[token].history.shift();
        }

        // Keep extended history for statistical analysis (2 hours)
        if (!priceHistoryExtended[token]) priceHistoryExtended[token] = [];
        priceHistoryExtended[token].push({ price, time: now });
        // Keep last 2 hours (720 points at 10-second intervals)
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        priceHistoryExtended[token] = priceHistoryExtended[token].filter(p => p.time > twoHoursAgo);

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

// ============================================
// STATISTICAL ANALYSIS ENGINE
// ============================================

// Store extended price history for analysis (last 2 hours)
const priceHistoryExtended = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  priceHistoryExtended[token] = [];
});

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

// Calculate momentum (recent price trend)
// Returns: positive = uptrend, negative = downtrend, magnitude = strength
function calculateMomentum(history, lookbackMinutes = 5) {
  if (history.length < 5) return { trend: 0, strength: 'weak' };

  const now = Date.now();
  const lookbackMs = lookbackMinutes * 60 * 1000;

  // Get prices in the lookback window
  const recentPrices = history.filter(p => now - p.time < lookbackMs);
  if (recentPrices.length < 3) return { trend: 0, strength: 'weak' };

  // Calculate trend using linear regression
  const n = recentPrices.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  recentPrices.forEach((p, i) => {
    sumX += i;
    sumY += p.price;
    sumXY += i * p.price;
    sumX2 += i * i;
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = sumY / n;

  // Normalize slope as percentage per minute
  const trendPctPerMin = (slope / avgPrice) * 100;

  // Classify strength
  let strength = 'weak';
  if (Math.abs(trendPctPerMin) > 0.1) strength = 'moderate';
  if (Math.abs(trendPctPerMin) > 0.3) strength = 'strong';

  return {
    trend: trendPctPerMin,
    strength,
    direction: trendPctPerMin > 0.05 ? 'up' : trendPctPerMin < -0.05 ? 'down' : 'neutral'
  };
}

// Analyze historical price crossings
// Given current price and a target, how often does price cross that target in X minutes?
function analyzeHistoricalCrossings(history, currentPrice, targetPrice, windowMinutes = 15) {
  if (history.length < 30) {
    return { crossingProb: 0.5, sampleSize: 0, reliable: false };
  }

  const windowMs = windowMinutes * 60 * 1000;
  let crossings = 0;
  let totalWindows = 0;

  // Look at historical windows
  for (let i = 0; i < history.length - 10; i++) {
    const startPrice = history[i].price;
    const startTime = history[i].time;

    // Find prices within the window
    const windowPrices = history.filter(p =>
      p.time > startTime && p.time <= startTime + windowMs
    );

    if (windowPrices.length < 3) continue;
    totalWindows++;

    // Did price cross the equivalent target?
    // Scale target relative to start price
    const relativeTarget = targetPrice / currentPrice;
    const scaledTarget = startPrice * relativeTarget;

    const didCross = windowPrices.some(p => {
      if (currentPrice > targetPrice) {
        // Currently above target - did it drop below?
        return p.price < scaledTarget;
      } else {
        // Currently below target - did it rise above?
        return p.price > scaledTarget;
      }
    });

    if (didCross) crossings++;
  }

  const crossingProb = totalWindows > 0 ? crossings / totalWindows : 0.5;

  return {
    crossingProb,
    sampleSize: totalWindows,
    reliable: totalWindows >= 10
  };
}

// Main statistical prediction function
// Returns probability that price will be above/below target at expiry
function predictOutcome(token, currentPrice, targetPrice, expiryMinutes = 15) {
  const history = cryptoPrices[token]?.history || [];
  const extHistory = priceHistoryExtended[token] || [];

  // Combine histories for analysis
  const allHistory = [...extHistory, ...history].sort((a, b) => a.time - b.time);

  // 1. Calculate volatility-based probability (baseline)
  const volatility = cryptoPrices[token]?.volatility || 0.025;

  // KEY INSIGHT: Scale volatility by time remaining
  // Less time = less chance for price to move = current position more likely to hold
  // sqrt(time) scaling because volatility scales with sqrt of time
  const timeScaleFactor = Math.sqrt(expiryMinutes / 15);  // 1.0 at 15min, 0.58 at 5min, 0.41 at 2.5min
  const adjustedVolatility = volatility * timeScaleFactor;

  const pctFromTarget = (currentPrice - targetPrice) / targetPrice;
  // How many "adjusted standard deviations" away is the current price?
  const zScore = pctFromTarget / adjustedVolatility;

  // Base probability from normal distribution
  // Higher z-score = more likely to stay on current side
  let probAbove = normalCDF(zScore);
  let probBelow = 1 - probAbove;

  // 2. TIME DECAY BOOST
  // If price has moved significantly AND little time remains, boost confidence
  // E.g., price 2% above strike with only 3 minutes left = very likely to stay above
  const timeRemainingRatio = expiryMinutes / 15;  // 1.0 at start, 0.2 at 3min left
  const priceDistanceRatio = Math.abs(pctFromTarget) / adjustedVolatility;

  if (priceDistanceRatio > 0.5 && timeRemainingRatio < 0.5) {
    // Price has moved AND time is running out
    // Boost the probability of staying on current side
    const timeDecayBoost = (1 - timeRemainingRatio) * 0.15;  // Up to +15% at expiry

    if (currentPrice > targetPrice) {
      probAbove = Math.min(0.95, probAbove + timeDecayBoost);
      probBelow = 1 - probAbove;
    } else {
      probBelow = Math.min(0.95, probBelow + timeDecayBoost);
      probAbove = 1 - probBelow;
    }
  }

  // 3. Adjust for momentum
  const momentum = calculateMomentum(allHistory, 5);

  // Momentum adjustment: if trending in a direction, boost that side
  let momentumAdjustment = 0;
  if (momentum.strength === 'strong') {
    momentumAdjustment = momentum.trend > 0 ? 0.10 : -0.10;  // ±10%
  } else if (momentum.strength === 'moderate') {
    momentumAdjustment = momentum.trend > 0 ? 0.05 : -0.05;  // ±5%
  }

  probAbove = Math.max(0.05, Math.min(0.95, probAbove + momentumAdjustment));
  probBelow = 1 - probAbove;

  // 4. Check historical crossing data
  const crossingAnalysis = analyzeHistoricalCrossings(allHistory, currentPrice, targetPrice, expiryMinutes);

  if (crossingAnalysis.reliable) {
    // Blend with historical data (weight: 30% historical, 70% model)
    const historicalProbCross = crossingAnalysis.crossingProb;

    if (currentPrice > targetPrice) {
      const blendedProbBelow = 0.3 * historicalProbCross + 0.7 * probBelow;
      probBelow = blendedProbBelow;
      probAbove = 1 - probBelow;
    } else {
      const blendedProbAbove = 0.3 * historicalProbCross + 0.7 * probAbove;
      probAbove = blendedProbAbove;
      probBelow = 1 - probAbove;
    }
  }

  // 5. Calculate confidence based on data quality AND time remaining
  // More confident when: more data, strong momentum, less time remaining
  const timeConfidenceBoost = (1 - timeRemainingRatio) * 0.2;  // Up to +20% confidence near expiry
  const confidence = Math.min(0.95,
    0.4 +  // Base confidence
    (allHistory.length / 200) * 0.2 +  // Data quality
    (momentum.strength === 'strong' ? 0.15 : momentum.strength === 'moderate' ? 0.08 : 0) +
    timeConfidenceBoost
  );

  return {
    probAbove,
    probBelow,
    momentum,
    volatility,
    adjustedVolatility,
    zScore,
    confidence,
    timeRemaining: expiryMinutes,
    dataPoints: allHistory.length,
    analysis: {
      method: crossingAnalysis.reliable ? 'historical+model' : 'model',
      momentumDirection: momentum.direction,
      momentumStrength: momentum.strength,
      timeDecayApplied: priceDistanceRatio > 0.5 && timeRemainingRatio < 0.5
    }
  };
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

// Calculate how many standard deviations the current price is from strike
// This helps identify "obvious" mispricings
function calculateZScore(currentPrice, strikePrice, volatility) {
  const pctDiff = (currentPrice - strikePrice) / strikePrice;
  return pctDiff / volatility;  // How many std devs away
}

// Simple probability estimate based on distance from strike
// More robust than complex volatility model for short timeframes
function simpleEdgeCheck(currentPrice, strikePrice, marketPrice, side, volatility) {
  const pctFromStrike = (currentPrice - strikePrice) / strikePrice * 100;
  const zScore = calculateZScore(currentPrice, strikePrice, volatility);

  // For "above/up" markets: YES wins if price ends >= strike
  // If current price is ABOVE strike, YES is more likely
  // If current price is BELOW strike, NO is more likely

  let result = {
    pctFromStrike,
    zScore,
    isObviousBet: false,
    obviousSide: null,
    obviousEdge: 0
  };

  // "Obvious" bet: price is far from strike (2+ std devs)
  // These are potential "free money" situations
  if (Math.abs(zScore) >= 1.5) {
    if (zScore > 0) {
      // Price is well ABOVE strike - YES (above) is very likely
      // If YES is cheap (< 85¢), there's edge
      result.isObviousBet = true;
      result.obviousSide = 'YES';
      // Estimate: if 1.5+ std devs above, ~93% chance it stays above
      const estimatedProb = normalCDF(zScore);  // Prob of staying above
      result.obviousEdge = (estimatedProb - marketPrice) * 100;
    } else {
      // Price is well BELOW strike - NO (below) is very likely
      // If NO is cheap (< 85¢), there's edge
      result.isObviousBet = true;
      result.obviousSide = 'NO';
      const estimatedProb = normalCDF(-zScore);  // Prob of staying below
      result.obviousEdge = (estimatedProb - (1 - marketPrice)) * 100;
    }
  }

  return result;
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
    // Fetch crypto markets directly by series ticker instead of filtering 1000+ markets
    // This ensures we get the 15-minute crypto markets that would otherwise be buried
    const cryptoSeries = [
      // 15-minute markets (short term, high frequency)
      'KXBTC15M',   // Bitcoin 15-minute up/down
      'KXETH15M',   // Ethereum 15-minute up/down
      'KXSOL15M',   // Solana 15-minute up/down

      // Daily above/below markets
      'KXBTCD',     // Bitcoin above/below
      'KXETHD',     // Ethereum above/below
      'KXSOLD',     // Solana above/below
      'KXXRPD',     // XRP above/below
      'KXDOGED',    // Doge above/below
      'KXLTCD',     // Litecoin above/below
      'KXLINKD',    // Chainlink above/below
      'KXAVAXD',    // Avalanche above/below
      'KXDOTD',     // Polkadot above/below
      'KXSHIBAD',   // Shiba above/below

      // Range/min/max markets (look for mispricings)
      'KXBTCMAXD',  // BTC max daily
      'KXBTC',      // Bitcoin range
      'KXETH',      // Ethereum range
      'KXSOL',      // Solana range
      'KXXRP',      // XRP range

      // Monthly directional
      'KXBTCMAXM',  // BTC max monthly
      'KXETHMAXM',  // ETH max monthly
      'KXSOLMAXM',  // SOL max monthly
    ];

    const allMarkets = [];

    // Fetch each crypto series in parallel
    const fetches = cryptoSeries.map(async (series) => {
      try {
        const data = await kalshiRequest('GET', `/markets?limit=100&status=open&series_ticker=${series}`);
        return data.markets || [];
      } catch (e) {
        console.log(`No markets for ${series}`);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    results.forEach(markets => allMarkets.push(...markets));

    // Also try the general crypto filter as backup
    try {
      const data = await kalshiRequest('GET', '/markets?limit=1000&status=open');
      const markets = data.markets || [];

      markets.forEach(m => {
        const ticker = (m.ticker || '').toUpperCase();
        const title = (m.title || '').toUpperCase();

        // Check if already added
        if (allMarkets.some(existing => existing.ticker === m.ticker)) return;

        // Check if it's a crypto market
        let isCrypto = false;
        for (const [token, cfg] of Object.entries(TRACKED_TOKENS)) {
          if (ticker.includes(token) || title.includes(token) || title.includes(cfg.name.toUpperCase())) {
            isCrypto = true;
            break;
          }
        }

        if (isCrypto) allMarkets.push(m);
      });
    } catch (e) {
      console.log('Backup market fetch failed:', e.message);
    }

    // Filter for short-term markets (within 4 hours, more than 30 seconds remaining)
    const cryptoMarkets = allMarkets.filter(m => {
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      const isShortTerm = timeRemaining && timeRemaining > 30000 && timeRemaining < 4 * 60 * 60 * 1000;
      return isShortTerm;
    });

    console.log(`📊 Fetched ${allMarkets.length} crypto markets, ${cryptoMarkets.length} short-term`);

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

  // Extract strike price - check floor_strike first (for 15-minute markets), then title
  let strikePrice = null;
  if (market.floor_strike && typeof market.floor_strike === 'number') {
    strikePrice = market.floor_strike;
  } else {
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
  }

  // Determine market type (above/below/between)
  // 15-minute markets use "up" (YES = price goes up = above starting price)
  let marketType = null;
  if (title.includes('above') || title.includes('>=') || title.includes('higher') ||
      title.includes('or more') || title.includes('over') || title.includes(' up')) {
    marketType = 'above'; // YES = price above strike
  } else if (title.includes('below') || title.includes('<=') || title.includes('lower') ||
             title.includes('or less') || title.includes('under') || title.includes(' down')) {
    marketType = 'below'; // YES = price below strike
  } else if (title.includes('between')) {
    marketType = 'between';
  }

  // Time remaining
  const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
  const timeRemaining = closeTime ? closeTime - Date.now() : null;
  const timeRemainingMinutes = timeRemaining ? timeRemaining / (60 * 1000) : null;

  // Kalshi API returns prices in cents (0-100), convert to probability (0-1)
  // e.g., yes_ask: 4 means $0.04 = 4% probability
  const yesAsk = (parseFloat(market.yes_ask) || 0) / 100;
  const noAsk = (parseFloat(market.no_ask) || 0) / 100;
  const yesBid = (parseFloat(market.yes_bid) || 0) / 100;
  const noBid = (parseFloat(market.no_bid) || 0) / 100;

  return {
    ticker: market.ticker,
    title: market.title,
    cryptoType,
    strikePrice,
    marketType,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    volume: parseInt(market.volume) || 0
  };
}

// Analyze market and find the SAFEST side to bet (highest win probability)
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

  // Calculate how far price is from strike
  const pctFromStrike = ((currentPrice - parsed.strikePrice) / parsed.strikePrice) * 100;

  // USE STATISTICAL PREDICTION ENGINE
  // This analyzes historical data, momentum, and volatility
  const prediction = predictOutcome(
    parsed.cryptoType,
    currentPrice,
    parsed.strikePrice,
    timeMinutes
  );

  // For "above/up" markets: YES wins if price >= strike at expiry
  // For "below/down" markets: YES wins if price < strike at expiry
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = prediction.probAbove;
    probNoWins = prediction.probBelow;
  } else {
    probYesWins = prediction.probBelow;
    probNoWins = prediction.probAbove;
  }

  // Market implied probabilities from ask prices
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge for BOTH sides
  const yesEdge = (probYesWins - marketProbYes) * 100;
  const noEdge = (probNoWins - marketProbNo) * 100;

  // Build analysis description
  const momentumDesc = prediction.momentum.direction === 'up' ? '📈 UP' :
                       prediction.momentum.direction === 'down' ? '📉 DOWN' : '➡️ flat';
  const timeDesc = prediction.analysis.timeDecayApplied ? '⏰ time decay' : '';

  // ============================================
  // SAFETY-FIRST BET SELECTION
  // ============================================
  // Strategy: Pick the side with HIGHEST WIN PROBABILITY
  // Only requirement: must have SOME positive edge (>0.5%)
  // We don't care about profit size - we want SAFE wins

  let bestBet = null;

  // Evaluate YES side
  const yesValid = parsed.yesAsk > 0 && parsed.yesAsk < 0.98 && yesEdge > 0.5;
  // Evaluate NO side
  const noValid = parsed.noAsk > 0 && parsed.noAsk < 0.98 && noEdge > 0.5;

  // Pick the side with HIGHER WIN PROBABILITY (safest bet)
  if (yesValid && noValid) {
    // Both sides have positive edge - pick the one with higher probability
    if (probYesWins >= probNoWins) {
      bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
    } else {
      bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
    }
  } else if (yesValid) {
    bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
  } else if (noValid) {
    bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
  }

  // No valid bet found
  if (!bestBet) {
    return null;
  }

  // Determine if this is a "safe" bet (high confidence)
  const isHighProb = bestBet.prob >= 0.60;
  const isSafeBet = bestBet.prob >= 0.70;

  // Build reason string
  const probPct = (bestBet.prob * 100).toFixed(0);
  const betReason = `${momentumDesc} ${timeDesc} | ${probPct}% win prob`;

  // Calculate expected profit per $1 bet
  const profitPerContract = 1 - bestBet.price;
  const expectedProfit = (bestBet.prob * profitPerContract - (1 - bestBet.prob) * bestBet.price) * 100;

  // Profit if we win (per contract at $1 payout)
  const profitIfWin = ((1 - bestBet.price) * 100).toFixed(0);
  const profitPotential = ((1 - bestBet.price) / bestBet.price) * 100;

  // Fixed bet amount ($1) for sustainable growth
  const recommendedBet = config.fixedBetAmount || config.minBetAmount;

  return {
    ...parsed,
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    pctFromStrike: pctFromStrike.toFixed(2),
    zScore: prediction.zScore.toFixed(2),
    probYesWins: probYesWins * 100,
    probNoWins: probNoWins * 100,
    ourProbability: bestBet.prob * 100,
    winProbability: (bestBet.prob * 100).toFixed(1),
    marketImpliedProb: bestBet.price * 100,
    yesEdge,
    noEdge,
    edge: bestBet.edge,
    betSide: bestBet.side,
    betPrice: bestBet.price,
    betReason,
    profitIfWin,
    expectedProfit: expectedProfit.toFixed(1),
    profitPotential,
    recommendedBet,
    isObviousBet: isSafeBet,
    isHighProb,
    // Statistical analysis info
    momentum: prediction.momentum.direction,
    momentumStrength: prediction.momentum.strength,
    confidence: (prediction.confidence * 100).toFixed(0) + '%',
    dataPoints: prediction.dataPoints,
    analysisMethod: prediction.analysis.method,
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
      .filter(m => m !== null && m.edge >= 0.5) // Only need 0.5% edge minimum
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

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

    // Kalshi API returns prices in cents already (e.g., yes_ask: 4 means 4 cents)
    const priceCents = side.toLowerCase() === 'yes'
      ? parseFloat(market.yes_ask) || 0
      : parseFloat(market.no_ask) || 0;

    if (!priceCents || priceCents <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid market price' });
    }
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

// Auto-bet on best opportunity (Place Best Bet button)
app.post('/api/crypto/auto-bet', async (req, res) => {
  try {
    const markets = await fetchCryptoMarkets();
    const now = Date.now();

    // Clean up old bets from tracking (older than 30 min)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => {
        if (m === null) return false;
        // Skip if we already bet on this exact market
        if (recentBets.has(m.ticker)) return false;
        // Only need minimal edge (0.5%) - we prioritize safety
        if (m.edge < 0.5) return false;
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: 'No opportunities found with positive edge. Waiting for safer bets...',
        bet: null,
        scanned: markets.length
      });
    }

    const best = opportunities[0];

    // Fixed $1 max bet - never exceed this
    const MAX_BET_CENTS = 100; // $1.00 max

    if (config.bankroll < 100) {
      return res.json({
        success: true,
        message: 'Bankroll too low (need $1 minimum)',
        bet: null
      });
    }

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost at $1
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      return res.json({ success: true, message: 'Bet size too small', bet: null });
    }

    // Ensure we don't exceed $1 total
    const totalCost = count * priceCents;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      cryptoType: best.cryptoType,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      edge: best.edge,
      ourProbability: best.ourProbability,
      currentPrice: best.currentPrice,
      strikePrice: best.strikePrice,
      timestamp: new Date().toISOString(),
      status: 'pending',
      auto: true
    };

    // Mark this market as bet on
    recentBets.set(best.ticker, { timestamp: now, side: best.betSide });

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
    const now = Date.now();

    // Clean up old bets (remove bets older than 30 minutes)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => {
        if (m === null) return false;
        // Skip if we already bet on this exact market
        if (recentBets.has(m.ticker)) {
          return false;
        }
        // Only need minimal edge (0.5%) - we prioritize safety
        if (m.edge < 0.5) return false;
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    const safeCount = opportunities.filter(o => parseFloat(o.winProbability) >= 70).length;
    console.log(`📊 Found ${markets.length} markets, ${opportunities.length} with edge (${safeCount} above 70% win prob)`);

    if (opportunities.length === 0) {
      console.log('⏳ No opportunities - waiting for next scan...');
      return;
    }

    const best = opportunities[0];
    console.log(`\n💰 BEST OPPORTUNITY:`);
    console.log(`   ${best.title}`);
    console.log(`   ${best.betReason}`);
    console.log(`   Side: ${best.betSide} @ ${(best.betPrice * 100).toFixed(0)}¢ | Win prob: ${best.winProbability}%`);
    console.log(`   Current: $${best.currentPrice.toFixed(2)} | Strike: $${best.strikePrice.toFixed(2)} (${best.pctFromStrike}% away)`);
    console.log(`   Edge: +${best.edge.toFixed(1)}% | Profit if win: ${best.profitIfWin}¢ per contract`);
    console.log(`   ${best.isObviousBet ? '✅ HIGH CONFIDENCE - Safe bet' : '⚠️ Model-based - Use caution'}`);

    // Fixed $1 max bet - never exceed this
    const MAX_BET_CENTS = 100; // $1.00 max
    let betAmount = Math.min(MAX_BET_CENTS, config.bankroll);

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost at $1
    let count = Math.floor(betAmount / priceCents);
    if (count < 1) {
      console.log('⚠️ Bet size too small');
      return;
    }

    // Ensure we don't exceed $1 total
    const totalCost = count * priceCents;
    if (totalCost > MAX_BET_CENTS) {
      count = Math.floor(MAX_BET_CENTS / priceCents);
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

    // Mark this market as bet on BEFORE placing the bet
    recentBets.set(best.ticker, { timestamp: now, side: best.betSide });

    if (!config.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;
      console.log(`🎰 Simulated: ${betRecord.side.toUpperCase()} on ${best.cryptoType} | $${(betRecord.totalCost/100).toFixed(2)} | Edge: ${best.edge.toFixed(1)}%`);
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

    console.log(`🎰 Placed: ${betRecord.side.toUpperCase()} on ${best.cryptoType} | $${(betRecord.totalCost/100).toFixed(2)} | Edge: ${best.edge.toFixed(1)}%`);

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

app.get('/api/portfolio', async (req, res) => {
  try {
    // If authenticated, fetch real data from Kalshi
    if (config.isAuthenticated) {
      // Fetch balance
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      // Fetch recent fills (completed trades) - last 20
      let realBetHistory = [];
      try {
        const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=20');
        const fills = fillsData.fills || [];

        // Transform fills into our bet history format
        realBetHistory = fills.map(fill => {
          const count = fill.count || 1;
          // Kalshi API can return price in different formats:
          // - As cents (0-100): e.g., 10 = 10 cents
          // - As decimal probability (0-1): e.g., 0.10 = 10 cents
          // We need to normalize to cents
          let priceCents = fill.price || 0;
          if (priceCents > 0 && priceCents <= 1) {
            // Price is a decimal probability, convert to cents
            priceCents = Math.round(priceCents * 100);
          }
          // Total cost = number of contracts × price per contract (in cents)
          const totalCost = count * priceCents;

          console.log(`Fill: ${fill.ticker} | count=${count} | price=${fill.price} | priceCents=${priceCents} | totalCost=${totalCost}`);

          return {
            id: fill.trade_id || fill.fill_id || Date.now().toString(),
            ticker: fill.ticker,
            title: fill.ticker,
            side: fill.side,
            count,
            price: priceCents,
            totalCost,
            timestamp: fill.created_time || fill.ts || new Date().toISOString(),
            status: 'pending', // Will be updated below
            action: fill.action || 'buy',
            orderId: fill.order_id,
            outcome: null, // Will be 'won', 'lost', or null (pending)
            payout: 0,
            profit: 0
          };
        });

        // Get market data including settlement results
        const uniqueTickers = [...new Set(realBetHistory.map(b => b.ticker))];
        const marketData = {};

        for (const ticker of uniqueTickers.slice(0, 15)) {
          try {
            const data = await kalshiRequest('GET', `/markets/${ticker}`);
            if (data.market) {
              marketData[ticker] = {
                title: data.market.title || ticker,
                result: data.market.result, // 'yes', 'no', or null if not settled
                status: data.market.status, // 'open', 'closed', 'settled'
                closeTime: data.market.close_time
              };
            }
          } catch (e) {
            marketData[ticker] = { title: ticker, result: null, status: 'unknown' };
          }
        }

        // Update bets with market data and calculate outcomes
        realBetHistory = realBetHistory.map(bet => {
          const market = marketData[bet.ticker] || {};
          const title = market.title || bet.ticker;
          const result = market.result; // 'yes' or 'no' if settled
          const marketStatus = market.status;

          let outcome = null;
          let status = 'open';
          let payout = 0;
          let profit = 0;

          // Only calculate outcomes for buy orders (not sells)
          const isBuy = bet.action?.toLowerCase() !== 'sell';

          if (result && isBuy) {
            // Market has settled - determine if we won
            const betSide = bet.side?.toLowerCase();
            const wonBet = (betSide === result);

            outcome = wonBet ? 'won' : 'lost';
            status = 'settled';

            if (wonBet) {
              // Won: payout is $1 per contract (100 cents)
              payout = bet.count * 100;
              profit = payout - bet.totalCost;
            } else {
              // Lost: lose the entire bet amount (totalCost)
              payout = 0;
              profit = -bet.totalCost;
            }

            console.log(`Outcome: ${bet.ticker} | side=${betSide} | result=${result} | won=${wonBet} | cost=${bet.totalCost} | profit=${profit}`);
          } else if (marketStatus === 'closed') {
            status = 'closed';
          } else {
            status = 'open';
          }

          return {
            ...bet,
            title,
            status,
            outcome,
            payout,
            profit,
            marketResult: result,
            closeTime: market.closeTime
          };
        });

      } catch (fillError) {
        console.error('Error fetching fills:', fillError.message);
        realBetHistory = betHistory.slice(0, 20);
      }

      // Merge with in-memory history
      const combinedHistory = [...realBetHistory];
      betHistory.forEach(memBet => {
        if (!combinedHistory.some(b => b.orderId === memBet.orderId || b.id === memBet.id)) {
          combinedHistory.push(memBet);
        }
      });

      // Sort by timestamp descending
      combinedHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate totals
      const settled = combinedHistory.filter(b => b.outcome);
      const totalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);
      const wins = settled.filter(b => b.outcome === 'won').length;
      const losses = settled.filter(b => b.outcome === 'lost').length;

      res.json({
        success: true,
        simulated: false,
        balance: portfolio.balance / 100,
        betHistory: combinedHistory.slice(0, 20),
        stats: {
          totalBets: settled.length,
          wins,
          losses,
          winRate: settled.length > 0 ? ((wins / settled.length) * 100).toFixed(1) : '0',
          totalProfit: totalProfit / 100 // in dollars
        }
      });
    } else {
      // Return simulated data
      res.json({
        success: true,
        simulated: true,
        balance: config.bankroll / 100,
        betHistory: betHistory.slice(0, 20),
        stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 }
      });
    }
  } catch (error) {
    console.error('Portfolio error:', error.message);
    res.json({
      success: true,
      simulated: !config.isAuthenticated,
      balance: config.bankroll / 100,
      betHistory: betHistory.slice(0, 20),
      stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 },
      error: error.message
    });
  }
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

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🎰 Shimi Crypto Bot running on port ${PORT}`);
  console.log(`📊 Tracking ${Object.keys(TRACKED_TOKENS).length} tokens: ${Object.keys(TRACKED_TOKENS).join(', ')}`);
  console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);

  // Auto-load Kalshi credentials from environment
  await loadCredentialsFromEnv();
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
