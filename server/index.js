import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';
import * as auth from './auth.js';

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
// CONFIGURATION - Default template for new users
// ============================================

const DEFAULT_CONFIG = {
  apiKeyId: null,
  privateKey: null,
  isAuthenticated: false,
  bankroll: 1000, // cents ($10.00)
  maxBetPercent: 15,
  minEdge: 5, // 5% minimum - model has uncertainty, need buffer
  autoBetEnabled: false,
  // Risk management settings (in cents) - bet sizing uses maxPerBet
  riskLimits: {
    maxPerBet: 500,      // $5.00 max per bet (unified)
    maxPerToken: 500,    // $5.00 max per token
    maxTotal: 500,       // $5.00 max total exposure (unified)
    // Legacy nested structure for compatibility
    hourly: {
      maxPerBet: 500,
      maxTotal: 500
    },
    other: {
      maxPerBet: 500,
      maxTotal: 500
    }
  },
  // Scale-in settings: add to position when probability improves
  scaleIn: {
    enabled: true,
    minProbabilityIncrease: 15,  // Only scale in if prob increased by 15%+ (60% → 75%)
    maxBetsPerMarket: 3,         // Maximum times to bet on same market
    minTimeBetweenBets: 60000    // At least 1 minute between bets on same market
  },
  // Degen mode: allow low-probability bets with strong momentum
  degenMode: {
    enabled: false,
    minPrice: 15,
    maxPrice: 39,
    requireStrongMomentum: true,
    maxTimeMinutes: 5,
    maxBetMultiplier: 0.5
  },
  // Aggressive vs Conservative mode toggle
  // Based on 474-bet analysis: NO bets win 70.6%, YES only 53.1%
  aggressiveMode: {
    enabled: false,              // Default to CONSERVATIVE (data-driven)
    minPrice: 26,                // Aggressive: 26¢+ (vs conservative 41¢)
    minDistanceFromStrike: 0.05, // Aggressive: 0.05% (vs conservative 0.10%)
    allowNightTrading: true,     // Aggressive: allow night trading
    minConfidenceScore: 1        // Aggressive: score >= 1 (vs conservative >= 2)
  }
};

// ============================================
// PER-USER STATE MANAGEMENT
// ============================================
const USER_DATA_DIR = path.join(__dirname, 'userData');

// Ensure userData directory exists
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// In-memory cache of user states
const userStates = new Map();

// Auto-bet intervals per user
const userAutoBetIntervals = new Map();

// Get or create user state
function getUserState(userId) {
  if (!userId) {
    // Return a default read-only state for unauthenticated requests
    return {
      config: { ...DEFAULT_CONFIG },
      betHistory: [],
      portfolio: { balance: 0, positions: [] }
    };
  }

  if (!userStates.has(userId)) {
    // Try to load from disk
    const userFile = path.join(USER_DATA_DIR, `${userId}.json`);
    if (fs.existsSync(userFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
        userStates.set(userId, {
          config: { ...DEFAULT_CONFIG, ...data.config },
          betHistory: data.betHistory || [],
          portfolio: data.portfolio || { balance: 0, positions: [] }
        });
        console.log(`📂 Loaded state for user ${userId}`);
      } catch (err) {
        console.error(`Error loading user state for ${userId}:`, err);
        userStates.set(userId, createDefaultUserState());
      }
    } else {
      // New user - create default state
      userStates.set(userId, createDefaultUserState());
      console.log(`🆕 Created new state for user ${userId}`);
    }
  }
  return userStates.get(userId);
}

// Create default user state
function createDefaultUserState() {
  return {
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), // Deep clone
    betHistory: [],
    portfolio: { balance: 0, positions: [] }
  };
}

// Save user state to disk
function saveUserState(userId) {
  if (!userId) return;
  const state = userStates.get(userId);
  if (!state) return;

  const userFile = path.join(USER_DATA_DIR, `${userId}.json`);
  try {
    fs.writeFileSync(userFile, JSON.stringify({
      config: state.config,
      betHistory: state.betHistory,
      portfolio: state.portfolio
    }, null, 2));
  } catch (err) {
    console.error(`Error saving user state for ${userId}:`, err);
  }
}

// Middleware to extract user from JWT token
function extractUser(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    const userId = auth.verifyToken(token);
    if (userId) {
      req.userId = userId;
      req.userState = getUserState(userId);
    }
  }

  // If no valid token, use empty/default state
  if (!req.userState) {
    req.userState = getUserState(null);
  }

  next();
}

// Apply extractUser middleware to all routes
app.use(extractUser);

// Legacy compatibility - point global config to a getter (for code that still uses it)
let config = DEFAULT_CONFIG;
let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// ============================================
// PROFILES SYSTEM (DEPRECATED - kept for migration)
// ============================================
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
let profiles = {};
let activeProfileId = null;

// Load profiles from disk
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
      profiles = data.profiles || {};
      activeProfileId = data.activeProfileId || null;
      console.log(`👥 Loaded ${Object.keys(profiles).length} profiles`);
      return true;
    }
  } catch (err) {
    console.log('Could not load profiles:', err.message);
  }
  return false;
}

// Save profiles to disk
function saveProfiles() {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify({
      profiles,
      activeProfileId,
      savedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    console.log('Could not save profiles:', err.message);
  }
}

// Restore active profile on startup
function restoreActiveProfile() {
  if (activeProfileId && profiles[activeProfileId]) {
    const profile = profiles[activeProfileId];
    console.log(`🔄 Restoring active profile: ${profile.name}`);

    // Restore Kalshi credentials
    if (profile.kalshiApiKeyId && profile.kalshiPrivateKey) {
      config.apiKeyId = profile.kalshiApiKeyId;
      config.privateKey = profile.kalshiPrivateKey;
      config.isAuthenticated = true;
      console.log(`🔑 Restored Kalshi credentials for ${profile.name}`);
    }

    // Restore settings
    if (profile.settings) {
      if (profile.settings.riskLimits) {
        config.riskLimits = { ...config.riskLimits, ...profile.settings.riskLimits };
      }
      if (profile.settings.scaleIn) {
        config.scaleIn = { ...config.scaleIn, ...profile.settings.scaleIn };
      }
      if (profile.settings.degenMode) {
        config.degenMode = { ...config.degenMode, ...profile.settings.degenMode };
      }
      if (profile.settings.aggressiveMode) {
        config.aggressiveMode = { ...config.aggressiveMode, ...profile.settings.aggressiveMode };
      }
      if (profile.settings.autoBetEnabled !== undefined) {
        config.autoBetEnabled = profile.settings.autoBetEnabled;
      }
    }

    // Restore bet history
    if (profile.betHistory && profile.betHistory.length > 0) {
      betHistory = profile.betHistory;
      console.log(`📊 Restored ${betHistory.length} bets from profile`);
    }

    return true;
  }
  return false;
}

// Save current state to active profile
function saveToActiveProfile() {
  if (activeProfileId && profiles[activeProfileId]) {
    const profile = profiles[activeProfileId];
    profile.settings = {
      riskLimits: config.riskLimits,
      scaleIn: config.scaleIn,
      degenMode: config.degenMode,
      aggressiveMode: config.aggressiveMode,
      autoBetEnabled: config.autoBetEnabled
    };
    profile.betHistory = betHistory;
    profile.lastActive = new Date().toISOString();
    saveProfiles();
  }
}

// Load profiles on startup (but DON'T auto-login - user must select profile)
loadProfiles();
// Clear active profile on startup - require manual login
activeProfileId = null;
console.log('👤 No profile auto-loaded - please select a profile to login');

// ============================================
// PERFORMANCE TRACKING
// ============================================
// Track all bets and their outcomes to measure model accuracy

const PERFORMANCE_FILE = path.join(__dirname, 'performance_data.json');

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

// Binance symbol mapping (PRIMARY - fast)
const BINANCE_SYMBOLS = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT', AVAX: 'AVAXUSDT', LINK: 'LINKUSDT', MATIC: 'MATICUSDT',
  DOT: 'DOTUSDT', SHIB: 'SHIBUSDT', LTC: 'LTCUSDT', UNI: 'UNIUSDT', ATOM: 'ATOMUSDT', APT: 'APTUSDT'
};

