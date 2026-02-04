import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';
import * as auth from './auth.js';
import { getKalshiWebSocket } from './kalshiWebSocket.js';
import { pool, initDatabase } from './db.js';

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
  // Liquidity settings: filter out illiquid markets with wide spreads
  liquiditySettings: {
    enabled: true,
    minContracts: 10,            // Minimum contracts at best price
    maxSpreadCents: 8,           // Maximum bid-ask spread in cents
    spreadPenaltyEnabled: true   // Subtract half-spread from edge calculation
  },
  // Momentum confirmation: use candlestick data to confirm price direction
  momentumSettings: {
    enabled: true,
    alignmentBonus: 2,           // +2% edge bonus if momentum aligns with bet
    oppositionPenalty: -3,       // -3% edge penalty if momentum opposes bet
    lookbackCandles: 5,          // Number of candles to analyze
    volumeWeighted: true         // Weight by volume
  },
  // Take-profit settings: exit positions early when favorable
  // SMART MODE: Uses urgency scoring to decide when to lock in gains
  takeProfitSettings: {
    enabled: true,               // ENABLED by default - solidify gains!
    autoExecute: true,           // Auto-execute when conditions are optimal
    minProfitPercent: 10,        // Base minimum (lowered by urgency score)
    confidenceFactor: 0.85,      // Model uncertainty discount
    logOnly: false,              // Actually execute (set true to test first)
    scanIntervalMs: 15000,       // Check positions every 15 seconds (faster reaction)
    // Smart exit thresholds (urgency score 0-100)
    urgencyThresholds: {
      low: 20,                   // Below this: require full minProfitPercent
      medium: 40,                // At this: start lowering profit requirement
      high: 60,                  // At this: take 5%+ profits
      critical: 80               // At this: take any profit > 3%
    }
  },
  // Limit Order Settings - DISABLED: Kalshi doesn't support limit orders for crypto markets
  // These settings are kept for reference but the feature is disabled
  // Stop-loss is now handled by active monitoring in evaluateTakeProfit()
  limitOrderSettings: {
    stopLoss: {
      enabled: false,            // DISABLED - Kalshi rejects limit orders for crypto markets
      threshold: -40             // Used by active monitoring for stop-loss threshold
    },
    takeProfit: {
      enabled: false,            // DISABLED - Kalshi rejects limit orders for crypto markets
      threshold: 25              // Used by active monitoring for take-profit threshold
    }
  },
  // Active monitoring settings (runs every 15 seconds when auto-bet is on)
  activeMonitoring: {
    stopLossEnabled: true,       // Cut losses at threshold
    stopLossThreshold: -40,      // Exit if position is down 40%
    easyProfitEnabled: true,     // Take "free money" on high-confidence positions
    easyProfitMinPrice: 75,      // Minimum buy price for easy profit (75¢ = 75% implied prob)
    easyProfitThreshold: 12      // Near expiry (<5min): take 12%+ profit (accounts for fees)
    // Note: Early exits (>5min left) require 18%+ profit to justify fees
  }
};

// ============================================
// PER-USER STATE MANAGEMENT (PostgreSQL)
// ============================================

// ============================================
// EMPIRICAL LOOKUP TABLES (Pure Data-Driven Betting)
// ============================================
// Philosophy: Let the data speak - no theoretical assumptions
// Edge comes from volatility mispricing, not directional alpha
// Trade selectively (5-15% of intervals) when signal is extreme

const LEARNED_PARAMS_FILE = path.join(__dirname, 'learned_params.json');
const LEARNING_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Default empirical tables structure
const DEFAULT_EMPIRICAL_TABLES = {
  lastUpdated: null,
  sampleSize: 0,

  // Core lookup tables - win rate by distance from strike
  winRateByDistance: {
    0.1: { count: 0, favoredWinRate: 50, surpriseRate: 50 },
    0.2: { count: 0, favoredWinRate: 52, surpriseRate: 48 },
    0.3: { count: 0, favoredWinRate: 54, surpriseRate: 46 },
    0.5: { count: 0, favoredWinRate: 58, surpriseRate: 42 },
    0.75: { count: 0, favoredWinRate: 62, surpriseRate: 38 },
    1.0: { count: 0, favoredWinRate: 68, surpriseRate: 32 },
    1.5: { count: 0, favoredWinRate: 74, surpriseRate: 26 },
    2.0: { count: 0, favoredWinRate: 80, surpriseRate: 20 },
    3.0: { count: 0, favoredWinRate: 86, surpriseRate: 14 },
    5.0: { count: 0, favoredWinRate: 92, surpriseRate: 8 }
  },

  // Volatility regime tables (key insight from domain analysis)
  volatilityRegimes: {
    low: {
      description: 'Calm market, predictable movements',
      winRateMultiplier: 1.05,  // Slightly boost confidence
      coinFlipThreshold: 0.1,   // Smaller moves matter
      sitOut: false
    },
    medium: {
      description: 'Normal market conditions',
      winRateMultiplier: 1.0,
      coinFlipThreshold: 0.2,
      sitOut: false
    },
    high: {
      description: 'Elevated volatility, be cautious',
      winRateMultiplier: 0.92,  // Reduce confidence
      coinFlipThreshold: 0.4,
      sitOut: false
    },
    spike: {
      description: 'Volatility spike detected (2%+ in 5 min)',
      winRateMultiplier: 0,
      coinFlipThreshold: 1.0,
      sitOut: true  // Don't bet during spikes
    }
  },

  // Token-specific with learned entry windows
  byToken: {
    BTC: {
      sampleSize: 0,
      avgSettlementDistance: 0,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 2,
      optimalEntryWindows: {
        distanceMin: 0.5,   // Minimum % from strike to bet
        distanceMax: 3.0,   // Maximum % (beyond this, edge eaten by fees)
        timeMin: 2,         // Minimum minutes remaining
        timeMax: 12,        // Maximum minutes (too early = unpredictable)
        priceMin: 35,       // Minimum bet price in cents
        priceMax: 75        // Maximum bet price in cents
      }
    },
    ETH: {
      sampleSize: 0,
      avgSettlementDistance: 0,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 2,
      optimalEntryWindows: {
        distanceMin: 0.5,
        distanceMax: 3.0,
        timeMin: 2,
        timeMax: 12,
        priceMin: 35,
        priceMax: 75
      }
    },
    SOL: {
      sampleSize: 0,
      avgSettlementDistance: 0,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 3,  // SOL typically most volatile
      optimalEntryWindows: {
        distanceMin: 0.75,  // Need more buffer for SOL
        distanceMax: 4.0,
        timeMin: 3,
        timeMax: 10,
        priceMin: 40,
        priceMax: 70
      }
    }
  },

  // Selectivity rules (learned thresholds for when to bet)
  selectivityRules: {
    minSignalStrength: 70,      // 0-100 score required to bet
    minEmpiricalWinRate: 62,    // Minimum win rate from lookup tables
    minEdgeAfterFees: 5,        // 5% minimum edge after all fees
    maxBetsPerHour: 6,          // Rate limiting for discipline
    maxBetsPerToken: 3,         // Per-token concentration limit
    requireRegimeCheck: true    // Must pass volatility regime check
  },

  // Performance tracking for adaptive adjustment
  performanceTracking: {
    recentBets: [],             // Last 50 bets for short-term calibration
    winRateByRegime: {
      low: { bets: 0, wins: 0 },
      medium: { bets: 0, wins: 0 },
      high: { bets: 0, wins: 0 }
    },
    calibrationError: 0,        // Difference between predicted and actual
    lastCalibrationUpdate: null
  },

  // Legacy compatibility fields
  thresholds: {
    coinFlipExit: 0.15,
    nearStrikeExit: 0.25,
    timeBuffer: 180000
  },
  yesNoBias: {
    global: { yesWinRate: 50, noWinRate: 50, noBias: 0, sampleSize: 0 }
  },
  probabilityThresholds: {
    autoMinProbability: 62,     // Raised from 60 based on analysis
    manualMinProbability: 55
  },
  confidence: 0
};

// Legacy alias for backward compatibility
const DEFAULT_LEARNED_PARAMS = DEFAULT_EMPIRICAL_TABLES;

// Load learned parameters (now empirical tables)
let learnedParams = JSON.parse(JSON.stringify(DEFAULT_EMPIRICAL_TABLES));
try {
  if (fs.existsSync(LEARNED_PARAMS_FILE)) {
    const data = JSON.parse(fs.readFileSync(LEARNED_PARAMS_FILE, 'utf8'));
    learnedParams = { ...DEFAULT_LEARNED_PARAMS, ...data };
    console.log(`📚 Loaded learned params: sample size ${learnedParams.sampleSize}, last updated ${learnedParams.lastUpdated}`);
  }
} catch (err) {
  console.error('Error loading learned params:', err.message);
}

// Save learned parameters
function saveLearnedParams() {
  try {
    fs.writeFileSync(LEARNED_PARAMS_FILE, JSON.stringify(learnedParams, null, 2));
    console.log(`💾 Saved learned params to ${LEARNED_PARAMS_FILE}`);
  } catch (err) {
    console.error('Error saving learned params:', err.message);
  }
}

// Check if learning data is stale (>24 hours old)
function isLearningDataStale() {
  if (!learnedParams.lastUpdated) return true;
  const lastUpdate = new Date(learnedParams.lastUpdated).getTime();
  return Date.now() - lastUpdate > LEARNING_INTERVAL;
}

// Sleep helper for rate limiting
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// In-memory cache of user states
const userStates = new Map();

// Auto-bet intervals per user
const userAutoBetIntervals = new Map();

// Create default user state
function createDefaultUserState() {
  return {
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), // Deep clone
    betHistory: [],
    portfolio: { balance: 0, positions: [] }
  };
}

// Get or create user state (loads from PostgreSQL if not in cache)
async function getUserStateAsync(userId) {
  if (!userId) {
    // Return a default read-only state for unauthenticated requests
    return {
      config: { ...DEFAULT_CONFIG },
      betHistory: [],
      portfolio: { balance: 0, positions: [] }
    };
  }

  if (!userStates.has(userId)) {
    // Try to load from database
    try {
      const result = await pool.query(
        'SELECT config, portfolio, bet_history FROM user_data WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        // Deep merge config to preserve nested riskLimits structure
        const loadedConfig = { ...DEFAULT_CONFIG, ...(row.config || {}) };
        if (row.config?.riskLimits) {
          loadedConfig.riskLimits = {
            ...DEFAULT_CONFIG.riskLimits,
            ...row.config.riskLimits,
            hourly: {
              ...DEFAULT_CONFIG.riskLimits.hourly,
              ...(row.config.riskLimits?.hourly || {})
            },
            other: {
              ...DEFAULT_CONFIG.riskLimits.other,
              ...(row.config.riskLimits?.other || {})
            }
          };
        }
        userStates.set(userId, {
          config: loadedConfig,
          betHistory: row.bet_history || [],
          portfolio: row.portfolio || { balance: 0, positions: [] }
        });
        console.log(`📂 Loaded state for user ${userId} from database`);
      } else {
        // New user - create default state
        userStates.set(userId, createDefaultUserState());
        console.log(`🆕 Created new state for user ${userId}`);
      }
    } catch (err) {
      console.error(`Error loading user state for ${userId}:`, err);
      userStates.set(userId, createDefaultUserState());
    }
  }
  return userStates.get(userId);
}

// Synchronous version for backward compatibility (returns cached state or default)
function getUserState(userId) {
  if (!userId) {
    return {
      config: { ...DEFAULT_CONFIG },
      betHistory: [],
      portfolio: { balance: 0, positions: [] }
    };
  }

  if (userStates.has(userId)) {
    return userStates.get(userId);
  }

  // If not cached, return default (async load will happen in middleware)
  const defaultState = createDefaultUserState();
  userStates.set(userId, defaultState);
  return defaultState;
}

// Save user state to PostgreSQL
async function saveUserState(userId) {
  if (!userId) return;
  const state = userStates.get(userId);
  if (!state) return;

  try {
    await pool.query(`
      INSERT INTO user_data (user_id, config, portfolio, bet_history, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        config = $2, portfolio = $3, bet_history = $4, updated_at = NOW()
    `, [userId, JSON.stringify(state.config), JSON.stringify(state.portfolio), JSON.stringify(state.betHistory)]);
  } catch (err) {
    console.error(`Error saving user state for ${userId}:`, err);
  }
}

// Middleware to extract user from JWT token (async to load from DB)
async function extractUser(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    const userId = auth.verifyToken(token);
    if (userId) {
      req.userId = userId;
      req.userState = await getUserStateAsync(userId);
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
      autoBetEnabled: config.autoBetEnabled
    };
    profile.betHistory = betHistory;
    profile.lastActive = new Date().toISOString();
    saveProfiles();
  }
}

// Profile system removed - user state is now tied directly to logged-in user account
// Each user's settings, Kalshi credentials, and bet history are stored in their user state file

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
    userId: betInfo.userId || null,  // Track which user placed this bet
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
      // Infer expiry from ticker if not set (ticker format: KXBTC15M-26FEB031700-00)
      // Pattern: [YY][MMM][DD][HHMM] where YY=year, MMM=month, DD=day, HHMM=time
      let expiryTime = bet.expiryTime;
      if (!expiryTime && bet.ticker) {
        const match = bet.ticker.match(/(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/);
        if (match) {
          const [, yearSuffix, monthStr, day, hour, minute] = match;
          const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
          const fullYear = 2000 + parseInt(yearSuffix);
          const month = months[monthStr] || 0;
          expiryTime = new Date(fullYear, month, parseInt(day), parseInt(hour), parseInt(minute)).toISOString();
          // Store inferred expiry time for next check
          bet.expiryTime = expiryTime;
        }
      }

      // Check if market has settled (allow 5 minute grace period for settlement)
      if (expiryTime && new Date(expiryTime).getTime() + 5 * 60 * 1000 > Date.now()) {
        continue; // Not expired yet (with 5 min grace period)
      }

      // Try to get settlement from Kalshi (market data is public, try without auth first)
      // If bet has userId, try to get user's config for authenticated request
      let userConfig = config;
      if (bet.userId) {
        const userState = getUserState(bet.userId);
        if (userState?.config?.isAuthenticated) {
          userConfig = userState.config;
        }
      }

      if (bet.ticker) {
        try {
          // Try with user config if available, otherwise use global
          const market = await kalshiRequest('GET', `/markets/${bet.ticker}`, null, userConfig);
          if (market.market?.result) {
            const result = market.market.result;  // 'yes' or 'no'
            const won = (bet.side.toLowerCase() === result);
            const profit = won ? (bet.contracts * 100 - bet.totalCost) : 0;
            settleBet(bet.id, won ? 'won' : 'lost', market.market.settlement_value, profit);
            console.log(`   ✅ Settled bet ${bet.id}: ${won ? 'WON' : 'LOST'} (${bet.side} on ${bet.ticker})`);
          }
        } catch (e) {
          // Market might not exist or API error - try price-based settlement below
        }
      }

      // For simulated bets or if we can't get Kalshi data, check price
      if (bet.outcome === 'pending' && bet.strikePrice && bet.token) {
        const currentPrice = cryptoPrices[bet.token]?.price;
        // Use inferred expiryTime (variable from above) which may have been set earlier in this iteration
        if (currentPrice && expiryTime && new Date(expiryTime) <= new Date()) {
          // Market should have settled - determine outcome from price
          const isAbove = currentPrice >= bet.strikePrice;
          const won = (bet.side.toLowerCase() === 'yes' && isAbove) ||
                      (bet.side.toLowerCase() === 'no' && !isAbove);
          const profit = won ? (bet.contracts * 100 - bet.totalCost) : 0;
          settleBet(bet.id, won ? 'won' : 'lost', currentPrice, profit);
          console.log(`   ✅ Settled bet ${bet.id} via price: ${won ? 'WON' : 'LOST'} (${bet.side} ${bet.token} @ strike $${bet.strikePrice}, current $${currentPrice})`);
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

// Only tracking 15-minute BTC, ETH, SOL markets
const TRACKED_TOKENS = {
  BTC: { name: 'Bitcoin', minPrice: 10000, maxPrice: 500000 },
  ETH: { name: 'Ethereum', minPrice: 100, maxPrice: 20000 },
  SOL: { name: 'Solana', minPrice: 1, maxPrice: 1000 }
};

// Price data storage
const cryptoPrices = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  cryptoPrices[token] = { price: 0, timestamp: 0, history: [], volatility: 0.02 };
});

// Binance symbol mapping (PRIMARY - fast)
const BINANCE_SYMBOLS = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT'
};

// CoinGecko ID mapping (FALLBACK - slower but reliable)
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana'
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
  // Handle edge cases
  if (isNaN(x) || !isFinite(x)) return 0.5;
  if (x > 10) return 0.999;
  if (x < -10) return 0.001;

  // For crypto, use df=3-5 (very fat tails)
  // For indices, use df=7-10 (moderately fat tails)
  const t = x;
  const a = df / 2;
  const b = 0.5;

  // Use incomplete beta function approximation
  const x2 = df / (df + t * t);

  let result;
  if (t >= 0) {
    result = 1 - 0.5 * incompleteBeta(x2, a, b);
  } else {
    result = 0.5 * incompleteBeta(x2, a, b);
  }

  // Sanitize result
  if (isNaN(result) || !isFinite(result)) return 0.5;
  return Math.max(0.001, Math.min(0.999, result));
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
  if (isNaN(n) || !isFinite(n)) return 1;
  if (n === 1) return 1;
  if (n === 0.5) return Math.sqrt(Math.PI);
  if (n < 0.5) {
    const sinVal = Math.sin(Math.PI * n);
    if (Math.abs(sinVal) < 1e-10) return 1; // Avoid division by zero
    return Math.PI / (sinVal * gamma(1 - n));
  }

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

// ============================================
// LEGACY PROBABILITY FUNCTIONS (DEPRECATED)
// ============================================
// These theoretical probability models have been REPLACED by the
// pure empirical data-driven system (evaluateOpportunityEmpirical).
// Kept for backward compatibility but no longer used in runAutoBet.
// The new system uses lookupEmpiricalWinRate() and calculateSignalStrength().

// Bootstrap simulation: resample historical returns to estimate probability
// DEPRECATED: Use lookupEmpiricalWinRate() instead
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
// DEPRECATED: Use evaluateOpportunityEmpirical() instead
// This theoretical model with z-scores, Student-t, and bootstrap has been replaced
// by pure empirical lookup tables built from 6000+ historical settlements.
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

  // Sanitize individual probabilities before combining
  const safeNormalProb = isNaN(normalProbAbove) ? 0.5 : Math.max(0.01, Math.min(0.99, normalProbAbove));
  const safeTProb = isNaN(tProbAbove) ? 0.5 : Math.max(0.01, Math.min(0.99, tProbAbove));
  const safeBootstrapProb = isNaN(bootstrapProbAbove) ? 0.5 : Math.max(0.01, Math.min(0.99, bootstrapProbAbove));
  const safeHistoricalProb = isNaN(historicalProbStay) ? 0.5 : Math.max(0.01, Math.min(0.99, historicalProbStay));

  // Calculate raw ensemble probability
  let ensembleProbAbove =
    weights.normal * safeNormalProb +
    weights.studentT * safeTProb +
    weights.bootstrap * safeBootstrapProb +
    weights.historical * (isAboveTarget ? safeHistoricalProb : 1 - safeHistoricalProb);

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

  // Defensive check: if any NaN crept through, use simple fallback
  if (isNaN(ensembleProbAbove)) {
    console.log(`   ⚠️ NaN detected in probability calculation, using simple fallback`);
    // Simple fallback: if above target, more likely to stay above
    ensembleProbAbove = isAboveTarget ? 0.55 : 0.45;
  }

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
  // Handle edge cases
  if (isNaN(x) || !isFinite(x)) return 0.5;
  if (x > 8) return 0.9999;
  if (x < -8) return 0.0001;

  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  const result = 0.5 * (1.0 + sign * y);
  return isNaN(result) ? 0.5 : Math.max(0.0001, Math.min(0.9999, result));
}

// Start price tracking (every 10 seconds)
let priceInterval = setInterval(fetchCryptoPrices, 10000);
fetchCryptoPrices();

// ============================================
// RISK MANAGEMENT
// ============================================

// Risk limits are now configurable via config.riskLimits
// Helper functions to get current limits - accept optional userConfig for per-user limits
function getMaxRisk(type, userConfig = null) {
  const cfg = userConfig || config;
  return cfg.riskLimits[type]?.maxTotal || 500;
}

function getMaxPerBet(type, userConfig = null) {
  const cfg = userConfig || config;
  return cfg.riskLimits[type]?.maxPerBet || 200;
}

function getMaxTotalRisk(userConfig = null) {
  // If user has a unified maxTotal, use that
  const cfg = userConfig || config;
  if (cfg.riskLimits.maxTotal) {
    return cfg.riskLimits.maxTotal;
  }
  return getMaxRisk('hourly', userConfig) + getMaxRisk('other', userConfig);
}

// Determine if a ticker is an hourly market
function isHourlyMarket(ticker) {
  if (!ticker) return false;
  // Hourly series end in 1H (e.g., KXBTC1H, KXETH1H)
  return ticker.includes('1H') || ticker.includes('-1H-');
}

