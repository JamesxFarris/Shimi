import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';

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
  minEdge: 3, // 3% minimum - lowered for more action
  autoBetEnabled: false,
  // Risk management settings (in cents)
  riskLimits: {
    maxPerBet: 500,      // $5.00 max per bet
    maxTotal: 1500,      // $15.00 max total exposure
    maxPerToken: 500     // $5.00 max per token
  },
  // Scale-in settings: add to position when probability improves
  scaleIn: {
    enabled: true,
    minProbabilityIncrease: 15,  // Only scale in if prob increased by 15%+ (60% → 75%)
    maxBetsPerMarket: 3,         // Maximum times to bet on same market
    minTimeBetweenBets: 60000    // At least 1 minute between bets on same market
  }
};

let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// Track last auto-bet scan status for diagnostics
let lastScanStatus = {
  timestamp: null,
  cryptoMarketsFound: 0,
  indexMarketsFound: 0,
  analyzedValid: 0,
  withEdge: 0,
  above60: 0,
  filteredByRecentBet: 0,
  bestOpportunity: null,
  blockedReason: null,  // 'no_opportunities' | 'risk_limit' | 'token_limit' | 'bet_placed'
  betPlaced: false,
  betDetails: null
};

// ============================================
// PERFORMANCE TRACKING
// ============================================
// Track all bets and their outcomes to measure model accuracy

const PERFORMANCE_FILE = path.join(__dirname, 'performance_data.json');
const STATE_FILE = path.join(__dirname, 'autobet_state.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ============================================
// AUTO-BET STATE PERSISTENCE
// ============================================
// Save/restore auto-bet state so it survives server restarts

function loadAutoBetState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log(`🔄 Loaded auto-bet state: ${data.enabled ? 'ENABLED' : 'disabled'}`);
      return data;
    }
  } catch (err) {
    console.log('Could not load auto-bet state:', err.message);
  }
  return { enabled: false, intervalSeconds: 15 };
}