// CoinGecko ID mapping (FALLBACK - slower but reliable)
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin',
  ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink', MATIC: 'matic-network',
  DOT: 'polkadot', SHIB: 'shiba-inu', LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos', APT: 'aptos'
};

// Track which price source we're using
let priceSource = 'none';
let binanceFailCount = 0;

// Helper to update a token's price data
function updateTokenPrice(token, price, now) {
  if (!cryptoPrices[token]) return;

  cryptoPrices[token].price = price;
  cryptoPrices[token].timestamp = now;
  cryptoPrices[token].source = priceSource;

  // Keep 120 price points for volatility (more history with faster updates)
  cryptoPrices[token].history.push({ price, time: now });
  if (cryptoPrices[token].history.length > 120) {
    cryptoPrices[token].history.shift();
  }

  // Keep extended history for statistical analysis (2 hours)
  if (!priceHistoryExtended[token]) priceHistoryExtended[token] = [];
  priceHistoryExtended[token].push({ price, time: now });
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  priceHistoryExtended[token] = priceHistoryExtended[token].filter(p => p.time > twoHoursAgo);

  // Calculate volatility
  cryptoPrices[token].volatility = calculateVolatility(cryptoPrices[token].history, token);
}

// Fetch prices from Binance.US (PRIMARY - very fast, works for US users)
async function fetchBinancePrices() {
  try {
    const res = await fetch(`https://api.binance.us/api/v3/ticker/price`);

    if (!res.ok) {
      throw new Error(`Binance API error: ${res.status}`);
    }

    const data = await res.json();
    const now = Date.now();
    let updated = 0;

    // Create lookup map
    const priceMap = {};
    for (const item of data) {
      priceMap[item.symbol] = parseFloat(item.price);
    }

    // Update each tracked token
    for (const [token, symbol] of Object.entries(BINANCE_SYMBOLS)) {
      const price = priceMap[symbol];
      if (price && price > 0) {
        updateTokenPrice(token, price, now);
        updated++;
      }
    }

    if (updated > 0) {
      priceSource = 'binance';
      binanceFailCount = 0;
    }

    return updated > 0 ? cryptoPrices : null;
  } catch (error) {
    binanceFailCount++;
    if (binanceFailCount <= 3) {
      console.error('Binance error (will fallback to CoinGecko):', error.message);
    }
    return null;
  }
}

// Fetch prices from CoinGecko (FALLBACK - slower but reliable)
async function fetchCoinGeckoPrices() {
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const data = await res.json();

    if (data.error) {
      console.error('CoinGecko error:', data.error);
      return null;
    }

    const now = Date.now();
    let updated = 0;

    // Update each tracked token
    for (const [token, geckoId] of Object.entries(COINGECKO_IDS)) {
      const priceData = data[geckoId];
      if (priceData && priceData.usd > 0) {
        updateTokenPrice(token, priceData.usd, now);
        updated++;
      }
    }

    if (updated > 0) {
      priceSource = 'coingecko';
    }

    return updated > 0 ? cryptoPrices : null;
  } catch (error) {
    console.error('CoinGecko error:', error.message);
    return null;
  }
}

// Main price fetch function - tries Binance first, falls back to CoinGecko
async function fetchCryptoPrices() {
  // Try Binance first (faster)
  const binanceResult = await fetchBinancePrices();
  if (binanceResult) {
    return binanceResult;
  }

  // Fall back to CoinGecko
  return await fetchCoinGeckoPrices();
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

  // Momentum adjustment (smaller than before)
  const momentum = calculateMomentumMultiTimeframe(allHistory);
  let momentumAdjust = 0;
  if (momentum.aligned) {
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

  // Calculate raw ensemble probability
  let ensembleProbAbove =
    weights.normal * normalProbAbove +
    weights.studentT * tProbAbove +
    weights.bootstrap * bootstrapProbAbove +
    weights.historical * (isAboveTarget ? historicalProbStay : 1 - historicalProbStay);

  // Apply momentum adjustment
  ensembleProbAbove = Math.max(0.05, Math.min(0.95, ensembleProbAbove + momentumAdjust));

  // Apply uncertainty discount - pull extreme probabilities toward 50%
  // Reduced from 15% to 10% shrinkage to allow more betting opportunities
  const uncertaintyFactor = 0.90; // 10% shrinkage toward 50%
  ensembleProbAbove = 0.5 + (ensembleProbAbove - 0.5) * uncertaintyFactor;

  // Data quality adjustment - less aggressive shrinkage
  // With 50 data points: factor = 0.85, with 100+: factor = 0.95
  const dataQualityFactor = Math.min(1, allHistory.length / 100);
  ensembleProbAbove = 0.5 + (ensembleProbAbove - 0.5) * (0.80 + 0.15 * dataQualityFactor);

  // DYNAMIC CAPS: Allow higher confidence when conditions are very favorable
  // Base cap is 80%, but can increase to 92% for "obvious" situations
  let MAX_PROB = 0.80;
  let MIN_PROB = 0.20;

  // Check for "obvious bet" conditions that warrant higher confidence
  const absDistanceFromStrike = Math.abs(pctFromTarget);
  const methodsAgree = Math.abs(normalProbAbove - tProbAbove) < 0.10 &&
                       Math.abs(normalProbAbove - bootstrapProbAbove) < 0.15;
  const strongMomentum = Math.abs(momentum.score) > 0.02;
  const momentumSupportsPosition = (isAboveTarget && momentum.direction === 'bullish') ||
                                    (!isAboveTarget && momentum.direction === 'bearish');

  // Increase cap for short time + large buffer + agreement
  if (expiryMinutes <= 10 && absDistanceFromStrike >= 0.5 && methodsAgree) {
    // Very short time, price well past strike, models agree
    if (expiryMinutes <= 5 && absDistanceFromStrike >= 1.0) {
      MAX_PROB = 0.92; // Allow up to 92% for obvious situations
      MIN_PROB = 0.08;
    } else if (expiryMinutes <= 7 && absDistanceFromStrike >= 0.75) {
      MAX_PROB = 0.88;
      MIN_PROB = 0.12;
    } else {
      MAX_PROB = 0.85;
      MIN_PROB = 0.15;
    }

    // Bonus if momentum also supports the position
    if (strongMomentum && momentumSupportsPosition) {
      MAX_PROB = Math.min(0.94, MAX_PROB + 0.03);
      MIN_PROB = Math.max(0.06, MIN_PROB - 0.03);
    }
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
// Helper functions to get current limits
function getMaxRisk(type) {
  return config.riskLimits[type]?.maxTotal || 500;
}

function getMaxPerBet(type) {
  return config.riskLimits[type]?.maxPerBet || 200;
}

function getMaxTotalRisk() {
  return getMaxRisk('hourly') + getMaxRisk('other');
}

// Determine if a ticker is an hourly market
function isHourlyMarket(ticker) {
  if (!ticker) return false;
  // Hourly series end in 1H (e.g., KXBTC1H, KXETH1H)
  return ticker.includes('1H') || ticker.includes('-1H-');
}

// Get risk breakdown by market type
function getRiskByType() {
  let hourlyRisk = 0;
  let otherRisk = 0;
  const kalshiTickers = new Set();

  // First, build a map of our actual costs from betHistory for each ticker
  const ourCostsByTicker = {};
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of betHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;

    const ticker = bet.ticker;
    if (!ourCostsByTicker[ticker]) {
      ourCostsByTicker[ticker] = { totalCost: 0, contracts: 0 };
    }
    ourCostsByTicker[ticker].totalCost += bet.totalCost || (bet.count * bet.price) || 0;
    ourCostsByTicker[ticker].contracts += bet.count || bet.filledCount || 0;
  }

  // Count Kalshi positions
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        kalshiTickers.add(pos.ticker);

        // Try to get the actual cost - check multiple sources in order of reliability
        let posRisk;
        if (pos.market_exposure && pos.market_exposure > 0) {
          // Kalshi's market_exposure is in cents, this is the most accurate
          posRisk = pos.market_exposure;
        } else if (pos.average_price && pos.average_price > 0) {
          posRisk = contracts * pos.average_price;
        } else if (ourCostsByTicker[pos.ticker]) {
          // Use our tracked costs - this is what we actually paid
          posRisk = ourCostsByTicker[pos.ticker].totalCost;
        } else {
          // Last resort: use a conservative estimate (high price to prevent over-betting)
          posRisk = contracts * 75; // Assume 75¢ avg if we have no data
        }

        if (isHourlyMarket(pos.ticker)) {
          hourlyRisk += posRisk;
        } else {
          otherRisk += posRisk;
        }
      }
    }
  }

  // Add unsettled local bets not already counted via Kalshi positions
  for (const bet of betHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;
    if (kalshiTickers.has(bet.ticker)) continue;

    const betRisk = bet.totalCost || (bet.count * bet.price) || 0;
    if (isHourlyMarket(bet.ticker)) {
      hourlyRisk += betRisk;
    } else {
      otherRisk += betRisk;
    }
  }

  return { hourly: hourlyRisk, other: otherRisk, total: hourlyRisk + otherRisk };
}