// Sync Kalshi positions to betHistory so exposure is tracked correctly after server restart
// This creates synthetic bet records for positions that don't have matching local bets
function syncKalshiPositionsToBetHistory(userState, positions, userId = null) {
  const userBetHistory = userState?.betHistory || betHistory;
  const positionsArray = positions || [];

  // Build set of current Kalshi position tickers
  const currentPositionTickers = new Set(
    positionsArray
      .filter(p => Math.abs(p.position || 0) > 0)
      .map(p => p.ticker)
  );

  // Clean up stale synced bets (positions that no longer exist in Kalshi)
  let cleanedCount = 0;
  for (const bet of userBetHistory) {
    if (bet.source === 'kalshi-sync' && bet.status !== 'settled' && bet.status !== 'closed') {
      if (!currentPositionTickers.has(bet.ticker)) {
        bet.status = 'settled';
        bet.outcome = 'unknown'; // We don't know the outcome, just that it's gone
        cleanedCount++;
        console.log(`🧹 Cleaned up stale synced bet: ${bet.ticker}`);
      }
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stale synced bets`);
  }

  // Now sync new positions
  if (positionsArray.length === 0) {
    // Still need to save if we cleaned up stale bets
    if (cleanedCount > 0 && userId) {
      saveUserState(userId);
    }
    return;
  }

  const existingTickers = new Set(
    userBetHistory
      .filter(b => b.status !== 'settled' && b.status !== 'closed')
      .map(b => b.ticker)
  );

  let syncedCount = 0;
  for (const pos of positionsArray) {
    const contracts = Math.abs(pos.position || 0);
    if (contracts === 0) continue;

    // Skip if we already have a bet record for this ticker
    if (existingTickers.has(pos.ticker)) continue;

    // Calculate the cost for this position
    let totalCost;
    if (pos.market_exposure && pos.market_exposure > 0) {
      totalCost = pos.market_exposure;
    } else if (pos.average_price && pos.average_price > 0) {
      totalCost = contracts * pos.average_price;
    } else {
      // Conservative estimate
      totalCost = contracts * 75;
    }

    // Create a synthetic bet record
    const syntheticBet = {
      id: `sync-${pos.ticker}-${Date.now()}`,
      ticker: pos.ticker,
      title: pos.market_title || pos.ticker,
      side: pos.position > 0 ? 'yes' : 'no',
      price: pos.average_price || 0,
      count: contracts,
      filledCount: contracts,
      totalCost: totalCost,
      status: 'open',
      outcome: 'pending',
      timestamp: new Date().toISOString(),
      source: 'kalshi-sync', // Mark as synced from Kalshi
      assetType: getTokenFromTicker(pos.ticker),
      userId: userId
    };

    userBetHistory.push(syntheticBet);
    existingTickers.add(pos.ticker);
    syncedCount++;
    console.log(`🔄 Synced position: ${pos.ticker} | ${contracts} contracts @ ${pos.average_price || '?'}¢ | exposure: $${(totalCost / 100).toFixed(2)}`);
  }

  if (syncedCount > 0) {
    console.log(`✅ Synced ${syncedCount} existing Kalshi positions to bet history`);
  }

  // Save user state if any changes were made
  if ((syncedCount > 0 || cleanedCount > 0) && userId) {
    saveUserState(userId);
  }
}

// Get risk breakdown by market type
// Now accepts optional userState for per-user tracking
function getRiskByType(userState = null) {
  let hourlyRisk = 0;
  let otherRisk = 0;
  const kalshiTickers = new Set();

  // Use user-specific data if provided, otherwise fall back to globals
  const userBetHistory = userState?.betHistory || betHistory;
  const userPortfolio = userState?.portfolio || portfolio;

  // First, build a map of our actual costs from betHistory for each ticker
  const ourCostsByTicker = {};
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of userBetHistory) {
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
  if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
    for (const pos of userPortfolio.positions) {
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
  for (const bet of userBetHistory) {
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

function getCurrentRiskFromPortfolio(userState = null) {
  const { total } = getRiskByType(userState);
  return total;
}

function canPlaceBet(betCostCents, ticker, userState = null) {
  const risk = getRiskByType(userState);
  const type = isHourlyMarket(ticker) ? 'hourly' : 'other';
  return (risk[type] + betCostCents) <= getMaxRisk(type);
}

function getRemainingRiskBudget(ticker, userState = null, userConfig = null) {
  const risk = getRiskByType(userState);
  const type = isHourlyMarket(ticker) ? 'hourly' : 'other';
  return Math.max(0, getMaxRisk(type, userConfig) - risk[type]);
}

// Get total remaining budget (for display)
function getTotalRemainingBudget(userState = null, userConfig = null) {
  const risk = getRiskByType(userState);
  const hourlyRemaining = Math.max(0, getMaxRisk('hourly', userConfig) - risk.hourly);
  const otherRemaining = Math.max(0, getMaxRisk('other', userConfig) - risk.other);
  return hourlyRemaining + otherRemaining;
}

// Extract token symbol from market ticker (e.g., KXBTC-24... -> BTC, KXSOL1H... -> SOL)
function getTokenFromTicker(ticker) {
  if (!ticker) return null;
  // Match patterns like KXBTC, KXETH, KXSOL, etc.
  const match = ticker.match(/KX([A-Z]+)/);
  if (match) return match[1];
  return null;
}

// Get total exposure per token across all positions
function getExposureByToken(userState = null) {
  const tokenExposure = {};
  const kalshiTickers = new Set();

  // Use user-specific data if provided, otherwise fall back to globals
  const userBetHistory = userState?.betHistory || betHistory;
  const userPortfolio = userState?.portfolio || portfolio;

  // First, build a map of our actual costs from betHistory for each ticker
  const ourCostsByTicker = {};
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const bet of userBetHistory) {
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
  if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
    for (const pos of userPortfolio.positions) {
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
  for (const bet of userBetHistory) {
    if (bet.status === 'settled' || bet.status === 'closed' || bet.status === 'simulated') continue;
    const betTime = new Date(bet.timestamp).getTime();
    if (betTime < twoHoursAgo) continue;
    // Skip bets already counted via Kalshi positions or synced from Kalshi
    if (kalshiTickers.has(bet.ticker) || bet.source === 'kalshi-sync') continue;

    const betRisk = bet.totalCost || (bet.count * bet.price) || 0;
    const token = getTokenFromTicker(bet.ticker) || bet.assetType;

    if (token) {
      tokenExposure[token] = (tokenExposure[token] || 0) + betRisk;
    }
  }

  return tokenExposure;
}

// Get max allowed per token (configurable)
function getMaxPerToken(userConfig = null) {
  const cfg = userConfig || config;
  return cfg.riskLimits.maxPerToken || 500; // Default $5.00
}

// HARD CAP validation - ensures bet won't exceed ANY limit before placing
// This is the final safety check to prevent exposure limit violations
function validateBetWontExceedLimits(ticker, betCostCents, userState, userConfig) {
  const currentExposure = getRiskByType(userState);
  const tokenExposure = getExposureByToken(userState);
  const token = getTokenFromTicker(ticker);

  const newTotalExposure = currentExposure.total + betCostCents;
  const newTokenExposure = (tokenExposure[token] || 0) + betCostCents;

  const maxTotal = getMaxTotalRisk(userConfig);
  const maxPerToken = getMaxPerToken(userConfig);

  if (newTotalExposure > maxTotal) {
    return { valid: false, reason: `Would exceed total limit: $${(newTotalExposure/100).toFixed(2)} > $${(maxTotal/100).toFixed(2)}` };
  }
  if (token && newTokenExposure > maxPerToken) {
    return { valid: false, reason: `Would exceed ${token} limit: $${(newTokenExposure/100).toFixed(2)} > $${(maxPerToken/100).toFixed(2)}` };
  }
  return { valid: true };
}

// Get remaining budget for a specific token
function getRemainingTokenBudget(ticker, assetType, userState = null, userConfig = null) {
  const token = getTokenFromTicker(ticker) || assetType;
  if (!token) return getMaxPerToken(userConfig); // If can't determine token, use full budget

  const tokenExposure = getExposureByToken(userState);
  const currentExposure = tokenExposure[token] || 0;
  return Math.max(0, getMaxPerToken(userConfig) - currentExposure);
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
  // Strip query parameters from path (Kalshi expects signature without query params)
  const pathWithoutQuery = path.split('?')[0];
  const message = timestamp + method + pathWithoutQuery;
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

// ============================================
// ORDERBOOK CACHE & FETCHING
// ============================================
const orderbookCache = new Map(); // ticker -> { data, timestamp }
const ORDERBOOK_CACHE_TTL = 5000; // 5 second cache to avoid rate limits

// Candlestick cache for momentum analysis
const candlestickCache = new Map(); // ticker -> { data, timestamp }
const CANDLESTICK_CACHE_TTL = 10000; // 10 second cache

// WebSocket instance (initialized on server start)
let kalshiWs = null;
let wsEnabled = false;

/**
 * Initialize WebSocket connection for real-time data
 */
function initializeWebSocket(userConfig = null) {
  try {
    const cfg = userConfig || config;

    kalshiWs = getKalshiWebSocket({
      apiKeyId: cfg.apiKeyId,
      privateKey: cfg.privateKey,
      onTickerUpdate: (ticker, data) => {
        // Update marketCache with real-time ticker data
        if (marketCache.data) {
          const market = marketCache.data.find(m => m.ticker === ticker);
          if (market) {
            market.yes_ask = data.yesAsk;
            market.yes_bid = data.yesBid;
            market.no_ask = data.noAsk;
            market.no_bid = data.noBid;
            market.last_price = data.lastPrice;
            market.volume = data.volume;
            console.log(`[WS] Updated ${ticker}: YES ${data.yesBid}/${data.yesAsk} NO ${data.noBid}/${data.noAsk}`);
          }
        }
      },
      onOrderbookUpdate: (ticker, data) => {
        // Update orderbook cache with real-time data
        orderbookCache.set(ticker, {
          data: data,
          timestamp: Date.now(),
          source: 'websocket'
        });
      },
      onConnectionChange: (connected) => {
        wsEnabled = connected;
        console.log(`[WS] Connection status: ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);
      },
      onError: (msg, err) => {
        console.error(`[WS] Error: ${msg}`, err || '');
      }
    });

    // Connect to WebSocket
    kalshiWs.connect().then(() => {
      wsEnabled = true;
      console.log('[WS] Kalshi WebSocket initialized');
    }).catch(err => {
      console.log('[WS] Could not connect, falling back to REST:', err.message);
      wsEnabled = false;
    });

  } catch (err) {
    console.log('[WS] WebSocket initialization failed:', err.message);
    wsEnabled = false;
  }
}

/**
 * Fetch orderbook for a market (with caching)
 * Returns bid/ask depth to understand true cost of entry
 */
async function fetchOrderbook(ticker, userConfig = null) {
  const now = Date.now();
  const cached = orderbookCache.get(ticker);

  // Return cached data if fresh
  if (cached && (now - cached.timestamp) < ORDERBOOK_CACHE_TTL) {
    return cached.data;
  }

  // Try WebSocket cache first (most up-to-date)
  if (wsEnabled && kalshiWs) {
    const wsData = kalshiWs.getOrderbook(ticker);
    if (wsData && (now - wsData.timestamp) < ORDERBOOK_CACHE_TTL) {
      orderbookCache.set(ticker, { data: wsData, timestamp: now, source: 'websocket' });
      return wsData;
    }
  }

  // Fall back to REST API
  try {
    const cfg = userConfig || config;
    const response = await kalshiRequest('GET', `/markets/${ticker}/orderbook`, null, cfg);

    // Parse orderbook response
    const orderbook = {
      ticker,
      // YES side
      bestYesBid: response.yes?.bid?.[0]?.price || 0,
      bestYesAsk: response.yes?.ask?.[0]?.price || 0,
      yesSpread: 0,
      yesLiquidityAtBest: response.yes?.ask?.[0]?.count || 0,
      yesTotalDepth: (response.yes?.ask || []).reduce((sum, o) => sum + (o.count || 0), 0),
      // NO side
      bestNoBid: response.no?.bid?.[0]?.price || 0,
      bestNoAsk: response.no?.ask?.[0]?.price || 0,
      noSpread: 0,
      noLiquidityAtBest: response.no?.ask?.[0]?.count || 0,
      noTotalDepth: (response.no?.ask || []).reduce((sum, o) => sum + (o.count || 0), 0),
      // Raw data
      raw: response,
      timestamp: now,
      source: 'rest'
    };

    // Calculate spreads
    if (orderbook.bestYesAsk && orderbook.bestYesBid) {
      orderbook.yesSpread = orderbook.bestYesAsk - orderbook.bestYesBid;
    }
    if (orderbook.bestNoAsk && orderbook.bestNoBid) {
      orderbook.noSpread = orderbook.bestNoAsk - orderbook.bestNoBid;
    }

    // Cache the result
    orderbookCache.set(ticker, { data: orderbook, timestamp: now, source: 'rest' });
    return orderbook;

  } catch (error) {
    console.log(`[Orderbook] Error fetching ${ticker}:`, error.message);
    // Return default values if fetch fails
    return {
      ticker,
      bestYesBid: 0,
      bestYesAsk: 0,
      yesSpread: 100, // Assume wide spread if unknown (conservative)
      yesLiquidityAtBest: 0,
      yesTotalDepth: 0,
      bestNoBid: 0,
      bestNoAsk: 0,
      noSpread: 100,
      noLiquidityAtBest: 0,
      noTotalDepth: 0,
      timestamp: now,
      source: 'default'
    };
  }
}

/**
 * Get cached orderbook (doesn't fetch if not cached)
 */
function getCachedOrderbook(ticker) {
  const cached = orderbookCache.get(ticker);
  if (cached && (Date.now() - cached.timestamp) < ORDERBOOK_CACHE_TTL * 2) {
    return cached.data;
  }
  return null;
}

/**
 * Fetch candlestick data for momentum analysis
 * Returns OHLCV data for the specified period
 */
async function fetchCandlesticks(ticker, periodMinutes = 1, count = 15, userConfig = null) {
  const now = Date.now();
  const cacheKey = `${ticker}_${periodMinutes}`;
  const cached = candlestickCache.get(cacheKey);

  // Return cached data if fresh
  if (cached && (now - cached.timestamp) < CANDLESTICK_CACHE_TTL) {
    return cached.data;
  }

  try {
    const cfg = userConfig || config;

    // Build period interval string (1m, 5m, 15m, etc.)
    const periodStr = `${periodMinutes}m`;

    // Fetch candlesticks from Kalshi API
    const response = await kalshiRequest(
      'GET',
      `/markets/${ticker}/candlesticks?period_interval=${periodStr}&limit=${count}`,
      null,
      cfg
    );

    const candles = (response.candlesticks || []).map(c => ({
      open: c.open_price || c.open || 0,
      high: c.high_price || c.high || 0,
      low: c.low_price || c.low || 0,
      close: c.close_price || c.close || 0,
      volume: c.volume || 0,
      timestamp: new Date(c.end_period_ts || c.timestamp).getTime()
    }));

    const result = {
      ticker,
      period: periodMinutes,
      candles,
      timestamp: now
    };

    // Cache the result
    candlestickCache.set(cacheKey, { data: result, timestamp: now });
    return result;

  } catch (error) {
    console.log(`[Candles] Error fetching ${ticker}:`, error.message);
    // Return empty data if fetch fails
    return {
      ticker,
      period: periodMinutes,
      candles: [],
      timestamp: now
    };
  }
}

/**
 * Analyze market momentum from candlestick data
 * Returns momentum direction, strength, and confirmation status
 */
function analyzeMarketMomentum(candleData, currentBetSide = null) {
  const candles = candleData?.candles || [];

  if (candles.length < 3) {
    return {
      confirmed: false,
      direction: 'unknown',
      strength: 0,
      reason: 'Insufficient candle data'
    };
  }

  // Analyze last N candles (default 5)
  const lookback = Math.min(5, candles.length);
  const recentCandles = candles.slice(-lookback);

  // Count up/down candles
  let upCandles = 0;
  let downCandles = 0;
  let totalVolume = 0;
  let upVolume = 0;
  let downVolume = 0;

  for (const candle of recentCandles) {
    const change = candle.close - candle.open;
    totalVolume += candle.volume || 0;

    if (change > 0) {
      upCandles++;
      upVolume += candle.volume || 0;
    } else if (change < 0) {
      downCandles++;
      downVolume += candle.volume || 0;
    }
  }

  // Determine direction
  let direction = 'neutral';
  let strength = 0;

  if (upCandles > downCandles + 1) {
    direction = 'up';
    strength = (upCandles - downCandles) / lookback;
    // Volume confirmation
    if (totalVolume > 0 && upVolume > downVolume * 1.2) {
      strength += 0.2;
    }
  } else if (downCandles > upCandles + 1) {
    direction = 'down';
    strength = (downCandles - upCandles) / lookback;
    // Volume confirmation
    if (totalVolume > 0 && downVolume > upVolume * 1.2) {
      strength += 0.2;
    }
  }

  // Clamp strength between 0 and 1
  strength = Math.max(0, Math.min(1, strength));

  // Check if momentum aligns with bet side
  let confirmed = false;
  let alignment = 'neutral';

  if (currentBetSide) {
    const side = currentBetSide.toUpperCase();
    // For YES bet on "up" markets, we want upward momentum
    // For NO bet on "up" markets, we want downward momentum
    if (side === 'YES' && direction === 'up') {
      confirmed = true;
      alignment = 'aligned';
    } else if (side === 'NO' && direction === 'down') {
      confirmed = true;
      alignment = 'aligned';
    } else if (side === 'YES' && direction === 'down') {
      alignment = 'opposed';
    } else if (side === 'NO' && direction === 'up') {
      alignment = 'opposed';
    }
  }

  return {
    confirmed,
    direction,
    strength,
    alignment,
    upCandles,
    downCandles,
    totalVolume,
    reason: `${upCandles}/${lookback} up candles, ${direction} momentum`
  };
}

/**
 * Apply momentum adjustment to edge calculation
 */
function applyMomentumAdjustment(edge, momentum, momentumSettings) {
  if (!momentumSettings?.enabled) return edge;

  let adjustment = 0;

  if (momentum.alignment === 'aligned' && momentum.strength > 0.3) {
    // Momentum confirms our bet direction - add bonus
    adjustment = momentumSettings.alignmentBonus || 2;
    adjustment *= momentum.strength; // Scale by strength
  } else if (momentum.alignment === 'opposed' && momentum.strength > 0.3) {
    // Momentum opposes our bet - apply penalty
    adjustment = momentumSettings.oppositionPenalty || -3;
    adjustment *= momentum.strength; // Scale by strength
  }

  return edge + adjustment;
}

// ============================================
// SMART TAKE-PROFIT EVALUATION
// ============================================
// Philosophy: Solidify gains when risk of losing them is high
// Factors: Time urgency, momentum reversal, profit-at-risk, volatility

/**
 * Calculate urgency score for taking profit
 * Higher score = more urgent to exit
 * Returns 0-100 urgency score
 */
function calculateTakeProfitUrgency(position, market, momentum, profitPercent) {
  let urgencyScore = 0;
  const reasons = [];

  // 1. TIME URGENCY (0-30 points)
  // As expiry approaches, urgency increases dramatically
  if (market) {
    const timeRemaining = market.timeRemaining || (market.close_time ? new Date(market.close_time).getTime() - Date.now() : null);
    if (timeRemaining) {
      const minutesLeft = timeRemaining / 60000;
      if (minutesLeft < 2) {
        urgencyScore += 30;
        reasons.push(`⏰ CRITICAL: Only ${minutesLeft.toFixed(1)}min left`);
      } else if (minutesLeft < 5) {
        urgencyScore += 20;
        reasons.push(`⏰ Urgent: ${minutesLeft.toFixed(1)}min left`);
      } else if (minutesLeft < 8) {
        urgencyScore += 10;
        reasons.push(`⏰ ${minutesLeft.toFixed(1)}min remaining`);
      }
    }
  }

  // 2. MOMENTUM REVERSAL (0-25 points)
  // If momentum is turning against our position, urgency increases
  if (momentum && momentum.direction !== 'neutral') {
    const side = position.side || (position.position > 0 ? 'yes' : 'no');
    let isAgainst = false;

    // For YES positions on "above" markets, DOWN momentum is bad
    // For NO positions on "above" markets, UP momentum is bad
    if (side === 'yes' && momentum.direction === 'down') {
      isAgainst = true;
    } else if (side === 'no' && momentum.direction === 'up') {
      isAgainst = true;
    }

    if (isAgainst) {
      const momentumPenalty = Math.round(momentum.strength * 25);
      urgencyScore += momentumPenalty;
      reasons.push(`📉 Momentum against us: ${momentum.direction} (${(momentum.strength*100).toFixed(0)}% strength)`);
    }
  }

  // 3. PROFIT-AT-RISK (0-25 points)
  // Higher profits are worth protecting more aggressively
  if (profitPercent >= 50) {
    urgencyScore += 25;
    reasons.push(`💰 Large profit at risk: ${profitPercent.toFixed(1)}%`);
  } else if (profitPercent >= 30) {
    urgencyScore += 15;
    reasons.push(`💰 Good profit at risk: ${profitPercent.toFixed(1)}%`);
  } else if (profitPercent >= 15) {
    urgencyScore += 8;
    reasons.push(`💰 Moderate profit: ${profitPercent.toFixed(1)}%`);
  }

  // 4. PRICE PROXIMITY TO STRIKE (0-20 points)
  // If current price is close to strike, outcome is uncertain
  if (market) {
    const parsed = parseMarket(market);
    if (parsed && parsed.strikePrice) {
      const token = parsed.cryptoType;
      const currentPrice = cryptoPrices[token]?.price || 0;
      if (currentPrice > 0) {
        const pctFromStrike = Math.abs((currentPrice - parsed.strikePrice) / parsed.strikePrice * 100);
        if (pctFromStrike < 0.1) {
          urgencyScore += 20;
          reasons.push(`⚠️ Price very close to strike (${pctFromStrike.toFixed(2)}%)`);
        } else if (pctFromStrike < 0.3) {
          urgencyScore += 12;
          reasons.push(`⚠️ Price near strike (${pctFromStrike.toFixed(2)}%)`);
        } else if (pctFromStrike < 0.5) {
          urgencyScore += 5;
          reasons.push(`Price ${pctFromStrike.toFixed(2)}% from strike`);
        }
      }
    }
  }

  return { urgencyScore, reasons };
}

/**
 * Calculate dynamic stop-loss threshold using empirical data
 * Uses distance from strike, time remaining, and volatility to make smarter exit decisions
 * @returns {number} Stop-loss threshold (e.g., -15 means exit at -15% loss)
 */
function calculateSmartStopLoss(position, market, profitPercent, userConfig) {
  const cfg = userConfig || config;
  // Use activeMonitoring settings, fall back to limitOrderSettings for backwards compatibility
  const defaultStopLoss = cfg.activeMonitoring?.stopLossThreshold || cfg.limitOrderSettings?.stopLoss?.threshold || -40;

  // Need market data for smart decisions
  if (!market || !market.close_time) {
    return defaultStopLoss;
  }

  const token = getTokenFromTicker(position.ticker);
  const timeRemaining = (new Date(market.close_time).getTime() - Date.now()) / 60000; // minutes

  // Calculate distance from strike
  const parsed = parseMarket(market);
  const strikePrice = parsed?.strikePrice || 0;
  const currentPrice = cryptoPrices[token]?.price;

  if (!currentPrice || !strikePrice) {
    return defaultStopLoss;
  }

  const pctFromStrike = Math.abs(currentPrice - strikePrice) / strikePrice * 100;

  // Get empirical data
  const empirical = lookupEmpiricalWinRate(pctFromStrike);
  const regime = detectVolatilityRegime(token);

  // CRITICAL: Determine if our position is favored or underdog
  // YES bet wins if price ends ABOVE strike
  // NO bet wins if price ends BELOW strike
  const positionSide = position.side || (position.position > 0 ? 'yes' : 'no');
  const priceAboveStrike = currentPrice > strikePrice;

  // Are we the favored side?
  const positionIsFavored = (positionSide === 'yes' && priceAboveStrike) ||
                            (positionSide === 'no' && !priceAboveStrike);

  // Use the CORRECT win rate based on whether we're favored or underdog
  // If we're the underdog (losing side), use surpriseRate as our recovery chance
  const baseRecoveryChance = positionIsFavored ? empirical.winRate : empirical.surpriseRate;
  const recoveryChance = Math.min(99.5, baseRecoveryChance * (regime.multiplier || 1.0));

  // Log for debugging
  if (profitPercent < 0) {
    console.log(`[SmartStopLoss] ${position.ticker}: side=${positionSide}, price ${priceAboveStrike ? 'ABOVE' : 'BELOW'} strike, ` +
                `favored=${positionIsFavored}, recovery=${recoveryChance.toFixed(1)}% (${positionIsFavored ? 'favored' : 'underdog'})`);
  }

  // Dynamic stop-loss based on recovery probability and time
  let stopLossThreshold = defaultStopLoss;

  // Coin-flip territory: very close to strike with little time
  const coinFlipThreshold = learnedParams?.byToken?.[token]?.coinFlipThreshold || 0.1;
  if (pctFromStrike < coinFlipThreshold && timeRemaining < 3) {
    // Exit anything unprofitable - it's a coin flip
    stopLossThreshold = Math.max(stopLossThreshold, -5);
    console.log(`[SmartStopLoss] ${position.ticker}: Coin-flip territory (${pctFromStrike.toFixed(3)}% from strike, ${timeRemaining.toFixed(1)}min left) → threshold: ${stopLossThreshold}%`);
  }
  // Low recovery chance with limited time
  else if (recoveryChance < 55 && timeRemaining < 5) {
    stopLossThreshold = Math.max(stopLossThreshold, -15);
    console.log(`[SmartStopLoss] ${position.ticker}: Low recovery (${recoveryChance.toFixed(0)}%) + limited time (${timeRemaining.toFixed(1)}min) → threshold: ${stopLossThreshold}%`);
  }
  // Very low recovery chance regardless of time
  else if (recoveryChance < 45) {
    stopLossThreshold = Math.max(stopLossThreshold, -10);
    console.log(`[SmartStopLoss] ${position.ticker}: Very low recovery (${recoveryChance.toFixed(0)}%) → threshold: ${stopLossThreshold}%`);
  }
  // Near expiry with any loss
  else if (timeRemaining < 2 && profitPercent < -10) {
    stopLossThreshold = Math.max(stopLossThreshold, -8);
    console.log(`[SmartStopLoss] ${position.ticker}: Near expiry (${timeRemaining.toFixed(1)}min) at ${profitPercent.toFixed(1)}% → threshold: ${stopLossThreshold}%`);
  }

  return stopLossThreshold;
}

/**
 * Smart take-profit evaluation
 * Considers multiple factors to decide when to lock in gains
 */
