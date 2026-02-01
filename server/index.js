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

  // Calculate how far price is from strike (as percentage and z-score)
  const pctFromStrike = ((currentPrice - parsed.strikePrice) / parsed.strikePrice) * 100;
  const zScore = pctFromStrike / (volatility * 100);

  // Calculate probabilities using log-normal model
  const { probAbove, probBelow } = calculateProbability(currentPrice, parsed.strikePrice, volatility);

  // For "above/up" markets: YES wins if price >= strike at expiry
  // For "below/down" markets: YES wins if price < strike at expiry
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = probAbove;
    probNoWins = probBelow;
  } else { // below
    probYesWins = probBelow;
    probNoWins = probAbove;
  }

  // Market implied probabilities from ask prices
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge for both sides
  // Edge = our probability - market's price (what we pay)
  const edgeYes = (probYesWins - marketProbYes) * 100;
  const edgeNo = (probNoWins - marketProbNo) * 100;

  // FIND "FREE MONEY" - high probability bets where we're very confident
  // Strategy: Take safe bets with small profits over risky bets with big profits
  // Even $0.10 profit on a 95% win rate = steady growth
  let obviousBet = null;
  let estimatedWinProb = 0;

  // For "above/up" markets:
  // - If current price is ABOVE strike, YES is likely (price just needs to stay up)
  // - If current price is BELOW strike, NO is likely (price just needs to stay down)
  if (parsed.marketType === 'above') {
    if (zScore >= 1.0) {
      // Price above strike - YES is favored
      estimatedWinProb = normalCDF(zScore);  // z=1 → 84%, z=1.5 → 93%, z=2 → 97%
      const obviousEdge = (estimatedWinProb - marketProbYes) * 100;
      // Accept smaller edge for high probability bets (free money)
      const minEdgeRequired = estimatedWinProb > 0.90 ? OBVIOUS_BET_MIN_EDGE : 3;
      if (obviousEdge >= minEdgeRequired && parsed.yesAsk > 0 && parsed.yesAsk < 0.98) {
        obviousBet = {
          side: 'YES',
          edge: obviousEdge,
          prob: estimatedWinProb,
          reason: `Price ${pctFromStrike.toFixed(1)}% above strike (${(estimatedWinProb*100).toFixed(0)}% win rate)`
        };
      }
    } else if (zScore <= -1.0) {
      // Price below strike - NO is favored
      estimatedWinProb = normalCDF(-zScore);
      const obviousEdge = (estimatedWinProb - marketProbNo) * 100;
      const minEdgeRequired = estimatedWinProb > 0.90 ? OBVIOUS_BET_MIN_EDGE : 3;
      if (obviousEdge >= minEdgeRequired && parsed.noAsk > 0 && parsed.noAsk < 0.98) {
        obviousBet = {
          side: 'NO',
          edge: obviousEdge,
          prob: estimatedWinProb,
          reason: `Price ${Math.abs(pctFromStrike).toFixed(1)}% below strike (${(estimatedWinProb*100).toFixed(0)}% win rate)`
        };
      }
    }
  } else {
    // For "below" markets, logic is reversed
    if (zScore <= -1.0) {
      estimatedWinProb = normalCDF(-zScore);
      const obviousEdge = (estimatedWinProb - marketProbYes) * 100;
      const minEdgeRequired = estimatedWinProb > 0.90 ? OBVIOUS_BET_MIN_EDGE : 3;
      if (obviousEdge >= minEdgeRequired && parsed.yesAsk > 0 && parsed.yesAsk < 0.98) {
        obviousBet = {
          side: 'YES',
          edge: obviousEdge,
          prob: estimatedWinProb,
          reason: `Price ${Math.abs(pctFromStrike).toFixed(1)}% below strike (${(estimatedWinProb*100).toFixed(0)}% win rate)`
        };
      }
    } else if (zScore >= 1.0) {
      estimatedWinProb = normalCDF(zScore);
      const obviousEdge = (estimatedWinProb - marketProbNo) * 100;
      const minEdgeRequired = estimatedWinProb > 0.90 ? OBVIOUS_BET_MIN_EDGE : 3;
      if (obviousEdge >= minEdgeRequired && parsed.noAsk > 0 && parsed.noAsk < 0.98) {
        obviousBet = {
          side: 'NO',
          edge: obviousEdge,
          prob: estimatedWinProb,
          reason: `Price ${pctFromStrike.toFixed(1)}% above strike (${(estimatedWinProb*100).toFixed(0)}% win rate)`
        };
      }
    }
  }

  // Pick the best bet: PRIORITIZE high probability "free money" over high edge risky bets
  // Strategy: Safe steady growth > gambling on uncertain edges
  let betSide = null;
  let betPrice = 0;
  let ourProbability = 0;
  let marketImpliedProb = 0;
  let edge = 0;
  let betReason = '';
  let winProbability = 0;

  if (obviousBet) {
    // PREFER obvious high-probability bets - this is the safe money strategy
    betSide = obviousBet.side;
    betPrice = obviousBet.side === 'YES' ? parsed.yesAsk : parsed.noAsk;
    ourProbability = obviousBet.prob * 100;
    winProbability = obviousBet.prob;
    marketImpliedProb = betPrice;
    edge = obviousBet.edge;
    betReason = '🎯 ' + obviousBet.reason;
  } else if (edgeYes > edgeNo && edgeYes >= MANUAL_BET_MIN_EDGE && parsed.yesAsk > 0 && parsed.yesAsk < 0.95) {
    betSide = 'YES';
    betPrice = parsed.yesAsk;
    ourProbability = probYesWins * 100;
    winProbability = probYesWins;
    marketImpliedProb = marketProbYes;
    edge = edgeYes;
    betReason = 'Model edge';
  } else if (edgeNo >= MANUAL_BET_MIN_EDGE && parsed.noAsk > 0 && parsed.noAsk < 0.95) {
    betSide = 'NO';
    betPrice = parsed.noAsk;
    ourProbability = probNoWins * 100;
    winProbability = probNoWins;
    marketImpliedProb = marketProbNo;
    edge = edgeNo;
    betReason = 'Model edge';
  }

  // Must have positive edge to show
  if (!betSide || edge < 0.5) {
    return null;
  }

  // Calculate expected profit per $1 bet
  // E.g., buy at 95¢, win = 5¢ profit, so EV = 0.95 * $0.05 - 0.05 * $0.95
  const profitPerContract = 1 - betPrice;  // What we get if we win (payout - cost)
  const expectedProfit = (winProbability * profitPerContract - (1 - winProbability) * betPrice) * 100; // in cents per $1

  // Profit if we win (per contract at $1 payout)
  const profitIfWin = ((1 - betPrice) * 100).toFixed(0);  // cents
  const profitPotential = ((1 - betPrice) / betPrice) * 100;

  // Fixed bet amount ($1) for sustainable growth
  const recommendedBet = config.fixedBetAmount || config.minBetAmount;

  return {
    ...parsed,
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    pctFromStrike: pctFromStrike.toFixed(2),
    zScore: zScore.toFixed(2),
    probYesWins: probYesWins * 100,
    probNoWins: probNoWins * 100,
    ourProbability,  // Already in percentage
    winProbability: (winProbability * 100).toFixed(1),
    marketImpliedProb: marketImpliedProb * 100,
    edgeYes,
    edgeNo,
    edge,
    betSide,
    betPrice,
    betReason,
    profitIfWin,  // cents profit per contract if we win
    expectedProfit: expectedProfit.toFixed(1),  // expected cents per $1 bet
    profitPotential,
    recommendedBet,
    isObviousBet: !!obviousBet,
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
        // Allow lower edge for obvious high-probability bets (free money)
        const minEdge = m.isObviousBet ? OBVIOUS_BET_MIN_EDGE : MANUAL_BET_MIN_EDGE;
        if (m.edge < minEdge) return false;
        return true;
      })
      // Sort by: obvious bets first, then by edge
      .sort((a, b) => {
        if (a.isObviousBet && !b.isObviousBet) return -1;
        if (!a.isObviousBet && b.isObviousBet) return 1;
        return b.edge - a.edge;
      });

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: `No opportunities found. Need >${OBVIOUS_BET_MIN_EDGE}% edge for safe bets or >${MANUAL_BET_MIN_EDGE}% for model bets.`,
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
        // Allow lower edge for obvious high-probability "free money" bets
        const minEdge = m.isObviousBet ? OBVIOUS_BET_MIN_EDGE : AUTO_BET_MIN_EDGE;
        if (m.edge < minEdge) return false;
        return true;
      })
      // Sort: obvious safe bets first, then by edge
      .sort((a, b) => {
        if (a.isObviousBet && !b.isObviousBet) return -1;
        if (!a.isObviousBet && b.isObviousBet) return 1;
        return b.edge - a.edge;
      });

    const obviousCount = opportunities.filter(o => o.isObviousBet).length;
    console.log(`📊 Found ${markets.length} markets, ${opportunities.length} opportunities (${obviousCount} safe bets)`);

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