function getCurrentRiskFromPortfolio() {
  const { total } = getRiskByType();
  return total;
}

function canPlaceBet(betCostCents, ticker) {
  const risk = getRiskByType();
  const type = isHourlyMarket(ticker) ? 'hourly' : 'other';
  return (risk[type] + betCostCents) <= getMaxRisk(type);
}

function getRemainingRiskBudget(ticker) {
  const risk = getRiskByType();
  const type = isHourlyMarket(ticker) ? 'hourly' : 'other';
  return Math.max(0, getMaxRisk(type) - risk[type]);
}

// Get total remaining budget (for display)
function getTotalRemainingBudget() {
  const risk = getRiskByType();
  const hourlyRemaining = Math.max(0, getMaxRisk('hourly') - risk.hourly);
  const otherRemaining = Math.max(0, getMaxRisk('other') - risk.other);
  return hourlyRemaining + otherRemaining;
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

  // First, build a map of our actual costs from betHistory for each ticker
  const ourCostsByTicker = {};
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of betHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;

    const ticker = bet.ticker;
    if (!ourCostsByTicker[ticker]) {
      ourCostsByTicker[ticker] = { totalCost: 0, contracts: 0 };
    }
    ourCostsByTicker[ticker].totalCost += bet.totalCost || (bet.count * bet.price) || 0;
    ourCostsByTicker[ticker].contracts += bet.count || bet.filledCount || 0;
  }

  // Count Kalshi positions by token
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        const token = getTokenFromTicker(pos.ticker);
        kalshiTickers.add(pos.ticker);

        // Try to get the actual cost - check multiple sources in order of reliability
        let posRisk;
        if (pos.market_exposure && pos.market_exposure > 0) {
          // Kalshi's market_exposure is in cents, this is the most accurate
          posRisk = pos.market_exposure;
        } else if (pos.average_price && pos.average_price > 0) {
          posRisk = contracts * pos.average_price;
        } else if (ourCostsByTicker[pos.ticker]) {
          // Use our tracked costs - this is what we actually paid
          posRisk = ourCostsByTicker[pos.ticker].totalCost;
          console.log(`📊 Using tracked cost for ${pos.ticker}: ${posRisk}¢ (Kalshi avg_price was ${pos.average_price})`);
        } else {
          // Last resort: use a conservative estimate (high price to prevent over-betting)
          posRisk = contracts * 75; // Assume 75¢ avg if we have no data
          console.log(`⚠️ No price data for ${pos.ticker}, using 75¢ estimate: ${posRisk}¢`);
        }

        if (token) {
          tokenExposure[token] = (tokenExposure[token] || 0) + posRisk;
        }
      }
    }
  }

  // Add unsettled local bets not already counted via Kalshi positions
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