function saveAutoBetState(enabled, intervalSeconds = 15) {
  try {
    const state = {
      enabled,
      intervalSeconds,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 Saved auto-bet state: ${enabled ? 'ENABLED' : 'disabled'}`);
  } catch (err) {
    console.log('Could not save auto-bet state:', err.message);
  }
}

// ============================================
// SETTINGS PERSISTENCE
// ============================================
// Save/restore risk settings so they survive server restarts

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      console.log(`⚙️ Loaded settings: $${(data.riskLimits?.maxTotal || 3500) / 100} max exposure`);
      return data;
    }
  } catch (err) {
    console.log('Could not load settings:', err.message);
  }
  return null;
}

function saveSettings() {
  try {
    const settings = {
      riskLimits: config.riskLimits,
      scaleIn: config.scaleIn,
      minEdge: config.minEdge,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`💾 Saved settings: $${config.riskLimits.maxTotal / 100} max exposure`);
  } catch (err) {
    console.log('Could not save settings:', err.message);
  }
}

let performanceData = {
  bets: [],           // All tracked bets with outcomes
  summary: {
    totalBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    totalWagered: 0,   // cents
    totalProfit: 0,    // cents (can be negative)
    winRate: 0,
    avgPredictedProb: 0,
    avgActualWinRate: 0,
    calibration: {}    // predicted bucket -> actual win rate
  },
  byToken: {},        // token -> { bets, wins, losses, profit }
  byProbBucket: {},   // "60-65" -> { bets, wins, actualRate }
  byMarketType: {},   // "hourly" | "15min" | "daily" -> stats
  lastUpdated: null
};

// Load performance data from file
function loadPerformanceData() {
  try {
    if (fs.existsSync(PERFORMANCE_FILE)) {
      const data = fs.readFileSync(PERFORMANCE_FILE, 'utf8');
      performanceData = JSON.parse(data);
      console.log(`📊 Loaded ${performanceData.bets.length} historical bets`);
    }
  } catch (err) {
    console.log('Could not load performance data:', err.message);
  }
}

// Save performance data to file
function savePerformanceData() {
  try {
    performanceData.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(performanceData, null, 2));
  } catch (err) {
    console.log('Could not save performance data:', err.message);
  }
}

// Track a new bet
function trackBet(betInfo) {
  const bet = {
    id: betInfo.id || Date.now().toString(),
    timestamp: new Date().toISOString(),
    ticker: betInfo.ticker,
    title: betInfo.title,
    token: betInfo.token || betInfo.assetType || getTokenFromTicker(betInfo.ticker),
    side: betInfo.side,
    contracts: betInfo.count || 1,
    price: betInfo.price,           // cents
    totalCost: betInfo.totalCost,   // cents
    predictedProb: betInfo.predictedProb || parseFloat(betInfo.winProbability) || 0,
    marketPrice: betInfo.marketPrice || betInfo.price,
    edge: betInfo.edge || 0,
    strikePrice: betInfo.strikePrice,
    currentPriceAtBet: betInfo.currentPrice,
    expiryTime: betInfo.expiryTime,
    marketType: betInfo.marketType || (betInfo.ticker?.includes('1H') ? 'hourly' :
                                        betInfo.ticker?.includes('15M') ? '15min' : 'daily'),
    // Outcome tracking (filled in later)
    outcome: 'pending',  // 'won' | 'lost' | 'pending'
    settlementPrice: null,
    actualProfit: null,  // cents
    settledAt: null
  };

  performanceData.bets.push(bet);
  performanceData.summary.totalBets++;
  performanceData.summary.pending++;
  performanceData.summary.totalWagered += bet.totalCost;

  savePerformanceData();
  console.log(`📊 Tracked bet: ${bet.side} on ${bet.token} @ ${bet.price}¢ (${bet.predictedProb.toFixed(1)}% predicted)`);

  return bet;
}

// Update bet with settlement outcome
function settleBet(betId, outcome, settlementPrice, actualProfit) {
  const bet = performanceData.bets.find(b => b.id === betId);
  if (!bet || bet.outcome !== 'pending') return null;

  bet.outcome = outcome;  // 'won' or 'lost'
  bet.settlementPrice = settlementPrice;
  bet.actualProfit = actualProfit;
  bet.settledAt = new Date().toISOString();

  // Update summary
  performanceData.summary.pending--;
  if (outcome === 'won') {
    performanceData.summary.wins++;
    performanceData.summary.totalProfit += actualProfit;
  } else {
    performanceData.summary.losses++;
    performanceData.summary.totalProfit -= bet.totalCost;
  }

  // Update by token
  const token = bet.token || 'UNKNOWN';
  if (!performanceData.byToken[token]) {
    performanceData.byToken[token] = { bets: 0, wins: 0, losses: 0, profit: 0 };
  }
  performanceData.byToken[token].bets++;
  if (outcome === 'won') {
    performanceData.byToken[token].wins++;
    performanceData.byToken[token].profit += actualProfit;
  } else {
    performanceData.byToken[token].losses++;
    performanceData.byToken[token].profit -= bet.totalCost;
  }

  // Update by probability bucket
  const probBucket = getProbBucket(bet.predictedProb);
  if (!performanceData.byProbBucket[probBucket]) {
    performanceData.byProbBucket[probBucket] = { bets: 0, wins: 0 };
  }
  performanceData.byProbBucket[probBucket].bets++;
  if (outcome === 'won') {
    performanceData.byProbBucket[probBucket].wins++;
  }

  // Update by market type
  const mktType = bet.marketType || 'other';
  if (!performanceData.byMarketType[mktType]) {
    performanceData.byMarketType[mktType] = { bets: 0, wins: 0, losses: 0, profit: 0 };
  }
  performanceData.byMarketType[mktType].bets++;
  if (outcome === 'won') {
    performanceData.byMarketType[mktType].wins++;
    performanceData.byMarketType[mktType].profit += actualProfit;
  } else {
    performanceData.byMarketType[mktType].losses++;
    performanceData.byMarketType[mktType].profit -= bet.totalCost;
  }

  // Recalculate summary stats
  recalculateSummary();
  savePerformanceData();

  console.log(`📊 Settled bet: ${bet.side} on ${bet.token} → ${outcome.toUpperCase()} (${actualProfit > 0 ? '+' : ''}${actualProfit}¢)`);
  return bet;
}

// Get probability bucket string (e.g., "60-65", "65-70")
function getProbBucket(prob) {
  if (prob < 55) return '50-55';
  if (prob < 60) return '55-60';
  if (prob < 65) return '60-65';
  if (prob < 70) return '65-70';
  if (prob < 75) return '70-75';
  if (prob < 80) return '75-80';
  if (prob < 85) return '80-85';
  return '85+';
}

// Recalculate summary statistics
function recalculateSummary() {
  const settled = performanceData.bets.filter(b => b.outcome !== 'pending');
  if (settled.length === 0) return;

  // Win rate
  performanceData.summary.winRate = (performanceData.summary.wins / settled.length) * 100;

  // Average predicted probability
  performanceData.summary.avgPredictedProb =
    settled.reduce((sum, b) => sum + b.predictedProb, 0) / settled.length;

  // Calculate calibration (predicted vs actual win rates by bucket)
  const calibration = {};
  for (const [bucket, data] of Object.entries(performanceData.byProbBucket)) {
    if (data.bets > 0) {
      calibration[bucket] = {
        predicted: getBucketMidpoint(bucket),
        actual: (data.wins / data.bets) * 100,
        bets: data.bets,
        difference: ((data.wins / data.bets) * 100) - getBucketMidpoint(bucket)
      };
    }
  }
  performanceData.summary.calibration = calibration;
}

// Get midpoint of a bucket for calibration
function getBucketMidpoint(bucket) {
  const map = {
    '50-55': 52.5, '55-60': 57.5, '60-65': 62.5, '65-70': 67.5,
    '70-75': 72.5, '75-80': 77.5, '80-85': 82.5, '85+': 87.5
  };
  return map[bucket] || 60;
}

// ============================================
// CALIBRATION ADJUSTMENT
// ============================================
// Apply learned adjustments based on historical performance
// If we predicted 70% but only won 60%, adjust future 70% predictions down

const MIN_BETS_FOR_CALIBRATION = 10;  // Need at least 10 bets in a bucket to calibrate

// Get calibration adjustment for a given probability
// Returns adjusted probability based on historical accuracy
function getCalibratedProbability(rawProbability, token = null, marketType = null) {
  // Start with raw probability
  let adjustedProb = rawProbability;
  let adjustments = [];

  // 1. GLOBAL CALIBRATION: Adjust based on probability bucket
  const bucket = getProbBucket(rawProbability);
  const bucketData = performanceData.byProbBucket[bucket];

  if (bucketData && bucketData.bets >= MIN_BETS_FOR_CALIBRATION) {
    const actualWinRate = (bucketData.wins / bucketData.bets) * 100;
    const bucketMidpoint = getBucketMidpoint(bucket);
    const calibrationError = actualWinRate - bucketMidpoint;

    // Apply 50% of the correction (conservative - don't over-correct)
    const correction = calibrationError * 0.5;
    adjustedProb += correction;

    if (Math.abs(correction) > 0.5) {
      adjustments.push(`bucket ${bucket}: ${correction > 0 ? '+' : ''}${correction.toFixed(1)}%`);
    }
  }

  // 2. TOKEN-SPECIFIC CALIBRATION: Some tokens may be more predictable
  if (token && performanceData.byToken[token]) {
    const tokenData = performanceData.byToken[token];
    if (tokenData.bets >= MIN_BETS_FOR_CALIBRATION) {
      const tokenWinRate = (tokenData.wins / tokenData.bets) * 100;
      const overallWinRate = performanceData.summary.winRate || 50;

      // If this token outperforms overall, slight boost; if underperforms, slight reduction
      const tokenAdjustment = (tokenWinRate - overallWinRate) * 0.25;
      adjustedProb += tokenAdjustment;

      if (Math.abs(tokenAdjustment) > 0.5) {
        adjustments.push(`${token}: ${tokenAdjustment > 0 ? '+' : ''}${tokenAdjustment.toFixed(1)}%`);
      }
    }
  }

  // 3. MARKET TYPE CALIBRATION: Hourly vs daily may have different accuracy
  if (marketType && performanceData.byMarketType[marketType]) {
    const typeData = performanceData.byMarketType[marketType];
    if (typeData.bets >= MIN_BETS_FOR_CALIBRATION) {
      const typeWinRate = (typeData.wins / typeData.bets) * 100;
      const overallWinRate = performanceData.summary.winRate || 50;

      const typeAdjustment = (typeWinRate - overallWinRate) * 0.25;
      adjustedProb += typeAdjustment;

      if (Math.abs(typeAdjustment) > 0.5) {
        adjustments.push(`${marketType}: ${typeAdjustment > 0 ? '+' : ''}${typeAdjustment.toFixed(1)}%`);
      }
    }
  }

  // Clamp to valid probability range
  adjustedProb = Math.max(1, Math.min(99, adjustedProb));

  // Log significant adjustments
  if (adjustments.length > 0 && Math.abs(adjustedProb - rawProbability) > 1) {
    console.log(`   📐 Calibration: ${rawProbability.toFixed(1)}% → ${adjustedProb.toFixed(1)}% (${adjustments.join(', ')})`);
  }

  return {
    probability: adjustedProb,
    rawProbability: rawProbability,
    wasCalibrated: adjustments.length > 0,
    adjustments
  };
}

// Get overall calibration health score (how well-calibrated is our model?)
function getCalibrationScore() {
  const calibration = performanceData.summary.calibration || {};
  const buckets = Object.values(calibration).filter(b => b.bets >= MIN_BETS_FOR_CALIBRATION);

  if (buckets.length === 0) {
    return { score: null, status: 'insufficient_data', message: 'Need more bets to calculate calibration' };
  }

  // Calculate mean absolute error between predicted and actual
  const totalError = buckets.reduce((sum, b) => sum + Math.abs(b.difference), 0);
  const mae = totalError / buckets.length;

  // Score from 0-100 where 100 is perfectly calibrated
  // MAE of 0 = score 100, MAE of 20 = score 0
  const score = Math.max(0, 100 - (mae * 5));

  let status, message;
  if (score >= 80) {
    status = 'excellent';
    message = 'Model is well-calibrated';
  } else if (score >= 60) {
    status = 'good';
    message = 'Model is reasonably calibrated';
  } else if (score >= 40) {
    status = 'needs_adjustment';
    message = 'Model may be over/under-confident';
  } else {
    status = 'poor';
    message = 'Model predictions are unreliable';
  }

  return {
    score: score.toFixed(0),
    mae: mae.toFixed(1),
    bucketsAnalyzed: buckets.length,
    status,
    message,
    details: buckets.map(b => ({
      bucket: Object.keys(calibration).find(k => calibration[k] === b),
      predicted: b.predicted.toFixed(0),
      actual: b.actual.toFixed(0),
      error: b.difference.toFixed(1),
      bets: b.bets
    }))
  };
}

// Check and settle pending bets (call periodically)
async function checkPendingSettlements() {
  const pending = performanceData.bets.filter(b => b.outcome === 'pending');
  if (pending.length === 0) return;

  console.log(`📊 Checking ${pending.length} pending bets for settlement...`);

  for (const bet of pending) {
    try {
      // Check if market has settled
      if (bet.expiryTime && new Date(bet.expiryTime) > new Date()) {
        continue; // Not expired yet
      }

      // Try to get settlement from Kalshi
      if (config.isAuthenticated && bet.ticker) {
        try {
          const market = await kalshiRequest('GET', `/markets/${bet.ticker}`);
          if (market.market?.result) {
            const result = market.market.result;  // 'yes' or 'no'
            const won = (bet.side.toLowerCase() === result);
            const profit = won ? (bet.contracts * 100 - bet.totalCost) : 0;
            settleBet(bet.id, won ? 'won' : 'lost', market.market.settlement_value, profit);
          }
        } catch (e) {
          // Market might not exist or API error - skip
        }
      }

      // For simulated bets or if we can't get Kalshi data, check price
      if (bet.outcome === 'pending' && bet.strikePrice && bet.token) {
        const currentPrice = cryptoPrices[bet.token]?.price || indexPrices[bet.token]?.price;
        if (currentPrice && bet.expiryTime && new Date(bet.expiryTime) <= new Date()) {
          // Market should have settled - determine outcome from price
          const isAbove = currentPrice >= bet.strikePrice;
          const won = (bet.side.toLowerCase() === 'yes' && isAbove) ||
                      (bet.side.toLowerCase() === 'no' && !isAbove);
          const profit = won ? (bet.contracts * 100 - bet.totalCost) : 0;
          settleBet(bet.id, won ? 'won' : 'lost', currentPrice, profit);
        }
      }
    } catch (err) {
      console.log(`Error checking settlement for ${bet.ticker}:`, err.message);
    }
  }
}

// Load performance data on startup
loadPerformanceData();

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
// Key: ticker, Value: { timestamp, side, probability, betCount }
const recentBets = new Map();

// Check if we should allow a scale-in bet on this market
function shouldAllowScaleIn(ticker, currentProbability) {
  if (!config.scaleIn.enabled) return false;

  const existing = recentBets.get(ticker);
  if (!existing) return false; // No existing bet, this isn't a scale-in

  const now = Date.now();
  const timeSinceLastBet = now - existing.timestamp;

  // Check time between bets
  if (timeSinceLastBet < config.scaleIn.minTimeBetweenBets) {
    return false;
  }

  // Check max bets per market
  if ((existing.betCount || 1) >= config.scaleIn.maxBetsPerMarket) {
    return false;
  }

  // Check probability improvement
  const probIncrease = currentProbability - (existing.probability || 0);
  if (probIncrease < config.scaleIn.minProbabilityIncrease) {
    return false;
  }

  console.log(`📈 SCALE-IN OPPORTUNITY: ${ticker}`);
  console.log(`   Previous prob: ${existing.probability}% → Current: ${currentProbability}% (+${probIncrease.toFixed(1)}%)`);
  console.log(`   Bet #${(existing.betCount || 1) + 1} of max ${config.scaleIn.maxBetsPerMarket}`);

  return true;
}

// Edge requirements - lower for "obvious" high-probability bets
// Strategy: Safe growth from $10 → $100 by taking high-probability bets
const AUTO_BET_MIN_EDGE = 3;      // 3% edge for auto (lower for safe bets)
const MANUAL_BET_MIN_EDGE = 2;    // 2% edge for manual
const OBVIOUS_BET_MIN_EDGE = 1;   // 1% edge OK if probability is >90% (free money)

// ============================================
// NEWS & SENTIMENT MONITORING CONFIGURATION
// ============================================

const NEWS_CONFIG = {
  checkIntervalMs: 60000,   // Check RSS feeds every 60 seconds
  urgencyThreshold: 10,     // Score needed to trigger alert
  newsBoostMultiplier: 1.5, // How much to boost bets with aligned news
  enableAutoTrade: true,    // Auto-trade on high-confidence news
  maxNewsAge: 15 * 60 * 1000 // Only consider news from last 15 min
};

// RSS Feed URLs (all free, no API keys needed)
const RSS_FEEDS = {
  coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  cointelegraph: 'https://cointelegraph.com/rss',
  cnbc_markets: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
  marketwatch: 'https://feeds.marketwatch.com/marketwatch/topstories/'
};

// Market-moving keywords for urgency detection
const URGENT_KEYWORDS = {
  crypto: {
    bullish: [
      'etf approved', 'sec approval', 'sec approves', 'institutional adoption',
      'partnership announced', 'upgrade complete', 'halving', 'bullish',
      'all-time high', 'ath', 'mass adoption', 'major investment',
      'blackrock', 'fidelity', 'spot etf', 'regulatory clarity'
    ],
    bearish: [
      'hack', 'hacked', 'exploit', 'exploited', 'sec lawsuit', 'sec sues',
      'ban', 'banned', 'exchange collapse', 'rug pull', 'vulnerability',
      'security breach', 'stolen', 'fraud', 'ponzi', 'investigation',
      'regulatory crackdown', 'delisting', 'insolvency', 'bankruptcy'
    ]
  },
  index: {
    bullish: [
      'rate cut', 'fed cuts', 'better than expected', 'beat estimates',
      'beats expectations', 'strong jobs', 'employment surge', 'gdp growth',
      'inflation falls', 'inflation drops', 'dovish', 'stimulus',
      'economic recovery', 'consumer confidence'
    ],
    bearish: [
      'rate hike', 'fed hikes', 'recession', 'missed estimates',
      'misses expectations', 'layoffs', 'bank failure', 'banking crisis',
      'inflation rises', 'inflation surges', 'hawkish', 'default',
      'debt ceiling', 'unemployment rises', 'economic downturn'
    ]
  }
};

// News storage
let newsCache = [];
let seenArticles = new Set(); // Track seen articles by URL
let recentAlerts = []; // Recent urgent news alerts
let redditSentiment = { data: null, lastFetch: 0, ttl: 5 * 60 * 1000 }; // 5 min cache

// ============================================
// RSS FEED PARSING & NEWS FETCHING
// ============================================

async function fetchRssFeed(url, source) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`RSS fetch failed for ${source}: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const result = await parseStringPromise(xml, { explicitArray: false });

    // Handle different RSS formats
    let items = [];
    if (result.rss && result.rss.channel && result.rss.channel.item) {
      items = Array.isArray(result.rss.channel.item)
        ? result.rss.channel.item
        : [result.rss.channel.item];
    } else if (result.feed && result.feed.entry) {
      // Atom format
      items = Array.isArray(result.feed.entry)
        ? result.feed.entry
        : [result.feed.entry];
    }

    return items.map(item => ({
      source,
      title: item.title || item.title?._ || '',
      link: item.link?.href || item.link || '',
      pubDate: new Date(item.pubDate || item.published || item.updated || Date.now()),
      description: item.description || item.summary || '',
      raw: item
    })).filter(item => item.title && item.link);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`RSS timeout for ${source}`);
    } else {
      console.log(`RSS error for ${source}: ${error.message}`);
    }
    return [];
  }
}

async function fetchAllNews() {
  const now = Date.now();
  const allArticles = [];

  // Fetch from all RSS feeds in parallel
  const feedPromises = Object.entries(RSS_FEEDS).map(async ([source, url]) => {
    const articles = await fetchRssFeed(url, source);
    return articles;
  });

  const results = await Promise.all(feedPromises);
  results.forEach(articles => allArticles.push(...articles));

  // Process and dedupe articles
  const newArticles = [];
  for (const article of allArticles) {
    // Skip if we've seen this article
    if (seenArticles.has(article.link)) continue;

    // Skip if article is too old
    const articleAge = now - article.pubDate.getTime();
    if (articleAge > 24 * 60 * 60 * 1000) continue; // Skip articles > 24h old

    // Score the article for urgency
    const urgency = scoreNewsUrgency(article.title, article.description);
    article.urgency = urgency;

    // Mark as seen
    seenArticles.add(article.link);
    newArticles.push(article);

    // Check if this is urgent news
    if (urgency.isUrgent) {
      handleUrgentNews(article);
    }
  }

  // Add new articles to cache (most recent first)
  newsCache = [...newArticles, ...newsCache]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, 100); // Keep last 100 articles

  // Clean up old seen articles (keep last 500)
  if (seenArticles.size > 500) {
    const articlesToKeep = [...seenArticles].slice(-500);
    seenArticles = new Set(articlesToKeep);
  }

  console.log(`📰 News update: ${newArticles.length} new articles | Cache: ${newsCache.length}`);
  return newArticles;
}

// Score news for urgency and direction
function scoreNewsUrgency(headline, body = '') {
  const text = (headline + ' ' + body).toLowerCase();
  let score = 0;
  let direction = 'neutral';
  let matchedKeywords = [];
  let assetType = null;

  // Check crypto keywords
  for (const keyword of URGENT_KEYWORDS.crypto.bullish) {
    if (text.includes(keyword)) {
      score += 10;
      direction = 'bullish';
      matchedKeywords.push(keyword);
      assetType = 'crypto';
    }
  }
  for (const keyword of URGENT_KEYWORDS.crypto.bearish) {
    if (text.includes(keyword)) {
      score += 10;
      direction = direction === 'bullish' ? 'mixed' : 'bearish';
      matchedKeywords.push(keyword);
      assetType = 'crypto';
    }
  }

  // Check index keywords
  for (const keyword of URGENT_KEYWORDS.index.bullish) {
    if (text.includes(keyword)) {
      score += 8;
      direction = direction === 'bearish' ? 'mixed' : 'bullish';
      matchedKeywords.push(keyword);
      assetType = assetType || 'index';
    }
  }
  for (const keyword of URGENT_KEYWORDS.index.bearish) {
    if (text.includes(keyword)) {
      score += 8;
      direction = direction === 'bullish' ? 'mixed' : 'bearish';
      matchedKeywords.push(keyword);
      assetType = assetType || 'index';
    }
  }

  // Detect which tokens are mentioned
  const mentionedTokens = [];
  for (const token of Object.keys(TRACKED_TOKENS)) {
    if (text.includes(token.toLowerCase()) ||
        text.includes(TRACKED_TOKENS[token].name.toLowerCase())) {
      mentionedTokens.push(token);
    }
  }

  // S&P 500 mentions
  if (text.includes('s&p') || text.includes('sp500') || text.includes('s&p 500') ||
      text.includes('stock market') || text.includes('wall street')) {
    assetType = 'index';
    mentionedTokens.push('SPX');
  }

  return {
    score,
    direction,
    isUrgent: score >= NEWS_CONFIG.urgencyThreshold,
    matchedKeywords,
    mentionedTokens,
    assetType
  };
}

// Handle urgent news - log alert and potentially trigger auto-bet
async function handleUrgentNews(article) {
  const alert = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    headline: article.title,
    source: article.source,
    link: article.link,
    direction: article.urgency.direction,
    score: article.urgency.score,
    keywords: article.urgency.matchedKeywords,
    tokens: article.urgency.mentionedTokens,
    assetType: article.urgency.assetType,
    acted: false
  };

  // Add to recent alerts (silently - no console spam)
  recentAlerts.unshift(alert);
  recentAlerts = recentAlerts.slice(0, 20);

  return alert;
}

// Get recent news for API
function getRecentNews(limit = 20, maxAgeMs = NEWS_CONFIG.maxNewsAge) {
  const now = Date.now();
  return newsCache
    .filter(article => now - article.pubDate.getTime() < maxAgeMs)
    .slice(0, limit);
}

// ============================================
// REDDIT SENTIMENT (ApeWisdom API)
// ============================================

async function getRedditSentiment() {
  const now = Date.now();

  // Return cached data if still valid
  if (redditSentiment.data && (now - redditSentiment.lastFetch) < redditSentiment.ttl) {
    return redditSentiment.data;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://apewisdom.io/api/v1.0/filter/all-crypto/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`ApeWisdom API error: ${res.status}`);
      return redditSentiment.data || [];
    }

    const data = await res.json();

    // Transform results
    const results = (data.results || []).slice(0, 30).map(item => ({
      ticker: item.ticker?.toUpperCase() || '',
      name: item.name || item.ticker || '',
      mentions: item.mentions || 0,
      upvotes: item.upvotes || 0,
      rank: item.rank || 0,
      mentionsChange24h: item.mentions_24h_ago ? item.mentions - item.mentions_24h_ago : 0
    }));

    redditSentiment.data = results;
    redditSentiment.lastFetch = now;

    console.log(`📊 Reddit sentiment updated: ${results.length} trending tickers`);
    return results;

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('ApeWisdom timeout');
    } else {
      console.log(`ApeWisdom error: ${error.message}`);
    }
    return redditSentiment.data || [];
  }
}

// Calculate overall market sentiment from news and reddit
function calculateOverallSentiment(news, reddit) {
  let bullishSignals = 0;
  let bearishSignals = 0;

  // Count news sentiment
  for (const article of news) {
    if (article.urgency?.direction === 'bullish') bullishSignals++;
    if (article.urgency?.direction === 'bearish') bearishSignals++;
  }

  // Reddit momentum (high mentions + positive change = bullish)
  const topReddit = reddit.slice(0, 10);
  const avgMentionChange = topReddit.reduce((sum, t) => sum + (t.mentionsChange24h || 0), 0) / topReddit.length;
  if (avgMentionChange > 50) bullishSignals += 2;
  if (avgMentionChange < -50) bearishSignals += 2;

  // Calculate overall sentiment (-100 to +100)
  const total = bullishSignals + bearishSignals;
  if (total === 0) return { score: 0, label: 'Neutral', description: 'No strong signals' };

  const score = Math.round(((bullishSignals - bearishSignals) / total) * 100);

  let label, description;
  if (score > 50) {
    label = 'Very Bullish';
    description = 'Strong positive sentiment across news and social';
  } else if (score > 20) {
    label = 'Bullish';
    description = 'Moderately positive market sentiment';
  } else if (score > -20) {
    label = 'Neutral';
    description = 'Mixed or no strong signals';
  } else if (score > -50) {
    label = 'Bearish';
    description = 'Moderately negative market sentiment';
  } else {
    label = 'Very Bearish';
    description = 'Strong negative sentiment - caution advised';
  }

  return { score, label, description, bullishSignals, bearishSignals };
}

// Get news boost for a specific token/asset
function getNewsBoost(assetType, token) {
  const now = Date.now();
  const recentNews = newsCache.filter(a =>
    now - a.pubDate.getTime() < NEWS_CONFIG.maxNewsAge &&
    a.urgency?.isUrgent
  );

  let boost = 0;
  let direction = null;

  for (const article of recentNews) {
    // Check if this news is relevant to the asset
    const isRelevant = article.urgency.mentionedTokens.includes(token) ||
      (assetType === 'crypto' && article.urgency.assetType === 'crypto') ||
      (assetType === 'index' && article.urgency.assetType === 'index');

    if (isRelevant && article.urgency.direction !== 'mixed' && article.urgency.direction !== 'neutral') {
      const newsAge = now - article.pubDate.getTime();
      const ageFactor = 1 - (newsAge / NEWS_CONFIG.maxNewsAge); // Newer = stronger
      const newsBoost = (article.urgency.score / 10) * ageFactor * NEWS_CONFIG.newsBoostMultiplier;

      if (direction === null || direction === article.urgency.direction) {
        direction = article.urgency.direction;
        boost += newsBoost;
      } else {
        // Conflicting news - reduce boost
        boost *= 0.5;
      }
    }
  }

  return { boost: Math.min(boost, 15), direction }; // Cap at 15% boost
}

// Start news monitoring (every 60 seconds)
let newsInterval = setInterval(fetchAllNews, NEWS_CONFIG.checkIntervalMs);
fetchAllNews(); // Initial fetch

// ============================================
// CRYPTO PRICE TRACKING - EXPANDED TOKENS
// ============================================

// All tokens we track - with price ranges for strike detection
const TRACKED_TOKENS = {
  BTC: { name: 'Bitcoin', minPrice: 20000, maxPrice: 500000 },
  ETH: { name: 'Ethereum', minPrice: 500, maxPrice: 20000 },
  SOL: { name: 'Solana', minPrice: 50, maxPrice: 1000 },
  XRP: { name: 'XRP', minPrice: 0.3, maxPrice: 100 },
  DOGE: { name: 'Dogecoin', minPrice: 0.05, maxPrice: 10 },
  ADA: { name: 'Cardano', minPrice: 0.2, maxPrice: 50 },
  AVAX: { name: 'Avalanche', minPrice: 10, maxPrice: 500 },
  LINK: { name: 'Chainlink', minPrice: 5, maxPrice: 200 },
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

// ============================================
// MOMENTUM BETTING SIGNAL - Our actual edge
// ============================================
// For 15-min markets: follow recent momentum
// This is simpler and more profitable than complex probability models

function getMomentumBetSignal(token) {
  const history = priceHistoryExtended[token];
  if (!history || history.length < 15) {
    return { shouldBet: false, reason: 'insufficient_data' };
  }

  const now = Date.now();
  const latest = history[history.length - 1];
  if (!latest || now - latest.time > 60000) {
    return { shouldBet: false, reason: 'stale_data' };
  }

  const latestPrice = latest.price;

  // Find prices at specific times ago
  const findPriceAt = (secondsAgo) => {
    const targetTime = now - (secondsAgo * 1000);
    let closest = history[0];
    let minDiff = Math.abs(history[0].time - targetTime);
    for (const p of history) {
      const diff = Math.abs(p.time - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = p;
      }
    }
    return closest.price;
  };

  // Short-term returns (what we actually trade on)
  const price1min = findPriceAt(60);
  const price2min = findPriceAt(120);
  const price3min = findPriceAt(180);
  const price5min = findPriceAt(300);

  const ret1 = ((latestPrice - price1min) / price1min) * 100;
  const ret2 = ((latestPrice - price2min) / price2min) * 100;
  const ret3 = ((latestPrice - price3min) / price3min) * 100;
  const ret5 = ((latestPrice - price5min) / price5min) * 100;

  // Check for aligned momentum (all timeframes agree) - LOOSENED for more action
  const allUp = ret1 > 0.01 && ret2 > 0.02 && ret3 > 0.03;
  const allDown = ret1 < -0.01 && ret2 < -0.02 && ret3 < -0.03;

  // Strong signal: aligned + meaningful move (lowered thresholds)
  if (allUp && ret3 >= 0.05) {
    const confidence = ret3 >= 0.15 ? 'very_high' : ret3 >= 0.08 ? 'high' : 'medium';
    return {
      shouldBet: true,
      side: 'YES',
      confidence,
      momentum: { ret1, ret2, ret3, ret5 },
      reason: `UP momentum: ${ret3.toFixed(2)}% in 3min`
    };
  }

  if (allDown && ret3 <= -0.05) {
    const confidence = ret3 <= -0.15 ? 'very_high' : ret3 <= -0.08 ? 'high' : 'medium';
    return {
      shouldBet: true,
      side: 'NO',
      confidence,
      momentum: { ret1, ret2, ret3, ret5 },
      reason: `DOWN momentum: ${ret3.toFixed(2)}% in 3min`
    };
  }

  // WEAKER signal: just 2-minute alignment (more trades, slightly lower quality)
  if (ret1 > 0.02 && ret2 > 0.03) {
    return {
      shouldBet: true,
      side: 'YES',
      confidence: 'medium',
      momentum: { ret1, ret2, ret3, ret5 },
      reason: `Short UP trend: ${ret2.toFixed(2)}% in 2min`
    };
  }

  if (ret1 < -0.02 && ret2 < -0.03) {
    return {
      shouldBet: true,
      side: 'NO',
      confidence: 'medium',
      momentum: { ret1, ret2, ret3, ret5 },
      reason: `Short DOWN trend: ${ret2.toFixed(2)}% in 2min`
    };
  }

  // No clear signal
  return {
    shouldBet: false,
    side: null,
    momentum: { ret1, ret2, ret3, ret5 },
    reason: `No momentum (1m:${ret1.toFixed(2)}% 2m:${ret2.toFixed(2)}%)`
  };
}

// Multi-timeframe momentum scoring
// Track price momentum over 5min, 15min, and 60min
function calculateMomentumMultiTimeframe(history) {
  if (history.length < 10) {
    return {
      m5: 0, m15: 0, m60: 0,
      aligned: false,
      strength: 0,
      direction: 'neutral'
    };
  }

  const now = Date.now();
  const latest = history[history.length - 1]?.price || 0;

  // Find prices at different lookback periods
  const findPriceAt = (minutesAgo) => {
    const targetTime = now - (minutesAgo * 60 * 1000);
    const closest = history.reduce((prev, curr) => {
      return Math.abs(curr.time - targetTime) < Math.abs(prev.time - targetTime) ? curr : prev;
    });
    return closest.price;
  };

  const price5minAgo = findPriceAt(5);
  const price15minAgo = findPriceAt(15);
  const price60minAgo = findPriceAt(60);

  // Calculate returns
  const m5 = price5minAgo ? ((latest - price5minAgo) / price5minAgo) * 100 : 0;
  const m15 = price15minAgo ? ((latest - price15minAgo) / price15minAgo) * 100 : 0;
  const m60 = price60minAgo ? ((latest - price60minAgo) / price60minAgo) * 100 : 0;

  // Check if all timeframes are aligned
  const signs = [Math.sign(m5), Math.sign(m15), Math.sign(m60)];
  const aligned = signs[0] !== 0 && signs[0] === signs[1] && signs[1] === signs[2];

  // Calculate average strength
  const strength = (Math.abs(m5) + Math.abs(m15) + Math.abs(m60)) / 3;

  // Determine overall direction
  let direction = 'neutral';
  if (aligned) {
    direction = m5 > 0 ? 'bullish' : 'bearish';
  } else if (m5 > 0.3 && m15 > 0.1) {
    direction = 'bullish';
  } else if (m5 < -0.3 && m15 < -0.1) {
    direction = 'bearish';
  }

  return {
    m5: m5.toFixed(2),
    m15: m15.toFixed(2),
    m60: m60.toFixed(2),
    aligned,
    strength: strength.toFixed(2),
    direction
  };
}

// ============================================
// ADVANCED STATISTICAL ANALYSIS MODULE
// Uses multiple methods for robust probability estimation
// ============================================

// Student-t CDF approximation (better for fat tails than normal)
// Degrees of freedom (df) controls tail heaviness: lower df = fatter tails
function studentTCDF(x, df = 5) {
  // For crypto, use df=3-5 (very fat tails)
  // For indices, use df=7-10 (moderately fat tails)
  const t = x;
  const a = df / 2;
  const b = 0.5;

  // Use incomplete beta function approximation
  const x2 = df / (df + t * t);

  if (t >= 0) {
    return 1 - 0.5 * incompleteBeta(x2, a, b);
  } else {
    return 0.5 * incompleteBeta(x2, a, b);
  }
}

// Incomplete beta function approximation
function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Simple approximation using continued fraction
  const maxIterations = 100;
  const epsilon = 1e-8;

  let result = Math.pow(x, a) * Math.pow(1 - x, b) / a;

  let sum = 1;
  let term = 1;

  for (let n = 1; n < maxIterations; n++) {
    term *= (a + n - 1) * x / n;
    sum += term;
    if (Math.abs(term) < epsilon) break;
  }

  // Normalize (approximate)
  const beta = gamma(a) * gamma(b) / gamma(a + b);
  return Math.min(1, Math.max(0, result * sum / beta));
}

// Gamma function approximation (Stirling)
function gamma(n) {
  if (n === 1) return 1;
  if (n === 0.5) return Math.sqrt(Math.PI);
  if (n < 0.5) return Math.PI / (Math.sin(Math.PI * n) * gamma(1 - n));

  // Stirling approximation for n > 0.5
  n -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];

  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (n + i);
  }

  const t = n + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, n + 0.5) * Math.exp(-t) * x;
}

// Bootstrap simulation: resample historical returns to estimate probability
function bootstrapProbability(history, currentPrice, targetPrice, expiryMinutes, numSimulations = 500) {
  if (history.length < 20) {
    return { probability: 0.5, confidence: 'low', simulations: 0 };
  }

  // Calculate historical returns over similar time intervals
  const targetIntervalMs = expiryMinutes * 60 * 1000;
  const returns = [];

  for (let i = 1; i < history.length; i++) {
    const timeDiff = history[i].time - history[i-1].time;
    // Only use returns from similar time intervals (within 2x)
    if (timeDiff > 0 && timeDiff < targetIntervalMs * 2) {
      const ret = (history[i].price - history[i-1].price) / history[i-1].price;
      // Scale return to target interval
      const scaledReturn = ret * Math.sqrt(targetIntervalMs / timeDiff);
      returns.push(scaledReturn);
    }
  }

  if (returns.length < 10) {
    return { probability: 0.5, confidence: 'low', simulations: 0 };
  }

  // Run Monte Carlo simulation
  let aboveCount = 0;
  const isCurrentlyAbove = currentPrice >= targetPrice;

  for (let sim = 0; sim < numSimulations; sim++) {
    // Randomly sample returns with replacement
    let simulatedPrice = currentPrice;

    // Simulate price path (use ~3-5 steps for 15 min)
    const numSteps = Math.max(1, Math.floor(expiryMinutes / 5));

    for (let step = 0; step < numSteps; step++) {
      const randomReturn = returns[Math.floor(Math.random() * returns.length)];
      simulatedPrice *= (1 + randomReturn / Math.sqrt(numSteps));
    }

    if (simulatedPrice >= targetPrice) {
      aboveCount++;
    }
  }

  const probability = aboveCount / numSimulations;

  // Confidence based on sample size and simulation count
  const confidence = returns.length >= 50 ? 'high' : returns.length >= 20 ? 'medium' : 'low';

  return {
    probability,
    probAbove: probability,
    probBelow: 1 - probability,
    confidence,
    simulations: numSimulations,
    sampleSize: returns.length
  };
}

// Calculate realized volatility with multiple estimators
function calculateRobustVolatility(history, windowMinutes = 60) {
  if (history.length < 10) {
    return { volatility: 0.03, method: 'default', confidence: 'low' };
  }

  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const recentHistory = history.filter(p => now - p.time < windowMs);

  if (recentHistory.length < 5) {
    return { volatility: 0.03, method: 'default', confidence: 'low' };
  }

  // Method 1: Simple return volatility
  const returns = [];
  for (let i = 1; i < recentHistory.length; i++) {
    const ret = (recentHistory[i].price - recentHistory[i-1].price) / recentHistory[i-1].price;
    returns.push(ret);
  }

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  const simpleVol = Math.sqrt(variance);

  // Method 2: Parkinson volatility (uses high-low range, more efficient)
  // Approximate by using max-min of recent prices
  const prices = recentHistory.map(p => p.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const parkinsonVol = Math.log(high / low) / (2 * Math.sqrt(Math.log(2)));

  // Method 3: Exponentially weighted (more weight on recent)
  let ewmaVar = variance;
  const lambda = 0.94; // Decay factor
  for (let i = returns.length - 1; i >= 0; i--) {
    ewmaVar = lambda * ewmaVar + (1 - lambda) * Math.pow(returns[i] - meanReturn, 2);
  }
  const ewmaVol = Math.sqrt(ewmaVar);

  // Combine methods (use maximum for conservative estimate)
  // Fat tails mean we should err on side of higher volatility
  const combinedVol = Math.max(simpleVol, parkinsonVol * 0.8, ewmaVol);

  // Scale to 15-minute volatility
  const avgIntervalMs = (recentHistory[recentHistory.length-1].time - recentHistory[0].time) / (recentHistory.length - 1);
  const intervalsIn15Min = (15 * 60 * 1000) / Math.max(avgIntervalMs, 1000);
  const vol15Min = combinedVol * Math.sqrt(intervalsIn15Min);

  // Cap at reasonable bounds but allow for high volatility
  const cappedVol = Math.max(0.005, Math.min(0.15, vol15Min));

  return {
    volatility: cappedVol,
    simpleVol,
    parkinsonVol,
    ewmaVol,
    method: 'ensemble',
    confidence: recentHistory.length >= 30 ? 'high' : 'medium',
    dataPoints: recentHistory.length
  };
}

// Calculate tail risk (probability of extreme moves)
function calculateTailRisk(history, threshold = 0.02) {
  if (history.length < 30) {
    return { leftTailProb: 0.05, rightTailProb: 0.05, kurtosis: 3 };
  }

  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const ret = (history[i].price - history[i-1].price) / history[i-1].price;
    returns.push(ret);
  }

  // Count tail events
  const leftTailCount = returns.filter(r => r < -threshold).length;
  const rightTailCount = returns.filter(r => r > threshold).length;

  const leftTailProb = leftTailCount / returns.length;
  const rightTailProb = rightTailCount / returns.length;

  // Calculate kurtosis (measure of tail heaviness)
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const fourthMoment = returns.reduce((a, b) => a + Math.pow(b - mean, 4), 0) / returns.length;
  const kurtosis = fourthMoment / Math.pow(variance, 2);

  return {
    leftTailProb,
    rightTailProb,
    kurtosis, // Normal = 3, crypto typically 5-20
    hasFatTails: kurtosis > 4
  };
}

// Main ensemble probability estimator
// Combines multiple methods and returns conservative estimate
function calculateEnsembleProbability(token, currentPrice, targetPrice, expiryMinutes = 15) {
  const history = cryptoPrices[token]?.history || [];
  const extHistory = priceHistoryExtended[token] || [];
  const allHistory = [...extHistory, ...history].sort((a, b) => a.time - b.time);

  const isAboveTarget = currentPrice >= targetPrice;
  const pctFromTarget = ((currentPrice - targetPrice) / targetPrice) * 100;

  // Get robust volatility estimate
  const volData = calculateRobustVolatility(allHistory, 60);
  const volatility = volData.volatility;

  // Get tail risk assessment
  const tailRisk = calculateTailRisk(allHistory);

  // Method 1: Normal distribution (baseline)
  const timeScaleFactor = Math.sqrt(expiryMinutes / 15);
  const adjustedVol = volatility * timeScaleFactor;
  const zScore = (currentPrice - targetPrice) / (targetPrice * adjustedVol);
  const normalProbAbove = normalCDF(zScore);

  // Method 2: Student-t distribution (accounts for fat tails)
  // Use df based on kurtosis: higher kurtosis = lower df = fatter tails
  const df = Math.max(3, Math.min(10, 30 / tailRisk.kurtosis));
  const tProbAbove = studentTCDF(zScore * Math.sqrt(df / (df - 2)), df);

  // Method 3: Bootstrap simulation (empirical)
  const bootstrapResult = bootstrapProbability(allHistory, currentPrice, targetPrice, expiryMinutes);
  const bootstrapProbAbove = bootstrapResult.probAbove;

  // Method 4: Historical crossing analysis
  const crossingAnalysis = analyzeHistoricalCrossings(allHistory, currentPrice, targetPrice, expiryMinutes);
  const historicalProbStay = crossingAnalysis.reliable ? (1 - crossingAnalysis.crossingProb) : 0.5;

  // Momentum is our EDGE - the market doesn't instantly price in recent moves
  // Strong recent momentum predicts continuation in very short term
  const momentum = calculateMomentumMultiTimeframe(allHistory);
  const shortMomentum = calculateMomentum(allHistory, 2); // Last 2 minutes only

  let momentumAdjust = 0;
  // Strong short-term momentum = higher adjustment (our actual edge)
  if (shortMomentum.strength === 'strong') {
    momentumAdjust = shortMomentum.direction === 'up' ? 0.15 : -0.15;
  } else if (shortMomentum.strength === 'moderate') {
    momentumAdjust = shortMomentum.direction === 'up' ? 0.08 : -0.08;
  } else if (momentum.aligned) {
    momentumAdjust = momentum.direction === 'bullish' ? 0.05 : -0.05;
  }

  // Combine methods using weighted average
  // Weight by confidence/reliability
  let weights = {
    normal: 0.15,
    studentT: 0.25,  // Higher weight - better for fat tails
    bootstrap: bootstrapResult.confidence === 'high' ? 0.35 : bootstrapResult.confidence === 'medium' ? 0.25 : 0.10,
    historical: crossingAnalysis.reliable ? 0.25 : 0.10
  };

  // Normalize weights
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  Object.keys(weights).forEach(k => weights[k] /= totalWeight);

  // SAFETY: Replace any NaN values with 0.5 (no information)
  const safeNormalProb = isNaN(normalProbAbove) ? 0.5 : normalProbAbove;
  const safeTProb = isNaN(tProbAbove) ? 0.5 : tProbAbove;
  const safeBootstrapProb = isNaN(bootstrapProbAbove) ? 0.5 : bootstrapProbAbove;
  const safeHistoricalProb = isNaN(historicalProbStay) ? 0.5 : historicalProbStay;

  // Calculate raw ensemble probability
  let ensembleProbAbove =
    weights.normal * safeNormalProb +
    weights.studentT * safeTProb +
    weights.bootstrap * safeBootstrapProb +
    weights.historical * (isAboveTarget ? safeHistoricalProb : 1 - safeHistoricalProb);

  // Apply momentum adjustment
  ensembleProbAbove = Math.max(0.05, Math.min(0.95, ensembleProbAbove + momentumAdjust));

  // LESS conservative - we need edge to make money
  // Only apply shrinkage when momentum is weak (uncertain)
  const hasStrongMomentumSignal = shortMomentum.strength === 'strong' || shortMomentum.strength === 'moderate';

  if (!hasStrongMomentumSignal) {
    // Weak momentum = less confident = shrink toward 50%
    const uncertaintyFactor = 0.85;
    ensembleProbAbove = 0.5 + (ensembleProbAbove - 0.5) * uncertaintyFactor;
  }
  // Strong momentum = trust the signal, minimal shrinkage

  // Data quality adjustment - only for low data
  const dataQualityFactor = Math.min(1, allHistory.length / 50);
  if (dataQualityFactor < 0.8) {
    ensembleProbAbove = 0.5 + (ensembleProbAbove - 0.5) * (0.85 + 0.15 * dataQualityFactor);
  }

  // DYNAMIC CAPS based on signal strength
  let MAX_PROB = 0.75;
  let MIN_PROB = 0.25;

  const absDistanceFromStrike = Math.abs(pctFromTarget);
  const momentumSupportsPosition = (isAboveTarget && shortMomentum.direction === 'up') ||
                                    (!isAboveTarget && shortMomentum.direction === 'down');

  // Strong momentum = allow more extreme probabilities
  if (hasStrongMomentumSignal && momentumSupportsPosition) {
    if (shortMomentum.strength === 'strong') {
      MAX_PROB = 0.85;
      MIN_PROB = 0.15;
    } else {
      MAX_PROB = 0.80;
      MIN_PROB = 0.20;
    }
  }

  // Additional boost for very short time + clear direction
  if (expiryMinutes <= 7 && absDistanceFromStrike >= 0.5) {
    MAX_PROB = Math.min(0.92, MAX_PROB + 0.05);
    MIN_PROB = Math.max(0.08, MIN_PROB - 0.05);
  }

  ensembleProbAbove = Math.max(MIN_PROB, Math.min(MAX_PROB, ensembleProbAbove));

  const ensembleProbBelow = 1 - ensembleProbAbove;

  // Calculate confidence score (how much we trust our estimate)
  const confidenceScore = Math.min(0.9,
    0.3 + // Base
    (allHistory.length / 150) * 0.2 + // Data quality
    (volData.confidence === 'high' ? 0.15 : 0.05) + // Volatility confidence
    (bootstrapResult.confidence === 'high' ? 0.15 : 0.05) + // Bootstrap confidence
    (crossingAnalysis.reliable ? 0.1 : 0)
  );

  // Track if this is an "obvious" high-confidence situation
  const isObviousSituation = MAX_PROB > 0.80;

  return {
    probAbove: ensembleProbAbove,
    probBelow: ensembleProbBelow,
    confidence: confidenceScore,
    isObviousBet: isObviousSituation,
    maxProbAllowed: MAX_PROB,
    zScore,
    volatility,
    adjustedVolatility: adjustedVol,
    momentum,
    shortMomentum, // 2-minute momentum (our edge)
    hasStrongMomentumSignal,
    tailRisk,
    methods: {
      normal: normalProbAbove,
      studentT: tProbAbove,
      bootstrap: bootstrapProbAbove,
      historical: historicalProbStay,
      weights
    },
    dataQuality: {
      historyLength: allHistory.length,
      volConfidence: volData.confidence,
      bootstrapConfidence: bootstrapResult.confidence,
      historicalReliable: crossingAnalysis.reliable
    },
    // Debug info
    pctFromTarget,
    timeRemaining: expiryMinutes,
    dataPoints: allHistory.length
  };
}

// ============================================
// TIME-OF-DAY FACTORS (S&P 500)
// ============================================

// S&P 500 has documented intraday patterns
function getTimeOfDayFactor() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // Market hours: 9:30 AM - 4:00 PM ET (14:30 - 21:00 UTC)
  const marketOpen = 14.5; // 14:30 UTC
  const marketClose = 21;  // 21:00 UTC
  const currentTime = hour + minute / 60;

  // Check if market is open
  const isMarketOpen = currentTime >= marketOpen && currentTime < marketClose;
  if (!isMarketOpen) {
    return { factor: 1.0, period: 'closed', description: 'Market closed' };
  }

  const hoursUntilClose = marketClose - currentTime;
  const hoursFromOpen = currentTime - marketOpen;

  // Opening 30 minutes: High volatility, mean-reverting
  if (hoursFromOpen < 0.5) {
    return {
      factor: 1.3,
      period: 'opening',
      description: 'Opening volatility - mean reversion common'
    };
  }

  // Last 15 minutes: End-of-day positioning, volatile
  if (hoursUntilClose < 0.25) {
    return {
      factor: 1.5,
      period: 'closing',
      description: 'Final 15min - increased volatility'
    };
  }

  // Power hour (3pm-4pm ET = last hour)
  if (hoursUntilClose < 1) {
    return {
      factor: 1.2,
      period: 'power_hour',
      description: 'Power hour - higher volume/volatility'
    };
  }

  // First hour after open (9:30-10:30 ET)
  if (hoursFromOpen < 1) {
    return {
      factor: 1.15,
      period: 'early',
      description: 'Early trading - settling volatility'
    };
  }

  // Midday stability (10am-2pm ET)
  if (hoursUntilClose > 2.5 && hoursFromOpen > 1) {
    return {
      factor: 1.0,
      period: 'midday',
      description: 'Midday stability - lower volatility'
    };
  }

  return { factor: 1.0, period: 'normal', description: 'Normal trading' };
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
// NOW USES ENSEMBLE METHOD for more accurate, conservative estimates
function predictOutcome(token, currentPrice, targetPrice, expiryMinutes = 15) {
  // Use the new ensemble probability estimator
  const ensemble = calculateEnsembleProbability(token, currentPrice, targetPrice, expiryMinutes);

  // For backwards compatibility, also return legacy fields
  return {
    probAbove: ensemble.probAbove,
    probBelow: ensemble.probBelow,
    momentum: ensemble.momentum,
    volatility: ensemble.volatility,
    adjustedVolatility: ensemble.adjustedVolatility,
    zScore: ensemble.zScore,
    confidence: ensemble.confidence,
    timeRemaining: expiryMinutes,
    dataPoints: ensemble.dataPoints,
    analysis: {
      method: 'ensemble',
      momentumDirection: ensemble.momentum.direction,
      momentumStrength: ensemble.momentum.strength,
      methods: ensemble.methods,
      tailRisk: ensemble.tailRisk
    },
    // New detailed data
    ensemble
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
// S&P 500 INDEX PRICE TRACKING
// ============================================

const indexPrices = {
  SPX: { price: 0, timestamp: 0, history: [], volatility: 0.01 }
};

// Extended history for S&P 500
const indexHistoryExtended = { SPX: [] };

async function fetchIndexPrice() {
  try {
    // Yahoo Finance API (free, no key needed)
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();

    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const price = result.meta.regularMarketPrice;
      const now = Date.now();

      if (price && price > 0) {
        indexPrices.SPX.price = price;
        indexPrices.SPX.timestamp = now;

        // Keep 60 price points for volatility calculation
        indexPrices.SPX.history.push({ price, time: now });
        if (indexPrices.SPX.history.length > 60) {
          indexPrices.SPX.history.shift();
        }

        // Extended history (2 hours)
        indexHistoryExtended.SPX.push({ price, time: now });
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        indexHistoryExtended.SPX = indexHistoryExtended.SPX.filter(p => p.time > twoHoursAgo);

        // Calculate volatility (S&P is much less volatile than crypto)
        indexPrices.SPX.volatility = calculateIndexVolatility(indexPrices.SPX.history);

        console.log(`📈 S&P 500: $${price.toFixed(2)} | Vol: ${(indexPrices.SPX.volatility * 100).toFixed(2)}%`);
      }
    }
  } catch (error) {
    console.error('Error fetching S&P 500 price:', error.message);
  }
}

function calculateIndexVolatility(history) {
  // Default S&P 500 15-minute volatility (much lower than crypto)
  if (history.length < 10) return 0.005; // 0.5% default

  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const logReturn = Math.log(history[i].price / history[i-1].price);
    returns.push(logReturn);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Scale to 15-minute equivalent
  const avgInterval = (history[history.length - 1].time - history[0].time) / (history.length - 1);
  const intervalsIn15Min = (15 * 60 * 1000) / avgInterval;
  const vol15min = stdDev * Math.sqrt(intervalsIn15Min);

  // Clamp to reasonable range for S&P (0.1% to 3%)
  return Math.max(0.001, Math.min(0.03, vol15min));
}

// Start S&P 500 price tracking (every 15 seconds - don't spam Yahoo)
let indexPriceInterval = setInterval(fetchIndexPrice, 15000);
fetchIndexPrice();

// ============================================
// RISK MANAGEMENT
// ============================================

// Risk limits are now configurable via config.riskLimits
function getMaxRisk() {
  return config.riskLimits.maxTotal;
}

function getMaxPerBet() {
  return config.riskLimits.maxPerBet;
}

// Kelly Criterion bet sizing - mathematically optimal for long-term growth
// Uses fractional Kelly (25%) to be more conservative and handle model uncertainty
function calculateKellyBet(probability, priceCents, bankrollCents, maxBetCents) {
  const p = probability / 100;  // Convert to decimal
  const q = 1 - p;              // Probability of losing
  const price = priceCents / 100;  // Price as fraction of $1

  // Odds: if you bet at 40¢, you win 60¢ profit on a $1 payout
  // b = (1 - price) / price = profit per dollar risked
  const b = (1 - price) / price;

  // Kelly formula: f* = (bp - q) / b
  const kellyFraction = (b * p - q) / b;

  // If Kelly is negative or zero, don't bet (no edge)
  if (kellyFraction <= 0) return 0;

  // Use fractional Kelly (25%) - more conservative, handles model error
  const KELLY_FRACTION = 0.25;
  const adjustedKelly = kellyFraction * KELLY_FRACTION;

  // Calculate bet size in cents
  let betSize = Math.floor(bankrollCents * adjustedKelly);

  // Cap at max per bet
  betSize = Math.min(betSize, maxBetCents);

  // Minimum bet of 1 contract
  if (betSize < priceCents) betSize = priceCents;

  return betSize;
}

function getMaxTotalRisk() {
  return config.riskLimits.maxTotal;
}

// Get current total exposure
function getCurrentExposure() {
  let totalExposure = 0;
  const kalshiTickers = new Set();

  // Count Kalshi positions
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        const avgPrice = pos.average_price || 50;
        totalExposure += contracts * avgPrice;
        kalshiTickers.add(pos.ticker);
      }
    }
  }

  // Add unsettled local bets not in Kalshi
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of betHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;
    if (kalshiTickers.has(bet.ticker)) continue;
    totalExposure += bet.totalCost || (bet.count * bet.price) || 0;
  }

  return totalExposure;
}

// Simplified - just returns total exposure (for backward compat)
function getRiskByType() {
  const total = getCurrentExposure();
  return { total };
}

function getCurrentRiskFromPortfolio() {
  return getCurrentExposure();
}

function canPlaceBet(betCostCents) {
  return (getCurrentExposure() + betCostCents) <= config.riskLimits.maxTotal;
}

function getRemainingRiskBudget() {
  return Math.max(0, config.riskLimits.maxTotal - getCurrentExposure());
}

// Get total remaining budget (for display)
function getTotalRemainingBudget() {
  return getRemainingRiskBudget();
}

// Extract token symbol from market ticker (e.g., KXBTC-24... -> BTC, KXSOL1H... -> SOL)
function getTokenFromTicker(ticker) {
  if (!ticker) return null;
  // Match patterns like KXBTC, KXETH, KXSOL, etc.
  const match = ticker.match(/KX([A-Z]+)/);
  if (match) return match[1];
  // Also check for SPX (S&P 500)
  if (ticker.includes('INX') || ticker.includes('SPX')) return 'SPX';
  return null;
}

// Get total exposure per token across all positions
function getExposureByToken() {
  const tokenExposure = {};
  const kalshiTickers = new Set();

  // Count Kalshi positions by token
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        const avgPrice = pos.average_price || 50;
        const posRisk = contracts * avgPrice;
        const token = getTokenFromTicker(pos.ticker);
        kalshiTickers.add(pos.ticker);

        if (token) {
          tokenExposure[token] = (tokenExposure[token] || 0) + posRisk;
        }
      }
    }
  }

  // Add unsettled local bets not in Kalshi
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of betHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;
    if (kalshiTickers.has(bet.ticker)) continue;

    const betRisk = bet.totalCost || (bet.count * bet.price) || 0;
    const token = getTokenFromTicker(bet.ticker) || bet.assetType;

    if (token) {
      tokenExposure[token] = (tokenExposure[token] || 0) + betRisk;
    }
  }

  return tokenExposure;
}

// Get max allowed per token (configurable)
function getMaxPerToken() {
  return config.riskLimits.maxPerToken || 500; // Default $5.00
}

// Get remaining budget for a specific token
function getRemainingTokenBudget(ticker, assetType) {
  const token = getTokenFromTicker(ticker) || assetType;
  if (!token) return getMaxPerToken(); // If can't determine token, use full budget

  const tokenExposure = getExposureByToken();
  const currentExposure = tokenExposure[token] || 0;
  return Math.max(0, getMaxPerToken() - currentExposure);
}

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

// Rate limiting for Kalshi API
const rateLimiter = {
  lastRequest: 0,
  minDelay: 200,  // 200ms between requests (5 req/sec max)
  queue: [],
  processing: false
};

async function rateLimitedRequest(fn) {
  return new Promise((resolve, reject) => {
    rateLimiter.queue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (rateLimiter.processing || rateLimiter.queue.length === 0) return;
  rateLimiter.processing = true;

  while (rateLimiter.queue.length > 0) {
    const now = Date.now();
    const timeSince = now - rateLimiter.lastRequest;
    if (timeSince < rateLimiter.minDelay) {
      await new Promise(r => setTimeout(r, rateLimiter.minDelay - timeSince));
    }

    const { fn, resolve, reject } = rateLimiter.queue.shift();
    rateLimiter.lastRequest = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  rateLimiter.processing = false;
}

async function kalshiRequest(method, endpoint, body = null, retries = 3) {
  return rateLimitedRequest(async () => {
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

    // Handle rate limiting with exponential backoff
    if (response.status === 429 && retries > 0) {
      const delay = (4 - retries) * 2000; // 2s, 4s, 6s backoff
      console.log(`⏳ Rate limited, waiting ${delay/1000}s... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, delay));
      return kalshiRequest(method, endpoint, body, retries - 1);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
    }

    return response.json();
  });
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
    // 15-minute crypto markets + hourly S&P
    const cryptoSeries = [
      // 15-minute crypto (high frequency)
      'KXBTC15M',   // Bitcoin 15-minute
      'KXETH15M',   // Ethereum 15-minute
      'KXSOL15M',   // Solana 15-minute
      'KXXRP15M',   // XRP 15-minute (if exists)
      'KXDOGE15M',  // Dogecoin 15-minute (if exists)

      // Hourly crypto
      'KXBTC1H',    // Bitcoin hourly
      'KXETH1H',    // Ethereum hourly
      'KXSOL1H',    // Solana hourly

      // Hourly S&P 500
      'KXINX1H',    // S&P 500 hourly
      'KXINXU1H',   // S&P 500 above/below hourly
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

// ============================================
// S&P 500 INDEX MARKET FETCHING
// ============================================

const indexMarketCache = { data: null, lastFetch: 0, ttl: 30000 };

async function fetchIndexMarkets() {
  const now = Date.now();

  if (indexMarketCache.data && (now - indexMarketCache.lastFetch) < indexMarketCache.ttl) {
    return indexMarketCache.data;
  }

  try {
    // S&P 500 market series on Kalshi
    const indexSeries = [
      'KXINX',      // S&P 500 daily range
      'KXINXU',     // S&P 500 above/below
      'KXINXD',     // S&P 500 daily direction
    ];

    const allMarkets = [];

    // Fetch each index series in parallel
    const fetches = indexSeries.map(async (series) => {
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

    // Filter for markets closing within reasonable time (today)
    const indexMarkets = allMarkets.filter(m => {
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      // S&P markets settle at end of day, so allow up to 8 hours
      const isValidTime = timeRemaining && timeRemaining > 60000 && timeRemaining < 8 * 60 * 60 * 1000;
      return isValidTime;
    });

    console.log(`📊 Fetched ${allMarkets.length} index markets, ${indexMarkets.length} valid`);

    indexMarketCache.data = indexMarkets;
    indexMarketCache.lastFetch = now;

    return indexMarkets;
  } catch (error) {
    console.error('Error fetching index markets:', error.message);
    return [];
  }
}

// Parse S&P 500 market data
function parseIndexMarket(market) {
  const ticker = (market.ticker || '').toUpperCase();
  const title = (market.title || '').toLowerCase();

  // Extract strike price from title
  // Example titles: "S&P 500 above 6,000?", "S&P 500 to close between 5,950 and 6,000?"
  let strikePrice = null;
  const priceMatches = title.match(/[\d,]+(?:\.\d+)?/g);
  if (priceMatches) {
    for (const match of priceMatches) {
      const price = parseFloat(match.replace(/,/g, ''));
      // S&P 500 range: 3000-8000
      if (price >= 3000 && price <= 8000) {
        strikePrice = price;
        break;
      }
    }
  }

  // Determine market type
  let marketType = null;
  if (title.includes('above') || title.includes('higher') || title.includes('or more') || title.includes('at least')) {
    marketType = 'above';
  } else if (title.includes('below') || title.includes('lower') || title.includes('or less') || title.includes('under')) {
    marketType = 'below';
  } else if (title.includes('between')) {
    marketType = 'between';
  }

  // Time remaining
  const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
  const timeRemaining = closeTime ? closeTime - Date.now() : null;
  const timeRemainingMinutes = timeRemaining ? timeRemaining / (60 * 1000) : null;

  // Prices (Kalshi returns in cents)
  const yesAsk = (parseFloat(market.yes_ask) || 0) / 100;
  const noAsk = (parseFloat(market.no_ask) || 0) / 100;

  return {
    ticker: market.ticker,
    title: market.title,
    assetType: 'SPX',
    strikePrice,
    marketType,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk,
    noAsk,
    volume: parseInt(market.volume) || 0
  };
}

// Analyze S&P 500 market for betting opportunity
function analyzeIndexMarket(parsed) {
  if (!parsed.strikePrice || !parsed.marketType || parsed.marketType === 'between') {
    return null;
  }

  const priceData = indexPrices.SPX;
  if (!priceData || !priceData.price) {
    return null;
  }

  const currentPrice = priceData.price;
  const volatility = priceData.volatility;
  const timeMinutes = parsed.timeRemainingMinutes || 60;

  // Calculate how far price is from strike
  const pctFromStrike = ((currentPrice - parsed.strikePrice) / parsed.strikePrice) * 100;

  // Get time-of-day factor for S&P 500
  const timeOfDay = getTimeOfDayFactor();

  // Adjust volatility based on time of day
  const adjustedVolatility = volatility * timeOfDay.factor;

  // Simple probability model for S&P 500
  // Use z-score based on volatility
  const timeHours = timeMinutes / 60;
  const expectedMove = currentPrice * adjustedVolatility * Math.sqrt(timeHours / 4); // 4-hour normalized vol
  const zScore = (parsed.strikePrice - currentPrice) / expectedMove;

  // Convert z-score to probability using normal CDF
  const probBelow = normalCDF(zScore);
  const probAbove = 1 - probBelow;

  // Calculate multi-timeframe momentum
  const allHistory = [...(indexHistoryExtended.SPX || []), ...(priceData.history || [])];
  const momentum = calculateMomentumMultiTimeframe(allHistory);

  // Determine win probabilities based on market type
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = probAbove;
    probNoWins = probBelow;
  } else {
    probYesWins = probBelow;
    probNoWins = probAbove;
  }

  // Adjust for momentum
  if (momentum.aligned) {
    const momentumBoost = parseFloat(momentum.strength) / 100 * 0.5; // Up to 5% boost
    if (momentum.direction === 'bullish') {
      probYesWins = Math.min(0.95, probYesWins + momentumBoost);
      probNoWins = Math.max(0.05, probNoWins - momentumBoost);
    } else if (momentum.direction === 'bearish') {
      probNoWins = Math.min(0.95, probNoWins + momentumBoost);
      probYesWins = Math.max(0.05, probYesWins - momentumBoost);
    }
  }

  // BULLETPROOF: Ensure probabilities are valid numbers
  if (!probYesWins || !probNoWins || isNaN(probYesWins) || isNaN(probNoWins) ||
      probYesWins < 0 || probYesWins > 1) {
    // Fallback based on distance from strike
    const rawProb = 0.5 + (pctFromStrike / 100 * 5);
    probYesWins = Math.max(0.25, Math.min(0.75, parsed.marketType === 'above' ? rawProb : 1 - rawProb));
    probNoWins = 1 - probYesWins;
    console.log(`   📊 Using fallback prob for SPX: ${(probYesWins*100).toFixed(0)}%`);
  }

  // SKIP CALIBRATION - use raw probabilities
  const marketType = parsed.ticker?.includes('1H') ? 'hourly' :
                     parsed.ticker?.includes('15M') ? '15min' : 'daily';

  // Final safety
  if (isNaN(probYesWins)) probYesWins = 0.5;
  if (isNaN(probNoWins)) probNoWins = 0.5;

  // Market implied probabilities
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge
  let yesEdge = (probYesWins - marketProbYes) * 100;
  let noEdge = (probNoWins - marketProbNo) * 100;

  // Find best bet (highest win probability with positive edge)
  let bestBet = null;
  const yesValid = parsed.yesAsk > 0 && parsed.yesAsk < 0.98 && yesEdge > 0.5;
  const noValid = parsed.noAsk > 0 && parsed.noAsk < 0.98 && noEdge > 0.5;

  if (yesValid && noValid) {
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

  // No valid bet found - log why for high-priced markets
  if (!bestBet) {
    const maxPrice = Math.max(parsed.yesAsk || 0, parsed.noAsk || 0);
    if (maxPrice > 0.75) {
      console.log(`   ⚠️ Skipped SPX market: YES@${Math.round((parsed.yesAsk||0)*100)}¢ NO@${Math.round((parsed.noAsk||0)*100)}¢ | Our prob: ${(probYesWins*100).toFixed(0)}% | Need >${Math.round(maxPrice*100)}% to bet`);
    }
    return null;
  }

  const isHighProb = bestBet.prob >= 0.60;
  const isSafeBet = bestBet.prob >= 0.70;

  const priceCents = Math.round(bestBet.price * 100);
  const contractsFor1Dollar = Math.floor(100 / priceCents);
  const totalCostCents = contractsFor1Dollar * priceCents;
  const feeCents = calculateKalshiFee(contractsFor1Dollar, bestBet.price);
  const profitIfWinCents = contractsFor1Dollar * 100 - totalCostCents - feeCents;

  // Build reason string
  const momentumDesc = momentum.direction === 'bullish' ? '📈' : momentum.direction === 'bearish' ? '📉' : '➡️';

  return {
    ...parsed,
    marketCategory: 'index',
    assetType: 'SPX',
    assetName: 'S&P 500',
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    adjustedVolatility: (adjustedVolatility * 100).toFixed(2) + '%',
    pctFromStrike: pctFromStrike.toFixed(2),
    zScore: zScore.toFixed(2),
    winProbability: (bestBet.prob * 100).toFixed(1),
    edge: bestBet.edge,
    betSide: bestBet.side,
    betPrice: bestBet.price,
    betPriceCents: priceCents,
    contractsFor1Dollar,
    feeCents,
    profitIfWin: profitIfWinCents, // After fees
    betReason: `${momentumDesc} S&P ${pctFromStrike > 0 ? 'above' : 'below'} by ${Math.abs(pctFromStrike).toFixed(1)}%`,
    isObviousBet: isSafeBet,
    isHighProb,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    // Enhanced data
    momentum: momentum.direction,
    momentumStrength: momentum.aligned ? 'strong' : 'weak',
    momentumData: momentum,
    timeOfDay: timeOfDay,
    confidence: (isSafeBet ? 85 : isHighProb ? 70 : 55) + '%',
    dataPoints: allHistory.length
  };
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
    // Only match prices with $ sign to avoid matching "15" from "15 mins"
    const priceMatches = title.match(/\$([\d,]+(?:\.\d+)?)/g);
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
    // If no $ price found, try the floor_strike from market data as fallback
    if (!strikePrice && market.floor_strike) {
      strikePrice = parseFloat(market.floor_strike);
    }

    // For "price up/down" 15-min markets, use current price as strike if nothing else
    if (!strikePrice && cryptoType && (title.includes('up') || title.includes('down'))) {
      const priceData = cryptoPrices[cryptoType];
      if (priceData && priceData.price > 0) {
        strikePrice = priceData.price;
        console.log(`   📊 Using current ${cryptoType} price as strike: $${strikePrice.toFixed(2)}`);
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

// Helper to build base result object
function buildBaseResult(parsed, currentPrice, timeMinutes, signal) {
  return {
    ticker: parsed.ticker,
    title: parsed.title,
    cryptoType: parsed.cryptoType,
    assetType: parsed.cryptoType,
    marketType: parsed.marketType,
    currentPrice,
    strikePrice: parsed.strikePrice || currentPrice,
    timeRemaining: parsed.timeRemaining,
    timeRemainingMinutes: timeMinutes,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    yesAsk: parsed.yesAsk,
    noAsk: parsed.noAsk,
    momentumSignal: signal,
    shortMomentum: signal?.momentum
  };
}

// Analyze market using MOMENTUM STRATEGY
// Simple: follow recent price direction for 15-min markets
function analyzeCryptoMarket(parsed) {
  if (!parsed.cryptoType) return null;
  if (!parsed.marketType || parsed.marketType === 'between') return null;

  const priceData = cryptoPrices[parsed.cryptoType];
  if (!priceData || !priceData.price) return null;

  const currentPrice = priceData.price;
  const timeMinutes = parsed.timeRemainingMinutes || 15;

  // Get MOMENTUM SIGNAL - this is our edge
  const signal = getMomentumBetSignal(parsed.cryptoType);

  // If no momentum signal, try PRICE POSITION strategy
  // If price is already far from strike, bet on continuation
  if (!signal.shouldBet) {
    const yesPrice = parsed.yesAsk || 0.5;
    const noPrice = parsed.noAsk || 0.5;
    const strikePrice = parsed.strikePrice || currentPrice;
    const pctFromStrike = ((currentPrice - strikePrice) / strikePrice) * 100;

    // PRICE POSITION STRATEGY: If price is >0.1% from strike, bet on that side
    // The further from strike + less time = higher confidence
    if (Math.abs(pctFromStrike) >= 0.1 && timeMinutes <= 10) {
      const positionSide = pctFromStrike > 0 ? 'YES' : 'NO';
      const positionPrice = positionSide === 'YES' ? yesPrice : noPrice;
      const positionPriceCents = Math.round(positionPrice * 100);

      // Confidence based on distance from strike
      let positionConfidence = 'medium';
      let winProb = 55;
      if (Math.abs(pctFromStrike) >= 0.25) {
        positionConfidence = 'high';
        winProb = 60;
      }
      if (Math.abs(pctFromStrike) >= 0.4) {
        positionConfidence = 'very_high';
        winProb = 65;
      }
      // Time bonus: less time = more confidence price stays
      if (timeMinutes <= 5) winProb += 3;
      if (timeMinutes <= 3) winProb += 2;

      const positionEdge = winProb - positionPriceCents;

      // Only bet if we have positive edge
      if (positionEdge >= 3) {
        return {
          ticker: parsed.ticker,
          title: parsed.title,
          cryptoType: parsed.cryptoType,
          assetType: parsed.cryptoType,
          marketType: parsed.marketType,
          currentPrice,
          strikePrice,
          pctFromStrike: pctFromStrike.toFixed(2),
          timeRemaining: parsed.timeRemaining,
          timeRemainingMinutes: timeMinutes,
          timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
          yesAsk: yesPrice,
          noAsk: noPrice,
          betPriceCents: positionPriceCents,
          betSide: positionSide,
          betPrice: positionPrice,
          winProbability: winProb.toFixed(1),
          edge: positionEdge.toFixed(1),
          expectedValue: ((winProb / 100) * (100 - positionPriceCents) - ((100 - winProb) / 100) * positionPriceCents).toFixed(2),
          isRecommended: true,
          confidence: positionConfidence,
          momentumSignal: { ...signal, positionBased: true },
          reason: `Price ${pctFromStrike > 0 ? 'above' : 'below'} strike by ${Math.abs(pctFromStrike).toFixed(2)}%`
        };
      }
    }

    // No position-based bet either
    return {
      ticker: parsed.ticker,
      title: parsed.title,
      cryptoType: parsed.cryptoType,
      assetType: parsed.cryptoType,
      marketType: parsed.marketType,
      currentPrice,
      strikePrice: parsed.strikePrice || currentPrice,
      timeRemaining: parsed.timeRemaining,
      timeRemainingMinutes: timeMinutes,
      timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
      yesAsk: yesPrice,
      noAsk: noPrice,
      // No clear bet recommendation
      betSide: null,
      betPrice: null,
      winProbability: 50,
      edge: 0,
      expectedValue: 0,
      isRecommended: false,
      momentumSignal: signal,
      reason: signal.reason
    };
  }

  // We have a momentum signal! Determine bet
  const betSide = signal.side; // 'YES' or 'NO'
  const betPrice = betSide === 'YES' ? (parsed.yesAsk || 0.5) : (parsed.noAsk || 0.5);
  const betPriceCents = Math.round(betPrice * 100);

  // SANITY CHECK: Don't bet against strong market consensus
  // If market prices our side below 25¢, they see strong opposite momentum
  // We need VERY high confidence to bet against that
  if (betPriceCents < 25 && signal.confidence !== 'very_high') {
    return {
      ...buildBaseResult(parsed, currentPrice, timeMinutes, signal),
      betSide: null,
      isRecommended: false,
      reason: `Market strongly disagrees (${betSide} @ ${betPriceCents}¢) - need very high confidence to bet against`
    };
  }

  // If market prices our side below 35¢, require at least high confidence
  if (betPriceCents < 35 && signal.confidence === 'medium') {
    return {
      ...buildBaseResult(parsed, currentPrice, timeMinutes, signal),
      betSide: null,
      isRecommended: false,
      reason: `Market disagrees (${betSide} @ ${betPriceCents}¢) - need higher confidence`
    };
  }

  // For momentum strategy, probability is based on signal confidence
  let winProbability;
  if (signal.confidence === 'very_high') {
    winProbability = 68;
  } else if (signal.confidence === 'high') {
    winProbability = 62;
  } else {
    winProbability = 56;
  }

  // Edge = our probability - market price
  const edge = winProbability - betPriceCents;

  // Expected value
  const potentialWin = 100 - betPriceCents;
  const ev = (winProbability / 100) * potentialWin - ((100 - winProbability) / 100) * betPriceCents;

  return {
    ticker: parsed.ticker,
    title: parsed.title,
    cryptoType: parsed.cryptoType,
    assetType: parsed.cryptoType,
    marketType: parsed.marketType,
    currentPrice,
    strikePrice: parsed.strikePrice || currentPrice,
    timeRemaining: parsed.timeRemaining,
    timeRemainingMinutes: timeMinutes,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    yesAsk: parsed.yesAsk,
    noAsk: parsed.noAsk,
    betPriceCents,
    // Momentum-based bet recommendation
    betSide,
    betPrice,
    winProbability: winProbability.toFixed(1),
    edge: edge,
    expectedValue: ev.toFixed(2),
    isRecommended: edge >= 3,
    momentumSignal: signal,
    shortMomentum: signal.momentum,
    hasStrongMomentumSignal: true,
    reason: signal.reason
  };
}


// Calculate Kalshi taker fee
// Formula: ceil(0.07 × contracts × price × (1 - price))
// Capped at $0.02 (2 cents) per contract
function calculateKalshiFee(contracts, priceInDollars) {
  // Price should be between 0 and 1 (e.g., 0.65 for 65 cents)
  const price = Math.min(1, Math.max(0, priceInDollars));
  const feePerContract = Math.ceil(0.07 * price * (1 - price) * 100) / 100; // In dollars
  const cappedFeePerContract = Math.min(0.02, feePerContract); // Cap at 2 cents
  const totalFeeDollars = cappedFeePerContract * contracts;
  return Math.round(totalFeeDollars * 100); // Return in cents
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
      .filter(m => {
        if (m === null) return false;
        if (m.edge < 0.5) return false; // Need 0.5% edge minimum
        // Only show opportunities where win probability is at least 50%
        // This prevents showing bets on sides that are more likely to lose
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 50) return false;
        return true;
      })
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

// Get ALL opportunities (crypto + index) - unified endpoint
// Add ?showAll=true to include markets without edge (for debugging)
app.get('/api/opportunities/all', async (req, res) => {
  try {
    const showAll = req.query.showAll === 'true';

    // Fetch both market types in parallel
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      })
      .filter(m => m !== null)
      .map(m => {
        // Mark why market was filtered
        const winProb = parseFloat(m.winProbability) || 0;
        m.isRecommended = m.edge >= 0.5 && winProb >= 50;
        if (!m.isRecommended) {
          if (m.edge < 0.5) m.filterReason = `No edge (${parseFloat(m.edge || 0).toFixed(1)}%)`;
          else if (winProb < 50) m.filterReason = `Low prob (${winProb.toFixed(0)}%)`;
        }
        return m;
      });

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)))
      .filter(m => m !== null)
      .map(m => {
        const winProb = parseFloat(m.winProbability) || 0;
        m.isRecommended = m.edge >= 0.5 && winProb >= 50;
        if (!m.isRecommended) {
          if (m.edge < 0.5) m.filterReason = `No edge (${parseFloat(m.edge || 0).toFixed(1)}%)`;
          else if (winProb < 50) m.filterReason = `Low prob (${winProb.toFixed(0)}%)`;
        }
        return m;
      });

    // Combine all analyzed markets
    const allAnalyzed = [...cryptoOpps, ...indexOpps];

    // ALWAYS include BTC, ETH, SOL - mark as "locked" if no edge
    const coreTokens = ['BTC', 'ETH', 'SOL'];
    const coreMarkets = [];

    for (const token of coreTokens) {
      // Find the best market for this token (prefer 15min)
      const tokenMarket = cryptoOpps.find(m => m.cryptoType === token || m.assetType === token);

      if (tokenMarket) {
        // Market exists - mark as locked if not recommended
        tokenMarket.isLocked = !tokenMarket.isRecommended;
        tokenMarket.isCore = true;
        coreMarkets.push(tokenMarket);
      } else {
        // No market found - create placeholder
        const price = cryptoPrices[token]?.price || 0;
        coreMarkets.push({
          ticker: `KX${token}15M-PLACEHOLDER`,
          title: `${token} price prediction`,
          cryptoType: token,
          assetType: token,
          marketCategory: 'crypto',
          currentPrice: price,
          strikePrice: price,
          timeRemaining: 0,
          timeRemainingFormatted: 'Scanning...',
          winProbability: 50,
          edge: 0,
          betSide: null,
          isRecommended: false,
          isLocked: true,
          isCore: true,
          isPlaceholder: true,
          filterReason: 'No edge found'
        });
      }
    }

    // Filter to recommended only (unless showAll=true), but always include core markets
    const recommendedOpps = allAnalyzed.filter(m => m.isRecommended);
    const nonCoreRecommended = recommendedOpps.filter(m => !coreTokens.includes(m.cryptoType) && !coreTokens.includes(m.assetType));

    // Core markets first (BTC, ETH, SOL), then other recommended
    const allOpportunities = [...coreMarkets, ...nonCoreRecommended]
      .sort((a, b) => {
        // Core markets first
        if (a.isCore && !b.isCore) return -1;
        if (!a.isCore && b.isCore) return 1;
        // Then by recommended status
        if (a.isRecommended && !b.isRecommended) return -1;
        if (!a.isRecommended && b.isRecommended) return 1;
        // Then by probability
        return parseFloat(b.winProbability) - parseFloat(a.winProbability);
      });

    // Refresh positions before calculating risk
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    // Get current risk info by type
    const riskByType = getRiskByType();

    // Price display
    const priceDisplay = {
      crypto: {},
      index: { SPX: indexPrices.SPX.price }
    };
    for (const token of Object.keys(cryptoPrices)) {
      if (cryptoPrices[token].price > 0) {
        priceDisplay.crypto[token] = cryptoPrices[token].price;
      }
    }

    // Calculate filter statistics
    const recommended = allAnalyzed.filter(m => m.isRecommended);
    const noEdge = allAnalyzed.filter(m => !m.isRecommended && m.edge < 0.5);
    const lowProb = allAnalyzed.filter(m => !m.isRecommended && m.edge >= 0.5);

    res.json({
      success: true,
      count: allOpportunities.length,
      showingAll: showAll,
      stats: {
        totalAnalyzed: allAnalyzed.length,
        recommended: recommended.length,
        filteredNoEdge: noEdge.length,
        filteredLowProb: lowProb.length
      },
      cryptoCount: cryptoOpps.filter(m => m.isRecommended).length,
      indexCount: indexOpps.filter(m => m.isRecommended).length,
      prices: priceDisplay,
      risk: {
        current: riskByType.total,
        max: getMaxTotalRisk(),
        remaining: getTotalRemainingBudget(),
        currentDollars: (riskByType.total / 100).toFixed(2),
        maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
        remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2)
      },
      opportunities: allOpportunities
    });
  } catch (error) {
    console.error('Error getting all opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current risk exposure
app.get('/api/risk', async (req, res) => {
  try {
    // Refresh portfolio if authenticated
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    // Calculate risk from Kalshi positions
    let kalshiRisk = 0;
    const kalshiTickers = new Set();
    if (portfolio.positions && Array.isArray(portfolio.positions)) {
      for (const pos of portfolio.positions) {
        const contracts = Math.abs(pos.position || 0);
        if (contracts > 0) {
          const avgPrice = pos.average_price || 50;
          kalshiRisk += contracts * avgPrice;
          kalshiTickers.add(pos.ticker);
        }
      }
    }

    // Calculate risk from unsettled local bets not yet in Kalshi positions
    // Only count bets from the last 2 hours
    let localRisk = 0;
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const unsettledBets = betHistory.filter(bet => {
      if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') {
        return false;
      }
      const betTime = new Date(bet.timestamp).getTime();
      if (betTime < twoHoursAgo) {
        return false;
      }
      if (kalshiTickers.has(bet.ticker)) {
        return false;
      }
      return true;
    });

    for (const bet of unsettledBets) {
      localRisk += bet.totalCost || (bet.count * bet.price) || 0;
    }

    const currentRisk = kalshiRisk + localRisk;
    const remainingBudget = Math.max(0, getMaxTotalRisk() - currentRisk);

    console.log(`📊 Risk: Kalshi=$${(kalshiRisk/100).toFixed(2)} (${kalshiTickers.size} positions), Local=$${(localRisk/100).toFixed(2)} (${unsettledBets.length} bets), Total=$${(currentRisk/100).toFixed(2)} / $${(getMaxTotalRisk()/100).toFixed(2)}`);

    res.json({
      success: true,
      risk: {
        current: currentRisk,
        max: getMaxTotalRisk(),
        remaining: remainingBudget,
        currentDollars: (currentRisk / 100).toFixed(2),
        maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
        remainingDollars: (remainingBudget / 100).toFixed(2),
        positionCount: kalshiTickers.size,
        unsettledBetCount: unsettledBets.length,
        kalshiRiskDollars: (kalshiRisk / 100).toFixed(2),
        localRiskDollars: (localRisk / 100).toFixed(2)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get risk settings
app.get('/api/settings/risk', (req, res) => {
  res.json({
    success: true,
    riskLimits: config.riskLimits
  });
});

// Update risk settings
app.post('/api/settings/risk', (req, res) => {
  const { maxPerBet, maxTotal, maxPerToken } = req.body;

  if (maxPerBet !== undefined) {
    config.riskLimits.maxPerBet = Math.max(10, Math.min(1000, parseInt(maxPerBet) || 200));
  }
  if (maxTotal !== undefined) {
    config.riskLimits.maxTotal = Math.max(100, Math.min(10000, parseInt(maxTotal) || 1500));
  }
  if (maxPerToken !== undefined) {
    config.riskLimits.maxPerToken = Math.max(100, Math.min(5000, parseInt(maxPerToken) || 500));
  }

  // Persist to disk
  saveSettings();

  console.log(`⚙️ Risk settings updated:`, JSON.stringify(config.riskLimits));

  res.json({
    success: true,
    riskLimits: config.riskLimits,
    message: 'Risk settings saved'
  });
});

// Get scale-in settings
app.get('/api/settings/scale-in', (req, res) => {
  res.json({
    success: true,
    scaleIn: config.scaleIn
  });
});

// Update scale-in settings
app.post('/api/settings/scale-in', (req, res) => {
  const { enabled, minProbabilityIncrease, maxBetsPerMarket, minTimeBetweenBets } = req.body;

  if (enabled !== undefined) {
    config.scaleIn.enabled = !!enabled;
  }
  if (minProbabilityIncrease !== undefined) {
    config.scaleIn.minProbabilityIncrease = Math.max(5, Math.min(50, parseInt(minProbabilityIncrease) || 15));
  }
  if (maxBetsPerMarket !== undefined) {
    config.scaleIn.maxBetsPerMarket = Math.max(1, Math.min(10, parseInt(maxBetsPerMarket) || 3));
  }
  if (minTimeBetweenBets !== undefined) {
    config.scaleIn.minTimeBetweenBets = Math.max(30000, Math.min(600000, parseInt(minTimeBetweenBets) || 60000));
  }

  // Persist to disk
  saveSettings();

  console.log(`⚙️ Scale-in settings updated:`, JSON.stringify(config.scaleIn));

  res.json({
    success: true,
    scaleIn: config.scaleIn,
    message: 'Scale-in settings updated'
  });
});

// ============================================
// SENTIMENT & NEWS API ENDPOINTS
// ============================================

// Get overall market sentiment
app.get('/api/sentiment', async (req, res) => {
  try {
    const [news, reddit] = await Promise.all([
      Promise.resolve(getRecentNews(20)),
      getRedditSentiment()
    ]);

    const overall = calculateOverallSentiment(news, reddit);

    res.json({
      success: true,
      timestamp: Date.now(),
      overall,
      news: news.map(a => ({
        title: a.title,
        source: a.source,
        link: a.link,
        pubDate: a.pubDate,
        urgency: a.urgency
      })),
      reddit: reddit.slice(0, 20),
      alerts: recentAlerts.slice(0, 10),
      config: {
        newsInterval: NEWS_CONFIG.checkIntervalMs,
        urgencyThreshold: NEWS_CONFIG.urgencyThreshold,
        maxNewsAge: NEWS_CONFIG.maxNewsAge
      }
    });
  } catch (error) {
    console.error('Sentiment API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent news articles
app.get('/api/news/latest', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const maxAgeMinutes = parseInt(req.query.maxAge) || 60;

  const news = getRecentNews(limit, maxAgeMinutes * 60 * 1000);

  res.json({
    success: true,
    count: news.length,
    news: news.map(a => ({
      title: a.title,
      source: a.source,
      link: a.link,
      pubDate: a.pubDate,
      urgency: a.urgency,
      age: Math.round((Date.now() - a.pubDate.getTime()) / 60000) + ' min ago'
    }))
  });
});

// Get recent alerts
app.get('/api/news/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  res.json({
    success: true,
    count: recentAlerts.length,
    alerts: recentAlerts.slice(0, limit)
  });
});

// Manually trigger news check
app.post('/api/news/check', async (req, res) => {
  try {
    const newArticles = await fetchAllNews();

    res.json({
      success: true,
      newArticles: newArticles.length,
      totalCached: newsCache.length,
      alerts: recentAlerts.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Reddit sentiment data
app.get('/api/reddit/sentiment', async (req, res) => {
  try {
    const reddit = await getRedditSentiment();

    res.json({
      success: true,
      count: reddit.length,
      tickers: reddit
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Place a bet
app.post('/api/bet', async (req, res) => {
  try {
    const { ticker, side, expectedPrice } = req.body;

    if (!ticker || !side) {
      return res.status(400).json({ success: false, error: 'ticker and side required' });
    }

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions before bet:', e.message);
      }
    }

    // Force fresh market data by clearing cache
    marketCache.lastFetch = 0;
    indexMarketCache.lastFetch = 0;

    // Search both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);

    let market = cryptoMarkets.find(m => m.ticker === ticker);
    let marketType = 'crypto';

    if (!market) {
      market = indexMarkets.find(m => m.ticker === ticker);
      marketType = 'index';
    }

    if (!market) {
      return res.status(404).json({ success: false, error: `Market ${ticker} not found or has expired` });
    }

    // Check if market is still open
    const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
    if (closeTime && closeTime < Date.now()) {
      return res.status(400).json({ success: false, error: 'Market has closed' });
    }

    // Kalshi API returns prices in cents already (e.g., yes_ask: 4 means 4 cents)
    let priceCents = side.toLowerCase() === 'yes'
      ? parseFloat(market.yes_ask) || 0
      : parseFloat(market.no_ask) || 0;

    console.log(`Bet attempt: ${ticker} | side=${side} | yes_ask=${market.yes_ask} | no_ask=${market.no_ask} | priceCents=${priceCents} | expectedPrice=${expectedPrice}`);

    // If we have an expected price from the UI and the fetched price is 0 or very different, use expected
    if (expectedPrice && expectedPrice > 0) {
      if (priceCents <= 0) {
        console.log(`Using expected price ${expectedPrice} since market price is 0`);
        priceCents = expectedPrice;
      } else if (Math.abs(priceCents - expectedPrice) > 10) {
        // Price changed by more than 10 cents - warn but proceed with current price
        console.log(`Price changed: expected ${expectedPrice}, got ${priceCents}`);
      }
    }

    if (!priceCents || priceCents <= 0) {
      return res.status(400).json({
        success: false,
        error: `No liquidity for ${side.toUpperCase()} side (price=0). Try the other side or wait.`,
        debug: { yes_ask: market.yes_ask, no_ask: market.no_ask, ticker }
      });
    }

    // Calculate bet size based on configurable limits
    const remainingBudget = getRemainingRiskBudget();
    const remainingTokenBudget = getRemainingTokenBudget(ticker, market.assetType);
    const maxPerBet = getMaxPerBet();
    const maxPerToken = getMaxPerToken();

    // Take minimum of: max per bet, pool budget, and token budget
    const TARGET_BET_CENTS = Math.min(maxPerBet, remainingBudget, remainingTokenBudget);

    if (remainingTokenBudget < priceCents) {
      const token = getTokenFromTicker(ticker) || market.assetType || 'token';
      return res.status(400).json({
        success: false,
        error: `Token limit reached for ${token}. Only $${(remainingTokenBudget/100).toFixed(2)} remaining of $${(maxPerToken/100).toFixed(2)} max per token.`
      });
    }

    if (TARGET_BET_CENTS < priceCents) {
      return res.status(400).json({
        success: false,
        error: `Risk limit reached for ${poolType} markets. Only $${(remainingBudget/100).toFixed(2)} remaining of $${(poolMax/100).toFixed(2)} max.`
      });
    }

    const count = Math.floor(TARGET_BET_CENTS / priceCents);

    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: `Contract price too high (${priceCents}¢). Max price: 99¢`
      });
    }

    const totalCost = count * priceCents;
    console.log(`Bet: ${ticker} | ${side} | price=${priceCents}¢ | count=${count} | total=${totalCost}¢`);

    const betRecord = {
      id: Date.now().toString(),
      ticker,
      title: market.title,
      side: side.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        token: market.assetType || getTokenFromTicker(ticker),
        predictedProb: parseFloat(req.body.winProbability) || 60,
        edge: parseFloat(req.body.edge) || 5,
        strikePrice: market.strikePrice,
        currentPrice: market.currentPrice,
        expiryTime: market.expiry || market.close_time,
        marketType: ticker?.includes('15M') ? '15min' : 'daily'
      });

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet - check orderbook for liquidity first
    let bestAsk = priceCents;
    try {
      const orderbook = await kalshiRequest('GET', `/markets/${ticker}/orderbook`);
      const sideKey = side.toLowerCase();
      const asks = sideKey === 'yes' ? orderbook.yes : orderbook.no;
      if (!asks || asks.length === 0 || !asks[0] || asks[0][1] === 0) {
        return res.status(400).json({
          success: false,
          error: `No liquidity available for ${side.toUpperCase()} side. The orderbook is empty.`
        });
      }
      bestAsk = asks[0][0];
      console.log(`Orderbook check: Best ${side} ask = ${bestAsk}¢, qty = ${asks[0][1]}`);
    } catch (obErr) {
      console.log(`Orderbook fetch failed: ${obErr.message}, using market price`);
    }

    // Use best ask + buffer to ensure fill
    const fillPrice = Math.min(bestAsk + 3, 99);

    const orderRequest = {
      ticker,
      action: 'buy',
      side: side.toLowerCase(),
      type: 'limit',
      count
    };

    // Add the appropriate price field based on side
    if (side.toLowerCase() === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }

    console.log(`Placing order (ask: ${priceCents}¢, bid: ${fillPrice}¢, using: ${fillPrice}¢):`, JSON.stringify(orderRequest));

    try {
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
      console.log('Order response:', JSON.stringify(orderResponse));

      const order = orderResponse.order;
      if (!order) {
        return res.status(400).json({ success: false, error: 'No order in response' });
      }

      // Check if order was filled
      const status = order.status;
      const filledCount = order.filled_count || 0;

      if (filledCount === 0) {
        return res.status(400).json({
          success: false,
          error: `Order not filled. Status: ${status}. No liquidity at current price.`
        });
      }

      // Update bet record with actual fill info
      betRecord.status = status === 'filled' ? 'filled' : 'partial';
      betRecord.orderId = order.order_id;
      betRecord.filledCount = filledCount;
      betRecord.avgPrice = order.average_fill_price || priceCents;
      betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
      betHistory.unshift(betRecord);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        count: filledCount,
        token: market.assetType || getTokenFromTicker(ticker),
        predictedProb: parseFloat(req.body.winProbability) || 60,
        edge: parseFloat(req.body.edge) || 5,
        strikePrice: market.strikePrice,
        currentPrice: market.currentPrice,
        expiryTime: market.expiry || market.close_time,
        marketType: ticker?.includes('15M') ? '15min' : 'daily'
      });

      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      // Refresh positions for risk tracking
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions after bet:', e.message);
      }

      const riskByType = getRiskByType();

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        newBalance: portfolio.balance / 100,
        risk: {
          current: riskByType.total,
          max: getMaxTotalRisk(),
          remaining: getTotalRemainingBudget(),
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
          remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2)
        }
      });

      console.log(`✅ Bet placed. Risk now: $${(riskByType.total / 100).toFixed(2)} / $${(getMaxTotalRisk() / 100).toFixed(2)}`);
    } catch (orderError) {
      console.error('Kalshi order error:', orderError.message);
      res.status(400).json({ success: false, error: `Kalshi: ${orderError.message}` });
    }

  } catch (error) {
    console.error('Error placing bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto-bet on best opportunity (Place Best Bet button) - now supports all markets
app.post('/api/crypto/auto-bet', async (req, res) => {
  try {
    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions before auto-bet:', e.message);
      }
    }

    // Fetch both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);
    const now = Date.now();

    // Clean up old bets from tracking (older than 30 min)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      });

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)));

    // Combine and filter
    const opportunities = [...cryptoOpps, ...indexOpps]
      .filter(m => {
        if (m === null) return false;
        // REQUIRE 60%+ WIN PROBABILITY for auto-betting
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 60) return false;

        // Check if we already bet on this market
        if (recentBets.has(m.ticker)) {
          // Allow scale-in if probability improved significantly
          if (shouldAllowScaleIn(m.ticker, winProb)) {
            m.isScaleIn = true; // Mark as scale-in opportunity
          } else {
            return false; // Skip - already bet and not a valid scale-in
          }
        }
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    const totalScanned = cryptoMarkets.length + indexMarkets.length;

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: 'No opportunities with 60%+ win probability found. Waiting...',
        bet: null,
        scanned: totalScanned
      });
    }

    const best = opportunities[0];

    // Check risk limit
    const remainingBudget = getRemainingRiskBudget();

    if (remainingBudget < 10) { // Less than 10 cents remaining
      return res.json({
        success: true,
        message: `Exposure limit reached ($${(getMaxTotalRisk()/100).toFixed(2)} max). Wait for positions to settle.`,
        bet: null,
        risk: getRiskByType()
      });
    }
    const category = best.marketCategory || 'crypto';
    const maxPerBet = getMaxPerBet();
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType);
    console.log(`Auto-bet found [${category}]: ${best.title} | Win prob: ${best.winProbability}% | Side: ${best.betSide}`);

    // Check per-token limit first
    if (remainingTokenBudget < 10) {
      const token = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
      console.log(`⚠️ Token limit reached for ${token} - $${(getMaxPerToken()/100).toFixed(2)} max per token`);
      return res.json({
        success: true,
        message: `Token limit reached for ${token}. Max $${(getMaxPerToken()/100).toFixed(2)} per token.`,
        bet: null,
        risk: getRiskByType()
      });
    }

    // Cap bet at remaining risk budget, max per bet, OR token budget - whichever is lowest
    const MAX_BET_CENTS = Math.min(maxPerBet, remainingBudget, remainingTokenBudget);

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      return res.json({ success: true, message: 'Bet size too small for risk budget', bet: null });
    }

    // Ensure we don't exceed budget
    const totalCost = count * priceCents;

    // Get existing bet info for scale-in tracking
    const existingBet = recentBets.get(best.ticker);
    const newBetCount = best.isScaleIn ? ((existingBet?.betCount || 1) + 1) : 1;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      marketCategory: category,
      assetType: best.assetType || best.cryptoType,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      edge: best.edge,
      winProbability: best.winProbability,
      currentPrice: best.currentPrice,
      strikePrice: best.strikePrice,
      timestamp: new Date().toISOString(),
      status: 'pending',
      auto: true,
      isScaleIn: best.isScaleIn || false,
      scaleInNumber: newBetCount
    };

    // Mark this market as bet on (or update for scale-in)
    recentBets.set(best.ticker, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      betCount: newBetCount
    });
    if (best.isScaleIn) {
      console.log(`📈 Scale-in bet #${newBetCount} on ${best.ticker} at ${best.winProbability}%`);
    }

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        opportunity: best,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet - check orderbook for liquidity first
    let bestAsk = priceCents;
    try {
      const orderbook = await kalshiRequest('GET', `/markets/${best.ticker}/orderbook`);
      const sideKey = best.betSide.toLowerCase();
      const asks = sideKey === 'yes' ? orderbook.yes : orderbook.no;
      if (!asks || asks.length === 0 || !asks[0] || asks[0][1] === 0) {
        return res.status(400).json({
          success: false,
          error: `No liquidity for ${best.betSide.toUpperCase()}. Orderbook empty.`
        });
      }
      bestAsk = asks[0][0];
      console.log(`Auto-bet orderbook: Best ${best.betSide} ask = ${bestAsk}¢`);
    } catch (obErr) {
      console.log(`Auto-bet orderbook fetch failed: ${obErr.message}`);
    }

    const fillPrice = Math.min(bestAsk + 3, 99);

    const orderRequest = {
      ticker: best.ticker,
      action: 'buy',
      side: best.betSide.toLowerCase(),
      type: 'limit',
      count
    };

    // Add the appropriate price field based on side
    if (best.betSide.toLowerCase() === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }

    console.log(`Auto-bet placing order (ask: ${priceCents}¢, bid: ${fillPrice}¢):`, JSON.stringify(orderRequest));

    try {
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
      console.log('Auto-bet order response:', JSON.stringify(orderResponse));

      const order = orderResponse.order;
      if (!order) {
        return res.status(400).json({ success: false, error: 'No order in response' });
      }

      // Check if order was filled
      const status = order.status;
      const filledCount = order.filled_count || 0;

      if (filledCount === 0) {
        // Remove from recent bets so we can try again
        recentBets.delete(best.ticker);
        return res.status(400).json({
          success: false,
          error: `Order not filled. Status: ${status}. No liquidity at current price.`
        });
      }

      // Update bet record with actual fill info
      betRecord.status = status === 'filled' ? 'filled' : 'partial';
      betRecord.orderId = order.order_id;
      betRecord.filledCount = filledCount;
      betRecord.avgPrice = order.average_fill_price || priceCents;
      betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
      betHistory.unshift(betRecord);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        count: filledCount,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: betRecord.avgPrice,
        marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      // Refresh positions for accurate risk calculation
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions after auto-bet:', e.message);
      }

      const riskByType = getRiskByType();

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        opportunity: best,
        newBalance: portfolio.balance / 100,
        risk: {
          current: riskByType.total,
          max: getMaxTotalRisk(),
          remaining: getTotalRemainingBudget(),
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
          remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2)
        }
      });
    } catch (orderError) {
      console.error('Kalshi auto-bet order error:', orderError.message);
      // Remove from recent bets on error so we can try again
      recentBets.delete(best.ticker);
      res.status(400).json({ success: false, error: `Kalshi: ${orderError.message}` });
    }

  } catch (error) {
    console.error('Error in auto-bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle auto-betting
let autoBetInterval = null;

async function runAutoBet() {
  try {
    console.log('\n🤖 ========== AUTO-BET SCAN ==========');

    // Reset scan status
    lastScanStatus = {
      timestamp: new Date().toISOString(),
      cryptoMarketsFound: 0,
      indexMarketsFound: 0,
      analyzedValid: 0,
      withEdge: 0,
      above60: 0,
      filteredByRecentBet: 0,
      bestOpportunity: null,
      blockedReason: null,
      betPlaced: false,
      betDetails: null
    };

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.market_positions || posData.positions || [];
        console.log(`📊 Refreshed positions: ${portfolio.positions.length} open positions from Kalshi`);
        if (portfolio.positions.length > 0) {
          portfolio.positions.forEach(p => {
            console.log(`   Position: ${p.ticker} | position=${p.position} | avg_price=${p.average_price}`);
          });
        }
      } catch (e) {
        console.log('⚠️ Could not refresh positions:', e.message);
      }
    }

    // Force fresh market data
    marketCache.lastFetch = 0;
    indexMarketCache.lastFetch = 0;

    // Fetch both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);
    const now = Date.now();

    // Clean up old bets (remove bets older than 30 minutes)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    console.log(`📊 Fetched: ${cryptoMarkets.length} crypto, ${indexMarkets.length} index markets`);
    console.log(`   Recent bets tracking: ${recentBets.size} markets`);

    // Update scan status
    lastScanStatus.cryptoMarketsFound = cryptoMarkets.length;
    lastScanStatus.indexMarketsFound = indexMarkets.length;

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      });

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)));

    // Count before filtering
    const allOpps = [...cryptoOpps, ...indexOpps].filter(m => m !== null);
    const withEdge = allOpps.filter(m => m.edge > 0);
    const above50 = allOpps.filter(m => parseFloat(m.winProbability) >= 50);
    const above60 = allOpps.filter(m => parseFloat(m.winProbability) >= 60);

    console.log(`   Analyzed: ${allOpps.length} valid | ${withEdge.length} with edge | ${above50.length} >50% | ${above60.length} >60%`);

    // Update scan status
    lastScanStatus.analyzedValid = allOpps.length;
    lastScanStatus.withEdge = withEdge.length;
    lastScanStatus.above60 = above60.length;

    // Show probability distribution for debugging
    const probBuckets = { '50-55': 0, '55-60': 0, '60-65': 0, '65-70': 0, '70-75': 0, '75-80': 0 };
    allOpps.forEach(m => {
      const prob = parseFloat(m.winProbability) || 0;
      if (prob >= 75) probBuckets['75-80']++;
      else if (prob >= 70) probBuckets['70-75']++;
      else if (prob >= 65) probBuckets['65-70']++;
      else if (prob >= 60) probBuckets['60-65']++;
      else if (prob >= 55) probBuckets['55-60']++;
      else if (prob >= 50) probBuckets['50-55']++;
    });
    console.log(`   Probability distribution: ${JSON.stringify(probBuckets)}`);

    // Combine and filter - EDGE-BASED FILTERING
    // Edge is what determines profitability, not raw probability!
    // A 46% probability at 14¢ has great expected value
    const MIN_EDGE = 3;        // 3% minimum edge - lowered for more action
    const MIN_PROB = 0;        // REMOVED - edge is all that matters

    // Log ALL markets for debugging
    console.log(`   🔍 Market breakdown:`);
    const withAnyEdge = allOpps.filter(m => m.edge > 0);
    const withGoodEdge = allOpps.filter(m => m.edge >= 2);
    console.log(`      Total analyzed: ${allOpps.length} | Any edge: ${withAnyEdge.length} | 2%+ edge: ${withGoodEdge.length}`);

    if (withAnyEdge.length > 0) {
      console.log(`   📊 Top 5 by edge:`);
      withAnyEdge.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge)).slice(0, 5).forEach(m => {
        const momStr = m.hasStrongMomentumSignal ? ` 🚀${m.shortMomentum?.direction || ''}` : '';
        const edgeNum = parseFloat(m.edge) || 0;
        console.log(`      - ${m.title?.substring(0, 30)}: ${m.winProbability}% @ ${m.betPriceCents}¢ | edge +${edgeNum.toFixed(1)}%${momStr}`);
      });
    }

    const opportunities = [...cryptoOpps, ...indexOpps]
      .filter(m => {
        if (m === null) return false;

        const winProb = parseFloat(m.winProbability) || 0;
        const edge = m.edge || 0;

        // Primary filter: ANY positive edge
        if (edge < MIN_EDGE) return false;

        // Secondary filter: must be better than coin flip
        if (winProb < MIN_PROB) return false;

        // Check if we already bet on this market
        if (recentBets.has(m.ticker)) {
          // Allow scale-in if probability improved significantly
          if (shouldAllowScaleIn(m.ticker, winProb)) {
            m.isScaleIn = true; // Mark as scale-in opportunity
          } else {
            return false; // Skip - already bet and not a valid scale-in
          }
        }

        // Calculate expected value score for sorting
        // EV = (prob * profit) - ((1-prob) * cost) normalized
        // Simplified: edge * probability gives us a quality score
        m.evScore = (edge / 100) * (winProb / 100) * 100;

        return true;
      })
      // SORT BY EXPECTED VALUE (best risk-adjusted bets first)
      .sort((a, b) => b.evScore - a.evScore);

    const highEdgeCount = opportunities.filter(o => parseFloat(o.edge) >= MIN_EDGE).length;
    console.log(`   Final: ${opportunities.length} opportunities (${highEdgeCount} with ${MIN_EDGE}%+ edge)`);

    // Show top opportunities
    if (opportunities.length > 0) {
      console.log(`   🎯 Top opportunities (by EV):`);
      opportunities.slice(0, 3).forEach(m => {
        console.log(`      - ${m.title}: ${m.winProbability}% @ ${m.betPriceCents}¢ | Edge: +${parseFloat(m.edge || 0).toFixed(1)}% | EV: ${m.evScore.toFixed(2)}`);
      });
    }

    // Show markets close to threshold
    const nearThreshold = allOpps.filter(m => {
      const edge = m.edge || 0;
      return edge > 0 && edge < MIN_EDGE;
    });
    if (nearThreshold.length > 0) {
      console.log(`   📈 ${nearThreshold.length} markets with small edge (0-${MIN_EDGE}%):`);
      nearThreshold.slice(0, 3).forEach(m => {
        console.log(`      - ${m.title}: ${m.winProbability}% | Edge: +${parseFloat(m.edge || 0).toFixed(1)}%`);
      });
    }

    if (opportunities.length === 0) {
      lastScanStatus.blockedReason = 'no_opportunities';
      // Find closest to threshold for diagnostic (best edge that didn't qualify)
      const closest = allOpps
        .filter(m => m.edge > 0)
        .sort((a, b) => b.edge - a.edge)[0];
      if (closest) {
        const winProb = parseFloat(closest.winProbability) || 0;
        let reason = '';
        if (closest.edge < MIN_EDGE) {
          reason = `Edge too low: ${parseFloat(closest.edge || 0).toFixed(1)}% (need ${MIN_EDGE}%+)`;
        } else if (winProb < MIN_PROB) {
          reason = `Prob too low: ${winProb}% (need ${MIN_PROB}%+)`;
        } else {
          reason = 'Already bet on this market';
        }
        lastScanStatus.bestOpportunity = {
          title: closest.title,
          winProbability: closest.winProbability,
          edge: closest.edge,
          reason
        };
      }
      console.log('⏳ No valid opportunities - waiting for next scan...');
      console.log('========================================\n');
      return;
    }

    // === MULTI-BET LOOP: Bet on ALL qualifying opportunities ===
    const riskByType = getRiskByType();
    console.log(`💰 Exposure: $${(riskByType.total/100).toFixed(2)} / $${(getMaxTotalRisk()/100).toFixed(2)}`);

    let betsPlaced = 0;
    let totalBetAmount = 0;
    const betResults = [];

    // Process each opportunity (already sorted by EV)
    for (const opp of opportunities) {
      // Check if we've hit overall limits
      if (getTotalRemainingBudget() < 10) {
        console.log('   ⚠️ Exposure limit reached - stopping');
        break;
      }

      const remainingBudget = getRemainingRiskBudget();
      const remainingTokenBudget = getRemainingTokenBudget(opp.ticker, opp.assetType || opp.cryptoType);
      const tokenName = getTokenFromTicker(opp.ticker) || opp.assetType || opp.cryptoType || 'token';

      // Skip if budget exhausted
      if (remainingBudget < 10) {
        console.log(`   ⏭️ ${tokenName}: Exposure limit reached`);
        continue;
      }

      // Skip if token limit exhausted
      if (remainingTokenBudget < 10) {
        console.log(`   ⏭️ ${tokenName}: Token limit reached`);
        continue;
      }

      const priceCents = Math.round(opp.betPrice * 100);
      const winProb = parseFloat(opp.winProbability);

      // Kelly Criterion bet sizing - use actual balance
      const actualBankroll = Math.max(config.bankroll, portfolio.balance || 0);
      const maxBetCents = Math.min(getMaxPerBet(), remainingBudget, remainingTokenBudget);
      const kellyBetSize = calculateKellyBet(winProb, priceCents, actualBankroll, maxBetCents);

      // Check if Kelly recommends betting
      if (kellyBetSize < priceCents) {
        // Log why Kelly rejected
        const edge = winProb - priceCents;
        if (edge <= 0) {
          console.log(`   ⏭️ ${tokenName}: No edge (prob ${winProb.toFixed(1)}% ≤ price ${priceCents}¢)`);
        } else {
          console.log(`   ⏭️ ${tokenName}: Kelly too small (${kellyBetSize}¢ < ${priceCents}¢ min)`);
        }
        continue;
      }

      const count = Math.floor(kellyBetSize / priceCents);
      if (count < 1) continue;

      const totalCost = count * priceCents;

      // Get existing bet info for scale-in tracking
      const existingBet = recentBets.get(opp.ticker);
      const newBetCount = opp.isScaleIn ? ((existingBet?.betCount || 1) + 1) : 1;

      const betRecord = {
        id: Date.now().toString() + '-' + betsPlaced,
        ticker: opp.ticker,
        title: opp.title,
        marketCategory: opp.marketCategory || 'crypto',
        assetType: opp.assetType || opp.cryptoType,
        side: opp.betSide.toLowerCase(),
        count,
        price: priceCents,
        totalCost,
        edge: opp.edge,
        winProbability: opp.winProbability,
        kellyFraction: (kellyBetSize / config.bankroll * 100).toFixed(1) + '%',
        timestamp: new Date().toISOString(),
        status: config.isAuthenticated ? 'pending' : 'simulated',
        auto: true,
        isScaleIn: opp.isScaleIn || false,
        scaleInNumber: newBetCount
      };

      // Mark this market as bet on
      recentBets.set(opp.ticker, {
        timestamp: now,
        side: opp.betSide,
        probability: winProb,
        betCount: newBetCount
      });

      if (!config.isAuthenticated) {
        // Simulated bet
        betRecord.orderId = 'SIM-' + Date.now() + '-' + betsPlaced;
        betHistory.unshift(betRecord);
        config.bankroll -= betRecord.totalCost;

        trackBet({
          ...betRecord,
          token: tokenName,
          predictedProb: winProb,
          marketPrice: priceCents,
          strikePrice: opp.strikePrice,
          currentPrice: opp.currentPrice,
          marketType: opp.ticker?.includes('15M') ? '15min' : 'daily',
          expiryTime: opp.expiry || opp.close_time
        });

        console.log(`   ✅ SIM: ${opp.betSide} ${tokenName} ${count}x@${priceCents}¢ | Edge:+${parseFloat(opp.edge || 0).toFixed(1)}% | Kelly:${betRecord.kellyFraction}`);
        betsPlaced++;
        totalBetAmount += totalCost;
        betResults.push({ ticker: opp.ticker, side: opp.betSide, count, price: priceCents, edge: opp.edge });

      } else {
        // Real bet - check orderbook for liquidity, flip sides if needed
        try {
          let finalSide = opp.betSide.toLowerCase();
          let bestAsk = priceCents;
          let hasLiquidity = false;
          let flippedSide = false;

          try {
            const orderbook = await kalshiRequest('GET', `/markets/${opp.ticker}/orderbook`);

            // Check preferred side first
            const preferredAsks = finalSide === 'yes' ? orderbook.yes : orderbook.no;
            if (preferredAsks && preferredAsks.length > 0 && preferredAsks[0] && preferredAsks[0][1] > 0) {
              hasLiquidity = true;
              bestAsk = preferredAsks[0][0];
              const availableQty = preferredAsks[0][1];
              if (availableQty < count) {
                console.log(`   ⚠️ ${tokenName}: Partial liquidity (${availableQty} available, need ${count})`);
              }
            } else {
              // No liquidity on preferred side - check opposite side
              const oppositeSide = finalSide === 'yes' ? 'no' : 'yes';
              const oppositeAsks = oppositeSide === 'yes' ? orderbook.yes : orderbook.no;

              if (oppositeAsks && oppositeAsks.length > 0 && oppositeAsks[0] && oppositeAsks[0][1] > 0) {
                const oppositePrice = oppositeAsks[0][0];
                // Our probability for the opposite side
                const oppositeProb = 100 - winProb;
                // Edge on opposite side = our prob - market implied prob
                const oppositeEdge = oppositeProb - oppositePrice;

                if (oppositeEdge >= 5) {
                  // Good edge on opposite side - flip!
                  console.log(`   🔄 ${tokenName}: Flipping ${finalSide.toUpperCase()}→${oppositeSide.toUpperCase()} (edge: +${oppositeEdge.toFixed(1)}%)`);
                  finalSide = oppositeSide;
                  bestAsk = oppositePrice;
                  hasLiquidity = true;
                  flippedSide = true;
                  // Update bet record with flipped info
                  betRecord.side = finalSide;
                  betRecord.flipped = true;
                  betRecord.originalSide = opp.betSide.toLowerCase();
                  betRecord.edge = oppositeEdge;
                  betRecord.winProbability = oppositeProb.toFixed(1);
                } else {
                  console.log(`   ⚠️ ${tokenName}: No liquidity for ${finalSide.toUpperCase()}, opposite edge too low (${oppositeEdge.toFixed(1)}%)`);
                }
              } else {
                console.log(`   ⚠️ ${tokenName}: No liquidity on either side`);
              }
            }
          } catch (obErr) {
            // Orderbook fetch failed, proceed with original price
            console.log(`   ℹ️ ${tokenName}: Orderbook unavailable, using market price`);
            hasLiquidity = true; // Try anyway
          }

          if (!hasLiquidity) {
            console.log(`   ❌ ${tokenName}: Skipped - no liquidity`);
            recentBets.delete(opp.ticker);
            continue;
          }

          // Use best ask + buffer to ensure fill
          const fillPrice = Math.min(bestAsk + 3, 99);
          const orderRequest = {
            ticker: opp.ticker,
            action: 'buy',
            side: finalSide,
            type: 'limit',
            count
          };

          if (finalSide === 'yes') {
            orderRequest.yes_price = fillPrice;
          } else {
            orderRequest.no_price = fillPrice;
          }

          const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
          const order = orderResponse.order;

          if (order && order.filled_count > 0) {
            const filledCount = order.filled_count;
            betRecord.status = order.status === 'filled' ? 'filled' : 'partial';
            betRecord.orderId = order.order_id;
            betRecord.filledCount = filledCount;
            betRecord.avgPrice = order.average_fill_price || priceCents;
            betRecord.totalCost = filledCount * betRecord.avgPrice;
            betHistory.unshift(betRecord);

            trackBet({
              ...betRecord,
              count: filledCount,
              token: tokenName,
              predictedProb: betRecord.winProbability || winProb,
              marketPrice: betRecord.avgPrice,
              strikePrice: opp.strikePrice,
              currentPrice: opp.currentPrice,
              marketType: opp.ticker?.includes('15M') ? '15min' : 'daily',
              expiryTime: opp.expiry || opp.close_time
            });

            const flipNote = betRecord.flipped ? ' (flipped)' : '';
            console.log(`   ✅ REAL: ${betRecord.side.toUpperCase()} ${tokenName} ${filledCount}x@${betRecord.avgPrice}¢ | Edge:+${parseFloat(betRecord.edge || 0).toFixed(1)}%${flipNote}`);
            betsPlaced++;
            totalBetAmount += betRecord.totalCost;
            betResults.push({ ticker: opp.ticker, side: betRecord.side, count: filledCount, price: betRecord.avgPrice, edge: betRecord.edge, flipped: betRecord.flipped });
          } else {
            console.log(`   ❌ ${tokenName}: No fill`);
            recentBets.delete(opp.ticker);
          }
        } catch (orderError) {
          console.log(`   ❌ ${tokenName}: ${orderError.message}`);
          recentBets.delete(opp.ticker);
        }
      }

      // Small delay between orders to avoid rate limiting
      if (config.isAuthenticated && betsPlaced < opportunities.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Update balance after all bets
    if (config.isAuthenticated && betsPlaced > 0) {
      try {
        const balanceData = await kalshiRequest('GET', '/portfolio/balance');
        config.bankroll = balanceData.balance || 0;
      } catch (e) {}
    }

    // Update scan status
    if (betsPlaced > 0) {
      lastScanStatus.betPlaced = true;
      lastScanStatus.blockedReason = null;
      lastScanStatus.betDetails = {
        count: betsPlaced,
        totalAmount: totalBetAmount,
        bets: betResults
      };
      console.log(`\n🎯 PLACED ${betsPlaced} BETS | Total: $${(totalBetAmount/100).toFixed(2)} | Balance: $${(config.bankroll/100).toFixed(2)}`);
    } else {
      lastScanStatus.blockedReason = 'limits_reached';
      lastScanStatus.bestOpportunity = {
        title: opportunities[0]?.title,
        winProbability: opportunities[0]?.winProbability,
        edge: opportunities[0]?.edge,
        reason: 'All opportunities blocked by limits'
      };
    }

    console.log('========================================\n');

  } catch (error) {
    lastScanStatus.blockedReason = 'error';
    lastScanStatus.bestOpportunity = lastScanStatus.bestOpportunity || {};
    lastScanStatus.bestOpportunity.reason = error.message;
    console.error('❌ Auto-bet error:', error.message);
    console.error('   Stack:', error.stack);
    console.log('========================================\n');
  }
}