async function evaluateTakeProfit(position, userConfig = null) {
  const cfg = userConfig || config;
  const settings = cfg.takeProfitSettings || {};
  const limitSettings = cfg.limitOrderSettings || {};

  // Don't return early - always evaluate stop-loss even if take-profit is disabled
  // Stop-loss via limit orders doesn't work reliably (orders don't fill on fast crashes)
  // So we need active monitoring as backup

  const ticker = position.ticker;
  const contracts = Math.abs(position.position || 0);
  // Kalshi sometimes returns undefined for average_price - fall back to market_exposure / contracts
  let avgCost = position.average_price || 0; // In cents
  if (avgCost === 0 && position.market_exposure && contracts > 0) {
    avgCost = Math.round(position.market_exposure / contracts);
    console.log(`[TakeProfit] ${ticker}: Using market_exposure fallback for avgCost: ${avgCost}¢`);
  }

  if (contracts === 0 || avgCost === 0) {
    return { shouldExit: false, reason: 'No valid position data (missing avg_price and market_exposure)' };
  }

  // Fetch current orderbook for exit price
  const orderbook = await fetchOrderbook(ticker, cfg);

  // Determine current bid (what we can sell for)
  const side = position.side || (position.position > 0 ? 'yes' : 'no');
  const currentBid = side === 'yes' ? orderbook.bestYesBid : orderbook.bestNoBid;
  const spread = side === 'yes' ? orderbook.yesSpread : orderbook.noSpread;

  if (!currentBid || currentBid <= 0) {
    return { shouldExit: false, reason: 'No valid bid price' };
  }

  // Calculate current profit WITH KALSHI FEES
  // Kalshi charges taker fee on sells: ceil(0.07 × contracts × price × (1 - price)), capped at 2¢/contract
  const sellPrice = currentBid / 100; // Convert to dollars for fee calc
  const sellFeePerContract = Math.min(0.02, Math.ceil(0.07 * sellPrice * (1 - sellPrice) * 100) / 100);
  const totalSellFee = Math.round(sellFeePerContract * contracts * 100); // In cents

  const grossProfit = (currentBid - avgCost) * contracts; // In cents
  const spreadCost = Math.round((spread / 2) * contracts); // Half-spread cost estimate
  const netProfit = grossProfit - totalSellFee - spreadCost; // INCLUDE SELL FEE!

  // True profit percent after all fees
  const totalCostWithFees = avgCost * contracts; // Entry cost (fee already paid)
  const netProceedsAfterSell = (currentBid * contracts) - totalSellFee - spreadCost;
  const profitPercent = ((netProceedsAfterSell - totalCostWithFees) / totalCostWithFees) * 100;

  // Get market for stop-loss calculations (needed before stop-loss check)
  const marketsForStopLoss = marketCache.data || [];
  const marketForStopLoss = marketsForStopLoss.find(m => m.ticker === ticker);

  // ============================================
  // STOP-LOSS CHECK - Cut losses before they get worse
  // Uses smart empirical-based threshold calculation
  // ============================================
  const stopLossPercent = calculateSmartStopLoss(position, marketForStopLoss, profitPercent, cfg);

  if (profitPercent <= stopLossPercent) {
    // Loss exceeds threshold - cut it now
    return {
      shouldExit: true,
      reason: `🛑 STOP-LOSS: Position at ${profitPercent.toFixed(1)}% (smart threshold: ${stopLossPercent}%)`,
      urgencyScore: 100,
      urgencyReasons: [`Stop-loss triggered at ${profitPercent.toFixed(1)}% (threshold: ${stopLossPercent}%)`],
      analysis: { profitPercent, netProfit, currentBid, avgCost, totalSellFee, spreadCost, stopLossTriggered: true, smartThreshold: stopLossPercent }
    };
  }

  // Time-based stop-loss: If <3 min left AND losing badly (>25%), cut losses
  // This is a backup in case smart stop-loss didn't trigger
  if (marketForStopLoss && profitPercent < -25) {
    const timeRemaining = marketForStopLoss.close_time ? new Date(marketForStopLoss.close_time).getTime() - Date.now() : null;
    if (timeRemaining && timeRemaining < 3 * 60 * 1000) {
      return {
        shouldExit: true,
        reason: `🛑 TIME STOP-LOSS: ${profitPercent.toFixed(1)}% loss with <3min left - cutting losses`,
        urgencyScore: 90,
        urgencyReasons: [`Time-critical stop-loss: ${profitPercent.toFixed(1)}% loss, ${(timeRemaining/60000).toFixed(1)}min left`],
        analysis: { profitPercent, netProfit, currentBid, avgCost, totalSellFee, spreadCost, timeRemaining, stopLossTriggered: true }
      };
    }
  }

  // ============================================
  // COIN-FLIP PREVENTION - Exit when price is at strike near expiry
  // Uses DATA-DRIVEN LEARNED THRESHOLDS when available
  // ============================================
  // If price is very close to strike AND time is running out, exit to avoid gambling
  if (marketForStopLoss) {
    const parsed = parseMarket(marketForStopLoss);
    if (parsed && parsed.strikePrice) {
      const token = parsed.cryptoType;
      const currentPrice = cryptoPrices[token]?.price || 0;
      if (currentPrice > 0) {
        const pctFromStrike = Math.abs((currentPrice - parsed.strikePrice) / parsed.strikePrice * 100);
        const timeRemaining = marketForStopLoss.close_time ? new Date(marketForStopLoss.close_time).getTime() - Date.now() : null;

        // Get learned threshold for this token (falls back to 0.15 if not learned)
        const coinFlipThreshold = getCoinFlipThreshold(token);
        const nearStrikeThreshold = learnedParams.thresholds.nearStrikeExit || 0.25;
        const timeBuffer = learnedParams.thresholds.timeBuffer || 180000; // 3 minutes default

        // Log threshold being used (for debugging)
        if (pctFromStrike < nearStrikeThreshold && timeRemaining && timeRemaining < timeBuffer) {
          console.log(`[TakeProfit] ${ticker}: Using learned threshold ${coinFlipThreshold}% for ${token} (sample size: ${learnedParams.byToken[token]?.sampleSize || 0})`);
        }

        // If within learned coin-flip threshold AND <3 min left - this is a coin flip, exit
        if (pctFromStrike < coinFlipThreshold && timeRemaining && timeRemaining < timeBuffer) {
          console.log(`[TakeProfit] ${ticker}: COIN-FLIP PREVENTION - price ${pctFromStrike.toFixed(3)}% from strike with ${(timeRemaining/60000).toFixed(1)}min left (threshold: ${coinFlipThreshold}%)`);
          return {
            shouldExit: true,
            reason: `🎲 COIN-FLIP EXIT: Price only ${pctFromStrike.toFixed(2)}% from strike with <3min left - avoiding gamble (learned threshold: ${coinFlipThreshold}%)`,
            urgencyScore: 95,
            urgencyReasons: [`Coin-flip prevention: ${pctFromStrike.toFixed(2)}% from strike, ${(timeRemaining/60000).toFixed(1)}min left`],
            analysis: { profitPercent, netProfit, currentBid, avgCost, pctFromStrike, timeRemaining, coinFlipExit: true, learnedThreshold: coinFlipThreshold }
          };
        }

        // Slightly wider threshold with less time - nearStrikeThreshold from strike AND <2 min
        if (pctFromStrike < nearStrikeThreshold && timeRemaining && timeRemaining < 2 * 60 * 1000) {
          console.log(`[TakeProfit] ${ticker}: COIN-FLIP PREVENTION - price ${pctFromStrike.toFixed(3)}% from strike with ${(timeRemaining/60000).toFixed(1)}min left (near-strike threshold: ${nearStrikeThreshold}%)`);
          return {
            shouldExit: true,
            reason: `🎲 COIN-FLIP EXIT: Price ${pctFromStrike.toFixed(2)}% from strike with <2min left - too risky (near-strike threshold: ${nearStrikeThreshold}%)`,
            urgencyScore: 95,
            urgencyReasons: [`Coin-flip prevention: ${pctFromStrike.toFixed(2)}% from strike, ${(timeRemaining/60000).toFixed(1)}min left`],
            analysis: { profitPercent, netProfit, currentBid, avgCost, pctFromStrike, timeRemaining, coinFlipExit: true, learnedThreshold: nearStrikeThreshold }
          };
        }
      }
    }
  }

  // NOTE: Stop-loss via Kalshi limit orders is NOT reliable - limit orders only
  // execute at the specified price or better. If the market crashes through the
  // stop-loss price, the order sits unfilled. So we still need active monitoring
  // as a backup to execute market sells when stop-loss triggers.

  // If take-profit is disabled, we've already checked stop-loss above.
  // Skip the rest of the take-profit logic and return hold status.
  if (!settings.enabled) {
    return { shouldExit: false, reason: 'Position held (take-profit disabled, stop-loss not triggered)' };
  }

  // Get market data for analysis
  const markets = marketCache.data || [];
  const market = markets.find(m => m.ticker === ticker);

  if (!market) {
    console.log(`[TakeProfit] ${ticker}: Market not found in cache (${markets.length} markets cached)`);
  }

  // Get momentum data
  let momentum = null;
  try {
    const candleData = await fetchCandlesticks(ticker, 1, 10, cfg);
    if (candleData?.candles?.length >= 3) {
      momentum = analyzeMarketMomentum(candleData);
    }
  } catch (e) {
    // Continue without momentum
  }

  // Calculate urgency score
  const { urgencyScore, reasons } = calculateTakeProfitUrgency(position, market, momentum, profitPercent);

  // Get our probability estimate for this market
  let probWin = 0.5; // Default if we can't calculate
  let parsed = null;
  let analysis = null;

  if (market) {
    parsed = parseMarket(market);
    analysis = analyzeCryptoMarket(parsed, orderbook, momentum, cfg);
    if (analysis) {
      probWin = side === 'yes'
        ? analysis.probYesWins / 100
        : analysis.probNoWins / 100;
    }
  }

  // Calculate Expected Values (with proper fee accounting)
  const totalCostPaid = avgCost * contracts; // What we paid to enter (sunk cost)

  // EV(exit) = net profit from selling now (after fees)
  const evExit = netProfit;

  // EV(hold) = P(win) * payout - P(lose) * loss
  // If we WIN: we get $1 per contract (no sell fee, market settles)
  // If we LOSE: we lose our entire cost (already paid)
  const payoutIfWin = contracts * 100; // $1 per contract in cents
  const lossIfLose = totalCostPaid; // We lose what we paid

  // Note: Entry fee is sunk cost - don't double count it
  const evHold = (probWin * payoutIfWin) - ((1 - probWin) * lossIfLose);

  // Apply confidence factor (model uncertainty discount)
  const confidenceFactor = settings.confidenceFactor || 0.85;
  const adjustedEvHold = evHold * confidenceFactor;

  // ============================================
  // SMART EXIT DECISION LOGIC
  // ============================================
  // We exit if ANY of these conditions are met:

  let shouldExit = false;
  let exitReason = '';

  // Base profit threshold (can be lowered by urgency)
  const baseMinProfit = settings.minProfitPercent || 10;

  // Get active monitoring settings
  const activeMonitoring = cfg.activeMonitoring || {};

  // 1. EASY PROFIT - Take "free money" on high-confidence positions
  // If we bought at 75-85¢ (high implied probability), take smaller profits
  // BUT: Don't sell too early - wait for time pressure OR higher profit to justify fees
  // Kalshi fees (~2-3¢ round trip) eat into small profits significantly
  const easyProfitEnabled = activeMonitoring.easyProfitEnabled !== false; // Default true
  const easyProfitMinPrice = activeMonitoring.easyProfitMinPrice || 75;   // 75¢ = 75% implied prob
  const easyProfitThreshold = activeMonitoring.easyProfitThreshold || 12; // Take 12%+ profit (accounts for fees)
  const easyProfitEarlyThreshold = 18; // If taking early (>5min left), need higher profit to justify fees

  if (easyProfitEnabled && avgCost >= easyProfitMinPrice) {
    const timeRemainingMs = marketForStopLoss?.close_time
      ? new Date(marketForStopLoss.close_time).getTime() - Date.now()
      : null;
    const timeRemainingMin = timeRemainingMs ? timeRemainingMs / 60000 : null;

    // Two modes:
    // A) Near expiry (<5 min): Take smaller profits (12%+) - time pressure justifies it
    // B) Early (>5 min): Need higher profit (18%+) to justify fees and opportunity cost
    if (timeRemainingMin !== null && timeRemainingMin < 5 && profitPercent >= easyProfitThreshold) {
      shouldExit = true;
      exitReason = `EASY PROFIT: High-confidence (${avgCost}¢) at +${profitPercent.toFixed(1)}% with ${timeRemainingMin.toFixed(1)}min left - securing gains`;
    } else if (profitPercent >= easyProfitEarlyThreshold) {
      // Higher profit justifies early exit even with fees
      shouldExit = true;
      exitReason = `EASY PROFIT: High-confidence (${avgCost}¢) at +${profitPercent.toFixed(1)}% - profit high enough to justify fees`;
    }
  }

  // 2. URGENCY-ADJUSTED THRESHOLD
  // Higher urgency = lower profit threshold required
  // At 50+ urgency, we'll take profits as low as 5%
  // At 80+ urgency, we'll take any profit above 3%
  const urgencyAdjustedMinProfit = Math.max(3, baseMinProfit - (urgencyScore / 5));

  if (!shouldExit && profitPercent >= urgencyAdjustedMinProfit && urgencyScore >= 40) {
    shouldExit = true;
    exitReason = `HIGH URGENCY (${urgencyScore}): Lock in ${profitPercent.toFixed(1)}% profit`;
  }

  // 4. CLASSIC EV COMPARISON (when profit meets base threshold)
  else if (!shouldExit && profitPercent >= baseMinProfit && evExit > adjustedEvHold) {
    shouldExit = true;
    exitReason = `EV exit (${evExit.toFixed(0)}¢) > EV hold (${adjustedEvHold.toFixed(0)}¢)`;
  }

  // 5. MOMENTUM REVERSAL OVERRIDE
  // If momentum is strongly against us and we have any decent profit, exit
  if (!shouldExit && momentum && momentum.strength > 0.5 && profitPercent >= 8) {
    const momentumAgainst = (side === 'yes' && momentum.direction === 'down') ||
                            (side === 'no' && momentum.direction === 'up');
    if (momentumAgainst) {
      shouldExit = true;
      exitReason = `MOMENTUM REVERSAL: ${momentum.direction} momentum, locking in ${profitPercent.toFixed(1)}%`;
    }
  }

  // 6. TIME CRITICAL OVERRIDE
  // With less than 3 minutes left and profit > 5%, consider exit
  // BUT: If probability is high (>75%), let it ride to expiration - expected payout is better
  if (market && !shouldExit) {
    const timeRemaining = market.close_time ? new Date(market.close_time).getTime() - Date.now() : null;
    if (timeRemaining && timeRemaining < 3 * 60 * 1000 && profitPercent >= 5) {
      // High probability? Let it ride - EV of holding to settlement is better
      if (probWin >= 0.75) {
        // Don't exit - expected value of holding is higher
        console.log(`[TakeProfit] ${ticker}: High prob (${(probWin*100).toFixed(0)}%) with <3min left - letting it ride`);
      } else if (probWin >= 0.60 && evHold > evExit * 1.5) {
        // Medium-high prob with much better EV hold - also let ride
        console.log(`[TakeProfit] ${ticker}: ${(probWin*100).toFixed(0)}% prob, EV hold (${evHold.toFixed(0)}¢) >> EV exit (${evExit.toFixed(0)}¢) - holding`);
      } else {
        // Lower probability or EV doesn't favor holding - take the profit
        shouldExit = true;
        exitReason = `TIME CRITICAL: <3min left, ${(probWin*100).toFixed(0)}% prob, securing ${profitPercent.toFixed(1)}% profit`;
      }
    }
  }

  // 7. BIG WINNER PROTECTION
  // If profit is 30%+, we protect it more aggressively
  if (!shouldExit && profitPercent >= 30) {
    // Take profit if EV hold isn't significantly better
    if (evExit > adjustedEvHold * 0.9) {
      shouldExit = true;
      exitReason = `BIG WINNER: Protecting ${profitPercent.toFixed(1)}% gain`;
    }
  }

  // Build final reason string
  const finalReason = shouldExit
    ? `✅ EXIT: ${exitReason}`
    : `⏳ HOLD: Profit ${profitPercent.toFixed(1)}%, urgency ${urgencyScore}, waiting for better exit`;

  return {
    shouldExit,
    reason: finalReason,
    urgencyScore,
    urgencyReasons: reasons,
    analysis: {
      ticker,
      side,
      contracts,
      avgCost,
      currentBid,
      spread,
      profitPercent,
      netProfit,
      grossProfit,
      // Fee breakdown
      totalSellFee,
      spreadCost,
      feesTotal: totalSellFee + spreadCost,
      // EV analysis
      probWin: probWin * 100,
      evExit,
      evHold,
      adjustedEvHold,
      confidenceFactor,
      // Urgency
      urgencyScore,
      urgencyAdjustedMinProfit,
      baseMinProfit,
      momentum: momentum ? {
        direction: momentum.direction,
        strength: momentum.strength
      } : null,
      timeRemaining: market?.close_time ? new Date(market.close_time).getTime() - Date.now() : null
    }
  };
}

/**
 * Execute take-profit exit (sell position)
 */
async function executeTakeProfitExit(position, analysis, userConfig = null) {
  const cfg = userConfig || config;
  const settings = cfg.takeProfitSettings || {};

  // Safety check - don't execute if logOnly mode
  if (settings.logOnly || !settings.autoExecute) {
    console.log(`\n💰 [TakeProfit] RECOMMENDATION (not executing - logOnly mode):`);
    console.log(`   📊 ${position.ticker}`);
    console.log(`   💵 Profit: ${analysis.profitPercent.toFixed(1)}% | Net: $${(analysis.netProfit/100).toFixed(2)}`);
    console.log(`   📈 Urgency: ${analysis.urgencyScore}/100`);
    console.log(`   📉 EV exit: ${analysis.evExit.toFixed(0)}¢ vs EV hold: ${analysis.evHold.toFixed(0)}¢`);
    if (analysis.momentum) {
      console.log(`   🔄 Momentum: ${analysis.momentum.direction} (${(analysis.momentum.strength*100).toFixed(0)}%)`);
    }
    return { executed: false, reason: 'Log only mode - would have exited' };
  }

  try {
    const ticker = position.ticker;
    const contracts = Math.abs(position.position || 0);
    const side = position.side || (position.position > 0 ? 'yes' : 'no');

    // Place sell order at current bid (or slightly below for faster fill)
    const sellPrice = Math.max(1, analysis.currentBid - 1); // 1 cent below bid for faster fill

    const orderRequest = {
      ticker,
      action: 'sell',
      side,
      type: 'limit',
      count: contracts
    };

    // Set price based on side
    if (side === 'yes') {
      orderRequest.yes_price = sellPrice;
    } else {
      orderRequest.no_price = sellPrice;
    }

    console.log(`\n💰 [TakeProfit] EXECUTING EXIT:`);
    console.log(`   📊 ${ticker} | ${contracts} contracts @ ${sellPrice}¢`);
    console.log(`   💵 Locking in ${analysis.profitPercent.toFixed(1)}% profit ($${(analysis.netProfit/100).toFixed(2)})`);
    console.log(`   📈 Urgency score: ${analysis.urgencyScore}/100`);
    console.log(`   Order: ${JSON.stringify(orderRequest)}`);

    const response = await kalshiRequest('POST', '/portfolio/orders', orderRequest, cfg);

    if (response.order) {
      const filledCount = response.order.filled_count || 0;
      const fillPrice = response.order.average_fill_price || sellPrice;

      console.log(`   ✅ Order ${response.order.order_id}: ${filledCount}/${contracts} filled @ ${fillPrice}¢`);

      if (filledCount > 0) {
        const actualProfit = (fillPrice - analysis.avgCost) * filledCount;
        console.log(`   💵 Realized profit: $${(actualProfit/100).toFixed(2)}`);
      }

      return {
        executed: true,
        orderId: response.order.order_id,
        filledCount,
        fillPrice,
        realizedProfit: (response.order.average_fill_price - analysis.avgCost) * filledCount,
        reason: filledCount === contracts ? 'Fully filled' : `Partial fill: ${filledCount}/${contracts}`
      };
    }

    console.log(`   ⚠️ No order in response`);
    return { executed: false, reason: 'No order in response' };

  } catch (error) {
    console.error(`   ❌ Exit failed: ${error.message}`);
    return { executed: false, reason: error.message };
  }
}

/**
 * Scan all positions for take-profit opportunities
 * Smart scanning: evaluates all positions and executes optimal exits
 */
async function scanTakeProfitOpportunities(userConfig = null, userPortfolio = null) {
  const cfg = userConfig || config;
  const pf = userPortfolio || portfolio;
  const settings = cfg.takeProfitSettings || {};
  const limitSettings = cfg.limitOrderSettings || {};

  // Don't return early - always scan for stop-loss even if take-profit is disabled
  // Limit orders don't reliably execute on fast market crashes, so we need active monitoring

  const positions = pf.positions || [];
  if (positions.length === 0) return [];

  const opportunities = [];
  const positionStatuses = [];

  for (const position of positions) {
    if (Math.abs(position.position || 0) === 0) continue;

    try {
      const evaluation = await evaluateTakeProfit(position, cfg);
      const analysis = evaluation.analysis || {};

      // Track all position statuses for logging
      positionStatuses.push({
        ticker: position.ticker,
        profit: analysis.profitPercent?.toFixed(1) || '?',
        urgency: analysis.urgencyScore || 0,
        shouldExit: evaluation.shouldExit,
        reason: evaluation.reason
      });

      if (evaluation.shouldExit) {
        opportunities.push({
          position,
          evaluation,
          timestamp: new Date().toISOString()
        });

        // Execute if auto-execute is enabled
        if (settings.autoExecute && !settings.logOnly) {
          const result = await executeTakeProfitExit(position, evaluation.analysis, cfg);
          opportunities[opportunities.length - 1].executionResult = result;
        } else {
          // Log the recommendation
          await executeTakeProfitExit(position, evaluation.analysis, cfg);
        }
      }
    } catch (error) {
      console.log(`[TakeProfit] Error evaluating ${position.ticker}:`, error.message);
    }
  }

  // Summary log if there are positions
  if (positionStatuses.length > 0) {
    const exitCount = positionStatuses.filter(p => p.shouldExit).length;
    const holdCount = positionStatuses.filter(p => !p.shouldExit).length;

    console.log(`\n📊 [TakeProfit] Position Summary:`);
    console.log(`   ${positions.length} positions | ${exitCount} to exit | ${holdCount} to hold`);

    for (const status of positionStatuses) {
      const icon = status.shouldExit ? '🔔' : '⏳';
      console.log(`   ${icon} ${status.ticker}: ${status.profit}% profit, urgency ${status.urgency}`);
    }
  }

  return opportunities;
}

// Take-profit scan interval (per-user tracking)
let takeProfitInterval = null; // Legacy global interval (deprecated)
const userTakeProfitIntervals = new Map(); // userId -> interval

/**
 * Start take-profit scanning for a specific user
 * Refreshes positions from Kalshi before each scan
 */
function startTakeProfitScanning(intervalMs = 30000, userId, userConfig, userPortfolio) {
  // Stop existing interval for this user
  if (userId && userTakeProfitIntervals.has(userId)) {
    clearInterval(userTakeProfitIntervals.get(userId));
  }

  console.log(`[TakeProfit] Starting position scanning for user ${userId || 'global'} (every ${intervalMs/1000}s)`);

  const interval = setInterval(async () => {
    try {
      // Refresh positions from Kalshi before scanning
      if (userConfig && userConfig.isAuthenticated) {
        try {
          const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
          if (userPortfolio) {
            userPortfolio.positions = posData.market_positions || posData.positions || [];
          }
        } catch (e) {
          console.log('[TakeProfit] Could not refresh positions:', e.message);
        }
      }

      await scanTakeProfitOpportunities(userConfig, userPortfolio);
    } catch (error) {
      console.error('[TakeProfit] Scan error:', error.message);
    }
  }, intervalMs);

  if (userId) {
    userTakeProfitIntervals.set(userId, interval);
  } else {
    takeProfitInterval = interval; // Legacy fallback
  }
}

/**
 * Stop take-profit scanning
 * @param {string|null} userId - Stop for specific user, or all if null
 */
function stopTakeProfitScanning(userId = null) {
  if (userId && userTakeProfitIntervals.has(userId)) {
    clearInterval(userTakeProfitIntervals.get(userId));
    userTakeProfitIntervals.delete(userId);
    console.log(`[TakeProfit] Stopped scanning for user ${userId}`);
  } else if (!userId) {
    // Stop all (legacy behavior)
    for (const [uid, interval] of userTakeProfitIntervals) {
      clearInterval(interval);
    }
    userTakeProfitIntervals.clear();
    // Also clear legacy global interval
    if (takeProfitInterval) {
      clearInterval(takeProfitInterval);
      takeProfitInterval = null;
    }
  }
}