// User-aware Kalshi API request - uses provided config or falls back to global
async function kalshiRequest(method, endpoint, body = null, userConfig = null) {
  const cfg = userConfig || config; // Use user-specific config if provided
  const timestamp = Date.now().toString();
  const path = `/trade-api/v2${endpoint}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Shimi/1.0'
  };

  if (cfg.isAuthenticated && cfg.apiKeyId && cfg.privateKey) {
    const signature = signRequestWithConfig(method, path, timestamp, cfg);
    headers['KALSHI-ACCESS-KEY'] = cfg.apiKeyId;
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

// Sign request with specific config
function signRequestWithConfig(method, path, timestamp, cfg) {
  const message = timestamp + method + path;
  try {
    const privateKeyObj = crypto.createPrivateKey({
      key: cfg.privateKey,
      format: 'pem',
      type: 'pkcs8'
    });
    const signature = crypto.sign('RSA-SHA256', Buffer.from(message), {
      key: privateKeyObj,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    });
    return signature.toString('base64');
  } catch (err) {
    console.error('Signature error:', err.message);
    return '';
  }
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
      // HOURLY markets (separate risk pool)
      'KXBTC1H',    // Bitcoin hourly up/down
      'KXETH1H',    // Ethereum hourly up/down
      'KXSOL1H',    // Solana hourly up/down

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

  // No valid bet found - log why for high-priced markets
  if (!bestBet) {
    // Log markets where prices are too high for our model
    const maxPrice = Math.max(parsed.yesAsk || 0, parsed.noAsk || 0);
    if (maxPrice > 0.75) {
      console.log(`   ⚠️ Skipped ${parsed.cryptoType} market: YES@${Math.round((parsed.yesAsk||0)*100)}¢ NO@${Math.round((parsed.noAsk||0)*100)}¢ | Our prob: ${(probYesWins*100).toFixed(0)}% | Need >${Math.round(maxPrice*100)}% to bet`);
    }
    return null;
  }

  // Determine if this is a "safe" bet (high confidence)
  const isHighProb = bestBet.prob >= 0.60;
  const isSafeBet = bestBet.prob >= 0.70;

  // Build reason string
  const probPct = (bestBet.prob * 100).toFixed(0);
  const betReason = `${momentumDesc} ${timeDesc} | ${probPct}% win prob`;

  // Calculate profit for $1 worth of contracts
  // E.g., if price is 50¢, we buy 2 contracts. If we win, each pays $1, so profit = 2×$1 - $1 = $1 (100¢)
  const priceCents = Math.round(bestBet.price * 100);
  const contractsFor1Dollar = Math.floor(100 / priceCents);
  const totalCostCents = contractsFor1Dollar * priceCents;
  const feeCents = calculateKalshiFee(contractsFor1Dollar, bestBet.price);
  const payoutIfWinCents = contractsFor1Dollar * 100; // Each contract pays $1
  const profitIfWinCents = payoutIfWinCents - totalCostCents - feeCents;

  // Expected profit accounting for probability (include fee in both win and loss)
  const expectedProfit = (bestBet.prob * profitIfWinCents - (1 - bestBet.prob) * (totalCostCents + feeCents));
  const profitPotential = (profitIfWinCents / totalCostCents) * 100;

  // Fixed bet amount ($1) for sustainable growth
  const recommendedBet = 100; // Always $1

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
    betPriceCents: priceCents,
    contractsFor1Dollar,
    feeCents,
    betReason,
    profitIfWin: profitIfWinCents, // Total profit in cents for $1 bet (after fees)
    expectedProfit: expectedProfit.toFixed(1),
    profitPotential,
    recommendedBet,
    isObviousBet: isSafeBet || (prediction.ensemble?.isObviousBet && bestBet.prob >= 0.75),
    isHighProb,
    maxProbAllowed: prediction.ensemble?.maxProbAllowed || 0.80,
    // Statistical analysis info
    momentum: prediction.momentum.direction,
    momentumStrength: prediction.momentum.strength,
    confidence: (prediction.confidence * 100).toFixed(0) + '%',
    dataPoints: prediction.dataPoints,
    analysisMethod: prediction.analysis.method,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining)
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
          if (m.edge < 0.5) m.filterReason = `No edge (${m.edge.toFixed(1)}%)`;
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
          if (m.edge < 0.5) m.filterReason = `No edge (${m.edge.toFixed(1)}%)`;
          else if (winProb < 50) m.filterReason = `Low prob (${winProb.toFixed(0)}%)`;
        }
        return m;
      });

    // Combine all analyzed markets
    const allAnalyzed = [...cryptoOpps, ...indexOpps];

    // Filter to recommended only (unless showAll=true)
    const allOpportunities = showAll
      ? allAnalyzed.sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability))
      : allAnalyzed.filter(m => m.isRecommended).sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    // Refresh positions before calculating risk (user-specific)
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
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
        // Total risk
        current: riskByType.total,
        max: getMaxTotalRisk(),
        remaining: getTotalRemainingBudget(),
        currentDollars: (riskByType.total / 100).toFixed(2),
        maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
        remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2),
        // Hourly pool
        hourly: {
          current: riskByType.hourly,
          max: getMaxRisk('hourly'),
          remaining: Math.max(0, getMaxRisk('hourly') - riskByType.hourly),
          currentDollars: (riskByType.hourly / 100).toFixed(2),
          maxDollars: (getMaxRisk('hourly') / 100).toFixed(2)
        },
        // Other pool (daily, 15min, etc)
        other: {
          current: riskByType.other,
          max: getMaxRisk('other'),
          remaining: Math.max(0, getMaxRisk('other') - riskByType.other),
          currentDollars: (riskByType.other / 100).toFixed(2),
          maxDollars: (getMaxRisk('other') / 100).toFixed(2)
        }
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
  const { hourly, other, maxPerToken, maxPerBet, maxTotal } = req.body;

  // Support BOTH nested (hourly/other) and flat (maxPerBet/maxTotal) structures
  // Flat structure from simplified UI
  if (maxPerBet !== undefined) {
    const val = Math.max(10, Math.min(10000, parseInt(maxPerBet) || 200));
    config.riskLimits.maxPerBet = val; // Top-level for client reads
    config.riskLimits.hourly.maxPerBet = val;
    config.riskLimits.other.maxPerBet = val;
  }
  if (maxTotal !== undefined) {
    const val = Math.max(100, Math.min(100000, parseInt(maxTotal) || 1500));
    config.riskLimits.hourly.maxTotal = val;
    config.riskLimits.other.maxTotal = val;
    // Also set a unified maxTotal for easy access
    config.riskLimits.maxTotal = val;
  }

  // Nested structure (legacy support)
  if (hourly) {
    if (hourly.maxPerBet !== undefined) {
      config.riskLimits.hourly.maxPerBet = Math.max(10, Math.min(10000, parseInt(hourly.maxPerBet) || 200));
    }
    if (hourly.maxTotal !== undefined) {
      config.riskLimits.hourly.maxTotal = Math.max(100, Math.min(100000, parseInt(hourly.maxTotal) || 500));
    }
  }

  if (other) {
    if (other.maxPerBet !== undefined) {
      config.riskLimits.other.maxPerBet = Math.max(10, Math.min(10000, parseInt(other.maxPerBet) || 200));
    }
    if (other.maxTotal !== undefined) {
      config.riskLimits.other.maxTotal = Math.max(100, Math.min(100000, parseInt(other.maxTotal) || 1000));
    }
  }

  // Max per token (e.g., max $5 on all SOL markets combined)
  if (maxPerToken !== undefined) {
    config.riskLimits.maxPerToken = Math.max(100, Math.min(50000, parseInt(maxPerToken) || 500));
  }

  // Create unified maxTotal for response if not set
  if (!config.riskLimits.maxTotal) {
    config.riskLimits.maxTotal = Math.max(config.riskLimits.hourly.maxTotal, config.riskLimits.other.maxTotal);
  }

  console.log(`⚙️ Risk settings updated:`, JSON.stringify(config.riskLimits));

  // Save to active profile
  saveToActiveProfile();

  res.json({
    success: true,
    riskLimits: {
      ...config.riskLimits,
      maxTotal: config.riskLimits.maxTotal || config.riskLimits.hourly.maxTotal
    },
    message: 'Risk settings updated'
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

  console.log(`⚙️ Scale-in settings updated:`, JSON.stringify(config.scaleIn));

  res.json({
    success: true,
    scaleIn: config.scaleIn,
    message: 'Scale-in settings updated'
  });
});

// Get degen mode settings
app.get('/api/settings/degen-mode', (req, res) => {
  res.json({
    success: true,
    degenMode: config.degenMode
  });
});

// Update degen mode settings
app.post('/api/settings/degen-mode', (req, res) => {
  const { enabled, minPrice, maxPrice, requireStrongMomentum } = req.body;

  if (!config.degenMode) {
    config.degenMode = { enabled: false, minPrice: 15, maxPrice: 39, requireStrongMomentum: true };
  }

  if (enabled !== undefined) config.degenMode.enabled = !!enabled;
  if (minPrice !== undefined) config.degenMode.minPrice = Math.max(5, Math.min(39, parseInt(minPrice) || 15));
  if (maxPrice !== undefined) config.degenMode.maxPrice = Math.max(20, Math.min(50, parseInt(maxPrice) || 39));
  if (requireStrongMomentum !== undefined) config.degenMode.requireStrongMomentum = !!requireStrongMomentum;

  console.log(`🔥 Degen mode ${config.degenMode.enabled ? 'ENABLED' : 'disabled'}`);

  res.json({
    success: true,
    degenMode: config.degenMode,
    message: `Degen mode ${config.degenMode.enabled ? 'enabled' : 'disabled'}`
  });
});

// Get aggressive mode settings
app.get('/api/settings/aggressive-mode', (req, res) => {
  res.json({
    success: true,
    aggressiveMode: config.aggressiveMode
  });
});

// Update aggressive mode settings (toggle conservative vs aggressive)
app.post('/api/settings/aggressive-mode', (req, res) => {
  const { enabled, minPrice, minDistanceFromStrike, allowNightTrading, minConfidenceScore } = req.body;

  // Initialize if not exists
  if (!config.aggressiveMode) {
    config.aggressiveMode = {
      enabled: false,  // Default to CONSERVATIVE
      minPrice: 26,
      minDistanceFromStrike: 0.05,
      allowNightTrading: true,
      minConfidenceScore: 1
    };
  }

  if (enabled !== undefined) config.aggressiveMode.enabled = !!enabled;
  if (minPrice !== undefined) config.aggressiveMode.minPrice = Math.max(15, Math.min(50, parseInt(minPrice) || 26));
  if (minDistanceFromStrike !== undefined) config.aggressiveMode.minDistanceFromStrike = Math.max(0.01, Math.min(0.5, parseFloat(minDistanceFromStrike) || 0.05));
  if (allowNightTrading !== undefined) config.aggressiveMode.allowNightTrading = !!allowNightTrading;
  if (minConfidenceScore !== undefined) config.aggressiveMode.minConfidenceScore = Math.max(0, Math.min(5, parseInt(minConfidenceScore) || 1));

  const mode = config.aggressiveMode.enabled ? 'AGGRESSIVE' : 'CONSERVATIVE';
  console.log(`⚡ Trading mode: ${mode}`, JSON.stringify(config.aggressiveMode));

  res.json({
    success: true,
    aggressiveMode: config.aggressiveMode,
    mode: mode,
    message: `Trading mode set to ${mode}`
  });
});

// ============================================
// PROFILE ENDPOINTS
// ============================================

// Get all profiles
app.get('/api/profiles', (req, res) => {
  const profileList = Object.entries(profiles).map(([id, p]) => ({
    id,
    name: p.name,
    hasCredentials: !!(p.kalshiApiKeyId && p.kalshiPrivateKey),
    hasPin: !!p.pin,
    isActive: id === activeProfileId,
    lastActive: p.lastActive,
    createdAt: p.createdAt
  }));

  res.json({
    success: true,
    profiles: profileList,
    activeProfileId
  });
});

// Create new profile
app.post('/api/profiles', (req, res) => {
  const { name, pin } = req.body;

  if (!name || name.length < 2) {
    return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });
  }

  const id = `profile_${Date.now()}`;
  profiles[id] = {
    name,
    pin: pin || null,
    kalshiApiKeyId: null,
    kalshiPrivateKey: null,
    settings: {
      riskLimits: { ...config.riskLimits },
      scaleIn: { ...config.scaleIn },
      degenMode: { ...config.degenMode },
      aggressiveMode: { ...config.aggressiveMode }
    },
    betHistory: [],
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };

  saveProfiles();

  res.json({
    success: true,
    profileId: id,
    message: `Profile "${name}" created`
  });
});

// Switch to profile
app.post('/api/profiles/:id/switch', async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!profiles[id]) {
    return res.status(404).json({ success: false, error: 'Profile not found' });
  }

  const profile = profiles[id];

  // Check PIN if profile has one
  if (profile.pin) {
    if (!pin) {
      // PIN required but not provided - tell client to prompt for it
      return res.json({ success: false, requiresPin: true, profileName: profile.name });
    }
    if (profile.pin !== pin) {
      // Wrong PIN
      return res.status(401).json({ success: false, error: 'Invalid PIN', requiresPin: true });
    }
  }

  // Save current profile state before switching
  if (activeProfileId && profiles[activeProfileId]) {
    saveToActiveProfile();
  }

  // Switch to new profile
  activeProfileId = id;

  // Load profile credentials
  if (profile.kalshiApiKeyId && profile.kalshiPrivateKey) {
    config.apiKeyId = profile.kalshiApiKeyId;
    config.privateKey = profile.kalshiPrivateKey;
    config.isAuthenticated = true;

    // Verify credentials with Kalshi
    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance / 100;
      console.log(`✅ Kalshi verified for ${profile.name}! Balance: $${portfolio.balance.toFixed(2)}`);
    } catch (err) {
      console.log(`⚠️ Kalshi verification failed: ${err.message}`);
    }
  } else {
    config.isAuthenticated = false;
  }

  // Restore settings
  if (profile.settings) {
    if (profile.settings.riskLimits) config.riskLimits = { ...config.riskLimits, ...profile.settings.riskLimits };
    if (profile.settings.scaleIn) config.scaleIn = { ...config.scaleIn, ...profile.settings.scaleIn };
    if (profile.settings.degenMode) config.degenMode = { ...config.degenMode, ...profile.settings.degenMode };
    if (profile.settings.aggressiveMode) config.aggressiveMode = { ...config.aggressiveMode, ...profile.settings.aggressiveMode };
  }

  // Restore bet history
  betHistory = profile.betHistory || [];

  // Update last active
  profile.lastActive = new Date().toISOString();
  saveProfiles();

  // Restore auto-bet if was enabled
  if (profile.settings?.autoBetEnabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;
    console.log(`🤖 Restoring auto-bet for ${profile.name}...`);
  }

  res.json({
    success: true,
    profile: {
      id,
      name: profile.name,
      hasCredentials: config.isAuthenticated
    },
    balance: portfolio.balance,
    isAuthenticated: config.isAuthenticated
  });
});

// Save credentials to profile
app.post('/api/profiles/save-credentials', (req, res) => {
  if (!activeProfileId || !profiles[activeProfileId]) {
    return res.status(400).json({ success: false, error: 'No active profile' });
  }

  profiles[activeProfileId].kalshiApiKeyId = config.apiKeyId;
  profiles[activeProfileId].kalshiPrivateKey = config.privateKey;
  saveProfiles();

  res.json({ success: true, message: 'Credentials saved to profile' });
});

// Logout from profile
app.post('/api/profiles/logout', (req, res) => {
  if (activeProfileId && profiles[activeProfileId]) {
    // Save current state to profile before logout
    saveToActiveProfile();
  }

  // Fully deactivate - clear profile selection AND credentials
  activeProfileId = null;
  config.apiKeyId = null;
  config.privateKey = null;
  config.isAuthenticated = false;
  config.autoBetEnabled = false;

  // Stop auto-bet if running
  if (autoBetInterval) {
    clearInterval(autoBetInterval);
    autoBetInterval = null;
  }

  betHistory = [];

  // Save the cleared active profile state
  saveProfiles();

  res.json({ success: true, message: 'Logged out - no active profile' });
});

// Delete a profile
app.delete('/api/profiles/:id', (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!profiles[id]) {
    return res.status(404).json({ success: false, error: 'Profile not found' });
  }

  const profile = profiles[id];

  // Require PIN to delete if profile has one
  if (profile.pin && profile.pin !== pin) {
    return res.status(401).json({ success: false, error: 'Invalid PIN - required to delete profile' });
  }

  // If deleting active profile, logout first
  if (activeProfileId === id) {
    activeProfileId = null;
    config.apiKeyId = null;
    config.privateKey = null;
    config.isAuthenticated = false;
    config.autoBetEnabled = false;
    if (autoBetInterval) {
      clearInterval(autoBetInterval);
      autoBetInterval = null;
    }
    betHistory = [];
  }

  // Delete the profile
  const profileName = profile.name;
  delete profiles[id];
  saveProfiles();

  console.log(`🗑️ Deleted profile: ${profileName}`);
  res.json({ success: true, message: `Profile "${profileName}" deleted` });
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
    const isHourly = isHourlyMarket(ticker);
    const poolType = isHourly ? 'hourly' : 'other';
    const remainingBudget = getRemainingRiskBudget(ticker);
    const remainingTokenBudget = getRemainingTokenBudget(ticker, market.assetType);
    const poolMax = getMaxRisk(poolType);
    const maxPerBet = getMaxPerBet(poolType);
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
        marketType: isHourlyMarket(ticker) ? 'hourly' : ticker?.includes('15M') ? '15min' : 'daily'
      });

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet - use limit order slightly above ask to ensure fill
    // Add 2 cent buffer to improve fill rate
    const fillPrice = Math.min(priceCents + 2, 99);

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

    console.log(`Placing order (ask: ${priceCents}¢, bid: ${fillPrice}¢):`, JSON.stringify(orderRequest));

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
        marketType: isHourlyMarket(ticker) ? 'hourly' : ticker?.includes('15M') ? '15min' : 'daily'
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
          remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2),
          hourly: {
            current: riskByType.hourly,
            max: getMaxRisk('hourly'),
            currentDollars: (riskByType.hourly / 100).toFixed(2),
            maxDollars: (getMaxRisk('hourly') / 100).toFixed(2)
          },
          other: {
            current: riskByType.other,
            max: getMaxRisk('other'),
            currentDollars: (riskByType.other / 100).toFixed(2),
            maxDollars: (getMaxRisk('other') / 100).toFixed(2)
          }
        }
      });

      console.log(`✅ Bet placed. Risk now: $${(currentRisk / 100).toFixed(2)} / $${(getMaxTotalRisk() / 100).toFixed(2)}`);
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

    // Check risk limit for this market's pool
    const isHourly = isHourlyMarket(best.ticker);
    const remainingBudget = getRemainingRiskBudget(best.ticker);
    const poolMax = isHourly ? getMaxRisk('hourly') : getMaxRisk('other');
    const poolName = isHourly ? 'hourly' : 'other';

    if (remainingBudget < 10) { // Less than 10 cents remaining in this pool
      return res.json({
        success: true,
        message: `Risk limit reached for ${poolName} markets ($${(poolMax/100).toFixed(2)} max). Wait for positions to settle.`,
        bet: null,
        risk: getRiskByType()
      });
    }
    const category = best.marketCategory || 'crypto';
    const maxPerBet = getMaxPerBet(poolName === 'HOURLY' ? 'hourly' : 'other');
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
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
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

    // Real bet - use limit order slightly above ask to ensure fill
    const fillPrice = Math.min(priceCents + 2, 99);

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
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
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
          remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2),
          hourly: {
            current: riskByType.hourly,
            max: getMaxRisk('hourly'),
            currentDollars: (riskByType.hourly / 100).toFixed(2),
            maxDollars: (getMaxRisk('hourly') / 100).toFixed(2)
          },
          other: {
            current: riskByType.other,
            max: getMaxRisk('other'),
            currentDollars: (riskByType.other / 100).toFixed(2),
            maxDollars: (getMaxRisk('other') / 100).toFixed(2)
          }
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

// Auto-bet scan status tracking
let lastScanStatus = {
  timestamp: null,
  marketsScanned: 0,
  marketsWithEdge: 0,
  opportunitiesFound: 0,
  status: 'idle', // idle, scanning, no_opportunities, risk_limit, token_limit, bet_placed, error
  statusMessage: 'Auto-bet not started',
  lastBet: null,
  blockedReasons: [] // Track why bets weren't placed
};

async function runAutoBet(userId = null) {
  try {
    // Get user-specific state if userId provided
    const userState = userId ? getUserState(userId) : null;
    const userConfig = userState?.config || config;
    const userPortfolio = userState?.portfolio || portfolio;
    const userBetHistory = userState?.betHistory || betHistory;

    console.log('\n🤖 ========== AUTO-BET SCAN ==========');
    if (userId) console.log(`   User: ${userId}`);

    // Reset scan status
    lastScanStatus = {
      timestamp: new Date().toISOString(),
      marketsScanned: 0,
      marketsWithEdge: 0,
      opportunitiesFound: 0,
      status: 'scanning',
      statusMessage: 'Scanning markets...',
      lastBet: lastScanStatus.lastBet,
      blockedReasons: []
    };

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
        console.log(`📊 Refreshed positions: ${userPortfolio.positions.length} open positions from Kalshi`);
        if (userPortfolio.positions.length > 0) {
          userPortfolio.positions.forEach(p => {
            const token = getTokenFromTicker(p.ticker);
            console.log(`   Position: ${p.ticker} (${token}) | contracts=${p.position} | avg_price=${p.average_price} | market_exposure=${p.market_exposure}`);
          });
          // Log calculated exposure by token
          const tokenExposure = getExposureByToken();
          console.log(`📊 Calculated token exposure:`);
          for (const [token, exposure] of Object.entries(tokenExposure)) {
            console.log(`   💵 ${token}: $${(exposure/100).toFixed(2)} exposure (max $${(getMaxPerToken()/100).toFixed(2)})`);
          }
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

    // Update scan status with analysis results
    lastScanStatus.marketsScanned = allOpps.length;
    lastScanStatus.marketsWithEdge = withEdge.length;

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

    // Combine and filter using aggressiveMode settings
    const aggMode = config.aggressiveMode || { enabled: true, minPrice: 26, allowNightTrading: true };
    const isAggressive = aggMode.enabled !== false;
    // Hard minimum of 40 cents - higher priced bets = lower variance, more consistent wins
    const ABSOLUTE_MIN_PRICE = 40;
    const modeMinPrice = isAggressive ? (aggMode.minPrice || 26) : 41;
    const minPrice = Math.max(ABSOLUTE_MIN_PRICE, modeMinPrice);
    const hourNow = new Date().getHours();
    const isNightTime = hourNow >= 0 && hourNow < 6;
    // Always allow night trading in both modes (user preference)
    const allowNight = true;

    // Log trading mode
    console.log(`   ⚡ Mode: ${isAggressive ? 'AGGRESSIVE' : 'CONSERVATIVE'} | Min price: ${minPrice}¢ | Night: always allowed`);

    const opportunities = [...cryptoOpps, ...indexOpps]
      .filter(m => {
        if (m === null) return false;

        // DATA-DRIVEN: Night trading (0-5 AM) has 43.1% win rate
        if (isNightTime && !allowNight) {
          return false;
        }

        // DATA-DRIVEN: Minimum price filter (under 26¢ loses badly)
        const priceCents = m.betPriceCents || Math.round((m.betPrice || 0) * 100);
        if (priceCents < minPrice) {
          return false;
        }

        // REQUIRE 60%+ WIN PROBABILITY for auto-betting
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 60) return false;
        // Also require positive edge
        if (m.edge < 0.5) return false;

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
      // DATA-DRIVEN: Prefer NO bets (70.6% win rate vs YES 53.1%)
      // Sort by: 1) NO bets first, 2) then by win probability
      .sort((a, b) => {
        // Bonus for NO bets based on data analysis
        const aBonus = (a.betSide || '').toUpperCase() === 'NO' ? 5 : 0;
        const bBonus = (b.betSide || '').toUpperCase() === 'NO' ? 5 : 0;
        const aScore = parseFloat(a.winProbability) + aBonus;
        const bScore = parseFloat(b.winProbability) + bBonus;
        return bScore - aScore;
      });

    const highConfCount = opportunities.filter(o => parseFloat(o.winProbability) >= 70).length;
    console.log(`   Final: ${opportunities.length} opportunities (${highConfCount} above 70%)`);

    // Show top opportunities
    if (opportunities.length > 0) {
      console.log(`   🎯 Top opportunities:`);
      opportunities.slice(0, 3).forEach(m => {
        console.log(`      - ${m.title}: ${m.winProbability}% @ ${m.betPriceCents}¢ (${m.betSide}, edge +${m.edge.toFixed(1)}%)`);
      });
    }

    // Show markets approaching the threshold (55-59%)
    const approaching = allOpps.filter(m => {
      const prob = parseFloat(m.winProbability) || 0;
      return prob >= 55 && prob < 60 && m.edge > 0;
    });
    if (approaching.length > 0) {
      console.log(`   📈 ${approaching.length} markets approaching 60% threshold:`);
      approaching.slice(0, 3).forEach(m => {
        console.log(`      - ${m.title}: ${m.winProbability}% (${m.betSide})`);
      });
    }

    if (opportunities.length === 0) {
      console.log('⏳ No valid opportunities - waiting for next scan...');
      console.log('========================================\n');

      // Update status with reason
      lastScanStatus.status = 'no_opportunities';
      lastScanStatus.statusMessage = `No opportunities meet criteria (need 60%+ win prob, ${minPrice}¢+ price)`;
      if (approaching.length > 0) {
        lastScanStatus.blockedReasons.push(`${approaching.length} markets at 55-59% (need 60%+)`);
      }
      if (above50.length > above60.length) {
        lastScanStatus.blockedReasons.push(`${above50.length - above60.length} markets at 50-59%`);
      }
      return;
    }

    lastScanStatus.opportunitiesFound = opportunities.length;

    // Always show the best opportunity found
    const best = opportunities[0];
    const category = best.marketCategory || 'crypto';

    // Check risk limit for this market's pool
    const isHourly = isHourlyMarket(best.ticker);
    const remainingBudget = getRemainingRiskBudget(best.ticker);
    const riskByType = getRiskByType();
    const poolMax = isHourly ? getMaxRisk('hourly') : getMaxRisk('other');
    const poolCurrent = isHourly ? riskByType.hourly : riskByType.other;
    const poolName = isHourly ? 'HOURLY' : 'OTHER';

    console.log(`💰 Risk [${poolName}]: $${(poolCurrent/100).toFixed(2)} / $${(poolMax/100).toFixed(2)} | Total: $${(riskByType.total/100).toFixed(2)} / $${(getMaxTotalRisk()/100).toFixed(2)}`);

    console.log(`\n💰 BEST OPPORTUNITY [${category.toUpperCase()}]:`);
    console.log(`   ${best.title}`);
    console.log(`   ${best.betReason}`);
    console.log(`   Side: ${best.betSide} @ ${(best.betPrice * 100).toFixed(0)}¢ | Win prob: ${best.winProbability}%`);
    console.log(`   Current: $${best.currentPrice?.toFixed(2) || 'N/A'} | Strike: $${best.strikePrice?.toFixed(2) || 'N/A'}`);
    console.log(`   Edge: +${best.edge.toFixed(1)}%`);

    // Show other good opportunities
    if (opportunities.length > 1) {
      console.log(`   + ${opportunities.length - 1} more opportunities above 60%`);
    }

    // Check risk limit AFTER showing opportunities
    if (remainingBudget < 10) {
      console.log(`⚠️ Risk limit reached for ${poolName} pool - watching but not betting...`);
      console.log('========================================\n');

      lastScanStatus.status = 'risk_limit';
      lastScanStatus.statusMessage = `Risk limit reached for ${poolName} pool ($${(poolCurrent/100).toFixed(2)}/$${(poolMax/100).toFixed(2)})`;
      lastScanStatus.blockedReasons.push(`${poolName} pool limit: $${(poolCurrent/100).toFixed(2)} / $${(poolMax/100).toFixed(2)}`);
      return;
    }

    // Check per-token limit
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType);
    const tokenName = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
    if (remainingTokenBudget < 10) {
      console.log(`⚠️ Token limit reached for ${tokenName} ($${(getMaxPerToken()/100).toFixed(2)} max) - skipping...`);
      console.log('========================================\n');

      lastScanStatus.status = 'token_limit';
      lastScanStatus.statusMessage = `Token limit reached for ${tokenName}`;
      lastScanStatus.blockedReasons.push(`${tokenName} limit: $${(getMaxPerToken()/100).toFixed(2)} max per token`);
      return;
    }

    console.log(`   ${best.isObviousBet ? '✅ HIGH CONFIDENCE' : '⚠️ Model-based'}`);
    console.log(`   Token budget for ${tokenName}: $${(remainingTokenBudget/100).toFixed(2)} remaining`);

    // Cap bet at remaining risk budget, max per bet, OR token budget - whichever is lowest
    const maxPerBet = getMaxPerBet(isHourly ? 'hourly' : 'other');
    const MAX_BET_CENTS = Math.min(maxPerBet, remainingBudget, remainingTokenBudget);

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      console.log('⚠️ Bet size too small for risk budget');
      lastScanStatus.status = 'bet_too_small';
      lastScanStatus.statusMessage = `Bet size too small (price ${priceCents}¢ > budget $${(MAX_BET_CENTS/100).toFixed(2)})`;
      lastScanStatus.blockedReasons.push(`Budget too low for ${priceCents}¢ contract`);
      return;
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
      timestamp: new Date().toISOString(),
      status: config.isAuthenticated ? 'pending' : 'simulated',
      auto: true,
      isScaleIn: best.isScaleIn || false,
      scaleInNumber: newBetCount
    };

    // Mark this market as bet on BEFORE placing the bet (or update for scale-in)
    recentBets.set(best.ticker, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      betCount: newBetCount
    });
    if (best.isScaleIn) {
      console.log(`📈 SCALE-IN: Adding bet #${newBetCount} on ${best.ticker} (prob increased to ${best.winProbability}%)`);
    }

    if (!config.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        strikePrice: best.strikePrice,
        currentPrice: best.currentPrice,
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      console.log(`\n🎰 SIMULATED BET PLACED:`);
      console.log(`   ${betRecord.side.toUpperCase()} on ${assetName}`);
      console.log(`   ${count} contracts @ ${priceCents}¢ = $${(betRecord.totalCost/100).toFixed(2)}`);
      console.log(`   Edge: +${best.edge.toFixed(1)}% | Win prob: ${best.winProbability}%`);
      console.log(`   New balance: $${(config.bankroll/100).toFixed(2)}`);
      console.log('========================================\n');

      lastScanStatus.status = 'bet_placed';
      lastScanStatus.statusMessage = `Simulated ${best.betSide} on ${assetName} (${count}x @ ${priceCents}¢)`;
      lastScanStatus.lastBet = {
        ticker: best.ticker,
        side: best.betSide,
        contracts: count,
        price: priceCents,
        total: betRecord.totalCost,
        winProb: best.winProbability,
        edge: best.edge,
        simulated: true,
        timestamp: new Date().toISOString()
      };
      return;
    }

    // Real bet - use limit order slightly above ask to ensure fill
    const fillPrice = Math.min(priceCents + 2, 99);

    console.log(`\n💸 PLACING REAL BET...`);
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
    console.log(`   Order (ask: ${priceCents}¢, bid: ${fillPrice}¢): ${JSON.stringify(orderRequest)}`);

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
    console.log(`   Response: ${JSON.stringify(orderResponse)}`);

    const order = orderResponse.order;
    if (!order) {
      console.error('❌ No order in response');
      recentBets.delete(best.ticker);
      console.log('========================================\n');
      return;
    }

    // Check if order was filled
    const status = order.status;
    const filledCount = order.filled_count || 0;

    if (filledCount === 0) {
      console.error(`❌ Order not filled. Status: ${status}. No liquidity.`);
      recentBets.delete(best.ticker);
      console.log('========================================\n');
      return;
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
      strikePrice: best.strikePrice,
      currentPrice: best.currentPrice,
      marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
      expiryTime: best.expiry || best.close_time
    });

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    config.bankroll = balanceData.balance || 0;

    console.log(`\n✅ REAL BET FILLED:`);
    console.log(`   ${betRecord.side.toUpperCase()} on ${best.cryptoType || best.assetType}`);
    console.log(`   ${filledCount} contracts @ ${betRecord.avgPrice}¢`);
    console.log(`   Edge: +${best.edge.toFixed(1)}% | New balance: $${(config.bankroll/100).toFixed(2)}`);
    console.log('========================================\n');

    const assetName = best.cryptoType || best.assetType || getTokenFromTicker(best.ticker) || 'unknown';
    lastScanStatus.status = 'bet_placed';
    lastScanStatus.statusMessage = `LIVE ${best.betSide} on ${assetName} (${filledCount}x @ ${betRecord.avgPrice}¢)`;
    lastScanStatus.lastBet = {
      ticker: best.ticker,
      side: best.betSide,
      contracts: filledCount,
      price: betRecord.avgPrice,
      total: betRecord.totalCost,
      winProb: best.winProbability,
      edge: best.edge,
      simulated: false,
      orderId: order.order_id,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Auto-bet error:', error.message);
    console.error('   Stack:', error.stack);
    console.log('========================================\n');

    lastScanStatus.status = 'error';
    lastScanStatus.statusMessage = `Error: ${error.message}`;
    lastScanStatus.blockedReasons.push(`Error: ${error.message}`);
  }
}