app.post('/api/crypto/auto-bet/toggle', (req, res) => {
  const { enabled, intervalSeconds = 15 } = req.body; // Check every 15 seconds

  if (enabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;
    saveAutoBetState(true, intervalSeconds); // Persist state

    runAutoBet();
    autoBetInterval = setInterval(runAutoBet, intervalSeconds * 1000);

    res.json({
      success: true,
      message: `Auto-betting enabled (every ${intervalSeconds}s) - will persist across restarts`,
      enabled: true
    });
  } else if (!enabled && config.autoBetEnabled) {
    config.autoBetEnabled = false;
    saveAutoBetState(false); // Persist state
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

// Get last scan status for diagnostics
app.get('/api/scan-status', (req, res) => {
  res.json({
    success: true,
    autoBetEnabled: config.autoBetEnabled,
    lastScan: lastScanStatus,
    summary: lastScanStatus.timestamp ? {
      age: Math.round((Date.now() - new Date(lastScanStatus.timestamp).getTime()) / 1000) + 's ago',
      markets: lastScanStatus.cryptoMarketsFound + lastScanStatus.indexMarketsFound,
      qualifyingOpportunities: lastScanStatus.above60,
      result: lastScanStatus.betPlaced ? 'bet_placed' :
              lastScanStatus.blockedReason || 'no_scan_yet'
    } : null
  });
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

          // Debug logging disabled for performance
          // console.log(`Fill: ${fill.ticker} | count=${count} | price=${fill.price} | priceCents=${priceCents} | totalCost=${totalCost}`);

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

        // Get market data including settlement results - FETCH IN PARALLEL for speed
        const uniqueTickers = [...new Set(realBetHistory.map(b => b.ticker))].slice(0, 10);
        const marketData = {};

        // Fetch all market data in parallel
        const marketPromises = uniqueTickers.map(async (ticker) => {
          try {
            const data = await kalshiRequest('GET', `/markets/${ticker}`);
            if (data.market) {
              return {
                ticker,
                title: data.market.title || ticker,
                result: data.market.result,
                status: data.market.status,
                closeTime: data.market.close_time
              };
            }
          } catch (e) {
            return { ticker, title: ticker, result: null, status: 'unknown' };
          }
          return { ticker, title: ticker, result: null, status: 'unknown' };
        });

        const marketResults = await Promise.all(marketPromises);
        marketResults.forEach(m => {
          if (m) marketData[m.ticker] = m;
        });

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

            // Debug logging disabled for performance
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

// ============================================
// PERFORMANCE TRACKING ENDPOINTS
// ============================================

// Get performance summary
app.get('/api/performance', (req, res) => {
  // Check for pending settlements first
  checkPendingSettlements();

  const settled = performanceData.bets.filter(b => b.outcome !== 'pending');
  const pending = performanceData.bets.filter(b => b.outcome === 'pending');

  // Get calibration health score
  const calibrationScore = getCalibrationScore();

  res.json({
    success: true,
    summary: {
      ...performanceData.summary,
      totalBets: performanceData.bets.length,
      settledBets: settled.length,
      pendingBets: pending.length,
      winRate: settled.length > 0 ? ((performanceData.summary.wins / settled.length) * 100).toFixed(1) : '0.0',
      totalWageredDollars: (performanceData.summary.totalWagered / 100).toFixed(2),
      totalProfitDollars: (performanceData.summary.totalProfit / 100).toFixed(2),
      roi: performanceData.summary.totalWagered > 0
        ? ((performanceData.summary.totalProfit / performanceData.summary.totalWagered) * 100).toFixed(1)
        : '0.0'
    },
    byToken: performanceData.byToken,
    byProbBucket: performanceData.byProbBucket,
    byMarketType: performanceData.byMarketType,
    calibration: performanceData.summary.calibration,
    calibrationScore,  // NEW: How well-calibrated is the model?
    recentBets: performanceData.bets.slice(-20).reverse()  // Last 20 bets, newest first
  });
});

// Get detailed bet history
app.get('/api/performance/bets', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status; // 'pending', 'won', 'lost', or undefined for all

  let bets = performanceData.bets;
  if (status) {
    bets = bets.filter(b => b.outcome === status);
  }

  const total = bets.length;
  const paginated = bets.slice(-limit - offset).slice(0, limit).reverse();

  res.json({
    success: true,
    total,
    offset,
    limit,
    bets: paginated
  });
});

// Get calibration data (predicted vs actual)
app.get('/api/performance/calibration', (req, res) => {
  const calibration = [];

  for (const [bucket, data] of Object.entries(performanceData.byProbBucket)) {
    if (data.bets >= 1) {  // Only include buckets with at least 1 bet
      calibration.push({
        bucket,
        predictedProb: getBucketMidpoint(bucket),
        actualWinRate: (data.wins / data.bets) * 100,
        bets: data.bets,
        wins: data.wins,
        difference: ((data.wins / data.bets) * 100) - getBucketMidpoint(bucket)
      });
    }
  }

  // Sort by bucket
  calibration.sort((a, b) => a.predictedProb - b.predictedProb);

  // Calculate overall calibration score (lower is better)
  const calibrationScore = calibration.length > 0
    ? calibration.reduce((sum, c) => sum + Math.abs(c.difference) * c.bets, 0) /
      calibration.reduce((sum, c) => sum + c.bets, 0)
    : 0;

  res.json({
    success: true,
    calibration,
    calibrationScore: calibrationScore.toFixed(1),
    interpretation: calibrationScore < 5 ? 'Excellent' :
                    calibrationScore < 10 ? 'Good' :
                    calibrationScore < 15 ? 'Fair' : 'Needs improvement'
  });
});

// Manually settle a bet (for testing/correction)
app.post('/api/performance/settle', (req, res) => {
  const { betId, outcome, settlementPrice } = req.body;

  if (!betId || !outcome || !['won', 'lost'].includes(outcome)) {
    return res.status(400).json({ success: false, error: 'Invalid betId or outcome' });
  }

  const bet = performanceData.bets.find(b => b.id === betId);
  if (!bet) {
    return res.status(404).json({ success: false, error: 'Bet not found' });
  }

  const profit = outcome === 'won' ? (bet.contracts * 100 - bet.totalCost) : 0;
  const settled = settleBet(betId, outcome, settlementPrice || null, profit);

  res.json({
    success: true,
    bet: settled
  });
});

// Force check all pending settlements
app.post('/api/performance/check-settlements', async (req, res) => {
  await checkPendingSettlements();
  res.json({
    success: true,
    pending: performanceData.bets.filter(b => b.outcome === 'pending').length
  });
});

// Clear all performance data (for testing)
app.delete('/api/performance', (req, res) => {
  performanceData = {
    bets: [],
    summary: { totalBets: 0, wins: 0, losses: 0, pending: 0, totalWagered: 0, totalProfit: 0, winRate: 0, avgPredictedProb: 0, avgActualWinRate: 0, calibration: {} },
    byToken: {},
    byProbBucket: {},
    byMarketType: {},
    lastUpdated: null
  };
  savePerformanceData();
  res.json({ success: true, message: 'Performance data cleared' });
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
    authenticated: config.isAuthenticated,
    performanceTracking: {
      totalBets: performanceData.bets.length,
      pendingBets: performanceData.bets.filter(b => b.outcome === 'pending').length
    }
  });
});

// ============================================
// HEALTH CHECK - Keep Render alive
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    autoBetEnabled: config.autoBetEnabled,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ping', (req, res) => {
  res.send('pong');
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
  console.log(`📊 Markets: BTC/ETH/SOL 15min + hourly, S&P 500 hourly`);
  console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);
  console.log(`📈 Performance tracking: ${performanceData.bets.length} historical bets loaded`);

  // Auto-load Kalshi credentials from environment
  await loadCredentialsFromEnv();

  // Restore saved settings (risk limits, etc.)
  const savedSettings = loadSettings();
  if (savedSettings) {
    if (savedSettings.riskLimits) {
      config.riskLimits = { ...config.riskLimits, ...savedSettings.riskLimits };
    }
    if (savedSettings.scaleIn) {
      config.scaleIn = { ...config.scaleIn, ...savedSettings.scaleIn };
    }
    if (savedSettings.minEdge !== undefined) {
      config.minEdge = savedSettings.minEdge;
    }
    console.log(`⚙️ Risk limits: $${config.riskLimits.maxPerBet/100}/bet, $${config.riskLimits.maxTotal/100} max exposure`);
  }

  // Restore auto-bet state from previous session
  const savedState = loadAutoBetState();
  if (savedState.enabled) {
    console.log(`🤖 Restoring auto-bet from previous session...`);
    config.autoBetEnabled = true;

    // Wait a few seconds for prices to load before first scan
    setTimeout(() => {
      runAutoBet();
      autoBetInterval = setInterval(runAutoBet, (savedState.intervalSeconds || 15) * 1000);
      console.log(`✅ Auto-bet restored and running (every ${savedState.intervalSeconds || 15}s)`);
    }, 5000);
  }

  // Check pending settlements every 2 minutes
  setInterval(async () => {
    try {
      await checkPendingSettlements();
    } catch (err) {
      console.log('Settlement check error:', err.message);
    }
  }, 2 * 60 * 1000);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