async function fetchCryptoMarkets() {
  const now = Date.now();

  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  try {
    // ONLY fetch 15-minute BTC, ETH, SOL markets
    const cryptoSeries = [
      'KXBTC15M',   // Bitcoin 15-minute up/down
      'KXETH15M',   // Ethereum 15-minute up/down
      'KXSOL15M',   // Solana 15-minute up/down
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

    // Filter for valid 15-minute markets (15 min = 900000ms, allow up to 20 minutes for timing)
    const cryptoMarkets = allMarkets.filter(m => {
      const ticker = (m.ticker || '').toUpperCase();
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;

      // Only include 15-minute markets
      if (!ticker.includes('15M')) return false;

      // Ensure market is open and has reasonable time remaining (30s to 20min)
      const isValid = timeRemaining && timeRemaining > 30000 && timeRemaining < 20 * 60 * 1000;
      return isValid;
    });

    console.log(`📊 Fetched ${allMarkets.length} markets, ${cryptoMarkets.length} valid 15-minute BTC/ETH/SOL`);

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
// Now incorporates orderbook data, spread penalty, and momentum confirmation
function analyzeCryptoMarket(parsed, orderbook = null, momentum = null, userConfig = null) {
  if (!parsed.cryptoType || !parsed.strikePrice || !parsed.marketType || parsed.marketType === 'between') {
    return null;
  }

  const priceData = cryptoPrices[parsed.cryptoType];
  if (!priceData || !priceData.price) {
    return null;
  }

  const cfg = userConfig || config;
  const liquiditySettings = cfg.liquiditySettings || {};
  const momentumSettings = cfg.momentumSettings || {};

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

  // ============================================
  // MARKET DISAGREEMENT PENALTY
  // ============================================
  // If the market strongly disagrees with our model (cheap bets = market says unlikely),
  // we should be skeptical. The market often has information we don't.
  //
  // Example: If we say 80% but market price is 20¢, the market disagrees by 60%!
  // Apply a penalty that shrinks our probability toward the market's view.

  const yesDisagreement = Math.abs(probYesWins - marketProbYes);
  const noDisagreement = Math.abs(probNoWins - marketProbNo);

  // For cheap bets (under 35¢), apply stronger skepticism
  // The market is usually right about unlikely events
  let adjustedProbYesWins = probYesWins;
  let adjustedProbNoWins = probNoWins;

  if (marketProbYes < 0.35 && yesDisagreement > 0.40) {
    // We think YES is likely but market thinks it's cheap - be skeptical
    // Shrink our probability 30% toward market's view
    adjustedProbYesWins = probYesWins * 0.7 + marketProbYes * 0.3;
    console.log(`   ⚠️ Market disagreement on YES: Our ${(probYesWins*100).toFixed(0)}% vs Market ${(marketProbYes*100).toFixed(0)}% → Adjusted to ${(adjustedProbYesWins*100).toFixed(0)}%`);
  }

  if (marketProbNo < 0.35 && noDisagreement > 0.40) {
    // We think NO is likely but market thinks it's cheap - be skeptical
    adjustedProbNoWins = probNoWins * 0.7 + marketProbNo * 0.3;
    console.log(`   ⚠️ Market disagreement on NO: Our ${(probNoWins*100).toFixed(0)}% vs Market ${(marketProbNo*100).toFixed(0)}% → Adjusted to ${(adjustedProbNoWins*100).toFixed(0)}%`);
  }

  // ============================================
  // SPREAD PENALTY (Phase 3 - Smart Edge)
  // ============================================
  // Subtract spread from edge to account for true cost of entry
  let yesSpreadPenalty = 0;
  let noSpreadPenalty = 0;

  if (orderbook && liquiditySettings.spreadPenaltyEnabled !== false) {
    // Calculate half-spread penalty (we pay half when entering, half when exiting)
    const yesSpread = orderbook.yesSpread || 0; // In cents
    const noSpread = orderbook.noSpread || 0;

    yesSpreadPenalty = yesSpread / 200; // Half spread as percentage of $1
    noSpreadPenalty = noSpread / 200;

    if (yesSpreadPenalty > 0.01) {
      console.log(`   📊 YES spread penalty: -${(yesSpreadPenalty * 100).toFixed(1)}% (spread: ${yesSpread}¢)`);
    }
    if (noSpreadPenalty > 0.01) {
      console.log(`   📊 NO spread penalty: -${(noSpreadPenalty * 100).toFixed(1)}% (spread: ${noSpread}¢)`);
    }
  }

  // Calculate edge with spread penalty
  // New formula: yesEdge = (adjustedProbYesWins - effectiveCost - halfSpread) * 100
  const effectiveYesCost = marketProbYes + yesSpreadPenalty;
  const effectiveNoCost = marketProbNo + noSpreadPenalty;

  let yesEdge = (adjustedProbYesWins - effectiveYesCost) * 100;
  let noEdge = (adjustedProbNoWins - effectiveNoCost) * 100;

  // Build analysis description
  const momentumDesc = prediction.momentum.direction === 'up' ? '📈 UP' :
                       prediction.momentum.direction === 'down' ? '📉 DOWN' : '➡️ flat';
  const timeDesc = prediction.analysis.timeDecayApplied ? '⏰ time decay' : '';

  // ============================================
  // BET SELECTION (Safe Mode Only)
  // ============================================
  // FIXED: Always use 40¢+ prices - empirical data shows best results here
  // Swing trading removed due to higher variance and exit logic issues

  let bestBet = null;

  // Fixed minimum price: 40¢ (market agrees at least 40%)
  const MIN_PRICE = 0.40;

  // ============================================
  // LIQUIDITY FILTERS (Phase 3)
  // ============================================
  const MIN_LIQUIDITY = liquiditySettings.minContracts || 10;
  const MAX_SPREAD_CENTS = liquiditySettings.maxSpreadCents || 8;

  // Check liquidity and spread requirements
  // Only apply filter if we have REAL orderbook data (not default/failed fetch)
  let yesLiquidityOk = true;
  let noLiquidityOk = true;

  const hasRealOrderbook = orderbook && orderbook.source !== 'default' && liquiditySettings.enabled !== false;

  if (hasRealOrderbook) {
    const yesLiquidity = orderbook.yesLiquidityAtBest || 0;
    const noLiquidity = orderbook.noLiquidityAtBest || 0;
    const yesSpread = orderbook.yesSpread || 0;
    const noSpread = orderbook.noSpread || 0;

    yesLiquidityOk = yesLiquidity >= MIN_LIQUIDITY && yesSpread <= MAX_SPREAD_CENTS;
    noLiquidityOk = noLiquidity >= MIN_LIQUIDITY && noSpread <= MAX_SPREAD_CENTS;

    if (!yesLiquidityOk) {
      console.log(`   🚫 YES liquidity filter: ${yesLiquidity} contracts (need ${MIN_LIQUIDITY}), spread ${yesSpread}¢ (max ${MAX_SPREAD_CENTS}¢)`);
    }
    if (!noLiquidityOk) {
      console.log(`   🚫 NO liquidity filter: ${noLiquidity} contracts (need ${MIN_LIQUIDITY}), spread ${noSpread}¢ (max ${MAX_SPREAD_CENTS}¢)`);
    }
  }

  // Evaluate YES side - require minimum price + liquidity
  // Validate prices are in safe range (40¢+)
  const yesValid = parsed.yesAsk >= MIN_PRICE && parsed.yesAsk < 0.98 && yesEdge > 0.5 && yesLiquidityOk;
  const noValid = parsed.noAsk >= MIN_PRICE && parsed.noAsk < 0.98 && noEdge > 0.5 && noLiquidityOk;

  // Pick the side with HIGHER WIN PROBABILITY (safest bet)
  if (yesValid && noValid) {
    // Both sides have positive edge - pick the one with higher probability
    // Use ADJUSTED probability for consistency with edge calculation
    if (adjustedProbYesWins >= adjustedProbNoWins) {
      bestBet = { side: 'YES', edge: yesEdge, prob: adjustedProbYesWins, price: parsed.yesAsk, spreadPenalty: yesSpreadPenalty };
    } else {
      bestBet = { side: 'NO', edge: noEdge, prob: adjustedProbNoWins, price: parsed.noAsk, spreadPenalty: noSpreadPenalty };
    }
  } else if (yesValid) {
    bestBet = { side: 'YES', edge: yesEdge, prob: adjustedProbYesWins, price: parsed.yesAsk, spreadPenalty: yesSpreadPenalty };
  } else if (noValid) {
    bestBet = { side: 'NO', edge: noEdge, prob: adjustedProbNoWins, price: parsed.noAsk, spreadPenalty: noSpreadPenalty };
  }

  // No valid bet found - return partial data so user can see the analysis
  if (!bestBet) {
    const maxPrice = Math.max(parsed.yesAsk || 0, parsed.noAsk || 0);
    const bestProb = Math.max(adjustedProbYesWins, adjustedProbNoWins);
    const bestSide = adjustedProbYesWins >= adjustedProbNoWins ? 'YES' : 'NO';
    const bestEdge = bestSide === 'YES' ? yesEdge : noEdge;

    // Determine why no bet was recommended
    let filterReason = 'No edge';
    if (bestEdge < 0.5) {
      filterReason = `No edge (${bestEdge.toFixed(1)}%)`;
    } else if (bestProb < 0.50) {
      filterReason = `Low confidence (${(bestProb*100).toFixed(0)}%)`;
    } else if (!yesLiquidityOk && !noLiquidityOk) {
      filterReason = 'Low liquidity';
    } else if (parsed.yesAsk < MIN_PRICE && parsed.noAsk < MIN_PRICE) {
      filterReason = `Price too low (<${Math.round(MIN_PRICE*100)}¢)`;
    }

    if (maxPrice > 0.75) {
      console.log(`   ⚠️ Skipped ${parsed.cryptoType} market: YES@${Math.round((parsed.yesAsk||0)*100)}¢ NO@${Math.round((parsed.noAsk||0)*100)}¢ | Our prob: ${(bestProb*100).toFixed(0)}% | ${filterReason}`);
    }

    // Return partial analysis so card can display probability
    return {
      ...parsed,
      currentPrice,
      volatility: (volatility * 100).toFixed(2) + '%',
      pctFromStrike: pctFromStrike.toFixed(2),
      zScore: prediction.zScore.toFixed(2),
      probYesWins: probYesWins * 100,
      probNoWins: probNoWins * 100,
      ourProbability: bestProb * 100,
      winProbability: (bestProb * 100).toFixed(1),
      marketImpliedProb: maxPrice * 100,
      yesEdge,
      noEdge,
      edge: bestEdge,
      betSide: bestSide,
      betPrice: bestSide === 'YES' ? parsed.yesAsk : parsed.noAsk,
      betPriceCents: Math.round((bestSide === 'YES' ? parsed.yesAsk : parsed.noAsk) * 100),
      isRecommended: false,
      isLocked: true,
      filterReason,
      timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
      momentum: prediction.momentum.direction,
      momentumStrength: prediction.momentum.strength,
      confidence: (prediction.confidence * 100).toFixed(0) + '%',
      dataPoints: prediction.dataPoints
    };
  }

  // ============================================
  // MOMENTUM CONFIRMATION (Phase 4)
  // ============================================
  // Apply momentum bonus/penalty to edge
  let momentumAdjustment = 0;
  let momentumInfo = null;

  if (momentum && momentumSettings.enabled !== false) {
    // Check if momentum aligns with our bet
    const momentumAnalysis = {
      ...momentum,
      alignment: 'neutral'
    };

    // For YES bets on "above" markets, upward momentum is good
    // For NO bets on "above" markets, downward momentum is good
    if (parsed.marketType === 'above') {
      if (bestBet.side === 'YES' && momentum.direction === 'up') {
        momentumAnalysis.alignment = 'aligned';
      } else if (bestBet.side === 'NO' && momentum.direction === 'down') {
        momentumAnalysis.alignment = 'aligned';
      } else if (bestBet.side === 'YES' && momentum.direction === 'down') {
        momentumAnalysis.alignment = 'opposed';
      } else if (bestBet.side === 'NO' && momentum.direction === 'up') {
        momentumAnalysis.alignment = 'opposed';
      }
    } else {
      // For "below" markets, reverse the logic
      if (bestBet.side === 'YES' && momentum.direction === 'down') {
        momentumAnalysis.alignment = 'aligned';
      } else if (bestBet.side === 'NO' && momentum.direction === 'up') {
        momentumAnalysis.alignment = 'aligned';
      } else if (bestBet.side === 'YES' && momentum.direction === 'up') {
        momentumAnalysis.alignment = 'opposed';
      } else if (bestBet.side === 'NO' && momentum.direction === 'down') {
        momentumAnalysis.alignment = 'opposed';
      }
    }

    momentumInfo = momentumAnalysis;

    // Apply adjustment based on alignment and strength
    if (momentumAnalysis.alignment === 'aligned' && momentum.strength > 0.3) {
      momentumAdjustment = (momentumSettings.alignmentBonus || 2) * momentum.strength;
      console.log(`   ✅ Momentum ALIGNED: +${momentumAdjustment.toFixed(1)}% bonus (${momentum.direction}, strength ${(momentum.strength*100).toFixed(0)}%)`);
    } else if (momentumAnalysis.alignment === 'opposed' && momentum.strength > 0.3) {
      momentumAdjustment = (momentumSettings.oppositionPenalty || -3) * momentum.strength;
      console.log(`   ⚠️ Momentum OPPOSED: ${momentumAdjustment.toFixed(1)}% penalty (${momentum.direction}, strength ${(momentum.strength*100).toFixed(0)}%)`);
    }

    bestBet.edge += momentumAdjustment;
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
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    // Phase 3 & 4: Orderbook and momentum data
    spreadPenalty: bestBet.spreadPenalty || 0,
    momentumAdjustment: momentumAdjustment || 0,
    momentumInfo: momentumInfo,
    orderbookData: orderbook ? {
      yesSpread: orderbook.yesSpread,
      noSpread: orderbook.noSpread,
      yesLiquidity: orderbook.yesLiquidityAtBest,
      noLiquidity: orderbook.noLiquidityAtBest
    } : null,
    // Safe mode always uses 40¢ minimum
    minPriceUsed: MIN_PRICE
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

    // Fetch 15-minute crypto markets only (BTC, ETH, SOL)
    const cryptoMarkets = await fetchCryptoMarkets();

    // Analyze crypto opportunities
    const allAnalyzed = cryptoMarkets
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

    // ALWAYS SHOW 3 CARDS - one for each token (BTC, ETH, SOL)
    // Create placeholder cards for tokens without active markets
    const tokenSlots = ['BTC', 'ETH', 'SOL'].map(token => {
      // Find the best opportunity for this token
      const tokenOpps = allAnalyzed.filter(m => m.assetType === token || m.cryptoType === token);

      if (tokenOpps.length > 0) {
        // Sort by win probability and take the best one
        tokenOpps.sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));
        const best = tokenOpps[0];
        best.hasActiveMarket = true;
        return best;
      } else {
        // No active market - create a placeholder card
        const currentPrice = cryptoPrices[token]?.price || 0;
        return {
          assetType: token,
          cryptoType: token,
          hasActiveMarket: false,
          isPlaceholder: true,
          isRecommended: false,
          filterReason: 'Waiting for next market',
          currentPrice: currentPrice,
          title: `${token} 15-Minute Up/Down`,
          winProbability: '--',
          edge: 0,
          betSide: '--',
          betPrice: 0,
          betPriceCents: 0,
          marketCategory: 'crypto'
        };
      }
    });

    // Filter to recommended only (unless showAll=true), but always include placeholders
    const allOpportunities = showAll
      ? tokenSlots.sort((a, b) => {
          if (a.isPlaceholder && !b.isPlaceholder) return 1;
          if (!a.isPlaceholder && b.isPlaceholder) return -1;
          return parseFloat(b.winProbability || 0) - parseFloat(a.winProbability || 0);
        })
      : tokenSlots; // Always show all 3 slots

    // Refresh positions before calculating risk (user-specific)
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    // Get current risk info by type (user-specific)
    const riskByType = getRiskByType(req.userState);

    // Price display (BTC, ETH, SOL only)
    const priceDisplay = {
      crypto: {}
    };
    for (const token of Object.keys(cryptoPrices)) {
      if (cryptoPrices[token].price > 0) {
        priceDisplay.crypto[token] = cryptoPrices[token].price;
      }
    }

    // Calculate filter statistics
    const activeMarkets = tokenSlots.filter(m => m.hasActiveMarket);
    const recommended = activeMarkets.filter(m => m.isRecommended);
    const noEdge = activeMarkets.filter(m => !m.isRecommended && m.edge < 0.5);
    const lowProb = activeMarkets.filter(m => !m.isRecommended && m.edge >= 0.5);

    res.json({
      success: true,
      count: allOpportunities.length,
      showingAll: showAll,
      stats: {
        totalAnalyzed: activeMarkets.length,
        recommended: recommended.length,
        filteredNoEdge: noEdge.length,
        filteredLowProb: lowProb.length
      },
      activeMarkets: activeMarkets.length,
      prices: priceDisplay,
      risk: {
        // Total risk - use user-specific limits
        current: riskByType.total,
        max: getMaxTotalRisk(userConfig),
        remaining: Math.max(0, getMaxTotalRisk(userConfig) - riskByType.total),
        currentDollars: (riskByType.total / 100).toFixed(2),
        maxDollars: (getMaxTotalRisk(userConfig) / 100).toFixed(2),
        remainingDollars: (Math.max(0, getMaxTotalRisk(userConfig) - riskByType.total) / 100).toFixed(2),
        // Per-token limit
        maxPerToken: getMaxPerToken(userConfig),
        byToken: getExposureByToken(req.userState),
        // Hourly pool
        hourly: {
          current: riskByType.hourly,
          max: getMaxRisk('hourly', userConfig),
          remaining: Math.max(0, getMaxRisk('hourly', userConfig) - riskByType.hourly),
          currentDollars: (riskByType.hourly / 100).toFixed(2),
          maxDollars: (getMaxRisk('hourly', userConfig) / 100).toFixed(2)
        },
        // Other pool (daily, 15min, etc)
        other: {
          current: riskByType.other,
          max: getMaxRisk('other', userConfig),
          remaining: Math.max(0, getMaxRisk('other', userConfig) - riskByType.other),
          currentDollars: (riskByType.other / 100).toFixed(2),
          maxDollars: (getMaxRisk('other', userConfig) / 100).toFixed(2)
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
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    const userBetHistory = req.userState?.betHistory || betHistory;

    // Refresh portfolio if authenticated
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    // Calculate risk from Kalshi positions
    let kalshiRisk = 0;
    const kalshiTickers = new Set();
    if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
      for (const pos of userPortfolio.positions) {
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
    const unsettledBets = userBetHistory.filter(bet => {
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
    const maxRisk = getMaxTotalRisk(userConfig);
    const remainingBudget = Math.max(0, maxRisk - currentRisk);

    console.log(`📊 Risk: Kalshi=$${(kalshiRisk/100).toFixed(2)} (${kalshiTickers.size} positions), Local=$${(localRisk/100).toFixed(2)} (${unsettledBets.length} bets), Total=$${(currentRisk/100).toFixed(2)} / $${(maxRisk/100).toFixed(2)}`);

    res.json({
      success: true,
      risk: {
        current: currentRisk,
        max: maxRisk,
        remaining: remainingBudget,
        currentDollars: (currentRisk / 100).toFixed(2),
        maxDollars: (maxRisk / 100).toFixed(2),
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

// Get risk settings - PER-USER
app.get('/api/settings/risk', (req, res) => {
  const userConfig = req.userState?.config || DEFAULT_CONFIG;
  res.json({
    success: true,
    riskLimits: userConfig.riskLimits
  });
});

// Update risk settings - PER-USER
app.post('/api/settings/risk', (req, res) => {
  const { hourly, other, maxPerToken, maxPerBet, maxTotal } = req.body;

  // Use per-user config
  const userConfig = req.userState?.config;
  if (!userConfig) {
    return res.status(401).json({ success: false, error: 'Must be logged in to update settings' });
  }

  // Ensure riskLimits structure exists
  if (!userConfig.riskLimits) {
    userConfig.riskLimits = JSON.parse(JSON.stringify(DEFAULT_CONFIG.riskLimits));
  }
  if (!userConfig.riskLimits.hourly) {
    userConfig.riskLimits.hourly = { maxPerBet: 500, maxTotal: 500 };
  }
  if (!userConfig.riskLimits.other) {
    userConfig.riskLimits.other = { maxPerBet: 500, maxTotal: 500 };
  }

  // Support BOTH nested (hourly/other) and flat (maxPerBet/maxTotal) structures
  // Flat structure from simplified UI
  if (maxPerBet !== undefined) {
    const val = Math.max(10, Math.min(10000, parseInt(maxPerBet) || 200));
    userConfig.riskLimits.maxPerBet = val; // Top-level for client reads
    userConfig.riskLimits.hourly.maxPerBet = val;
    userConfig.riskLimits.other.maxPerBet = val;
  }
  if (maxTotal !== undefined) {
    const val = Math.max(100, Math.min(100000, parseInt(maxTotal) || 1500));
    userConfig.riskLimits.hourly.maxTotal = val;
    userConfig.riskLimits.other.maxTotal = val;
    // Also set a unified maxTotal for easy access
    userConfig.riskLimits.maxTotal = val;
  }

  // Nested structure (legacy support)
  if (hourly) {
    if (hourly.maxPerBet !== undefined) {
      userConfig.riskLimits.hourly.maxPerBet = Math.max(10, Math.min(10000, parseInt(hourly.maxPerBet) || 200));
    }
    if (hourly.maxTotal !== undefined) {
      userConfig.riskLimits.hourly.maxTotal = Math.max(100, Math.min(100000, parseInt(hourly.maxTotal) || 500));
    }
  }

  if (other) {
    if (other.maxPerBet !== undefined) {
      userConfig.riskLimits.other.maxPerBet = Math.max(10, Math.min(10000, parseInt(other.maxPerBet) || 200));
    }
    if (other.maxTotal !== undefined) {
      userConfig.riskLimits.other.maxTotal = Math.max(100, Math.min(100000, parseInt(other.maxTotal) || 1000));
    }
  }

  // Max per token (e.g., max $5 on all SOL markets combined)
  if (maxPerToken !== undefined) {
    userConfig.riskLimits.maxPerToken = Math.max(100, Math.min(50000, parseInt(maxPerToken) || 500));
  }

  // Create unified maxTotal for response if not set
  if (!userConfig.riskLimits.maxTotal) {
    userConfig.riskLimits.maxTotal = Math.max(userConfig.riskLimits.hourly.maxTotal, userConfig.riskLimits.other.maxTotal);
  }

  console.log(`⚙️ Risk settings updated for user ${req.userId}:`, JSON.stringify(userConfig.riskLimits));

  // Save to per-user state file
  saveUserState(req.userId);

  res.json({
    success: true,
    riskLimits: {
      ...userConfig.riskLimits,
      maxTotal: userConfig.riskLimits.maxTotal || userConfig.riskLimits.hourly.maxTotal
    },
    message: 'Risk settings updated'
  });
});

// Get scale-in settings - PER-USER
app.get('/api/settings/scale-in', (req, res) => {
  const userConfig = req.userState?.config || DEFAULT_CONFIG;
  res.json({
    success: true,
    scaleIn: userConfig.scaleIn
  });
});

// Update scale-in settings - PER-USER
app.post('/api/settings/scale-in', (req, res) => {
  const { enabled, minProbabilityIncrease, maxBetsPerMarket, minTimeBetweenBets } = req.body;

  const userConfig = req.userState?.config;
  if (!userConfig) {
    return res.status(401).json({ success: false, error: 'Must be logged in to update settings' });
  }

  if (!userConfig.scaleIn) {
    userConfig.scaleIn = JSON.parse(JSON.stringify(DEFAULT_CONFIG.scaleIn));
  }

  if (enabled !== undefined) {
    userConfig.scaleIn.enabled = !!enabled;
  }
  if (minProbabilityIncrease !== undefined) {
    userConfig.scaleIn.minProbabilityIncrease = Math.max(5, Math.min(50, parseInt(minProbabilityIncrease) || 15));
  }
  if (maxBetsPerMarket !== undefined) {
    userConfig.scaleIn.maxBetsPerMarket = Math.max(1, Math.min(10, parseInt(maxBetsPerMarket) || 3));
  }
  if (minTimeBetweenBets !== undefined) {
    userConfig.scaleIn.minTimeBetweenBets = Math.max(30000, Math.min(600000, parseInt(minTimeBetweenBets) || 60000));
  }

  console.log(`⚙️ Scale-in settings updated for user ${req.userId}:`, JSON.stringify(userConfig.scaleIn));
  saveUserState(req.userId);

  res.json({
    success: true,
    scaleIn: userConfig.scaleIn,
    message: 'Scale-in settings updated'
  });
});

// ============================================
// LIMIT ORDER SETTINGS (Stop-Loss & Take-Profit)
// ============================================

// Get limit order settings - PER-USER
app.get('/api/limit-order-settings', (req, res) => {
  const userConfig = req.userState?.config || DEFAULT_CONFIG;
  res.json({
    success: true,
    limitOrderSettings: userConfig.limitOrderSettings || DEFAULT_CONFIG.limitOrderSettings
  });
});

// Update limit order settings - PER-USER
app.post('/api/limit-order-settings', (req, res) => {
  const { stopLoss, takeProfit } = req.body;

  const userConfig = req.userState?.config;
  if (!userConfig) {
    return res.status(401).json({ success: false, error: 'Must be logged in to update settings' });
  }

  // Ensure limitOrderSettings structure exists
  if (!userConfig.limitOrderSettings) {
    userConfig.limitOrderSettings = JSON.parse(JSON.stringify(DEFAULT_CONFIG.limitOrderSettings));
  }

  // Update stop-loss settings
  if (stopLoss !== undefined) {
    if (stopLoss.enabled !== undefined) {
      userConfig.limitOrderSettings.stopLoss.enabled = !!stopLoss.enabled;
    }
    if (stopLoss.threshold !== undefined) {
      // Clamp to reasonable range: -90% to -5%
      userConfig.limitOrderSettings.stopLoss.threshold = Math.max(-90, Math.min(-5, parseInt(stopLoss.threshold) || -40));
    }
  }

  // Update take-profit settings
  if (takeProfit !== undefined) {
    if (takeProfit.enabled !== undefined) {
      userConfig.limitOrderSettings.takeProfit.enabled = !!takeProfit.enabled;
    }
    if (takeProfit.threshold !== undefined) {
      // Clamp to reasonable range: 5% to 100%
      userConfig.limitOrderSettings.takeProfit.threshold = Math.max(5, Math.min(100, parseInt(takeProfit.threshold) || 25));
    }
  }

  console.log(`⚙️ Limit order settings updated for user ${req.userId}:`, JSON.stringify(userConfig.limitOrderSettings));
  saveUserState(req.userId);

  res.json({
    success: true,
    limitOrderSettings: userConfig.limitOrderSettings,
    message: 'Limit order settings updated'
  });
});


// ============================================
// PROFILE ENDPOINTS
// ============================================

// DEPRECATED: Profile system removed - credentials are now tied to user account
// These endpoints return empty/success for backwards compatibility
app.get('/api/profiles', (req, res) => {
  // Profiles deprecated - user state is tied to logged-in account
  res.json({
    success: true,
    profiles: [],
    activeProfileId: null,
    message: 'Profiles deprecated - settings are now tied to your account'
  });
});

// DEPRECATED: Profile endpoints - now return success for backwards compatibility
app.post('/api/profiles', (req, res) => {
  res.json({ success: true, message: 'Profiles deprecated - use account settings instead' });
});

app.post('/api/profiles/:id/switch', (req, res) => {
  res.json({ success: true, message: 'Profiles deprecated - settings tied to your account' });
});

app.post('/api/profiles/save-credentials', (req, res) => {
  res.json({ success: true, message: 'Profiles deprecated - use Kalshi settings instead' });
});

app.post('/api/profiles/logout', (req, res) => {
  res.json({ success: true, message: 'Use account logout instead' });
});

app.delete('/api/profiles/:id', (req, res) => {
  res.json({ success: true, message: 'Profiles deprecated' });
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

    // Use user-specific config for authentication
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    const userBetHistory = req.userState?.betHistory || betHistory;

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions before bet:', e.message);
      }
    }

    // Force fresh market data by clearing cache
    marketCache.lastFetch = 0;

    // Search crypto markets only (BTC, ETH, SOL)
    const cryptoMarkets = await fetchCryptoMarkets();

    let market = cryptoMarkets.find(m => m.ticker === ticker);
    let marketType = 'crypto';

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
    const remainingBudget = getRemainingRiskBudget(ticker, req.userState, userConfig);
    const remainingTokenBudget = getRemainingTokenBudget(ticker, market.assetType, req.userState, userConfig);
    const poolMax = getMaxRisk(poolType, userConfig);
    const maxPerBet = getMaxPerBet(poolType, userConfig);
    const maxPerToken = getMaxPerToken(userConfig);

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

    if (!userConfig.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      userBetHistory.unshift(betRecord);
      userConfig.bankroll = (userConfig.bankroll || 10000) - betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        token: market.assetType || getTokenFromTicker(ticker),
        predictedProb: parseFloat(req.body.winProbability) || 60,
        edge: parseFloat(req.body.edge) || 5,
        strikePrice: market.strikePrice,
        currentPrice: market.currentPrice,
        expiryTime: market.expiry || market.close_time,
        marketType: isHourlyMarket(ticker) ? 'hourly' : ticker?.includes('15M') ? '15min' : 'daily'
      });

      // Save user state
      if (req.userId) saveUserState(req.userId);

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: (userConfig.bankroll || 10000) / 100
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
      // Use userConfig for authentication
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest, userConfig);
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
      userBetHistory.unshift(betRecord);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        count: filledCount,
        token: market.assetType || getTokenFromTicker(ticker),
        predictedProb: parseFloat(req.body.winProbability) || 60,
        edge: parseFloat(req.body.edge) || 5,
        strikePrice: market.strikePrice,
        currentPrice: market.currentPrice,
        expiryTime: market.expiry || market.close_time,
        marketType: isHourlyMarket(ticker) ? 'hourly' : ticker?.includes('15M') ? '15min' : 'daily'
      });

      // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
      // Stop-loss and take-profit are now handled by active monitoring (evaluateTakeProfit)
      // which runs every 15 seconds and executes market sells when thresholds are hit

      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      userPortfolio.balance = balanceData.balance || 0;
      userConfig.bankroll = userPortfolio.balance;

      // Refresh positions for risk tracking
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions after bet:', e.message);
      }

      const riskByType = getRiskByType(req.userState);

      // Save user state after successful bet
      if (req.userId) saveUserState(req.userId);

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        newBalance: userPortfolio.balance / 100,
        risk: {
          current: riskByType.total,
          max: getMaxTotalRisk(userConfig),
          remaining: getTotalRemainingBudget(req.userState, userConfig),
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxDollars: (getMaxTotalRisk(userConfig) / 100).toFixed(2),
          remainingDollars: (getTotalRemainingBudget(req.userState, userConfig) / 100).toFixed(2),
          hourly: {
            current: riskByType.hourly,
            max: getMaxRisk('hourly', userConfig),
            currentDollars: (riskByType.hourly / 100).toFixed(2),
            maxDollars: (getMaxRisk('hourly', userConfig) / 100).toFixed(2)
          },
          other: {
            current: riskByType.other,
            max: getMaxRisk('other', userConfig),
            currentDollars: (riskByType.other / 100).toFixed(2),
            maxDollars: (getMaxRisk('other', userConfig) / 100).toFixed(2)
          }
        }
      });

      console.log(`✅ Bet placed. Risk now: $${(riskByType.total / 100).toFixed(2)} / $${(getMaxTotalRisk(userConfig) / 100).toFixed(2)}`);
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
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    const userBetHistory = req.userState?.betHistory || betHistory;

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions before auto-bet:', e.message);
      }
    }

    // Fetch crypto markets only (BTC, ETH, SOL 15-minute markets)
    const cryptoMarkets = await fetchCryptoMarkets();
    const now = Date.now();

    // Clean up old bets from tracking (older than 30 min)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    // Analyze crypto opportunities
    const opportunities = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      })
      .filter(m => {
        if (m === null) return false;
        // REQUIRE minimum WIN PROBABILITY for auto-betting (learned from historical data)
        const winProb = parseFloat(m.winProbability) || 0;
        const minAutoProb = getMinAutoWinProbability();
        if (winProb < minAutoProb) return false;

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

    const totalScanned = cryptoMarkets.length;

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: 'Scanning 3 markets (BTC, ETH, SOL) - no auto-bet opportunities yet',
        bet: null,
        scanned: 3  // Always 3 markets (BTC, ETH, SOL 15-min)
      });
    }

    const best = opportunities[0];

    // Check risk limit for this market's pool
    const isHourly = isHourlyMarket(best.ticker);
    const remainingBudget = getRemainingRiskBudget(best.ticker, req.userState, userConfig);
    const poolMax = isHourly ? getMaxRisk('hourly', userConfig) : getMaxRisk('other', userConfig);
    const poolName = isHourly ? 'hourly' : 'other';

    if (remainingBudget < 10) { // Less than 10 cents remaining in this pool
      return res.json({
        success: true,
        message: `Risk limit reached for ${poolName} markets ($${(poolMax/100).toFixed(2)} max). Wait for positions to settle.`,
        bet: null,
        risk: getRiskByType(req.userState)
      });
    }
    const category = best.marketCategory || 'crypto';
    const maxPerBet = getMaxPerBet(poolName === 'HOURLY' ? 'hourly' : 'other', userConfig);
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType, req.userState, userConfig);
    console.log(`Auto-bet found [${category}]: ${best.title} | Win prob: ${best.winProbability}% | Side: ${best.betSide}`);

    // Check per-token limit first
    if (remainingTokenBudget < 10) {
      const token = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
      console.log(`⚠️ Token limit reached for ${token} - $${(getMaxPerToken(userConfig)/100).toFixed(2)} max per token`);
      return res.json({
        success: true,
        message: `Token limit reached for ${token}. Max $${(getMaxPerToken(userConfig)/100).toFixed(2)} per token.`,
        bet: null,
        risk: getRiskByType(req.userState)
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

    // HARD LIMIT CHECK: Validate bet won't exceed ANY limit
    const validation = validateBetWontExceedLimits(best.ticker, totalCost, req.userState, req.userConfig);
    if (!validation.valid) {
      console.log(`🚫 Bet blocked: ${validation.reason}`);
      return res.json({
        success: true,
        message: `Bet blocked: ${validation.reason}`,
        bet: null,
        risk: getRiskByType(req.userState)
      });
    }

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

    if (!userConfig.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      userBetHistory.unshift(betRecord);
      userConfig.bankroll -= betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // Save user state
      if (req.userId) saveUserState(req.userId);

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        opportunity: best,
        newBalance: userConfig.bankroll / 100
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
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest, userConfig);
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
      userBetHistory.unshift(betRecord);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        count: filledCount,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: betRecord.avgPrice,
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
      // Stop-loss and take-profit handled by active monitoring (evaluateTakeProfit)

      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      userPortfolio.balance = balanceData.balance || 0;
      userConfig.bankroll = userPortfolio.balance;

      // Refresh positions for accurate risk calculation
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = posData.market_positions || posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions after auto-bet:', e.message);
      }

      const riskByType = getRiskByType(req.userState);

      // Save user state after successful bet
      if (req.userId) saveUserState(req.userId);

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        opportunity: best,
        newBalance: userPortfolio.balance / 100,
        risk: {
          current: riskByType.total,
          max: getMaxTotalRisk(userConfig),
          remaining: getTotalRemainingBudget(req.userState, userConfig),
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxDollars: (getMaxTotalRisk(userConfig) / 100).toFixed(2),
          remainingDollars: (getTotalRemainingBudget(req.userState, userConfig) / 100).toFixed(2),
          hourly: {
            current: riskByType.hourly,
            max: getMaxRisk('hourly', userConfig),
            currentDollars: (riskByType.hourly / 100).toFixed(2),
            maxDollars: (getMaxRisk('hourly', userConfig) / 100).toFixed(2)
          },
          other: {
            current: riskByType.other,
            max: getMaxRisk('other', userConfig),
            currentDollars: (riskByType.other / 100).toFixed(2),
            maxDollars: (getMaxRisk('other', userConfig) / 100).toFixed(2)
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
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(userState, userPortfolio.positions, userId);
        console.log(`📊 Refreshed positions: ${userPortfolio.positions.length} open positions from Kalshi`);
        if (userPortfolio.positions.length > 0) {
          userPortfolio.positions.forEach(p => {
            const token = getTokenFromTicker(p.ticker);
            console.log(`   Position: ${p.ticker} (${token}) | contracts=${p.position} | avg_price=${p.average_price} | market_exposure=${p.market_exposure}`);
          });
          // Log calculated exposure by token
          const tokenExposure = getExposureByToken(userState);
          console.log(`📊 Calculated token exposure:`);
          for (const [token, exposure] of Object.entries(tokenExposure)) {
            console.log(`   💵 ${token}: $${(exposure/100).toFixed(2)} exposure (max $${(getMaxPerToken(userConfig)/100).toFixed(2)})`);
          }
        }
        // Log pre-bet total exposure summary for debugging limit violations
        const preExposure = getRiskByType(userState);
        const preTokenExposure = getExposureByToken(userState);
        console.log(`📊 Pre-bet exposure: Total=$${(preExposure.total/100).toFixed(2)} (max $${(getMaxTotalRisk(userConfig)/100).toFixed(2)}) | Tokens=${JSON.stringify(
          Object.fromEntries(Object.entries(preTokenExposure).map(([k,v]) => [k, '$'+(v/100).toFixed(2)]))
        )}`);
      } catch (e) {
        console.log('⚠️ Could not refresh positions:', e.message);
      }

      // ============================================
      // TAKE-PROFIT SCAN (Phase 5)
      // ============================================
      // Scan existing positions for take-profit opportunities
      if (userConfig.takeProfitSettings?.enabled && userPortfolio.positions?.length > 0) {
        console.log(`\n📈 Scanning ${userPortfolio.positions.length} positions for take-profit...`);
        try {
          const takeProfitOpps = await scanTakeProfitOpportunities(userConfig, userPortfolio);
          if (takeProfitOpps.length > 0) {
            console.log(`   Found ${takeProfitOpps.length} take-profit opportunities`);
            takeProfitOpps.forEach(opp => {
              console.log(`   💰 ${opp.position.ticker}: ${opp.evaluation.analysis.profitPercent.toFixed(1)}% profit`);
            });
          }
        } catch (e) {
          console.log('⚠️ Take-profit scan error:', e.message);
        }
      }
    }

    // Force fresh market data
    marketCache.lastFetch = 0;

    // Fetch crypto markets only (BTC, ETH, SOL 15-minute markets)
    const cryptoMarkets = await fetchCryptoMarkets();
    const now = Date.now();

    // Clean up old bets (remove bets older than 30 minutes)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    console.log(`📊 Fetched: ${cryptoMarkets.length} crypto markets (BTC, ETH, SOL)`);
    console.log(`   Recent bets tracking: ${recentBets.size} markets`);

    // Subscribe to WebSocket updates for these markets
    if (wsEnabled && kalshiWs) {
      const tickers = cryptoMarkets.map(m => m.ticker);
      kalshiWs.subscribeTickers(tickers);
      kalshiWs.subscribeOrderbooks(tickers);
    }

    // ============================================
    // EMPIRICAL DATA-DRIVEN ANALYSIS
    // ============================================
    // Check global sit-out conditions first
    const globalSitOut = shouldSitOut(learnedParams);
    if (globalSitOut.sitOut) {
      console.log(`⏸️ SITTING OUT: ${globalSitOut.reasons.join(', ')}`);
      lastScanStatus.status = 'sitting_out';
      lastScanStatus.statusMessage = globalSitOut.reasons[0];
      lastScanStatus.blockedReasons = globalSitOut.reasons;
      console.log('========================================\n');
      return;
    }

    // Analyze crypto opportunities with EMPIRICAL evaluation
    const analysisPromises = cryptoMarkets.map(async (m) => {
      const parsed = parseMarket(m);
      if (!parsed.cryptoType || !parsed.strikePrice) return null;

      // Get current price for this token
      const priceData = cryptoPrices[parsed.cryptoType];
      if (!priceData?.price) return null;

      // Fetch orderbook for liquidity check
      let orderbook = null;
      if (userConfig.liquiditySettings?.enabled !== false) {
        try {
          orderbook = await fetchOrderbook(m.ticker, userConfig);
        } catch (e) {
          // Continue without orderbook
        }
      }

      // Use the new empirical evaluation
      const empiricalResult = evaluateOpportunityEmpirical(
        parsed,
        priceData.price,
        learnedParams,
        orderbook
      );

      // Merge parsed data with empirical evaluation
      return {
        ...parsed,
        ...empiricalResult,
        ticker: m.ticker,
        currentPrice: priceData.price,
        marketCategory: 'crypto',
        token: parsed.cryptoType,
        betSide: empiricalResult.side,
        betPrice: empiricalResult.marketPrice,
        betPriceCents: empiricalResult.marketPriceCents
      };
    });

    const allOppsRaw = await Promise.all(analysisPromises);
    const allOpps = allOppsRaw.filter(m => m !== null);
    const withEdge = allOpps.filter(m => m.edge > 0);
    const recommended = allOpps.filter(m => m.shouldBet);
    const minAutoThreshold = learnedParams.selectivityRules?.minEmpiricalWinRate || 62;

    console.log(`   Analyzed: ${allOpps.length} valid | ${withEdge.length} with edge | ${recommended.length} recommended`);

    // Update scan status
    lastScanStatus.marketsScanned = 3;
    lastScanStatus.activeMarkets = allOpps.length;
    lastScanStatus.marketsWithEdge = withEdge.length;

    // Show signal strength distribution for empirical debugging
    const signalBuckets = { '0-40': 0, '40-60': 0, '60-70': 0, '70-80': 0, '80-90': 0, '90-100': 0 };
    allOpps.forEach(m => {
      const sig = m.signalStrength || 0;
      if (sig >= 90) signalBuckets['90-100']++;
      else if (sig >= 80) signalBuckets['80-90']++;
      else if (sig >= 70) signalBuckets['70-80']++;
      else if (sig >= 60) signalBuckets['60-70']++;
      else if (sig >= 40) signalBuckets['40-60']++;
      else signalBuckets['0-40']++;
    });
    console.log(`   Signal strength distribution: ${JSON.stringify(signalBuckets)}`);

    // Show regime status for each token
    console.log(`   Volatility regimes:`);
    for (const token of ['BTC', 'ETH', 'SOL']) {
      const regime = detectVolatilityRegime(token);
      console.log(`      ${token}: ${regime.regime} (${regime.reason})`);
    }

    // Filter to only empirically recommended opportunities
    const opportunities = allOpps
      .filter(m => {
        // Must pass empirical evaluation
        if (!m.shouldBet) {
          return false;
        }

        // Check if we already bet on this market
        if (recentBets.has(m.ticker)) {
          // Allow scale-in if win rate improved significantly
          const currentWinRate = parseFloat(m.winProbability) || 0;
          if (shouldAllowScaleIn(m.ticker, currentWinRate)) {
            m.isScaleIn = true; // Mark as scale-in opportunity
          } else {
            return false; // Skip - already bet and not a valid scale-in
          }
        }
        return true;
      })
      // EMPIRICAL: Sort by signal strength (combines win rate, edge, regime, timing)
      .sort((a, b) => {
        // Primary sort: signal strength (the unified quality score)
        const aSignal = a.signalStrength || 0;
        const bSignal = b.signalStrength || 0;

        // If signals are close (within 5 points), use secondary criteria
        if (Math.abs(aSignal - bSignal) <= 5) {
          // Prefer higher edge
          const aEdge = a.edge || 0;
          const bEdge = b.edge || 0;
          if (Math.abs(aEdge - bEdge) > 2) {
            return bEdge - aEdge;
          }
          // Then prefer larger sample size (more reliable)
          return (b.sampleSize || 0) - (a.sampleSize || 0);
        }

        return bSignal - aSignal;
      });

    const highSignalCount = opportunities.filter(o => (o.signalStrength || 0) >= 80).length;
    console.log(`   Final: ${opportunities.length} opportunities (${highSignalCount} with signal ≥80)`);

    // Show top opportunities with empirical details
    if (opportunities.length > 0) {
      console.log(`   🎯 Top empirical opportunities:`);
      opportunities.slice(0, 3).forEach(m => {
        console.log(`      - ${m.title}: signal=${m.signalStrength} | win=${m.winProbability}% @ ${m.marketPriceCents}¢ | edge=${m.edge?.toFixed(1)}% | regime=${m.regime}`);
      });
    }

    // Show markets that almost qualified (signal 60-70)
    const minSignal = learnedParams.selectivityRules?.minSignalStrength || 70;
    const almostQualified = allOpps.filter(m => {
      const sig = m.signalStrength || 0;
      return sig >= minSignal - 15 && sig < minSignal && m.edge > 0;
    });
    if (almostQualified.length > 0) {
      console.log(`   📈 ${almostQualified.length} markets approaching signal threshold:`);
      almostQualified.slice(0, 3).forEach(m => {
        const rejectionReason = m.reasons?.[0] || 'Unknown';
        console.log(`      - ${m.title}: signal=${m.signalStrength} | ${rejectionReason}`);
      });
    }

    if (opportunities.length === 0) {
      console.log('⏳ No empirically valid opportunities - waiting for next scan...');
      console.log('========================================\n');

      // Update status with reason
      lastScanStatus.status = 'no_opportunities';
      lastScanStatus.statusMessage = `Scanning 3 markets (BTC, ETH, SOL) - waiting for high-signal opportunity`;
      if (almostQualified.length > 0) {
        lastScanStatus.blockedReasons.push(`${almostQualified.length} markets with signal ${minSignal-15}-${minSignal-1} (need ${minSignal}+)`);
      }
      // Show rejected opportunities and their reasons
      const rejectedWithReasons = allOpps.filter(m => !m.shouldBet && m.reasons?.length > 0);
      if (rejectedWithReasons.length > 0) {
        lastScanStatus.blockedReasons.push(`${rejectedWithReasons.length} markets rejected by empirical filters`);
      }
      return;
    }

    lastScanStatus.opportunitiesFound = opportunities.length;

    // Always show the best opportunity found
    const best = opportunities[0];
    const category = best.marketCategory || 'crypto';

    // Check risk limit for this market's pool
    const isHourly = isHourlyMarket(best.ticker);
    const remainingBudget = getRemainingRiskBudget(best.ticker, userState, userConfig);
    const riskByType = getRiskByType(userState);
    const poolMax = isHourly ? getMaxRisk('hourly', userConfig) : getMaxRisk('other', userConfig);
    const poolCurrent = isHourly ? riskByType.hourly : riskByType.other;
    const poolName = isHourly ? 'HOURLY' : 'OTHER';

    console.log(`💰 Risk [${poolName}]: $${(poolCurrent/100).toFixed(2)} / $${(poolMax/100).toFixed(2)} | Total: $${(riskByType.total/100).toFixed(2)} / $${(getMaxTotalRisk(userConfig)/100).toFixed(2)}`);

    // Display EMPIRICAL analysis for best opportunity
    console.log(`\n💰 BEST EMPIRICAL OPPORTUNITY [${category.toUpperCase()}]:`);
    console.log(`   ${best.title}`);
    console.log(`   📊 Signal Strength: ${best.signalStrength}/100`);
    console.log(`   Side: ${best.betSide} @ ${best.marketPriceCents}¢ | Win rate: ${best.winProbability}% (empirical)`);
    console.log(`   Current: $${best.currentPrice?.toFixed(2) || 'N/A'} | Strike: $${best.strikePrice?.toFixed(2) || 'N/A'}`);
    console.log(`   Distance: ${best.absDistance?.toFixed(2)}% from strike | Regime: ${best.regime}`);
    console.log(`   Edge: +${best.edge?.toFixed(1)}% (after fees) | Sample size: ${best.sampleSize}`);

    // Show other good opportunities
    if (opportunities.length > 1) {
      console.log(`   + ${opportunities.length - 1} more opportunities with signal ≥${minSignal}`);
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
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType, userState, userConfig);
    const tokenName = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
    if (remainingTokenBudget < 10) {
      console.log(`⚠️ Token limit reached for ${tokenName} ($${(getMaxPerToken(userConfig)/100).toFixed(2)} max) - skipping...`);
      console.log('========================================\n');

      lastScanStatus.status = 'token_limit';
      lastScanStatus.statusMessage = `Token limit reached for ${tokenName}`;
      lastScanStatus.blockedReasons.push(`${tokenName} limit: $${(getMaxPerToken(userConfig)/100).toFixed(2)} max per token`);
      return;
    }

    // Display confidence based on signal strength
    const confidenceLevel = best.signalStrength >= 85 ? '✅ HIGH CONFIDENCE (empirical)' :
                           best.signalStrength >= 75 ? '📊 GOOD SIGNAL' : '⚠️ MODERATE SIGNAL';
    console.log(`   ${confidenceLevel}`);
    console.log(`   Token budget for ${tokenName}: $${(remainingTokenBudget/100).toFixed(2)} remaining`);

    // Cap bet at remaining risk budget, max per bet, OR token budget - whichever is lowest
    const maxPerBet = getMaxPerBet(isHourly ? 'hourly' : 'other', userConfig);
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

    // HARD LIMIT CHECK: Validate bet won't exceed ANY limit
    const validation = validateBetWontExceedLimits(best.ticker, totalCost, userState, userConfig);
    if (!validation.valid) {
      console.log(`🚫 Bet blocked: ${validation.reason}`);
      lastScanStatus.status = 'limit_exceeded';
      lastScanStatus.statusMessage = validation.reason;
      return;
    }

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
      status: userConfig.isAuthenticated ? 'pending' : 'simulated',
      auto: true,
      isScaleIn: best.isScaleIn || false,
      scaleInNumber: newBetCount
    };

    // Mark this market as bet on BEFORE placing the bet (or update for scale-in)
    recentBets.set(best.ticker, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      signalStrength: best.signalStrength,
      regime: best.regime,
      betCount: newBetCount
    });

    // Record for empirical rate limiting
    recordEmpiricalBet(best.token || best.cryptoType);

    if (best.isScaleIn) {
      console.log(`📈 SCALE-IN: Adding bet #${newBetCount} on ${best.ticker} (signal increased to ${best.signalStrength})`);
    }

    if (!userConfig.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      userBetHistory.unshift(betRecord);
      userConfig.bankroll -= betRecord.totalCost;

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: userId,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        strikePrice: best.strikePrice,
        currentPrice: best.currentPrice,
        marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // Save user state
      if (userId) saveUserState(userId);

      console.log(`\n🎰 SIMULATED BET PLACED:`);
      console.log(`   ${betRecord.side.toUpperCase()} on ${assetName}`);
      console.log(`   ${count} contracts @ ${priceCents}¢ = $${(betRecord.totalCost/100).toFixed(2)}`);
      console.log(`   Edge: +${best.edge.toFixed(1)}% | Win prob: ${best.winProbability}%`);
      console.log(`   New balance: $${(userConfig.bankroll/100).toFixed(2)}`);
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

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest, userConfig);
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
    userBetHistory.unshift(betRecord);

    // Track for performance analysis
    trackBet({
      ...betRecord,
      userId: userId,
      count: filledCount,
      token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
      predictedProb: parseFloat(best.winProbability),
      marketPrice: betRecord.avgPrice,
      strikePrice: best.strikePrice,
      currentPrice: best.currentPrice,
      marketType: isHourlyMarket(best.ticker) ? 'hourly' : best.ticker?.includes('15M') ? '15min' : 'daily',
      expiryTime: best.expiry || best.close_time
    });

    // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
    // Stop-loss and take-profit handled by active monitoring (evaluateTakeProfit)

    const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
    userConfig.bankroll = balanceData.balance || 0;

    // Save user state after successful bet
    if (userId) saveUserState(userId);

    console.log(`\n✅ REAL BET FILLED:`);
    console.log(`   ${betRecord.side.toUpperCase()} on ${best.cryptoType || best.assetType}`);
    console.log(`   ${filledCount} contracts @ ${betRecord.avgPrice}¢`);
    console.log(`   Edge: +${best.edge.toFixed(1)}% | New balance: $${(userConfig.bankroll/100).toFixed(2)}`);
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
  const userPortfolio = req.userState.portfolio;

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

    // Start take-profit scanning to monitor positions for exit opportunities
    startTakeProfitScanning(15000, req.userId, userConfig, userPortfolio);

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

    // Stop take-profit scanning when auto-bet is disabled
    stopTakeProfitScanning(req.userId);

    res.json({ success: true, message: 'Auto-betting disabled', autoBetEnabled: false });
  } else {
    res.json({
      success: true,
      message: `Auto-betting ${userConfig.autoBetEnabled ? 'running' : 'stopped'}`,
      autoBetEnabled: userConfig.autoBetEnabled
    });
  }
});