app.post('/api/crypto/auto-bet/toggle', (req, res) => {
  const { enabled, intervalSeconds = 10 } = req.body; // Check every 10 seconds for faster reaction

  // Require authentication for auto-bet
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;

  if (enabled && !userConfig.autoBetEnabled) {
    userConfig.autoBetEnabled = true;
    saveUserState(req.userId);

    // For now, auto-bet still uses the user's state through the middleware
    // TODO: Implement per-user auto-bet intervals
    runAutoBet(req.userId);

    // Store interval per user
    if (userAutoBetIntervals.has(req.userId)) {
      clearInterval(userAutoBetIntervals.get(req.userId));
    }
    userAutoBetIntervals.set(req.userId, setInterval(() => runAutoBet(req.userId), intervalSeconds * 1000));

    res.json({
      success: true,
      message: `Auto-betting enabled (every ${intervalSeconds}s)`,
      autoBetEnabled: true
    });
  } else if (!enabled && userConfig.autoBetEnabled) {
    userConfig.autoBetEnabled = false;
    saveUserState(req.userId);

    // Clear user's auto-bet interval
    if (userAutoBetIntervals.has(req.userId)) {
      clearInterval(userAutoBetIntervals.get(req.userId));
      userAutoBetIntervals.delete(req.userId);
    }
    if (autoBetInterval) {
      clearInterval(autoBetInterval);
      autoBetInterval = null;
    }

    res.json({ success: true, message: 'Auto-betting disabled', autoBetEnabled: false });
  } else {
    res.json({
      success: true,
      message: `Auto-betting ${userConfig.autoBetEnabled ? 'running' : 'stopped'}`,
      autoBetEnabled: userConfig.autoBetEnabled
    });
  }
});

// Get auto-bet scan status
app.get('/api/auto-bet/status', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    autoBetEnabled: userConfig.autoBetEnabled,
    ...lastScanStatus
  });
});

// ============================================
// USER AUTHENTICATION (Email/Password)
// ============================================

// Register new user account
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await auth.registerUser(email, password);
    res.json({
      success: true,
      message: 'Account created successfully',
      token: result.token,
      user: { id: result.userId, email: result.email }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Login with email/password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Support legacy password-only login for backwards compatibility
    if (password && !email) {
      // Legacy mode - just check if password is not empty (old behavior)
      res.json({ success: true, message: 'Legacy login' });
      return;
    }

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await auth.loginUser(email, password);

    // If user has a linked profile, auto-activate it
    if (result.profileId && profiles[result.profileId]) {
      activeProfileId = result.profileId;
      restoreActiveProfile();
      console.log(`🔐 Auto-activated profile for ${email}`);
    }

    res.json({
      success: true,
      message: 'Logged in successfully',
      token: result.token,
      user: { id: result.userId, email: result.email, profileId: result.profileId }
    });
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// Get current user info
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const userId = auth.verifyToken(token);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const userInfo = auth.getUserInfo(userId);
  if (!userInfo) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  res.json({
    success: true,
    user: userInfo,
    activeProfile: activeProfileId ? profiles[activeProfileId]?.name : null
  });
});