// Get auto-bet scan status - also restore interval if needed
app.get('/api/auto-bet/status', (req, res) => {
  const userConfig = req.userState?.config || config;
  const userPortfolio = req.userState?.portfolio || portfolio;

  // CRITICAL FIX: If user has auto-bet enabled but no interval running, restart it
  // This handles server restarts and page refreshes
  if (req.userId && userConfig.autoBetEnabled && !userAutoBetIntervals.has(req.userId)) {
    console.log(`🔄 Restoring auto-bet interval for user ${req.userId}`);
    runAutoBet(req.userId);
    userAutoBetIntervals.set(req.userId, setInterval(() => runAutoBet(req.userId), 10000));

    // Also restore take-profit scanning (per-user)
    if (!userTakeProfitIntervals.has(req.userId)) {
      startTakeProfitScanning(15000, req.userId, userConfig, userPortfolio);
    }
  }

  res.json({
    success: true,
    autoBetEnabled: userConfig.autoBetEnabled,
    intervalRunning: req.userId ? userAutoBetIntervals.has(req.userId) : false,
    ...lastScanStatus
  });
});

// ============================================
// WEBSOCKET STATUS API (Phase 1)
// ============================================

// Get WebSocket connection status
app.get('/api/websocket/status', (req, res) => {
  const status = kalshiWs ? kalshiWs.getStatus() : {
    connected: false,
    authenticated: false,
    subscriptions: 0,
    tickersCached: 0,
    orderbooksCached: 0
  };

  res.json({
    success: true,
    enabled: wsEnabled,
    ...status
  });
});