// Link profile to user account
app.post('/api/auth/link-profile', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const userId = auth.verifyToken(token);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const { profileId } = req.body;
  if (!profileId || !profiles[profileId]) {
    return res.status(400).json({ success: false, error: 'Invalid profile ID' });
  }

  auth.linkProfileToUser(userId, profileId);
  res.json({ success: true, message: 'Profile linked to account' });
});

// Kalshi API auth endpoints
app.post('/api/auth/configure', async (req, res) => {
  try {
    const { apiKeyId, privateKey } = req.body;

    if (!apiKeyId || !privateKey) {
      return res.status(400).json({ success: false, error: 'apiKeyId and privateKey required' });
    }

    // Require authenticated user
    if (!req.userId) {
      return res.status(401).json({ success: false, error: 'Please login first' });
    }

    const userState = req.userState;
    const userConfig = userState.config;

    userConfig.apiKeyId = apiKeyId.trim();
    userConfig.privateKey = privateKey.trim();
    userConfig.isAuthenticated = true;

    try {
      // Test the credentials with user-specific config
      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      userState.portfolio.balance = balanceData.balance || 0;
      userConfig.bankroll = userState.portfolio.balance;

      // Save user state to disk
      saveUserState(req.userId);
      console.log(`🔑 Saved Kalshi credentials for user ${req.userId}`);

      res.json({
        success: true,
        message: 'Connected to Kalshi',
        balance: userState.portfolio.balance / 100
      });
    } catch (authError) {
      userConfig.apiKeyId = null;
      userConfig.privateKey = null;
      userConfig.isAuthenticated = false;
      res.status(401).json({ success: false, error: 'Invalid credentials: ' + authError.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    isAuthenticated: userConfig.isAuthenticated,
    hasApiKey: !!userConfig.apiKeyId,
    userId: req.userId || null
  });
});

app.get('/api/portfolio', async (req, res) => {
  try {
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    const userBetHistory = req.userState?.betHistory || betHistory;

    // If authenticated, fetch real data from Kalshi
    if (userConfig.isAuthenticated) {
      // Fetch balance
      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      userPortfolio.balance = balanceData.balance || 0;
      userConfig.bankroll = userPortfolio.balance;

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
            const data = await kalshiRequest('GET', `/markets/${ticker}`, null, userConfig);
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
        realBetHistory = userBetHistory.slice(0, 20);
      }

      // Merge with in-memory history
      const combinedHistory = [...realBetHistory];
      userBetHistory.forEach(memBet => {
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

      // Save updated state
      if (req.userId) saveUserState(req.userId);

      res.json({
        success: true,
        simulated: false,
        balance: userPortfolio.balance / 100,
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
        balance: userConfig.bankroll / 100,
        betHistory: userBetHistory.slice(0, 20),
        stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 }
      });
    }
  } catch (error) {
    console.error('Portfolio error:', error.message);
    const userConfig = req.userState?.config || config;
    const userBetHistory = req.userState?.betHistory || betHistory;
    res.json({
      success: true,
      simulated: !userConfig.isAuthenticated,
      balance: userConfig.bankroll / 100,
      betHistory: userBetHistory.slice(0, 20),
      stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 },
      error: error.message
    });
  }
});

app.get('/api/settings', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    settings: {
      bankroll: userConfig.bankroll / 100,
      minEdge: userConfig.minEdge,
      maxBetPercent: userConfig.maxBetPercent,
      autoBetEnabled: userConfig.autoBetEnabled
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
  console.log(`📈 Performance tracking: ${performanceData.bets.length} historical bets loaded`);

  // Auto-load Kalshi credentials from environment
  await loadCredentialsFromEnv();

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