// ============================================
// ORDERBOOK API (Phase 2)
// ============================================

// Get orderbook for a specific market
app.get('/api/orderbook/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const userConfig = req.userState?.config || config;

    const orderbook = await fetchOrderbook(ticker, userConfig);

    res.json({
      success: true,
      orderbook,
      cached: orderbookCache.has(ticker)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// MOMENTUM/CANDLESTICK API (Phase 4)
// ============================================

// Get candlestick data for a market
app.get('/api/candlesticks/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const { period = 1, count = 15 } = req.query;
    const userConfig = req.userState?.config || config;

    const candleData = await fetchCandlesticks(ticker, parseInt(period), parseInt(count), userConfig);
    const momentum = candleData?.candles?.length >= 3 ? analyzeMarketMomentum(candleData) : null;

    res.json({
      success: true,
      candlesticks: candleData,
      momentum
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HISTORICAL DATA ANALYSIS API
// ============================================

// ============================================
// EMPIRICAL DATA-DRIVEN BETTING SYSTEM
// ============================================
// Philosophy: Pure lookup-based evaluation from 6000+ historical settlements
// No theoretical probability models - let the data speak

// Track recent bets for rate limiting and performance
const empiricalBetTracking = {
  recentBetsThisHour: [],  // Timestamps of bets in the last hour
  betsByToken: new Map(),  // Token -> count of bets in last hour
  lastSpikeTimes: new Map() // Token -> timestamp of last detected spike
};

/**
 * Detect current volatility regime for a token
 * @param {string} token - 'BTC', 'ETH', or 'SOL'
 * @param {Array} priceHistory - Recent price history
 * @returns {object} Regime info: { regime: 'low'|'medium'|'high'|'spike', reason: string }
 */
function detectVolatilityRegime(token, priceHistory = null) {
  const history = priceHistory || cryptoPrices[token]?.history || [];
  const now = Date.now();

  // Default to medium if insufficient data
  if (history.length < 10) {
    return { regime: 'medium', reason: 'Insufficient price history', multiplier: 1.0 };
  }

  // Check for recent spike (2%+ move in 5 minutes)
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recentPrices = history.filter(p => p.time > fiveMinAgo);

  if (recentPrices.length >= 2) {
    const firstPrice = recentPrices[0]?.price;
    const lastPrice = recentPrices[recentPrices.length - 1]?.price;
    if (firstPrice && lastPrice) {
      const pctMove = Math.abs((lastPrice - firstPrice) / firstPrice * 100);
      if (pctMove >= 2.0) {
        empiricalBetTracking.lastSpikeTimes.set(token, now);
        return {
          regime: 'spike',
          reason: `${pctMove.toFixed(2)}% move in 5 min`,
          multiplier: 0,
          sitOut: true
        };
      }
    }
  }

  // Check if we're still in cooldown from a recent spike (5 min cooldown)
  const lastSpike = empiricalBetTracking.lastSpikeTimes.get(token);
  if (lastSpike && (now - lastSpike) < 5 * 60 * 1000) {
    return {
      regime: 'spike',
      reason: 'Spike cooldown period',
      multiplier: 0,
      sitOut: true
    };
  }

  // Calculate 15-minute realized volatility
  const fifteenMinAgo = now - 15 * 60 * 1000;
  const windowPrices = history.filter(p => p.time > fifteenMinAgo);

  if (windowPrices.length < 5) {
    return { regime: 'medium', reason: 'Limited recent data', multiplier: 1.0 };
  }

  // Calculate volatility as std dev of returns
  const returns = [];
  for (let i = 1; i < windowPrices.length; i++) {
    const ret = (windowPrices[i].price - windowPrices[i-1].price) / windowPrices[i-1].price;
    returns.push(ret);
  }

  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100; // As percentage

  // Get token-specific volatility thresholds from learned data
  const tokenData = learnedParams.byToken[token];
  const avgVol = tokenData?.avgSettlementDistance || 0.5;

  // Classify regime based on current vs historical volatility
  if (volatility < avgVol * 0.7) {
    return {
      regime: 'low',
      reason: `Low vol (${volatility.toFixed(3)}% vs avg ${avgVol.toFixed(3)}%)`,
      multiplier: 1.05,
      volatility
    };
  } else if (volatility > avgVol * 1.5) {
    return {
      regime: 'high',
      reason: `High vol (${volatility.toFixed(3)}% vs avg ${avgVol.toFixed(3)}%)`,
      multiplier: 0.92,
      volatility
    };
  } else {
    return {
      regime: 'medium',
      reason: `Normal vol (${volatility.toFixed(3)}%)`,
      multiplier: 1.0,
      volatility
    };
  }
}

/**
 * Calculate signal strength score (0-100) from empirical factors
 * @param {number} winRate - Empirical win rate from lookup tables (50-100)
 * @param {number} edge - Edge after fees (%)
 * @param {number} sampleSize - Number of samples at this distance bucket
 * @param {string} regime - Volatility regime
 * @param {number} timeRemaining - Minutes until expiry
 * @returns {number} Signal strength 0-100
 */
function calculateSignalStrength(winRate, edge, sampleSize, regime, timeRemaining) {
  let score = 0;

  // Win rate contribution: 0-40 points
  // 50% = 0 points, 70% = 20 points, 90% = 40 points
  const winRatePoints = Math.max(0, Math.min(40, (winRate - 50) * 2));
  score += winRatePoints;

  // Edge contribution: 0-30 points
  // 0% = 0 points, 5% = 10 points, 15%+ = 30 points
  const edgePoints = Math.max(0, Math.min(30, edge * 2));
  score += edgePoints;

  // Sample size contribution: 0-15 points
  // 0 samples = 0 points, 50 samples = 7.5 points, 100+ samples = 15 points
  const samplePoints = Math.min(15, (sampleSize / 100) * 15);
  score += samplePoints;

  // Regime contribution: -15 to +10 points
  const regimePoints = {
    'low': 10,      // Calm market = safer to bet
    'medium': 0,    // Normal conditions
    'high': -10,    // Volatile = riskier
    'spike': -15    // Don't bet
  };
  score += regimePoints[regime] || 0;

  // Time sweet spot contribution: 0-5 points
  // Optimal: 3-8 minutes (enough time for price to stabilize but not too much uncertainty)
  let timePoints = 0;
  if (timeRemaining >= 3 && timeRemaining <= 8) {
    timePoints = 5; // Sweet spot
  } else if (timeRemaining >= 2 && timeRemaining <= 12) {
    timePoints = 2; // Acceptable range
  } else {
    timePoints = 0; // Too early or too late
  }
  score += timePoints;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Check if we should sit out this interval
 * @param {object} tables - Empirical tables
 * @param {string} token - Token to check (optional, for token-specific limits)
 * @returns {object} { sitOut: boolean, reasons: string[] }
 */
function shouldSitOut(tables, token = null) {
  const reasons = [];
  const rules = tables?.selectivityRules || learnedParams.selectivityRules;
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Rate limiting: max bets per hour
  empiricalBetTracking.recentBetsThisHour = empiricalBetTracking.recentBetsThisHour
    .filter(ts => ts > oneHourAgo);

  if (empiricalBetTracking.recentBetsThisHour.length >= (rules?.maxBetsPerHour || 6)) {
    reasons.push(`Rate limit: ${empiricalBetTracking.recentBetsThisHour.length}/${rules?.maxBetsPerHour || 6} bets this hour`);
  }

  // Token-specific rate limiting
  if (token) {
    const tokenBets = empiricalBetTracking.betsByToken.get(token) || 0;
    if (tokenBets >= (rules?.maxBetsPerToken || 3)) {
      reasons.push(`Token limit: ${tokenBets}/${rules?.maxBetsPerToken || 3} ${token} bets this hour`);
    }
  }

  // Check if we have sufficient data
  if ((tables?.sampleSize || learnedParams.sampleSize) < 100) {
    reasons.push('Insufficient historical data for empirical betting');
  }

  return {
    sitOut: reasons.length > 0,
    reasons
  };
}

/**
 * Look up empirical win rate for a given distance from strike
 * @param {number} pctFromStrike - Absolute percentage distance from strike
 * @returns {object} { winRate: number, sampleSize: number, bucket: number }
 */
function lookupEmpiricalWinRate(pctFromStrike) {
  const absDistance = Math.abs(pctFromStrike);
  const winRateData = learnedParams.winRateByDistance || DEFAULT_EMPIRICAL_TABLES.winRateByDistance;

  // Find the appropriate bucket
  const buckets = Object.keys(winRateData).map(Number).sort((a, b) => a - b);

  for (const bucket of buckets) {
    if (absDistance <= bucket) {
      const data = winRateData[bucket];
      return {
        winRate: data?.favoredWinRate || 50,
        sampleSize: data?.count || 0,
        bucket,
        surpriseRate: data?.surpriseRate || 50
      };
    }
  }

  // Beyond all buckets - use the largest one with extrapolation
  const maxBucket = buckets[buckets.length - 1];
  const maxData = winRateData[maxBucket];
  const extrapolatedWinRate = Math.min(98, (maxData?.favoredWinRate || 85) + (absDistance - maxBucket) * 2);

  return {
    winRate: extrapolatedWinRate,
    sampleSize: maxData?.count || 0,
    bucket: maxBucket,
    extrapolated: true
  };
}

/**
 * Evaluate a market opportunity using pure empirical data
 * @param {object} parsed - Parsed market data
 * @param {object} currentPrice - Current crypto price
 * @param {object} tables - Empirical lookup tables
 * @param {object} orderbook - Orderbook data (optional)
 * @returns {object} { shouldBet, signalStrength, side, edge, winRate, reasons }
 */
function evaluateOpportunityEmpirical(parsed, currentPrice, tables = null, orderbook = null) {
  const empiricalTables = tables || learnedParams;
  const token = parsed.cryptoType;
  const strikePrice = parsed.strikePrice;
  const timeRemaining = parsed.timeRemainingMinutes || 15;

  // Basic validation
  if (!token || !strikePrice || !currentPrice) {
    return { shouldBet: false, reasons: ['Missing required data'] };
  }

  // Calculate distance from strike
  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice) * 100;
  const absDistance = Math.abs(pctFromStrike);

  // Detect volatility regime
  const regime = detectVolatilityRegime(token);

  // Check for sit-out conditions
  if (regime.sitOut) {
    return {
      shouldBet: false,
      regime: regime.regime,
      reasons: [`Volatility spike: ${regime.reason}`],
      signalStrength: 0
    };
  }

  // Look up empirical win rate
  const empirical = lookupEmpiricalWinRate(absDistance);

  // Get token-specific optimal entry windows
  const tokenData = empiricalTables.byToken?.[token] || DEFAULT_EMPIRICAL_TABLES.byToken[token];
  const entryWindows = tokenData?.optimalEntryWindows || {};

  // Check if within optimal entry window
  const withinDistanceWindow = absDistance >= (entryWindows.distanceMin || 0.5) &&
                               absDistance <= (entryWindows.distanceMax || 3.0);
  const withinTimeWindow = timeRemaining >= (entryWindows.timeMin || 2) &&
                           timeRemaining <= (entryWindows.timeMax || 12);

  // Determine bet side based on price position
  const isAboveStrike = currentPrice > strikePrice;
  let betSide, marketPrice;

  if (parsed.marketType === 'above') {
    // YES wins if price >= strike at expiry
    if (isAboveStrike) {
      betSide = 'YES';
      marketPrice = parsed.yesAsk || 0.5;
    } else {
      betSide = 'NO';
      marketPrice = parsed.noAsk || 0.5;
    }
  } else {
    // Below market: YES wins if price < strike
    if (isAboveStrike) {
      betSide = 'NO';
      marketPrice = parsed.noAsk || 0.5;
    } else {
      betSide = 'YES';
      marketPrice = parsed.yesAsk || 0.5;
    }
  }

  const marketPriceCents = Math.round(marketPrice * 100);

  // Check price window
  const withinPriceWindow = marketPriceCents >= (entryWindows.priceMin || 35) &&
                            marketPriceCents <= (entryWindows.priceMax || 75);

  // Apply regime multiplier to win rate (cap at 99.5% - can't exceed 100%)
  const adjustedWinRate = Math.min(99.5, empirical.winRate * (regime.multiplier || 1.0));

  // Calculate edge: our win rate - market implied probability - fees
  const marketImpliedProb = marketPrice * 100; // Market price as probability
  const feePct = 2; // Approximate Kalshi fee
  const grossEdge = adjustedWinRate - marketImpliedProb;
  const netEdge = grossEdge - feePct;

  // Calculate signal strength
  const signalStrength = calculateSignalStrength(
    adjustedWinRate,
    netEdge,
    empirical.sampleSize,
    regime.regime,
    timeRemaining
  );

  // Get selectivity rules
  const rules = empiricalTables.selectivityRules || DEFAULT_EMPIRICAL_TABLES.selectivityRules;

  // Build rejection reasons
  const reasons = [];

  if (signalStrength < (rules.minSignalStrength || 70)) {
    reasons.push(`Signal strength ${signalStrength} < ${rules.minSignalStrength || 70}`);
  }

  if (adjustedWinRate < (rules.minEmpiricalWinRate || 62)) {
    reasons.push(`Win rate ${adjustedWinRate.toFixed(1)}% < ${rules.minEmpiricalWinRate || 62}%`);
  }

  if (netEdge < (rules.minEdgeAfterFees || 5)) {
    reasons.push(`Edge ${netEdge.toFixed(1)}% < ${rules.minEdgeAfterFees || 5}%`);
  }

  if (!withinDistanceWindow) {
    reasons.push(`Distance ${absDistance.toFixed(2)}% outside optimal window [${entryWindows.distanceMin}-${entryWindows.distanceMax}%]`);
  }

  if (!withinTimeWindow) {
    reasons.push(`Time ${timeRemaining}min outside optimal window [${entryWindows.timeMin}-${entryWindows.timeMax}min]`);
  }

  if (!withinPriceWindow) {
    reasons.push(`Price ${marketPriceCents}¢ outside optimal window [${entryWindows.priceMin}-${entryWindows.priceMax}¢]`);
  }

  // Final decision
  const shouldBet = reasons.length === 0 && signalStrength >= (rules.minSignalStrength || 70);

  return {
    shouldBet,
    signalStrength,
    side: betSide,
    edge: netEdge,
    grossEdge,
    winRate: adjustedWinRate,
    rawWinRate: empirical.winRate,
    marketImpliedProb,
    marketPrice,
    marketPriceCents,
    pctFromStrike,
    absDistance,
    regime: regime.regime,
    regimeMultiplier: regime.multiplier,
    sampleSize: empirical.sampleSize,
    bucket: empirical.bucket,
    extrapolated: empirical.extrapolated,
    withinDistanceWindow,
    withinTimeWindow,
    withinPriceWindow,
    timeRemaining,
    token,
    reasons,
    // For display
    winProbability: adjustedWinRate.toFixed(1),
    isRecommended: shouldBet
  };
}

/**
 * Build comprehensive empirical lookup tables from settlement data
 * @param {Array} settlements - Array of settlement objects
 * @returns {object} Complete empirical tables
 */
function buildEmpiricalLookupTables(settlements) {
  if (!settlements || settlements.length < 100) {
    console.log(`⚠️ Insufficient data for empirical tables: ${settlements?.length || 0} settlements`);
    return null;
  }

  console.log(`📊 Building empirical tables from ${settlements.length} settlements...`);

  const tables = JSON.parse(JSON.stringify(DEFAULT_EMPIRICAL_TABLES));
  tables.sampleSize = settlements.length;
  tables.lastUpdated = new Date().toISOString();

  // Process settlements for distance analysis
  const distances = settlements.map(s => ({
    pctFromStrike: Math.abs((s.settlementPrice - s.strikePrice) / s.strikePrice * 100),
    result: s.result,
    token: s.token,
    wasAboveStrike: s.settlementPrice > s.strikePrice,
    wasBelowStrike: s.settlementPrice < s.strikePrice,
    closeTime: s.closeTime
  }));

  // Build win rate by distance buckets
  const distanceBuckets = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0];

  for (const bucket of distanceBuckets) {
    const withinBucket = distances.filter(d => d.pctFromStrike <= bucket);
    if (withinBucket.length < 5) continue;

    let favoredWins = 0;
    for (const d of withinBucket) {
      const yesFavored = d.wasAboveStrike;
      const noFavored = d.wasBelowStrike;
      const yesWon = d.result === 'yes';
      const noWon = d.result === 'no';

      if ((yesFavored && yesWon) || (noFavored && noWon)) {
        favoredWins++;
      }
    }

    const favoredWinRate = (favoredWins / withinBucket.length * 100);

    tables.winRateByDistance[bucket] = {
      count: withinBucket.length,
      favoredWinRate: parseFloat(favoredWinRate.toFixed(2)),
      surpriseRate: parseFloat((100 - favoredWinRate).toFixed(2))
    };
  }

  // Build token-specific stats
  const tokens = ['BTC', 'ETH', 'SOL'];
  for (const token of tokens) {
    const tokenSettlements = distances.filter(d => d.token === token);
    if (tokenSettlements.length < 20) continue;

    const tokenDistances = tokenSettlements.map(d => d.pctFromStrike);
    const avgDistance = tokenDistances.reduce((a, b) => a + b, 0) / tokenDistances.length;
    const variance = tokenDistances.reduce((a, b) => a + Math.pow(b - avgDistance, 2), 0) / tokenDistances.length;
    const stdDev = Math.sqrt(variance);

    const yesWins = tokenSettlements.filter(d => d.result === 'yes').length;
    const yesWinRate = (yesWins / tokenSettlements.length * 100);
    const noWinRate = 100 - yesWinRate;

    tables.byToken[token] = {
      ...tables.byToken[token],
      sampleSize: tokenSettlements.length,
      avgSettlementDistance: parseFloat(avgDistance.toFixed(4)),
      settlementDistanceStdDev: parseFloat(stdDev.toFixed(4)),
      yesWinRate: parseFloat(yesWinRate.toFixed(2)),
      noWinRate: parseFloat(noWinRate.toFixed(2)),
      noBias: parseFloat((noWinRate - yesWinRate).toFixed(2))
    };

    // Learn optimal entry windows from data
    // Find distance range where favored side wins >= 65%
    let optimalDistanceMin = 0.5;
    let optimalDistanceMax = 3.0;

    for (const bucket of distanceBuckets) {
      const bucketData = tables.winRateByDistance[bucket];
      if (bucketData && bucketData.favoredWinRate >= 65 && bucketData.count >= 20) {
        optimalDistanceMin = Math.min(optimalDistanceMin, bucket);
        break;
      }
    }

    for (const bucket of [...distanceBuckets].reverse()) {
      const bucketData = tables.winRateByDistance[bucket];
      if (bucketData && bucketData.favoredWinRate >= 75 && bucketData.count >= 20) {
        optimalDistanceMax = Math.max(optimalDistanceMax, bucket);
        break;
      }
    }

    tables.byToken[token].optimalEntryWindows = {
      ...tables.byToken[token].optimalEntryWindows,
      distanceMin: optimalDistanceMin,
      distanceMax: Math.max(optimalDistanceMax, optimalDistanceMin + 1)
    };
  }

  // Calculate volatility rankings
  const tokenVolatilities = Object.entries(tables.byToken)
    .map(([token, data]) => ({
      token,
      volatility: data.avgSettlementDistance || 0
    }))
    .sort((a, b) => a.volatility - b.volatility);

  tokenVolatilities.forEach((item, index) => {
    if (tables.byToken[item.token]) {
      tables.byToken[item.token].volatilityRank = index + 1;
    }
  });

  // Update global YES/NO bias
  const globalYesWins = distances.filter(d => d.result === 'yes').length;
  const globalYesRate = (globalYesWins / distances.length * 100);

  tables.yesNoBias = {
    global: {
      yesWinRate: parseFloat(globalYesRate.toFixed(2)),
      noWinRate: parseFloat((100 - globalYesRate).toFixed(2)),
      noBias: parseFloat((100 - 2 * globalYesRate).toFixed(2)),
      sampleSize: distances.length
    }
  };

  // Set optimal selectivity rules based on data
  // Find the threshold where we have consistent edge
  let minWinRateForAuto = 62;
  for (const bucket of distanceBuckets) {
    const bucketData = tables.winRateByDistance[bucket];
    if (bucketData && bucketData.favoredWinRate >= 62 && bucketData.count >= 50) {
      minWinRateForAuto = Math.max(62, Math.min(68, Math.floor(bucketData.favoredWinRate - 3)));
      break;
    }
  }

  tables.selectivityRules = {
    ...tables.selectivityRules,
    minEmpiricalWinRate: minWinRateForAuto
  };

  tables.probabilityThresholds = {
    autoMinProbability: minWinRateForAuto,
    manualMinProbability: Math.max(55, minWinRateForAuto - 7)
  };

  // Calculate confidence based on sample size
  tables.confidence = Math.min(0.99, settlements.length / 5000);

  console.log(`✅ Built empirical tables:`);
  console.log(`   Sample size: ${settlements.length}`);
  console.log(`   Win rate buckets: ${Object.keys(tables.winRateByDistance).filter(k => tables.winRateByDistance[k].count > 0).length}`);
  console.log(`   Min auto win rate: ${minWinRateForAuto}%`);
  for (const token of tokens) {
    const data = tables.byToken[token];
    console.log(`   ${token}: ${data.sampleSize} samples, avg distance ${data.avgSettlementDistance?.toFixed(3)}%, NO bias ${data.noBias}%`);
  }

  return tables;
}

/**
 * Record a bet for rate limiting tracking
 * @param {string} token - Token that was bet on
 */
function recordEmpiricalBet(token) {
  const now = Date.now();
  empiricalBetTracking.recentBetsThisHour.push(now);

  const currentCount = empiricalBetTracking.betsByToken.get(token) || 0;
  empiricalBetTracking.betsByToken.set(token, currentCount + 1);

  // Clean up old entries every 10 bets
  if (empiricalBetTracking.recentBetsThisHour.length % 10 === 0) {
    const oneHourAgo = now - 60 * 60 * 1000;
    empiricalBetTracking.recentBetsThisHour = empiricalBetTracking.recentBetsThisHour
      .filter(ts => ts > oneHourAgo);

    // Reset token counts every hour
    for (const [t, count] of empiricalBetTracking.betsByToken) {
      if (count > 0) {
        empiricalBetTracking.betsByToken.set(t, Math.max(0, count - 1));
      }
    }
  }
}

// ============================================
// BULK DATA COLLECTION & THRESHOLD LEARNING
// ============================================

/**
 * Fetch bulk historical settlement data with cursor pagination
 * @param {string} token - 'all', 'BTC', 'ETH', or 'SOL'
 * @param {number} maxPages - Maximum pages to fetch per token (100 events per page)
 * @param {object} userConfig - User configuration for API auth
 * @returns {Array} Array of settlement objects
 */
async function fetchBulkHistoricalData(token = 'all', maxPages = 50, userConfig = null) {
  const cfg = userConfig || config;
  const tokens = token === 'all' ? ['BTC', 'ETH', 'SOL'] : [token.toUpperCase()];
  const allSettlements = [];

  for (const t of tokens) {
    console.log(`📊 Fetching ${t} historical data...`);
    const series = `KX${t}15M`;
    const allEvents = [];
    let cursor = null;
    let page = 0;

    // Paginate through all events for this token
    // Note: Kalshi uses "settled" not "closed" for finalized events
    while (page < maxPages) {
      try {
        const url = cursor
          ? `/events?limit=100&series_ticker=${series}&status=settled&cursor=${cursor}`
          : `/events?limit=100&series_ticker=${series}&status=settled`;

        const response = await kalshiRequest('GET', url, null, cfg);

        if (response.events && response.events.length > 0) {
          allEvents.push(...response.events);
        }

        cursor = response.cursor;
        page++;

        console.log(`   Page ${page}: ${allEvents.length} events total`);

        if (!cursor || !response.events || response.events.length === 0) break;
        await sleep(500); // Rate limit protection
      } catch (err) {
        console.error(`   Error fetching page ${page} for ${t}:`, err.message);
        break;
      }
    }

    console.log(`   📋 Fetching market details for ${allEvents.length} ${t} events...`);

    // Sample events to avoid hitting rate limits (max 800 per token for ~2400 total)
    const maxEventsPerToken = 800;
    const eventsToProcess = allEvents.length > maxEventsPerToken
      ? allEvents.slice(0, maxEventsPerToken) // Most recent events
      : allEvents;

    if (allEvents.length > maxEventsPerToken) {
      console.log(`   📉 Sampling ${maxEventsPerToken}/${allEvents.length} events to respect rate limits`);
    }

    // For each event, fetch the market to get settlement data
    let processedCount = 0;
    let consecutiveErrors = 0;
    for (const event of eventsToProcess) {
      try {
        const marketData = await kalshiRequest('GET', `/markets?event_ticker=${event.event_ticker}`, null, cfg);
        const market = marketData.markets?.[0];

        if (market && market.floor_strike && market.expiration_value !== undefined) {
          allSettlements.push({
            ticker: market.ticker,
            eventTicker: event.event_ticker,
            token: t,
            strikePrice: market.floor_strike,
            settlementPrice: parseFloat(market.expiration_value),
            result: market.result, // 'yes' or 'no'
            closeTime: market.close_time,
            volume: market.volume || 0
          });
        }

        processedCount++;
        consecutiveErrors = 0; // Reset on success
        if (processedCount % 100 === 0) {
          console.log(`   Processed ${processedCount}/${eventsToProcess.length} ${t} markets (${allSettlements.filter(s => s.token === t).length} valid)...`);
        }

        await sleep(250); // Rate limit between market fetches (4 req/sec)
      } catch (err) {
        // Handle rate limiting with exponential backoff
        if (err.message.includes('429')) {
          consecutiveErrors++;
          const backoffMs = Math.min(5000, 500 * Math.pow(2, consecutiveErrors));
          console.log(`   ⏳ Rate limited, backing off ${backoffMs}ms...`);
          await sleep(backoffMs);
        } else if (!err.message.includes('404')) {
          console.error(`   Error fetching market for ${event.event_ticker}:`, err.message);
        }
        processedCount++;
      }
    }

    const tokenSettlements = allSettlements.filter(s => s.token === t).length;
    console.log(`   ✅ ${t}: ${tokenSettlements} settlements with valid data`);
  }

  return allSettlements;
}

/**
 * Analyze settlement data to find optimal thresholds
 * @param {Array} settlements - Array of settlement objects
 * @returns {object} Analysis results with optimal thresholds
 */
function analyzeSettlementData(settlements) {
  if (!settlements || settlements.length === 0) {
    return { error: 'No settlement data to analyze' };
  }

  // Calculate distance from strike for each settlement
  const distances = settlements.map(s => ({
    pctFromStrike: Math.abs((s.settlementPrice - s.strikePrice) / s.strikePrice * 100),
    result: s.result,
    token: s.token,
    ticker: s.ticker,
    // Add direction info for YES/NO bias analysis
    wasAboveStrike: s.settlementPrice > s.strikePrice,
    wasBelowStrike: s.settlementPrice < s.strikePrice
  }));

  // Distribution analysis at various thresholds
  const coinFlipThresholds = [0.05, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30, 0.35, 0.40];
  const analysis = {};

  for (const threshold of coinFlipThresholds) {
    const withinThreshold = distances.filter(d => d.pctFromStrike < threshold);
    const yesWins = withinThreshold.filter(d => d.result === 'yes').length;
    const noWins = withinThreshold.filter(d => d.result === 'no').length;

    analysis[threshold] = {
      count: withinThreshold.length,
      percent: withinThreshold.length > 0
        ? (withinThreshold.length / distances.length * 100).toFixed(1)
        : '0.0',
      yesWins,
      noWins,
      // Win rate when within this threshold (should be ~50% for true coin flips)
      yesWinRate: withinThreshold.length > 0
        ? (yesWins / withinThreshold.length * 100).toFixed(1)
        : '0.0'
    };
  }

  // Find optimal threshold: where win rate is closest to 50% with meaningful sample
  let optimalThreshold = 0.15; // Default
  let closestTo50 = 100;

  for (const [threshold, data] of Object.entries(analysis)) {
    const yesRate = parseFloat(data.yesWinRate);
    const diff = Math.abs(yesRate - 50);
    // Require at least 10 samples and win rate between 45-55% (true coin flip range)
    if (data.count >= 10 && diff < closestTo50 && yesRate >= 45 && yesRate <= 55) {
      closestTo50 = diff;
      optimalThreshold = parseFloat(threshold);
    }
  }

  // Group analysis by token
  const byToken = {};
  const tokens = [...new Set(distances.map(d => d.token))];

  for (const token of tokens) {
    const tokenDistances = distances.filter(d => d.token === token);
    const tokenAnalysis = {};

    for (const threshold of coinFlipThresholds) {
      const withinThreshold = tokenDistances.filter(d => d.pctFromStrike < threshold);
      const yesWins = withinThreshold.filter(d => d.result === 'yes').length;

      tokenAnalysis[threshold] = {
        count: withinThreshold.length,
        percent: tokenDistances.length > 0
          ? (withinThreshold.length / tokenDistances.length * 100).toFixed(1)
          : '0.0',
        yesWinRate: withinThreshold.length > 0
          ? (yesWins / withinThreshold.length * 100).toFixed(1)
          : '0.0'
      };
    }

    // Find token-specific optimal threshold
    let tokenOptimal = 0.15;
    let tokenClosest = 100;

    for (const [threshold, data] of Object.entries(tokenAnalysis)) {
      const yesRate = parseFloat(data.yesWinRate);
      const diff = Math.abs(yesRate - 50);
      if (data.count >= 5 && diff < tokenClosest && yesRate >= 45 && yesRate <= 55) {
        tokenClosest = diff;
        tokenOptimal = parseFloat(threshold);
      }
    }

    // Calculate token-specific YES/NO win rates
    const tokenYesWins = tokenDistances.filter(d => d.result === 'yes').length;
    const tokenNoWins = tokenDistances.filter(d => d.result === 'no').length;
    const tokenYesWinRate = tokenDistances.length > 0 ? (tokenYesWins / tokenDistances.length * 100) : 50;
    const tokenNoWinRate = tokenDistances.length > 0 ? (tokenNoWins / tokenDistances.length * 100) : 50;

    // Calculate token volatility (average distance and std dev)
    const tokenDistanceValues = tokenDistances.map(d => d.pctFromStrike);
    const tokenAvgDistance = tokenDistanceValues.length > 0
      ? tokenDistanceValues.reduce((a, b) => a + b, 0) / tokenDistanceValues.length
      : 0;
    const tokenDistanceVariance = tokenDistanceValues.length > 0
      ? tokenDistanceValues.reduce((sum, d) => sum + Math.pow(d - tokenAvgDistance, 2), 0) / tokenDistanceValues.length
      : 0;
    const tokenDistanceStdDev = Math.sqrt(tokenDistanceVariance);

    byToken[token] = {
      sampleSize: tokenDistances.length,
      analysis: tokenAnalysis,
      optimalThreshold: tokenOptimal,
      coinFlipPct: tokenAnalysis[tokenOptimal]?.percent || '0.0',
      // New metrics for data-driven improvements
      avgSettlementDistance: parseFloat(tokenAvgDistance.toFixed(4)),
      settlementDistanceStdDev: parseFloat(tokenDistanceStdDev.toFixed(4)),
      yesWinRate: parseFloat(tokenYesWinRate.toFixed(2)),
      noWinRate: parseFloat(tokenNoWinRate.toFixed(2)),
      noBias: parseFloat((tokenNoWinRate - tokenYesWinRate).toFixed(2)) // Positive = NO wins more often
    };
  }

  // Calculate overall statistics
  const allDistances = distances.map(d => d.pctFromStrike);
  allDistances.sort((a, b) => a - b);

  const stats = {
    min: allDistances[0]?.toFixed(4) || 0,
    max: allDistances[allDistances.length - 1]?.toFixed(4) || 0,
    median: allDistances[Math.floor(allDistances.length / 2)]?.toFixed(4) || 0,
    mean: (allDistances.reduce((a, b) => a + b, 0) / allDistances.length).toFixed(4),
    p10: allDistances[Math.floor(allDistances.length * 0.1)]?.toFixed(4) || 0,
    p25: allDistances[Math.floor(allDistances.length * 0.25)]?.toFixed(4) || 0,
    p75: allDistances[Math.floor(allDistances.length * 0.75)]?.toFixed(4) || 0,
    p90: allDistances[Math.floor(allDistances.length * 0.9)]?.toFixed(4) || 0
  };

  // ===== NEW: YES/NO BIAS ANALYSIS =====
  // Calculate global YES/NO win rates
  const globalYesWins = distances.filter(d => d.result === 'yes').length;
  const globalNoWins = distances.filter(d => d.result === 'no').length;
  const globalYesWinRate = distances.length > 0 ? (globalYesWins / distances.length * 100) : 50;
  const globalNoWinRate = distances.length > 0 ? (globalNoWins / distances.length * 100) : 50;
  const globalNoBias = globalNoWinRate - globalYesWinRate; // Positive = NO wins more

  const yesNoBias = {
    global: {
      yesWinRate: parseFloat(globalYesWinRate.toFixed(2)),
      noWinRate: parseFloat(globalNoWinRate.toFixed(2)),
      noBias: parseFloat(globalNoBias.toFixed(2)),
      sampleSize: distances.length
    }
  };

  // ===== NEW: WIN RATE BY DISTANCE BUCKETS =====
  // Analyze empirical win rates at different distance thresholds
  const distanceBuckets = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0];
  const winRateByDistance = {};

  for (const bucket of distanceBuckets) {
    // Find settlements where price was within this distance from strike
    const withinBucket = distances.filter(d => d.pctFromStrike <= bucket);
    if (withinBucket.length < 5) continue; // Need minimum sample size

    // For each settlement, determine if the "favored side" won
    // Favored side = the direction the price was when the bet would have been placed
    // If price > strike, YES is favored; if price < strike, NO is favored
    let favoredWins = 0;
    for (const d of withinBucket) {
      // If price was above strike (YES favored) and YES won, or
      // If price was below strike (NO favored) and NO won
      const yesFavored = d.wasAboveStrike;
      const noFavored = d.wasBelowStrike;
      const yesWon = d.result === 'yes';
      const noWon = d.result === 'no';

      if ((yesFavored && yesWon) || (noFavored && noWon)) {
        favoredWins++;
      }
    }

    const favoredWinRate = (favoredWins / withinBucket.length * 100);

    winRateByDistance[bucket] = {
      count: withinBucket.length,
      favoredSideWinRate: parseFloat(favoredWinRate.toFixed(2)),
      // Also track the surprise rate (unfavored side wins)
      surpriseRate: parseFloat((100 - favoredWinRate).toFixed(2))
    };
  }

  // ===== NEW: PROBABILITY THRESHOLD ANALYSIS =====
  // Analyze what minimum probability leads to profitability
  // Use distance buckets to infer approximate probability
  // Distance of ~0.5% -> roughly 70% win chance for favored side based on historical data
  // Distance of ~1.0% -> roughly 80% win chance, etc.

  // Find the distance threshold where favored side wins >= 60% (break-even for betting)
  let autoMinDistance = 0.5; // Default: 0.5% distance
  for (const bucket of distanceBuckets) {
    const data = winRateByDistance[bucket];
    if (data && data.favoredSideWinRate >= 60 && data.count >= 20) {
      autoMinDistance = bucket;
      break;
    }
  }

  // Convert distance to approximate probability for threshold
  // Higher distance = higher win rate for favored side
  const probabilityThresholds = {
    autoMinProbability: 60, // Default, will be updated based on analysis
    manualMinProbability: 55, // Can be more aggressive manually
    minDistanceForAuto: autoMinDistance
  };

  // Calculate volatility rankings for tokens
  const tokenVolatilities = Object.entries(byToken).map(([token, data]) => ({
    token,
    volatility: data.avgSettlementDistance || 0
  })).sort((a, b) => a.volatility - b.volatility);

  // Assign volatility ranks (1=lowest/safest, 3=highest/riskiest)
  tokenVolatilities.forEach((item, index) => {
    if (byToken[item.token]) {
      byToken[item.token].volatilityRank = index + 1;
    }
  });

  return {
    totalSamples: settlements.length,
    analysis,
    optimalThreshold,
    byToken,
    distanceStats: stats,
    confidence: Math.min(0.99, settlements.length / 5000), // Confidence grows with sample size
    // New data-driven analysis results
    yesNoBias,
    winRateByDistance,
    probabilityThresholds
  };
}

/**
 * Update learned parameters from historical data
 * NOW BUILDS COMPREHENSIVE EMPIRICAL LOOKUP TABLES
 * This is the main learning function
 */
async function updateLearnedParameters(userConfig = null) {
  console.log('📚 Starting EMPIRICAL TABLES build from historical data...');

  try {
    const settlements = await fetchBulkHistoricalData('all', 50, userConfig);

    if (settlements.length < 100) {
      console.log(`⚠️ Insufficient data for learning: only ${settlements.length} settlements`);
      return { success: false, error: 'Insufficient data', sampleSize: settlements.length };
    }

    // Build comprehensive empirical tables using the new function
    const empiricalTables = buildEmpiricalLookupTables(settlements);

    if (!empiricalTables) {
      console.log('⚠️ Failed to build empirical tables');
      return { success: false, error: 'Failed to build empirical tables' };
    }

    // Also run legacy analysis for backward compatibility
    const analysis = analyzeSettlementData(settlements);

    // Merge empirical tables into learnedParams
    learnedParams = {
      ...learnedParams,
      ...empiricalTables,
      // Keep legacy thresholds for compatibility
      thresholds: {
        ...learnedParams.thresholds,
        coinFlipExit: analysis.optimalThreshold
      }
    };

    // Merge token data (empirical tables + legacy analysis)
    for (const [token, data] of Object.entries(analysis.byToken)) {
      learnedParams.byToken[token] = {
        ...learnedParams.byToken[token],
        coinFlipThreshold: data.optimalThreshold,
        coinFlipPct: parseFloat(data.coinFlipPct) || 0
      };
    }

    // Save to disk
    saveLearnedParams();

    console.log(`\n✅ EMPIRICAL TABLES BUILD COMPLETE!`);
    console.log(`   Sample size: ${settlements.length}`);
    console.log(`   Win rate buckets: ${Object.keys(empiricalTables.winRateByDistance).filter(k => empiricalTables.winRateByDistance[k].count > 0).length}`);
    console.log(`   Confidence: ${(empiricalTables.confidence * 100).toFixed(0)}%`);
    console.log(`\n📊 Selectivity Rules:`);
    console.log(`   Min signal strength: ${empiricalTables.selectivityRules.minSignalStrength}`);
    console.log(`   Min empirical win rate: ${empiricalTables.selectivityRules.minEmpiricalWinRate}%`);
    console.log(`   Min edge after fees: ${empiricalTables.selectivityRules.minEdgeAfterFees}%`);
    console.log(`   Max bets per hour: ${empiricalTables.selectivityRules.maxBetsPerHour}`);
    console.log(`\n📈 Win Rate by Distance (favored side):`);
    for (const [bucket, data] of Object.entries(empiricalTables.winRateByDistance)) {
      if (data.count > 0) {
        console.log(`   ${bucket}%: ${data.favoredWinRate}% win rate (n=${data.count})`);
      }
    }
    console.log(`\n💰 Token Analysis:`);
    for (const [token, data] of Object.entries(learnedParams.byToken)) {
      console.log(`   ${token}: ${data.sampleSize} samples | avg dist ${data.avgSettlementDistance?.toFixed(3)}% | NO bias ${data.noBias}% | vol rank ${data.volatilityRank}`);
      if (data.optimalEntryWindows) {
        console.log(`      Entry window: distance [${data.optimalEntryWindows.distanceMin}-${data.optimalEntryWindows.distanceMax}%]`);
      }
    }

    return {
      success: true,
      sampleSize: settlements.length,
      empiricalTables: {
        winRateByDistance: empiricalTables.winRateByDistance,
        selectivityRules: empiricalTables.selectivityRules,
        volatilityRegimes: empiricalTables.volatilityRegimes
      },
      byToken: learnedParams.byToken,
      confidence: empiricalTables.confidence,
      yesNoBias: learnedParams.yesNoBias,
      probabilityThresholds: learnedParams.probabilityThresholds
    };
  } catch (err) {
    console.error('❌ Learning failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get the coin-flip threshold for a specific token
 * Uses learned params if available, falls back to defaults
 */
function getCoinFlipThreshold(token) {
  // Try token-specific threshold first
  if (learnedParams.byToken[token]?.coinFlipThreshold && learnedParams.byToken[token].sampleSize >= 100) {
    return learnedParams.byToken[token].coinFlipThreshold;
  }
  // Fall back to global learned threshold
  if (learnedParams.sampleSize >= 100) {
    return learnedParams.thresholds.coinFlipExit;
  }
  // Default threshold
  return 0.15;
}

/**
 * Get the NO side bias bonus for a specific token
 * Uses learned YES/NO win rates to determine how much to favor NO bets
 * @param {string} token - Token symbol (BTC, ETH, SOL)
 * @returns {number} Bonus points to add for NO bets (0-10 scale)
 */
function getNoBiasBonus(token) {
  // Try token-specific NO bias first
  const tokenData = learnedParams.byToken[token];
  if (tokenData && tokenData.sampleSize >= 100 && typeof tokenData.noBias === 'number') {
    // Convert noBias percentage to bonus points
    // noBias of 6% (NO wins 53% vs YES 47%) = 3 bonus points (original default)
    // Scale: every 2% bias = 1 bonus point, capped at 0-10
    const bonus = Math.max(0, Math.min(10, tokenData.noBias / 2));
    return parseFloat(bonus.toFixed(1));
  }

  // Fall back to global NO bias
  const globalBias = learnedParams.yesNoBias?.global;
  if (globalBias && globalBias.sampleSize >= 100 && typeof globalBias.noBias === 'number') {
    const bonus = Math.max(0, Math.min(10, globalBias.noBias / 2));
    return parseFloat(bonus.toFixed(1));
  }

  // Default: 3 points (original hardcoded value)
  return 3;
}

/**
 * Get empirical win rate for favored side at a given distance from strike
 * Uses historical data to estimate probability instead of theoretical models
 * @param {number} pctFromStrike - Percentage distance from strike price
 * @returns {number|null} Win rate percentage (50-100), or null if insufficient data
 */
function getEmpiricalWinRate(pctFromStrike) {
  const winRateData = learnedParams.winRateByDistance;
  if (!winRateData || Object.keys(winRateData).length === 0) {
    return null; // No learned data, use statistical model
  }

  // Find the closest bucket that is >= pctFromStrike
  const buckets = Object.keys(winRateData).map(Number).sort((a, b) => a - b);

  for (const bucket of buckets) {
    if (pctFromStrike <= bucket) {
      const data = winRateData[bucket];
      if (data && data.count >= 20) {
        return data.favoredSideWinRate;
      }
    }
  }

  // If distance is larger than all buckets, use the largest bucket
  const lastBucket = buckets[buckets.length - 1];
  if (lastBucket && winRateData[lastBucket]?.count >= 20) {
    // For larger distances, extrapolate slightly higher win rate
    const baseRate = winRateData[lastBucket].favoredSideWinRate;
    const extrapolation = Math.min(5, (pctFromStrike - lastBucket) * 2);
    return Math.min(99, baseRate + extrapolation);
  }

  return null; // Insufficient data
}

/**
 * Get token volatility factor for adjusting thresholds
 * Lower volatility = more predictable = can be more aggressive
 * @param {string} token - Token symbol (BTC, ETH, SOL)
 * @returns {number} Volatility factor (0.8 to 1.2, where 1.0 is baseline)
 */
function getTokenVolatilityFactor(token) {
  const tokenData = learnedParams.byToken[token];
  if (!tokenData || tokenData.sampleSize < 100) {
    return 1.0; // Default baseline
  }

  // Use volatility rank to determine factor
  // Rank 1 (lowest volatility) = 0.9 (can be more aggressive)
  // Rank 2 (medium volatility) = 1.0 (baseline)
  // Rank 3 (highest volatility) = 1.1 (be more conservative)
  const rank = tokenData.volatilityRank || 2;
  const factors = { 1: 0.9, 2: 1.0, 3: 1.1 };
  return factors[rank] || 1.0;
}

/**
 * Get minimum auto-bet probability threshold
 * Uses learned data to determine the optimal minimum probability
 * @returns {number} Minimum probability percentage for auto-betting (55-70)
 */
function getMinAutoWinProbability() {
  const thresholds = learnedParams.probabilityThresholds;
  if (thresholds && typeof thresholds.autoMinProbability === 'number' && learnedParams.sampleSize >= 100) {
    // Clamp to reasonable range
    return Math.max(55, Math.min(70, thresholds.autoMinProbability));
  }
  // Default: 60% (original hardcoded value)
  return 60;
}

// Fetch and analyze historical settled crypto 15-minute markets
app.get('/api/historical/crypto-settlements', async (req, res) => {
  try {
    const { limit = 100, token = 'all' } = req.query;
    const userConfig = req.userState?.config || config;

    const cryptoSeries = token === 'all'
      ? ['KXBTC15M', 'KXETH15M', 'KXSOL15M']
      : [`KX${token.toUpperCase()}15M`];

    const allMarkets = [];

    // Fetch closed markets for each series
    for (const series of cryptoSeries) {
      try {
        const data = await kalshiRequest('GET', `/markets?limit=${limit}&status=closed&series_ticker=${series}`, null, userConfig);
        if (data.markets) {
          allMarkets.push(...data.markets);
        }
      } catch (e) {
        console.log(`Error fetching closed markets for ${series}:`, e.message);
      }
    }

    // Analyze settlement data
    const analysis = {
      totalMarkets: allMarkets.length,
      byToken: {},
      distanceFromStrikeAtSettlement: [],
      coinFlipCount: 0, // Markets where settlement was within 0.15% of strike
      nearStrikeCount: 0, // Markets where settlement was within 0.25% of strike
      avgDistanceFromStrike: 0,
      markets: []
    };

    for (const market of allMarkets) {
      const ticker = market.ticker || '';
      const token = ticker.includes('BTC') ? 'BTC' : ticker.includes('ETH') ? 'ETH' : ticker.includes('SOL') ? 'SOL' : 'UNKNOWN';

      // Get strike price from floor_strike
      const strikePrice = market.floor_strike;
      // Settlement value is typically in the result field or we need to calculate from yes/no prices
      const settlementValue = market.settlement_value; // 0 = NO won, 1 = YES won
      const yesPrice = market.yes_price || market.last_price;
      const noPrice = market.no_price || (100 - (market.last_price || 50));

      if (!strikePrice) continue;

      // Try to get the settlement price from CF Benchmarks reference
      // The actual crypto price at settlement isn't directly in the API,
      // but we can infer from the result and market behavior

      const marketData = {
        ticker,
        token,
        strikePrice,
        closeTime: market.close_time,
        settlementValue,
        yesPrice,
        noPrice,
        result: settlementValue === 1 ? 'YES' : settlementValue === 0 ? 'NO' : 'UNKNOWN'
      };

      // Track by token
      if (!analysis.byToken[token]) {
        analysis.byToken[token] = { count: 0, yesWins: 0, noWins: 0 };
      }
      analysis.byToken[token].count++;
      if (settlementValue === 1) analysis.byToken[token].yesWins++;
      if (settlementValue === 0) analysis.byToken[token].noWins++;

      // Estimate how close the final price was to strike based on settlement prices
      // If yes_price or no_price near 50, it was a coin flip
      const finalYesPrice = yesPrice || 50;
      const impliedCertainty = Math.abs(finalYesPrice - 50); // 0 = pure coin flip, 50 = certain

      if (impliedCertainty < 10) { // Within 40-60 price range = very uncertain
        analysis.coinFlipCount++;
      }
      if (impliedCertainty < 15) { // Within 35-65 price range = near strike
        analysis.nearStrikeCount++;
      }

      analysis.markets.push(marketData);
    }

    // Calculate percentages
    if (analysis.totalMarkets > 0) {
      analysis.coinFlipPercent = ((analysis.coinFlipCount / analysis.totalMarkets) * 100).toFixed(1);
      analysis.nearStrikePercent = ((analysis.nearStrikeCount / analysis.totalMarkets) * 100).toFixed(1);
    }

    // Summary stats per token
    for (const [token, data] of Object.entries(analysis.byToken)) {
      data.yesWinRate = data.count > 0 ? ((data.yesWins / data.count) * 100).toFixed(1) : 0;
    }

    res.json({
      success: true,
      analysis,
      recommendation: analysis.coinFlipPercent > 20
        ? `${analysis.coinFlipPercent}% of markets ended as coin flips. Consider tighter entry filters or earlier exits.`
        : `Only ${analysis.coinFlipPercent}% coin flips. Current thresholds seem reasonable.`
    });

  } catch (error) {
    console.error('Historical analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get price volatility stats for tuning thresholds
app.get('/api/historical/volatility-stats', (req, res) => {
  try {
    const stats = {};

    for (const [token, data] of Object.entries(cryptoPrices)) {
      const history = data.history || [];
      if (history.length < 10) continue;

      // Calculate 15-minute price movements
      const movements = [];
      for (let i = 15; i < history.length; i++) {
        const oldPrice = history[i - 15]?.price;
        const newPrice = history[i]?.price;
        if (oldPrice && newPrice) {
          const pctChange = Math.abs((newPrice - oldPrice) / oldPrice * 100);
          movements.push(pctChange);
        }
      }

      if (movements.length > 0) {
        movements.sort((a, b) => a - b);
        stats[token] = {
          samples: movements.length,
          min: movements[0].toFixed(3),
          max: movements[movements.length - 1].toFixed(3),
          median: movements[Math.floor(movements.length / 2)].toFixed(3),
          avg: (movements.reduce((a, b) => a + b, 0) / movements.length).toFixed(3),
          p90: movements[Math.floor(movements.length * 0.9)]?.toFixed(3), // 90th percentile
          under015pct: ((movements.filter(m => m < 0.15).length / movements.length) * 100).toFixed(1),
          under025pct: ((movements.filter(m => m < 0.25).length / movements.length) * 100).toFixed(1),
          currentVolatility: (data.volatility * 100).toFixed(3)
        };
      }
    }

    res.json({
      success: true,
      stats,
      interpretation: `"under015pct" shows % of 15-min periods where price moved <0.15% from start. Lower = more volatile = coin-flip exit triggers more often.`
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// BULK SETTLEMENT DATA & THRESHOLD LEARNING API
// ============================================

// Fetch bulk historical settlements with pagination
// GET /api/historical/bulk-settlements?token=all&maxPages=10
app.get('/api/historical/bulk-settlements', async (req, res) => {
  try {
    const { token = 'all', maxPages = 10 } = req.query;
    const userConfig = req.userState?.config || config;

    console.log(`📊 Bulk settlement fetch requested: token=${token}, maxPages=${maxPages}`);

    const settlements = await fetchBulkHistoricalData(
      token,
      parseInt(maxPages, 10),
      userConfig
    );

    res.json({
      success: true,
      count: settlements.length,
      byToken: {
        BTC: settlements.filter(s => s.token === 'BTC').length,
        ETH: settlements.filter(s => s.token === 'ETH').length,
        SOL: settlements.filter(s => s.token === 'SOL').length
      },
      settlements: settlements.slice(0, 100), // Return first 100 for preview
      message: settlements.length > 100
        ? `Showing first 100 of ${settlements.length} settlements`
        : `Retrieved ${settlements.length} settlements`
    });
  } catch (error) {
    console.error('Bulk settlements error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Run statistical analysis on settlement data
// GET /api/historical/analyze?token=all&maxPages=20
app.get('/api/historical/analyze', async (req, res) => {
  try {
    const { token = 'all', maxPages = 20 } = req.query;
    const userConfig = req.userState?.config || config;

    console.log(`📈 Running settlement analysis: token=${token}, maxPages=${maxPages}`);

    const settlements = await fetchBulkHistoricalData(
      token,
      parseInt(maxPages, 10),
      userConfig
    );

    if (settlements.length === 0) {
      return res.json({
        success: false,
        error: 'No settlement data available'
      });
    }

    const analysis = analyzeSettlementData(settlements);

    res.json({
      success: true,
      ...analysis,
      recommendations: {
        globalThreshold: `Use ${analysis.optimalThreshold}% as coin-flip exit threshold`,
        perToken: Object.entries(analysis.byToken).map(([token, data]) => ({
          token,
          threshold: data.optimalThreshold,
          sampleSize: data.sampleSize,
          recommendation: `${token}: Use ${data.optimalThreshold}% threshold (${data.coinFlipPct}% of markets within this range)`
        }))
      }
    });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger parameter learning from historical data
// POST /api/historical/learn
app.post('/api/historical/learn', async (req, res) => {
  try {
    // Allow userId query param for admin/CLI access (one-time table building)
    let userConfig = req.userState?.config || config;
    const queryUserId = req.query.userId;
    console.log(`📚 Learn request: queryUserId=${queryUserId}, reqUserAuth=${req.userState?.config?.isAuthenticated}`);
    if (queryUserId) {
      const state = getUserState(queryUserId);
      console.log(`📚 Loaded state for ${queryUserId}: isAuth=${state?.config?.isAuthenticated}, hasKey=${!!state?.config?.apiKeyId}`);
      if (state?.config?.isAuthenticated && state?.config?.apiKeyId) {
        userConfig = state.config;
        console.log(`📚 Using credentials from user ${queryUserId}`);
      }
    }

    console.log(`📚 Manual learning triggered via API (auth=${userConfig.isAuthenticated}, key=${!!userConfig.apiKeyId})`);

    const result = await updateLearnedParameters(userConfig);

    if (result.success) {
      res.json({
        success: true,
        message: 'Learning complete! Thresholds updated.',
        ...result,
        currentParams: learnedParams
      });
    } else {
      res.json({
        success: false,
        error: result.error || 'Learning failed',
        sampleSize: result.sampleSize || 0
      });
    }
  } catch (error) {
    console.error('Learning error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// View current learned parameters
// GET /api/historical/params
app.get('/api/historical/params', (req, res) => {
  res.json({
    success: true,
    params: learnedParams,
    isStale: isLearningDataStale(),
    defaults: DEFAULT_LEARNED_PARAMS,
    thresholdsInUse: {
      BTC: getCoinFlipThreshold('BTC'),
      ETH: getCoinFlipThreshold('ETH'),
      SOL: getCoinFlipThreshold('SOL'),
      global: learnedParams.thresholds.coinFlipExit
    }
  });
});

// ============================================
// TAKE-PROFIT API (Phase 5)
// ============================================

// Get take-profit settings
app.get('/api/take-profit/settings', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    settings: userConfig.takeProfitSettings || {}
  });
});

// Update take-profit settings
app.post('/api/take-profit/settings', (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;
  const updates = req.body;

  // Merge updates into takeProfitSettings
  userConfig.takeProfitSettings = {
    ...userConfig.takeProfitSettings,
    ...updates
  };

  saveUserState(req.userId);

  res.json({
    success: true,
    message: 'Take-profit settings updated',
    settings: userConfig.takeProfitSettings
  });
});

// Manually scan for take-profit opportunities
app.post('/api/take-profit/scan', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;
  const userPortfolio = req.userState.portfolio;

  try {
    const opportunities = await scanTakeProfitOpportunities(userConfig, userPortfolio);
    res.json({
      success: true,
      opportunities,
      scannedPositions: userPortfolio.positions?.length || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Evaluate take-profit for a specific position
app.get('/api/take-profit/evaluate/:ticker', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const { ticker } = req.params;
  const userConfig = req.userState.config;
  const userPortfolio = req.userState.portfolio;

  const position = userPortfolio.positions?.find(p => p.ticker === ticker);
  if (!position) {
    return res.status(404).json({ success: false, error: 'Position not found' });
  }

  try {
    const evaluation = await evaluateTakeProfit(position, userConfig);
    res.json({
      success: true,
      ...evaluation
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Execute take-profit for a specific position
app.post('/api/take-profit/execute/:ticker', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const { ticker } = req.params;
  const userConfig = req.userState.config;
  const userPortfolio = req.userState.portfolio;

  const position = userPortfolio.positions?.find(p => p.ticker === ticker);
  if (!position) {
    return res.status(404).json({ success: false, error: 'Position not found' });
  }

  try {
    // First evaluate
    const evaluation = await evaluateTakeProfit(position, userConfig);
    if (!evaluation.shouldExit) {
      return res.json({
        success: false,
        message: 'Take-profit criteria not met',
        evaluation
      });
    }

    // Execute the exit
    const result = await executeTakeProfitExit(position, evaluation.analysis, userConfig);
    res.json({
      success: result.executed,
      ...result,
      evaluation
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// LIQUIDITY SETTINGS API (Phase 3)
// ============================================

// Get liquidity settings
app.get('/api/liquidity/settings', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    settings: userConfig.liquiditySettings || {}
  });
});

// Update liquidity settings
app.post('/api/liquidity/settings', (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;
  const updates = req.body;

  userConfig.liquiditySettings = {
    ...userConfig.liquiditySettings,
    ...updates
  };

  saveUserState(req.userId);

  res.json({
    success: true,
    message: 'Liquidity settings updated',
    settings: userConfig.liquiditySettings
  });
});

// ============================================
// MOMENTUM SETTINGS API (Phase 4)
// ============================================

// Get momentum settings
app.get('/api/momentum/settings', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    settings: userConfig.momentumSettings || {}
  });
});

// Update momentum settings
app.post('/api/momentum/settings', (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;
  const updates = req.body;

  userConfig.momentumSettings = {
    ...userConfig.momentumSettings,
    ...updates
  };

  saveUserState(req.userId);

  res.json({
    success: true,
    message: 'Momentum settings updated',
    settings: userConfig.momentumSettings
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

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await auth.loginUser(email, password);

    // User state is automatically loaded via middleware when they make authenticated requests
    console.log(`🔐 User logged in: ${email}`);

    res.json({
      success: true,
      message: 'Logged in successfully',
      token: result.token,
      user: { id: result.userId, email: result.email }
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
    user: userInfo
  });
});

// DEPRECATED: Profile linking - settings now tied directly to user account
app.post('/api/auth/link-profile', (req, res) => {
  res.json({ success: true, message: 'Profiles deprecated - settings tied to your account' });
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

// Disconnect from Kalshi (clear API credentials)
app.post('/api/auth/disconnect', (req, res) => {
  try {
    if (!req.userId || !req.userState) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const userConfig = req.userState.config;

    // Clear Kalshi credentials
    userConfig.apiKeyId = null;
    userConfig.privateKey = null;
    userConfig.isAuthenticated = false;

    // Reset portfolio to simulated state
    req.userState.portfolio = { balance: 2500, positions: [] }; // $25 simulated
    userConfig.bankroll = 2500;

    // Save user state
    saveUserState(req.userId);

    console.log(`🔌 User ${req.userId} disconnected from Kalshi`);

    res.json({ success: true, message: 'Disconnected from Kalshi' });
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
    // Check for pending settlements on every portfolio refresh
    await checkPendingSettlements();

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
        const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=20', null, userConfig);
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
            outcome: 'pending', // Will be updated to 'won' or 'lost' when market settles
            payout: 0,
            profit: 0
          };
        });

        // Get market data including settlement results - FETCH IN PARALLEL for speed
        const uniqueTickers = [...new Set(realBetHistory.map(b => b.ticker))].slice(0, 50);
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

          let outcome = 'pending';
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
      const settled = combinedHistory.filter(b => b.outcome === 'won' || b.outcome === 'lost');
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

  // Use user-specific config if authenticated, otherwise fall back to global
  const userConfig = req.userState?.config || config;

  if (bankroll !== undefined) userConfig.bankroll = Math.round(bankroll * 100);
  if (minEdge !== undefined) userConfig.minEdge = minEdge;
  if (maxBetPercent !== undefined) userConfig.maxBetPercent = maxBetPercent;

  // Save user state if authenticated
  if (req.userId) saveUserState(req.userId);

  res.json({
    success: true,
    settings: {
      bankroll: userConfig.bankroll / 100,
      minEdge: userConfig.minEdge,
      maxBetPercent: userConfig.maxBetPercent
    }
  });
});

// ============================================
// PERFORMANCE TRACKING ENDPOINTS
// ============================================

// Get performance summary - pulls from Kalshi portfolio history when authenticated
app.get('/api/performance', async (req, res) => {
  try {
    const userConfig = req.userState?.config || config;

    // If authenticated, fetch real performance from Kalshi fills
    if (userConfig.isAuthenticated) {
      try {
        // Fetch fills from Kalshi (up to 100 recent trades)
        const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=100', null, userConfig);
        const fills = fillsData.fills || [];

        // Get unique tickers to fetch market results
        const uniqueTickers = [...new Set(fills.map(f => f.ticker))].slice(0, 50);
        const marketData = {};

        // Fetch market data in parallel
        const marketPromises = uniqueTickers.map(async (ticker) => {
          try {
            const data = await kalshiRequest('GET', `/markets/${ticker}`, null, userConfig);
            if (data.market) {
              return { ticker, result: data.market.result, status: data.market.status };
            }
          } catch (e) { /* ignore */ }
          return { ticker, result: null, status: 'unknown' };
        });

        const marketResults = await Promise.all(marketPromises);
        marketResults.forEach(m => { if (m) marketData[m.ticker] = m; });

        // Process fills into bet records with outcomes
        const bets = fills.map(fill => {
          const count = fill.count || 1;
          let priceCents = fill.price || 0;
          if (priceCents > 0 && priceCents <= 1) priceCents = Math.round(priceCents * 100);
          const totalCost = count * priceCents;

          const market = marketData[fill.ticker] || {};
          const result = market.result;
          const betSide = fill.side?.toLowerCase();
          const isBuy = fill.action?.toLowerCase() !== 'sell';

          let outcome = 'pending';
          let profit = 0;

          if (result && isBuy) {
            const won = betSide === result;
            outcome = won ? 'won' : 'lost';
            profit = won ? (count * 100 - totalCost) : -totalCost;
          }

          return {
            ticker: fill.ticker,
            side: betSide,
            count,
            price: priceCents,
            totalCost,
            timestamp: fill.created_time || fill.ts,
            outcome,
            profit,
            token: getTokenFromTicker(fill.ticker)
          };
        });

        // Calculate stats
        const settled = bets.filter(b => b.outcome !== 'pending');
        const pending = bets.filter(b => b.outcome === 'pending');
        const wins = settled.filter(b => b.outcome === 'won').length;
        const totalWagered = bets.reduce((sum, b) => sum + (b.totalCost || 0), 0);
        const totalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);

        // Group by token
        const byToken = {};
        for (const bet of settled) {
          const token = bet.token || 'OTHER';
          if (!byToken[token]) byToken[token] = { wins: 0, losses: 0, profit: 0, wagered: 0 };
          byToken[token].wagered += bet.totalCost;
          byToken[token].profit += bet.profit;
          if (bet.outcome === 'won') byToken[token].wins++;
          else byToken[token].losses++;
        }

        return res.json({
          success: true,
          source: 'kalshi',
          summary: {
            totalBets: bets.length,
            settledBets: settled.length,
            pendingBets: pending.length,
            wins,
            losses: settled.length - wins,
            winRate: settled.length > 0 ? ((wins / settled.length) * 100).toFixed(1) : '0.0',
            totalWagered,
            totalWageredDollars: (totalWagered / 100).toFixed(2),
            totalProfit,
            totalProfitDollars: (totalProfit / 100).toFixed(2),
            roi: totalWagered > 0 ? ((totalProfit / totalWagered) * 100).toFixed(1) : '0.0'
          },
          byToken,
          recentBets: bets.slice(0, 20)
        });
      } catch (kalshiErr) {
        console.log('Could not fetch Kalshi performance:', kalshiErr.message);
        // Fall through to local data
      }
    }

    // Fall back to local performanceData
    checkPendingSettlements();

    const userBets = req.userId
      ? performanceData.bets.filter(b => b.userId === req.userId)
      : performanceData.bets;

    const settled = userBets.filter(b => b.outcome !== 'pending');
    const pending = userBets.filter(b => b.outcome === 'pending');
    const userWins = settled.filter(b => b.outcome === 'won').length;
    const userTotalWagered = userBets.reduce((sum, b) => sum + (b.stake || 0), 0);
    const userTotalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);

    res.json({
      success: true,
      source: 'local',
      summary: {
        totalBets: userBets.length,
        settledBets: settled.length,
        pendingBets: pending.length,
        wins: userWins,
        losses: settled.length - userWins,
        winRate: settled.length > 0 ? ((userWins / settled.length) * 100).toFixed(1) : '0.0',
        totalWagered: userTotalWagered,
        totalWageredDollars: (userTotalWagered / 100).toFixed(2),
        totalProfit: userTotalProfit,
        totalProfitDollars: (userTotalProfit / 100).toFixed(2),
        roi: userTotalWagered > 0
          ? ((userTotalProfit / userTotalWagered) * 100).toFixed(1)
          : '0.0'
      },
      byToken: performanceData.byToken,
      byProbBucket: performanceData.byProbBucket,
      byMarketType: performanceData.byMarketType,
      calibration: performanceData.summary.calibration,
      recentBets: userBets.slice(-20).reverse()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get detailed bet history
app.get('/api/performance/bets', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status; // 'pending', 'won', 'lost', or undefined for all

  // Filter bets to only show current user's bets (security fix)
  let bets = req.userId
    ? performanceData.bets.filter(b => b.userId === req.userId)
    : performanceData.bets;

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

// Debug endpoint to see raw Kalshi data (uses global server credentials)
app.get('/api/debug/kalshi-fills', async (req, res) => {
  try {
    // Try user config first, then fall back to global config
    let useConfig = req.userState?.config;
    if (!useConfig?.isAuthenticated) {
      useConfig = config; // Global server config from env vars
    }

    if (!useConfig.isAuthenticated) {
      return res.json({
        success: false,
        error: 'Not authenticated',
        debug: {
          hasUserConfig: !!req.userState?.config,
          userConfigAuth: req.userState?.config?.isAuthenticated,
          globalConfigAuth: config.isAuthenticated,
          hasApiKeyId: !!config.apiKeyId
        }
      });
    }

    // Fetch raw fills from Kalshi
    const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=30', null, useConfig);
    const fills = fillsData.fills || [];

    // Fetch market data for each unique ticker
    const uniqueTickers = [...new Set(fills.map(f => f.ticker))];
    const marketResults = {};

    for (const ticker of uniqueTickers.slice(0, 20)) {
      try {
        const market = await kalshiRequest('GET', `/markets/${ticker}`, null, userConfig);
        marketResults[ticker] = {
          result: market.market?.result,
          status: market.market?.status,
          close_time: market.market?.close_time
        };
      } catch (e) {
        marketResults[ticker] = { error: e.message };
      }
    }

    res.json({
      success: true,
      fillCount: fills.length,
      fills: fills.map(f => ({
        trade_id: f.trade_id,
        order_id: f.order_id,
        ticker: f.ticker,
        side: f.side,
        action: f.action,
        count: f.count,
        price: f.price,
        created_time: f.created_time
      })),
      marketResults
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
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

// Initialize database before starting server
initDatabase().then(() => {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🎰 Shimi Crypto Bot running on port ${PORT}`);
    console.log(`📊 Tracking ${Object.keys(TRACKED_TOKENS).length} tokens: ${Object.keys(TRACKED_TOKENS).join(', ')}`);
    console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);
    console.log(`📈 Performance tracking: ${performanceData.bets.length} historical bets loaded`);

    // Auto-load Kalshi credentials from environment
    await loadCredentialsFromEnv();

  // Initialize WebSocket for real-time market data (Phase 1)
  console.log(`🔌 Initializing Kalshi WebSocket connection...`);
  try {
    initializeWebSocket();
  } catch (err) {
    console.log(`⚠️ WebSocket initialization failed (falling back to REST): ${err.message}`);
  }

  // Check pending settlements every 2 minutes
  setInterval(async () => {
    try {
      await checkPendingSettlements();
    } catch (err) {
      console.log('Settlement check error:', err.message);
    }
  }, 2 * 60 * 1000);

  // Keep-alive: Self-ping every 10 minutes to prevent Render free tier from spinning down
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${RENDER_URL}/api/health`)
      .then(() => console.log('🔄 Keep-alive ping successful'))
      .catch(() => {}); // Silently ignore errors
  }, 10 * 60 * 1000);

  // ============================================
  // THRESHOLD LEARNING SCHEDULE
  // ============================================
  // Run learning on startup if data is stale, then daily thereafter

  // Initial learning check (delayed 30 seconds to let server stabilize)
  setTimeout(async () => {
    if (isLearningDataStale()) {
      console.log('📚 Learned thresholds are stale, triggering learning update...');
      try {
        await updateLearnedParameters();
      } catch (err) {
        console.log(`⚠️ Initial learning failed: ${err.message}`);
      }
    } else {
      console.log(`📚 Learned thresholds are current (last updated: ${learnedParams.lastUpdated})`);
      console.log(`   Global threshold: ${learnedParams.thresholds.coinFlipExit}%`);
      for (const [token, data] of Object.entries(learnedParams.byToken)) {
        if (data.sampleSize > 0) {
          console.log(`   ${token}: ${data.coinFlipThreshold}% (${data.sampleSize} samples)`);
        }
      }
    }
  }, 30000);

  // Schedule daily learning updates (run at ~4 AM server time to minimize impact)
  setInterval(async () => {
    const hour = new Date().getHours();
    // Only run between 4-5 AM to minimize impact on trading
    if (hour === 4) {
      console.log('📚 Running scheduled daily threshold learning...');
      try {
        await updateLearnedParameters();
      } catch (err) {
        console.log(`⚠️ Scheduled learning failed: ${err.message}`);
      }
    }
  }, 60 * 60 * 1000); // Check every hour

    server.on('error', (err) => {
      console.error('Server error:', err.message);
    });
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
