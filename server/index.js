import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';
import * as auth from './auth.js';
import WebSocket from 'ws';
import { getKalshiWebSocket } from './kalshiWebSocket.js';
import { pool, initDatabase } from './db.js';
import {
  ML_FEATURE_NAMES, sigmoid, extractMLFeatures, normalizeFeatures,
  mlPredict, computeFeatureStats, trainMLModel, buildMLTrainingData,
  saveMLModel, getMLModel
} from './mlModel.js';
import {
  normalCDF, calculateVolatility, calculateMomentum,
  calculateMomentumMultiTimeframe
} from './statistics.js';
import * as sentiment from './sentiment.js';
import { kalshiRequest, setDefaultConfig as setKalshiDefaultConfig, KALSHI_API_BASE } from './kalshiAPI.js';
import {
  addLeader, removeLeader, updateLeader, getLeaders,
  startCopyTrading, stopCopyTrading, getCopyTradingStatus,
  serializeCopyState, loadCopyState
} from './copyTrading.js';
import {
  addPolyWallet, removePolyWallet, updatePolyWallet, getPolyWallets,
  startPolyTracker, stopPolyTracker, getPolyTrackerStatus,
  serializePolyState, loadPolyState, fetchPolyPositions, fetchPolyProfile
} from './polymarketTracker.js';
import { analyzeWallet } from './walletAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message, err.stack);
  // Process is in undefined state after uncaught exception must exit
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());


// Global kill switch create this file to halt ALL betting immediately
const KILL_SWITCH_FILE = path.join(__dirname, 'KILL_SWITCH');
let globalKillSwitch = false;

function isKillSwitchActive() {
  // Check in-memory flag first (fast path), then check file
  if (globalKillSwitch) return true;
  try {
    if (fs.existsSync(KILL_SWITCH_FILE)) {
      globalKillSwitch = true;
      console.error(' GLOBAL KILL SWITCH ACTIVE all betting halted');
      return true;
    }
  } catch (e) { /* ignore fs errors */ }
  return false;
}

// ============================================
// DISCORD ALERTS — fire-and-forget with 2s rate limit
// ============================================
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_USER_ID = process.env.DISCORD_USER_ID || '';
const _discordQueue = [];
let _discordDraining = false;

function sendDiscordAlert(embed) {
  if (!DISCORD_WEBHOOK_URL) return;
  _discordQueue.push(embed);
  if (!_discordDraining) _drainDiscordQueue();
}

function _drainDiscordQueue() {
  if (_discordQueue.length === 0) { _discordDraining = false; return; }
  _discordDraining = true;
  const embed = _discordQueue.shift();
  const mentionContent = DISCORD_USER_ID ? `<@${DISCORD_USER_ID}>` : '';
  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: mentionContent, embeds: [embed] }),
  }).catch(err => console.log(' Discord alert failed:', err.message));
  setTimeout(_drainDiscordQueue, 2000);
}

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
  // Safety: bankroll floor
  minBankrollCents: 200, // Never auto-bet if bankroll drops below $2.00
  maxOpenPositions: 8, // Max simultaneous open positions (limits exposure, not frequency)
  // Risk management settings (in cents) - per-token-per-cycle is the primary limit
  riskLimits: {
    maxPerTokenPerCycle: 500, // $5.00 max per token per 15-min cycle
    maxPerMarket: 500, // $5.00 max per single market ticker (caps scale-in accumulation)
    maxTotalPerCycle: 1500, // $15.00 max TOTAL across all tokens per 15-min cycle
  },
  // Scale-in settings: add to position when probability improves
  scaleIn: {
    enabled: true,
    minProbabilityIncrease: 15, // Only scale in if prob increased by 15%+ (60% 75%)
    maxBetsPerMarket: 3, // Maximum times to bet on same market
    minTimeBetweenBets: 60000 // At least 1 minute between bets on same market
  },
  // Liquidity settings: filter out illiquid markets with wide spreads
  liquiditySettings: {
    enabled: true,
    minContracts: 10, // Minimum contracts at best price
    maxSpreadCents: 8, // Maximum bid-ask spread in cents
    spreadPenaltyEnabled: true // Subtract half-spread from edge calculation
  },
  // Momentum confirmation: use candlestick data to confirm price direction
  momentumSettings: {
    enabled: true,
    alignmentBonus: 2, // +2% edge bonus if momentum aligns with bet
    oppositionPenalty: -3, // -3% edge penalty if momentum opposes bet
    lookbackCandles: 5, // Number of candles to analyze
    volumeWeighted: true // Weight by volume
  },
  // Take-profit settings: exit positions early when favorable
  // DISABLED: Let winners ride to expiry instead of taking early profits
  // Stop-loss and coin-flip prevention still work regardless of this setting
  takeProfitSettings: {
    enabled: false, // DISABLED - let winners ride to expiry
    autoExecute: true, // Auto-execute when conditions are optimal
    minProfitPercent: 10, // Base minimum (lowered by urgency score)
    confidenceFactor: 0.85, // Model uncertainty discount
    logOnly: false, // Actually execute (set true to test first)
    scanIntervalMs: 15000, // Check positions every 15 seconds (faster reaction)
    // Smart exit thresholds (urgency score 0-100)
    urgencyThresholds: {
      low: 20, // Below this: require full minProfitPercent
      medium: 40, // At this: start lowering profit requirement
      high: 60, // At this: take 5%+ profits
      critical: 80 // At this: take any profit > 3%
    }
  },
  // Limit Order Settings - DISABLED: Kalshi doesn't support limit orders for crypto markets
  // These settings are kept for reference but the feature is disabled
  // Stop-loss is now handled by active monitoring in evaluateTakeProfit()
  limitOrderSettings: {
    stopLoss: {
      enabled: false, // DISABLED - Kalshi rejects limit orders for crypto markets
      threshold: -40 // Used by active monitoring for stop-loss threshold
    },
    takeProfit: {
      enabled: false, // DISABLED - Kalshi rejects limit orders for crypto markets
      threshold: 25 // Used by active monitoring for take-profit threshold
    }
  },
  // Maker order mode: post resting orders to avoid taker fees (~3.5% savings)
  makerMode: {
    enabled: true,        // ON by default — saves ~3.5% in fees
    fallbackToTaker: true, // Fall back if maker unfilled
    makerPollTimeMs: 10000, // 10s wait for maker fill
    minTimeForMaker: 3    // Below 3 min remaining → use taker directly
  },
  // Active monitoring settings (runs every 15 seconds when auto-bet is on)
  activeMonitoring: {
    stopLossEnabled: false, // Cut losses at threshold (disabled by default)
    stopLossThreshold: -40, // Exit if position is down 40%
    easyProfitEnabled: true, // Take "free money" on high-confidence positions
    easyProfitMinPrice: 75, // Minimum buy price for easy profit (75c = 75% implied prob)
    easyProfitThreshold: 12, // Near expiry (<5min): take 12%+ profit (accounts for fees)
    coinFlipPreventionEnabled: true // Exit coin-flip positions near expiry (can disable to ride it out)
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

// ============================================
// ECONOMIC CALENDAR — sit out during high-impact events
// ============================================
const ECONOMIC_CALENDAR_FILE = path.join(__dirname, 'economic_calendar.json');
let economicCalendar = [];
try {
  if (fs.existsSync(ECONOMIC_CALENDAR_FILE)) {
    economicCalendar = JSON.parse(fs.readFileSync(ECONOMIC_CALENDAR_FILE, 'utf8'));
    console.log(` Loaded ${economicCalendar.length} economic calendar events`);
  }
} catch (err) {
  console.log('Could not load economic calendar:', err.message);
}

function getActiveEconomicEvent() {
  const now = Date.now();
  for (const event of economicCalendar) {
    const eventTime = new Date(event.datetime).getTime();
    const sitOutMs = (event.sitOutMinutes || 15) * 60 * 1000;
    // Sit out from (sitOutMinutes before) to (sitOutMinutes after) the event
    if (now >= eventTime - sitOutMs && now <= eventTime + sitOutMs) {
      return event;
    }
  }
  return null;
}

// Default empirical tables structure
const DEFAULT_EMPIRICAL_TABLES = {
  lastUpdated: null,
  sampleSize: 0,

  // Core lookup tables - win rate by distance from strike
  // BALANCED: Not too conservative (blocks bets) or optimistic (99% is unrealistic)
  // Edge = our win rate - market price - fees. Need ~5% edge minimum.
  winRateByDistance: {
    0.1: { count: 0, favoredWinRate: 68, surpriseRate: 32 }, // Close but measurable edge
    0.2: { count: 0, favoredWinRate: 74, surpriseRate: 26 }, // Solid advantage
    0.3: { count: 0, favoredWinRate: 78, surpriseRate: 22 }, // Good edge zone
    0.5: { count: 0, favoredWinRate: 82, surpriseRate: 18 }, // Strong edge
    0.75: { count: 0, favoredWinRate: 86, surpriseRate: 14 }, // Very strong
    1.0: { count: 0, favoredWinRate: 89, surpriseRate: 11 }, // Excellent
    1.5: { count: 0, favoredWinRate: 91, surpriseRate: 9 }, // Near-certain
    2.0: { count: 0, favoredWinRate: 93, surpriseRate: 7 }, // Very high confidence
    3.0: { count: 0, favoredWinRate: 95, surpriseRate: 5 }, // Maximum confidence
    5.0: { count: 0, favoredWinRate: 95, surpriseRate: 5 } // Maximum confidence
  },

  // Volatility regime tables (key insight from domain analysis)
  volatilityRegimes: {
    low: {
      description: 'Calm market, predictable movements',
      winRateMultiplier: 1.05, // Slightly boost confidence
      coinFlipThreshold: 0.1, // Smaller moves matter
      sitOut: false
    },
    medium: {
      description: 'Normal market conditions',
      winRateMultiplier: 1.0,
      coinFlipThreshold: 0.2,
      sitOut: false
    },
    high: {
      description: 'Elevated volatility - sit out (model edge degrades)',
      winRateMultiplier: 0.92,
      coinFlipThreshold: 0.4,
      sitOut: true // Sit out: empirical win rates unreliable in high vol
    },
    spike: {
      description: 'Volatility spike detected (2%+ in 5 min)',
      winRateMultiplier: 0,
      coinFlipThreshold: 1.0,
      sitOut: true // Don't bet during spikes
    }
  },

  // Token-specific with learned entry windows
  byToken: {
    BTC: {
      sampleSize: 0,
      avgSettlementDistance: 0.25,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 2,
      optimalEntryWindows: {
        distanceMin: 0.1, // Low-vol hours produce 0.09-0.22% distances
        distanceMax: 5.0, // Don't reject large moves
        timeMin: 2, // Allow late entries
        timeMax: 8, // Tightened from 13: only bet when 2-8 min remain (best data window)
        priceMin: 55, // Raised from 40: below 55c is coin-flip territory
        priceMax: 92 // Raised from 85: 75c+ bets are high-probability favored bets
      }
    },
    ETH: {
      sampleSize: 0,
      avgSettlementDistance: 0.37,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 2,
      optimalEntryWindows: {
        distanceMin: 0.15, // ETH slightly higher min than BTC
        distanceMax: 5.0,
        timeMin: 2,
        timeMax: 8, // Tightened from 13
        priceMin: 55, // Raised from 40
        priceMax: 92 // Raised from 85: allow high-probability bets
      }
    },
    SOL: {
      sampleSize: 0,
      avgSettlementDistance: 0.36,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 3, // SOL typically most volatile
      optimalEntryWindows: {
        distanceMin: 0.2, // Slightly higher buffer for most volatile token
        distanceMax: 5.0,
        timeMin: 2,
        timeMax: 7, // Tighter than BTC/ETH: SOL needs more price confirmation
        priceMin: 55, // Raised from 40
        priceMax: 90 // Raised from 80: allow high-probability favored bets
      }
    },
    XRP: {
      sampleSize: 0,
      avgSettlementDistance: 0.35,
      settlementDistanceStdDev: 0,
      yesWinRate: 50,
      noWinRate: 50,
      noBias: 0,
      volatilityRank: 3, // XRP similar volatility to SOL
      optimalEntryWindows: {
        distanceMin: 0.2,
        distanceMax: 5.0,
        timeMin: 2,
        timeMax: 7,
        priceMin: 55,
        priceMax: 90 // Raised from 80
      }
    }
  },

  // Selectivity rules (learned thresholds for when to bet)
  selectivityRules: {
    minSignalStrength: 58, // 0-100 score required to bet (raised from 50: only clear signals)
    minEmpiricalWinRate: 64, // Minimum win rate from lookup tables (lowered from 68: allow borderline high-edge bets)
    minEdgeAfterFees: 6, // 6% minimum edge after fees (lowered from 8: allows more bets in efficient markets)
    minUnfavoredEdge: 8, // 8% minimum net edge for unfavored-side bets (raised from 5: long shots need bigger edge)
    maxBetsPerToken: 3, // Per-token concentration limit
    maxBetsPerHour: 15, // Maximum bets placed in a rolling 1-hour window
    requireRegimeCheck: true, // Must pass volatility regime check
    strongSignalMinSignal: 70, // Signal threshold for "too early" bypass
    strongSignalMinEdge: 6, // Edge threshold for "too early" bypass
    edgeOverrideThresholds: [ // High edge overrides min win rate floor
      { minEdge: 15, minWinRate: 52 },
      { minEdge: 10, minWinRate: 55 },
    ],
  },

  // Performance tracking for adaptive adjustment
  performanceTracking: {
    recentBets: [], // Last 50 bets for short-term calibration
    winRateByRegime: {
      low: { bets: 0, wins: 0 },
      medium: { bets: 0, wins: 0 },
      high: { bets: 0, wins: 0 }
    },
    calibrationError: 0, // Difference between predicted and actual
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
  // Cross-token correlation pairs: leader → followers with correlation strength (0-1)
  correlationPairs: {
    BTC: { ETH: 0.85, SOL: 0.70, XRP: 0.65 },
    ETH: { BTC: 0.80, SOL: 0.60, XRP: 0.55 }
    // SOL and XRP are followers, rarely leaders
  },
  probabilityThresholds: {
    autoMinProbability: 62, // Raised from 60 based on analysis
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
    // Deep merge: preserve nested structures (byToken, winRateByDistance, etc.)
    // Shallow merge would lose ETH/SOL if saved file only has partial byToken
    learnedParams = {
      ...DEFAULT_LEARNED_PARAMS,
      ...data,
      byToken: { ...DEFAULT_LEARNED_PARAMS.byToken, ...data.byToken },
      winRateByDistance: { ...DEFAULT_LEARNED_PARAMS.winRateByDistance, ...(data.winRateByDistance || {}) },
      volatilityRegimes: { ...DEFAULT_LEARNED_PARAMS.volatilityRegimes, ...(data.volatilityRegimes || {}) },
      thresholds: { ...DEFAULT_LEARNED_PARAMS.thresholds, ...(data.thresholds || {}) },
      yesNoBias: { ...DEFAULT_LEARNED_PARAMS.yesNoBias, ...(data.yesNoBias || {}) }
    };
    console.log(` Loaded learned params: sample size ${learnedParams.sampleSize}, last updated ${learnedParams.lastUpdated}`);
  }
} catch (err) {
  console.error('Error loading learned params:', err.message);
}

// Save learned parameters
function saveLearnedParams() {
  try {
    fs.writeFileSync(LEARNED_PARAMS_FILE, JSON.stringify(learnedParams, null, 2));
    console.log(` Saved learned params to ${LEARNED_PARAMS_FILE}`);
  } catch (err) {
    console.error('Error saving learned params:', err.message);
  }
}

// Check if learning data is stale (>24 hours old)
// Note: On Render free plan, filesystem is ephemeral — learned_params.json reverts
// to the Docker image version on every instance restart. So lastUpdated may always
// appear stale. Use sampleSize as the primary guard against unnecessary re-learning.
function isLearningDataStale() {
  if (!learnedParams.lastUpdated) return true;
  const lastUpdate = new Date(learnedParams.lastUpdated).getTime();
  return Date.now() - lastUpdate > LEARNING_INTERVAL;
}

// Check if we have enough learned data to skip startup learning
// With 12k+ samples baked into the Docker image, re-fetching on every restart is wasteful
function hasAdequateLearnedData() {
  return learnedParams.sampleSize >= 500 && Object.keys(learnedParams.winRateByDistance || {}).length >= 3;
}

// ML MODEL - imported from ./mlModel.js
// Functions: sigmoid, extractMLFeatures, normalizeFeatures, mlPredict,
//            computeFeatureStats, trainMLModel, buildMLTrainingData, saveMLModel, getMLModel

// ============================================
// PROSPECTIVE DATA COLLECTION
// ============================================
// Records price snapshots from active markets for future model training
// This captures "betting-time" data that historical settlements don't have

const PRICE_SNAPSHOTS_FILE = path.join(__dirname, 'price_snapshots.json');
const MAX_SNAPSHOTS = 10000; // Keep last 10k snapshots to limit file size

// ============================================
// TAKE-PROFIT EXECUTION HISTORY
// ============================================
// Tracks all take-profit and stop-loss executions for monitoring

const TAKE_PROFIT_HISTORY_FILE = path.join(__dirname, 'take_profit_history.json');
const MAX_TP_HISTORY = 200; // Keep last 200 executions

let takeProfitHistory = [];

// Load existing history
try {
  if (fs.existsSync(TAKE_PROFIT_HISTORY_FILE)) {
    takeProfitHistory = JSON.parse(fs.readFileSync(TAKE_PROFIT_HISTORY_FILE, 'utf8'));
    console.log(` Loaded ${takeProfitHistory.length} take-profit history entries`);
  }
} catch (err) {
  console.error('Error loading take-profit history:', err.message);
  takeProfitHistory = [];
}

// Debounced file I/O - batches writes with 5s delay to reduce disk thrashing
const _debouncedTimers = {};
function debouncedWrite(key, fn, delayMs = 5000) {
  if (_debouncedTimers[key]) clearTimeout(_debouncedTimers[key]);
  _debouncedTimers[key] = setTimeout(() => {
    _debouncedTimers[key] = null;
    fn();
  }, delayMs);
}

// Save take-profit history to disk (debounced)
function saveTakeProfitHistory() {
  debouncedWrite('takeProfitHistory', () => {
    try {
      if (takeProfitHistory.length > MAX_TP_HISTORY) {
        takeProfitHistory = takeProfitHistory.slice(-MAX_TP_HISTORY);
      }
      fs.writeFileSync(TAKE_PROFIT_HISTORY_FILE, JSON.stringify(takeProfitHistory, null, 2));
    } catch (err) {
      console.error('Error saving take-profit history:', err.message);
    }
  });
}

// Record a take-profit/stop-loss execution
function recordTakeProfitExecution(ticker, type, analysis, result, userId = null) {
  takeProfitHistory.push({
    timestamp: new Date().toISOString(),
    userId: userId || 'anonymous',
    ticker,
    type, // 'take-profit' or 'stop-loss'
    profitPercent: analysis.profitPercent,
    netProfit: analysis.netProfit,
    urgencyScore: analysis.urgencyScore || 0,
    avgCost: analysis.avgCost,
    exitPrice: analysis.currentBid,
    executed: result.executed,
    filledCount: result.filledCount || 0,
    fillPrice: result.fillPrice || 0,
    realizedProfit: result.realizedProfit || 0,
    reason: result.reason
  });
  // Trim in-memory array to prevent unbounded growth between debounced saves
  if (takeProfitHistory.length > MAX_TP_HISTORY * 2) {
    takeProfitHistory = takeProfitHistory.slice(-MAX_TP_HISTORY);
  }
  saveTakeProfitHistory();
}

// In-memory store for price snapshots
let priceSnapshots = [];

// Load existing snapshots
try {
  if (fs.existsSync(PRICE_SNAPSHOTS_FILE)) {
    priceSnapshots = JSON.parse(fs.readFileSync(PRICE_SNAPSHOTS_FILE, 'utf8'));
    console.log(` Loaded ${priceSnapshots.length} price snapshots`);
  }
} catch (err) {
  console.error('Error loading price snapshots:', err.message);
  priceSnapshots = [];
}

// Save snapshots to disk (debounced)
function savePriceSnapshots() {
  debouncedWrite('priceSnapshots', () => {
    try {
      // Trim to max size
      if (priceSnapshots.length > MAX_SNAPSHOTS) {
        priceSnapshots = priceSnapshots.slice(-MAX_SNAPSHOTS);
      }
      fs.writeFileSync(PRICE_SNAPSHOTS_FILE, JSON.stringify(priceSnapshots, null, 2));
      console.log(` Saved ${priceSnapshots.length} price snapshots`);
    } catch (err) {
      console.error('Error saving price snapshots:', err.message);
    }
  });
}

/**
 * Record price snapshot for an active market
 * @param {object} market - Market data with ticker, strikePrice, closeTime
 * @param {number} currentPrice - Current crypto price
 * @param {string} token - Token symbol (BTC, ETH, SOL)
 */
function recordPriceSnapshot(market, currentPrice, token) {
  const now = Date.now();
  const closeTime = new Date(market.closeTime || market.close_time).getTime();
  const timeToSettlement = (closeTime - now) / 60000; // minutes

  if (timeToSettlement <= 0 || timeToSettlement > 15) return;

  const strikePrice = market.strikePrice || market.floor_strike;
  if (!strikePrice || !currentPrice) return;

  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice) * 100;

  const vol5m = cryptoPrices[token]?.volatility ?? null;

  priceSnapshots.push({
    ticker: market.ticker,
    token,
    timestamp: new Date().toISOString(),
    currentPrice,
    strikePrice,
    pctFromStrike: parseFloat(pctFromStrike.toFixed(4)),
    timeToSettlement: parseFloat(timeToSettlement.toFixed(2)),
    marketDuration, // 15 or 60 minutes — enables duration-aware table building
    vol5m: vol5m !== null ? parseFloat(vol5m.toFixed(6)) : null, // Volatility at snapshot time
    settledResult: null // Will be filled when market settles
  });
}

/**
 * Match settled market with its snapshots and update results
 * @param {string} ticker - Market ticker
 * @param {string} result - Settlement result ('yes' or 'no')
 */
function matchSettlementWithSnapshots(ticker, result) {
  let matched = 0;
  for (const snapshot of priceSnapshots) {
    if (snapshot.ticker === ticker && snapshot.settledResult === null) {
      snapshot.settledResult = result;
      matched++;
    }
  }
  if (matched > 0) {
    console.log(` Matched ${matched} snapshots with settlement result: ${ticker} = ${result}`);
    savePriceSnapshots();
  }
}

/**
 * Analyze prospective data to get "betting time" win rates
 * This measures: "At T-X minutes before settlement, if price was Y% from strike, what was the result?"
 */
function analyzeProspectiveData() {
  const settledSnapshots = priceSnapshots.filter(s => s.settledResult !== null);

  if (settledSnapshots.length < 50) {
    return { success: false, error: 'Insufficient data', count: settledSnapshots.length };
  }

  // Group by time-to-settlement buckets
  const timeBuckets = { '0-2min': [], '2-5min': [], '5-10min': [], '10-15min': [] };

  for (const s of settledSnapshots) {
    const t = s.timeToSettlement;
    if (t <= 2) timeBuckets['0-2min'].push(s);
    else if (t <= 5) timeBuckets['2-5min'].push(s);
    else if (t <= 10) timeBuckets['5-10min'].push(s);
    else timeBuckets['10-15min'].push(s);
  }

  const analysis = {};

  for (const [bucket, snapshots] of Object.entries(timeBuckets)) {
    if (snapshots.length < 10) continue;

    // For each distance range, calculate actual win rate
    const distanceRanges = [
      { name: '0-0.5%', min: 0, max: 0.5 },
      { name: '0.5-1%', min: 0.5, max: 1 },
      { name: '1-2%', min: 1, max: 2 },
      { name: '2%+', min: 2, max: Infinity }
    ];

    analysis[bucket] = { total: snapshots.length, byDistance: {} };

    for (const range of distanceRanges) {
      const inRange = snapshots.filter(s => {
        const abs = Math.abs(s.pctFromStrike);
        return abs >= range.min && abs < range.max;
      });

      if (inRange.length < 5) continue;

      // Calculate: if price was above strike, did YES win?
      let favoredWins = 0;
      for (const s of inRange) {
        const yesFavored = s.pctFromStrike > 0;
        const yesWon = s.settledResult === 'yes';
        if ((yesFavored && yesWon) || (!yesFavored && !yesWon)) {
          favoredWins++;
        }
      }

      analysis[bucket].byDistance[range.name] = {
        count: inRange.length,
        favoredWinRate: parseFloat((favoredWins / inRange.length * 100).toFixed(2))
      };
    }
  }

  return { success: true, totalSettled: settledSnapshots.length, analysis };
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
          };
        }
        if (row.config?.activeMonitoring) {
          loadedConfig.activeMonitoring = {
            ...DEFAULT_CONFIG.activeMonitoring,
            ...row.config.activeMonitoring,
          };
        }
        userStates.set(userId, {
          userId,
          config: loadedConfig,
          betHistory: row.bet_history || [],
          portfolio: row.portfolio || { balance: 0, positions: [] }
        });
        // Restore copy trading state if saved
        if (loadedConfig.copyTrading) {
          loadCopyState(userId, loadedConfig.copyTrading);
        }
        // Restore Polymarket tracker state if saved
        if (loadedConfig.polyTrading) {
          loadPolyState(userId, loadedConfig.polyTrading);
        }
        console.log(` Loaded state for user ${userId} from database`);
      } else {
        // New user - create default state
        const newState = createDefaultUserState();
        newState.userId = userId;
        userStates.set(userId, newState);
        console.log(` Created new state for user ${userId}`);
      }
    } catch (err) {
      console.error(`Error loading user state for ${userId}:`, err);
      const fallbackState = createDefaultUserState();
      fallbackState.userId = userId;
      userStates.set(userId, fallbackState);
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
  defaultState.userId = userId;
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

// Wire Kalshi API module to use global config as default
setKalshiDefaultConfig(config);

// ============================================
// PERFORMANCE TRACKING
// ============================================
// Track all bets and their outcomes to measure model accuracy

const PERFORMANCE_FILE = path.join(__dirname, 'performance_data.json');

let performanceData = {
  bets: [], // All tracked bets with outcomes
  summary: {
    totalBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    totalWagered: 0, // cents
    totalProfit: 0, // cents (can be negative)
    winRate: 0,
    avgPredictedProb: 0,
    avgActualWinRate: 0,
    calibration: {} // predicted bucket -> actual win rate
  },
  byToken: {}, // token -> { bets, wins, losses, profit }
  byProbBucket: {}, // "60-65" -> { bets, wins, actualRate }
  byMarketType: {}, // "15min" | "daily" -> stats
  lastUpdated: null
};

// Load performance data from file
function loadPerformanceData() {
  try {
    if (fs.existsSync(PERFORMANCE_FILE)) {
      const data = fs.readFileSync(PERFORMANCE_FILE, 'utf8');
      performanceData = JSON.parse(data);
      console.log(` Loaded ${performanceData.bets.length} historical bets`);
    }
  } catch (err) {
    console.log('Could not load performance data:', err.message);
  }
}

// Save performance data to file (debounced)
function savePerformanceData() {
  debouncedWrite('performanceData', () => {
    try {
      performanceData.lastUpdated = new Date().toISOString();
      fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(performanceData, null, 2));
    } catch (err) {
      console.log('Could not save performance data:', err.message);
    }
  });
}

// ============================================
// DAILY P&L TRACKING
// ============================================
const DAILY_PNL_FILE = path.join(__dirname, 'daily_pnl_history.json');
let dailyPnlHistory = [];
let dailyStats = {
  date: new Date().toISOString().slice(0, 10),
  betsPlaced: 0,
  fills: 0,
  wins: 0,
  losses: 0,
  netPnlCents: 0,
  totalWageredCents: 0,
  bestBet: null,   // { ticker, pnlCents }
  worstBet: null,  // { ticker, pnlCents }
};

function loadDailyPnlHistory() {
  try {
    if (fs.existsSync(DAILY_PNL_FILE)) {
      dailyPnlHistory = JSON.parse(fs.readFileSync(DAILY_PNL_FILE, 'utf8'));
      console.log(` Loaded ${dailyPnlHistory.length} daily P&L records`);
    }
  } catch (err) {
    console.log('Could not load daily P&L history:', err.message);
  }
}
loadDailyPnlHistory();

function saveDailyPnlHistory() {
  debouncedWrite('dailyPnl', () => {
    try {
      // Keep last 30 days
      if (dailyPnlHistory.length > 30) dailyPnlHistory = dailyPnlHistory.slice(-30);
      fs.writeFileSync(DAILY_PNL_FILE, JSON.stringify(dailyPnlHistory, null, 2));
    } catch (err) {
      console.log('Could not save daily P&L history:', err.message);
    }
  });
}

function rolloverDailyStats() {
  const todayUTC = new Date().toISOString().slice(0, 10);
  if (dailyStats.date === todayUTC) return;
  // Day changed — archive yesterday's stats
  const summary = { ...dailyStats };
  dailyPnlHistory.push(summary);
  saveDailyPnlHistory();

  const pnlDollar = (summary.netPnlCents / 100).toFixed(2);
  const winRate = summary.wins + summary.losses > 0
    ? ((summary.wins / (summary.wins + summary.losses)) * 100).toFixed(1)
    : '0.0';
  console.log(` DAILY P&L SUMMARY (${summary.date}): ${summary.wins}W/${summary.losses}L (${winRate}%) P&L: $${pnlDollar}`);

  // Discord summary
  sendDiscordAlert({
    title: `Daily P&L Summary — ${summary.date}`,
    color: summary.netPnlCents >= 0 ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: 'Bets', value: `${summary.fills} fills (${summary.wins}W / ${summary.losses}L)`, inline: true },
      { name: 'Win Rate', value: `${winRate}%`, inline: true },
      { name: 'Net P&L', value: `$${pnlDollar}`, inline: true },
      { name: 'Wagered', value: `$${(summary.totalWageredCents / 100).toFixed(2)}`, inline: true },
      ...(summary.bestBet ? [{ name: 'Best', value: `${summary.bestBet.ticker} +${(summary.bestBet.pnlCents / 100).toFixed(2)}`, inline: true }] : []),
      ...(summary.worstBet ? [{ name: 'Worst', value: `${summary.worstBet.ticker} ${(summary.worstBet.pnlCents / 100).toFixed(2)}`, inline: true }] : []),
    ],
  });

  // Reset for new day
  dailyStats = {
    date: todayUTC,
    betsPlaced: 0,
    fills: 0,
    wins: 0,
    losses: 0,
    netPnlCents: 0,
    totalWageredCents: 0,
    bestBet: null,
    worstBet: null,
  };
}

// Track a new bet
function trackBet(betInfo) {
  const bet = {
    id: betInfo.id || Date.now().toString(),
    timestamp: new Date().toISOString(),
    userId: betInfo.userId || null, // Track which user placed this bet
    ticker: betInfo.ticker,
    title: betInfo.title,
    token: betInfo.token || betInfo.assetType || getTokenFromTicker(betInfo.ticker),
    side: betInfo.side,
    contracts: betInfo.count || 1,
    price: betInfo.price, // cents
    totalCost: betInfo.totalCost, // cents
    predictedProb: betInfo.predictedProb || parseFloat(betInfo.winProbability) || 0,
    marketPrice: betInfo.marketPrice || betInfo.price,
    edge: betInfo.edge || 0,
    strikePrice: betInfo.strikePrice,
    currentPriceAtBet: betInfo.currentPrice,
    expiryTime: betInfo.expiryTime,
    marketType: betInfo.marketType || (betInfo.ticker?.includes('15M') ? '15min' : 'daily'),
    // Outcome tracking (filled in later)
    outcome: 'pending', // 'won' | 'lost' | 'pending'
    settlementPrice: null,
    actualProfit: null, // cents
    settledAt: null
  };

  performanceData.bets.push(bet);
  performanceData.summary.totalBets++;
  performanceData.summary.pending++;
  performanceData.summary.totalWagered += bet.totalCost;

  // Daily P&L tracking
  dailyStats.betsPlaced++;
  dailyStats.fills++;
  dailyStats.totalWageredCents += bet.totalCost;

  savePerformanceData();
  console.log(` Tracked bet: ${bet.side} on ${bet.token} @ ${bet.price}c (${bet.predictedProb.toFixed(1)}% predicted)`);

  return bet;
}

// Update bet with settlement outcome
function settleBet(betId, outcome, settlementPrice, actualProfit) {
  const bet = performanceData.bets.find(b => b.id === betId);
  if (!bet || bet.outcome !== 'pending') return null;

  bet.outcome = outcome; // 'won' or 'lost'
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

  // Match prospective data snapshots with this settlement result
  if (bet.ticker) {
    const result = outcome === 'won' ? bet.side.toLowerCase() : (bet.side.toLowerCase() === 'yes' ? 'no' : 'yes');
    matchSettlementWithSnapshots(bet.ticker, result);
  }

  // Daily P&L tracking
  const pnlCents = outcome === 'won' ? actualProfit : -bet.totalCost;
  if (outcome === 'won') { dailyStats.wins++; } else { dailyStats.losses++; }
  dailyStats.netPnlCents += pnlCents;
  if (!dailyStats.bestBet || pnlCents > dailyStats.bestBet.pnlCents) {
    dailyStats.bestBet = { ticker: bet.ticker, pnlCents };
  }
  if (!dailyStats.worstBet || pnlCents < dailyStats.worstBet.pnlCents) {
    dailyStats.worstBet = { ticker: bet.ticker, pnlCents };
  }

  // Discord alert on settlement
  const settledCount = performanceData.summary.wins + performanceData.summary.losses;
  const runningWinRate = settledCount > 0 ? ((performanceData.summary.wins / settledCount) * 100).toFixed(1) : '0.0';
  sendDiscordAlert({
    title: `${outcome === 'won' ? 'WIN' : 'LOSS'}: ${bet.side} on ${bet.token}`,
    color: outcome === 'won' ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: 'Ticker', value: bet.ticker || 'N/A', inline: true },
      { name: 'P&L', value: `${pnlCents > 0 ? '+' : ''}${(pnlCents / 100).toFixed(2)}`, inline: true },
      { name: 'Running W/R', value: `${runningWinRate}% (${performanceData.summary.wins}W/${performanceData.summary.losses}L)`, inline: true },
      { name: 'Daily P&L', value: `$${(dailyStats.netPnlCents / 100).toFixed(2)}`, inline: true },
    ],
  });

  console.log(` Settled bet: ${bet.side} on ${bet.token} ${outcome.toUpperCase()} (${actualProfit > 0 ? '+' : ''}${actualProfit}c)`);
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

  console.log(` Checking ${pending.length} pending bets for settlement...`);

  for (const bet of pending) {
    // Guard against concurrent settlement of the same bet (async gap between find and settle)
    if (bet._settling) continue;
    bet._settling = true;
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
            const result = market.market.result; // 'yes' or 'no'
            const won = (bet.side.toLowerCase() === result);
            const contracts = bet.contracts || Math.floor((bet.totalCost || 0) / (bet.priceCents || 1));
            const profit = won ? (contracts * 100 - (bet.totalCost || 0)) : 0;
            settleBet(bet.id, won ? 'won' : 'lost', market.market.settlement_value, profit);
            console.log(` Settled bet ${bet.id}: ${won ? 'WON' : 'LOST'} (${bet.side} on ${bet.ticker})`);
          } else {
            // Market exists but no result yet — Kalshi hasn't settled it
            if (!bet._noResultLogCount) bet._noResultLogCount = 0;
            if (bet._noResultLogCount++ < 3) {
              console.log(` Market ${bet.ticker} has no result yet — waiting for Kalshi settlement`);
            }
          }
        } catch (e) {
          // Log the error so we can diagnose settlement failures
          if (!bet._apiErrorLogCount) bet._apiErrorLogCount = 0;
          if (bet._apiErrorLogCount++ < 3) {
            console.log(` Settlement API error for ${bet.ticker}: ${e.message}`);
          }
        }
      }

      // For simulated bets or if we can't get Kalshi data, check price
      if (bet.outcome === 'pending' && bet.strikePrice && bet.token) {
        const currentPrice = cryptoPrices[bet.token]?.price;
        const priceAge = Date.now() - (cryptoPrices[bet.token]?.timestamp || 0);
        // Use inferred expiryTime (variable from above) which may have been set earlier in this iteration
        // Reject stale prices (>60s old) — they give wrong settlement results
        if (priceAge > 60000) {
          if (!bet._staleLogCount) bet._staleLogCount = 0;
          if (bet._staleLogCount++ < 3) {
            console.log(` Skipping price-based settlement for ${bet.id}: price is ${(priceAge/1000).toFixed(0)}s stale`);
          }
        } else if (currentPrice && expiryTime && new Date(expiryTime) <= new Date()) {
          // Only settle from price if data is fresh (within 60s of expiry)
          // Stale prices give wrong settlement results
          const expiryMs = new Date(expiryTime).getTime();
          const settlementDelay = Date.now() - expiryMs;
          if (settlementDelay > 120000) {
            // More than 2 minutes past expiry — price has likely moved, skip price-based settlement
            // Cap log spam: only log first 5 attempts, then suppress until timeout
            if (!bet._settlementAttempts) bet._settlementAttempts = 0;
            bet._settlementAttempts++;
            if (bet._settlementAttempts <= 5) {
              console.log(` Skipping price-based settlement for ${bet.id}: ${(settlementDelay/1000).toFixed(0)}s past expiry (price may be stale)`);
            } else if (bet._settlementAttempts === 6) {
              console.log(` Settlement for ${bet.id}: suppressing further logs (waiting for Kalshi API result)`);
            }
            // After 30 minutes of retries, make one final Kalshi API attempt before giving up
            if (settlementDelay > 30 * 60 * 1000) {
              console.log(` Settlement TIMEOUT for ${bet.id}: ${(settlementDelay/1000).toFixed(0)}s past expiry — final API check...`);
              let finalSettled = false;
              if (bet.ticker) {
                try {
                  const finalMarket = await kalshiRequest('GET', `/markets/${bet.ticker}`, null, userConfig);
                  if (finalMarket.market?.result) {
                    const result = finalMarket.market.result;
                    const won = (bet.side.toLowerCase() === result);
                    const contracts3 = bet.contracts || Math.floor((bet.totalCost || 0) / (bet.priceCents || 1));
                    const profit = won ? (contracts3 * 100 - (bet.totalCost || 0)) : 0;
                    settleBet(bet.id, won ? 'won' : 'lost', finalMarket.market.settlement_value, profit);
                    console.log(` Final API check SUCCEEDED for ${bet.id}: ${won ? 'WON' : 'LOST'} (${bet.side} on ${bet.ticker})`);
                    finalSettled = true;
                  }
                } catch (e) {
                  console.log(` Final API check failed for ${bet.id}: ${e.message}`);
                }
              }
              if (!finalSettled) {
                console.log(` Forcing LOSS for ${bet.id} after all settlement attempts exhausted`);
                settleBet(bet.id, 'lost', null, 0);
              }
            }
          } else {
            // Market should have settled - determine outcome from price
            const isAbove = currentPrice >= bet.strikePrice;
            const won = (bet.side.toLowerCase() === 'yes' && isAbove) ||
                        (bet.side.toLowerCase() === 'no' && !isAbove);
            const contracts2 = bet.contracts || Math.floor((bet.totalCost || 0) / (bet.priceCents || 1));
            const profit = won ? (contracts2 * 100 - (bet.totalCost || 0)) : 0;
            settleBet(bet.id, won ? 'won' : 'lost', currentPrice, profit);
            console.log(` Settled bet ${bet.id} via price: ${won ? 'WON' : 'LOST'} (${bet.side} ${bet.token} @ strike $${bet.strikePrice}, current $${currentPrice}, delay=${(settlementDelay/1000).toFixed(0)}s)`);
          }
        }
      }
      // Cross-update betHistory when a performanceData bet settles
      if (bet.outcome !== 'pending' && bet.userId) {
        const userState = getUserState(bet.userId);
        const ubh = userState?.betHistory;
        if (ubh) {
          const match = ubh.find(b =>
            b.ticker === bet.ticker &&
            (b.side || '').toLowerCase() === (bet.side || '').toLowerCase() &&
            b.outcome !== 'won' && b.outcome !== 'lost'
          );
          if (match) {
            match.outcome = bet.outcome;
            match.profit = bet.actualProfit || 0;
            match.status = 'settled';
            saveUserState(bet.userId);
          }
        }
      }
    } catch (err) {
      console.log(`Error checking settlement for ${bet.ticker}:`, err.message);
    } finally {
      bet._settling = false;
    }
  }
}

// Load performance data on startup
loadPerformanceData();

// ============================================
// AUTO-LOAD CREDENTIALS FROM ENVIRONMENT
// ============================================
// Set these in Render dashboard under Environment Variables:
// KALSHI_API_KEY_ID = your API key ID
// KALSHI_PRIVATE_KEY = your private key (replace newlines with \n)
//
// For the private key, you can either:
// 1. Replace actual newlines with literal \n characters
// 2. Or base64 encode it and set KALSHI_PRIVATE_KEY_BASE64 instead

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
    console.log(' Found Kalshi credentials in environment variables');
    config.apiKeyId = apiKeyId.trim();
    config.privateKey = privateKey.trim();
    config.isAuthenticated = true;

    // Verify credentials by fetching balance
    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;
      console.log(` Kalshi authenticated! Balance: $${(portfolio.balance / 100).toFixed(2)}`);
      // Update WebSocket with valid credentials
      if (kalshiWs) {
        kalshiWs.setCredentials(config.apiKeyId, config.privateKey);
      }
    } catch (error) {
      console.error(' Kalshi credentials invalid:', error.message);
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;
    }
  } else {
    console.log(' No Kalshi credentials in environment. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_BASE64) in Render dashboard.');
  }
}

// Track markets we've already bet on to avoid duplicate bets
// Key: ticker, Value: { timestamp, side, probability, betCount }
const recentBets = new Map();

// Fix 2: Unfilled-order cooldown per market (exponential backoff)
const unfilledCooldowns = new Map(); // betKey -> { timestamp, consecutiveUnfills, cooldownMs }
const UNFILLED_BASE_COOLDOWN_MS = 2 * 60 * 1000;  // 2 min base
const UNFILLED_MAX_COOLDOWN_MS = 10 * 60 * 1000;   // 10 min max

// Fix 5: Track 429 rate limit pressure
let recent429Count = 0;
let last429ResetTime = Date.now();

// Check if we should allow a scale-in bet on this market
function shouldAllowScaleIn(ticker, currentProbability, currentSide, userConfig, userId) {
  const cfg = userConfig || config;
  if (!cfg.scaleIn.enabled) return false;

  const betKey = `${userId ?? 'default'}:${ticker}`;
  const existing = recentBets.get(betKey);
  if (!existing) return false; // No existing bet, this isn't a scale-in

  // CRITICAL: Reject if bet side flipped (YES->NO or NO->YES)
  // When crypto oscillates around strike, model alternates sides - betting both loses to fees
  if (currentSide && existing.side && existing.side.toUpperCase() !== currentSide.toUpperCase()) {
    console.log(` SIDE FLIP BLOCKED: ${ticker} was ${existing.side} now ${currentSide} refusing to bet both sides`);
    return false;
  }

  const now = Date.now();
  const timeSinceLastBet = now - existing.timestamp;

  // Check time between bets
  if (timeSinceLastBet < cfg.scaleIn.minTimeBetweenBets) {
    return false;
  }

  // Check max bets per market
  if ((existing.betCount || 1) >= cfg.scaleIn.maxBetsPerMarket) {
    return false;
  }

  // Check probability improvement
  const probIncrease = currentProbability - (existing.probability || 0);
  if (probIncrease < cfg.scaleIn.minProbabilityIncrease) {
    return false;
  }

  console.log(` SCALE-IN OPPORTUNITY: ${ticker}`);
  console.log(` Previous prob: ${existing.probability}% Current: ${currentProbability}% (+${probIncrease.toFixed(1)}%)`);
  console.log(` Bet #${(existing.betCount || 1) + 1} of max ${cfg.scaleIn.maxBetsPerMarket}`);

  return true;
}

// Edge requirements - lower for "obvious" high-probability bets
// Strategy: Safe growth from $10 $100 by taking high-probability bets
const AUTO_BET_MIN_EDGE = 3; // 3% edge for auto (lower for safe bets)
const MANUAL_BET_MIN_EDGE = 2; // 2% edge for manual
const OBVIOUS_BET_MIN_EDGE = 1; // 1% edge OK if probability is >90% (free money)

// ============================================
// CRYPTO PRICE TRACKING - EXPANDED TOKENS
// ============================================

// Only tracking 15-minute BTC, ETH, SOL, XRP markets
const TRACKED_TOKENS = {
  BTC: { name: 'Bitcoin', minPrice: 10000, maxPrice: 500000 },
  ETH: { name: 'Ethereum', minPrice: 100, maxPrice: 20000 },
  SOL: { name: 'Solana', minPrice: 1, maxPrice: 1000 },
  XRP: { name: 'XRP', minPrice: 0.1, maxPrice: 50 }
};

// NEWS & SENTIMENT - module imported from ./sentiment.js
sentiment.init(TRACKED_TOKENS);
sentiment.startNewsMonitoring();

// Ring buffer for O(1) price history updates (replaces O(n) array.shift())
// Returns a Proxy that supports array-like index access (buf[0], buf[i], etc.)
function createRingBuffer(capacity) {
  const state = {
    _buf: new Array(capacity),
    _capacity: capacity,
    _head: 0,
    _size: 0
  };

  function toArray() {
    if (state._size === 0) return [];
    if (state._size < state._capacity) {
      return state._buf.slice(0, state._size);
    }
    return [...state._buf.slice(state._head), ...state._buf.slice(0, state._head)];
  }

  function getByIndex(idx) {
    if (idx < 0 || idx >= state._size) return undefined;
    if (state._size < state._capacity) {
      return state._buf[idx];
    }
    return state._buf[(state._head + idx) % state._capacity];
  }

  const handler = {
    get(target, prop) {
      // Handle Symbol props first (Symbol.iterator, etc.)
      if (typeof prop === 'symbol') {
        if (prop === Symbol.iterator) return function*() {
          const arr = toArray();
          for (const item of arr) yield item;
        };
        return undefined;
      }
      // Numeric index access
      const idx = Number(prop);
      if (Number.isInteger(idx) && idx >= 0) {
        return getByIndex(idx);
      }
      if (prop === 'length') return state._size;
      if (prop === 'push') return (item) => {
        state._buf[state._head] = item;
        state._head = (state._head + 1) % state._capacity;
        if (state._size < state._capacity) state._size++;
      };
      if (prop === 'toArray') return toArray;
      if (prop === 'filter') return (fn) => toArray().filter(fn);
      if (prop === 'map') return (fn) => toArray().map(fn);
      if (prop === 'reduce') return (...args) => toArray().reduce(...args);
      if (prop === 'forEach') return (fn) => toArray().forEach(fn);
      if (prop === 'slice') return (a, b) => toArray().slice(a, b);
      if (prop === 'sort') return (fn) => toArray().sort(fn);
      return undefined;
    }
  };

  return new Proxy({}, handler);
}

// Price data storage
const cryptoPrices = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  cryptoPrices[token] = { price: 0, timestamp: 0, history: createRingBuffer(120), volatility: 0.02 };
});

// Kraken symbol mapping (PRIMARY - fast, US-legal)
const KRAKEN_SYMBOLS = {
  BTC: 'BTC/USD',
  ETH: 'ETH/USD',
  SOL: 'SOL/USD',
  XRP: 'XRP/USD'
};

// Reverse map: "BTC/USD" -> "BTC"
const KRAKEN_SYMBOL_TO_TOKEN = {};
for (const [token, symbol] of Object.entries(KRAKEN_SYMBOLS)) {
  KRAKEN_SYMBOL_TO_TOKEN[symbol] = token;
}

// CoinGecko ID mapping (FALLBACK - slower but reliable)
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple'
};

// Track which price source we're using
let priceSource = 'none';
let krakenFailCount = 0;

// Helper to update a token's price data
function updateTokenPrice(token, price, now, source) {
  if (!cryptoPrices[token]) return;

  cryptoPrices[token].price = price;
  cryptoPrices[token].timestamp = now;
  cryptoPrices[token].source = source || priceSource;
  if (source) priceSource = source;

  // Ring buffer: O(1) insert, capped at 120 entries automatically
  cryptoPrices[token].history.push({ price, time: now });

  // Keep extended history for statistical analysis (2 hours)
  if (!priceHistoryExtended[token]) priceHistoryExtended[token] = [];
  priceHistoryExtended[token].push({ price, time: now });
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  priceHistoryExtended[token] = priceHistoryExtended[token].filter(p => p.time > twoHoursAgo);

  // Calculate volatility
  cryptoPrices[token].volatility = calculateVolatility(cryptoPrices[token].history, token);
}

// Kraken WebSocket state
let krakenWsConnected = false;
let krakenWs = null;
let krakenWsReconnectDelay = 1000;
let krakenWsReconnectTimer = null;
let lastWsPriceUpdate = 0;

function initKrakenWebSocket() {
  if (krakenWs) {
    try { krakenWs.close(); } catch (e) {}
  }

  console.log(' Connecting to Kraken WebSocket...');
  krakenWs = new WebSocket('wss://ws.kraken.com/v2');

  krakenWs.on('open', () => {
    krakenWsConnected = true;
    krakenWsReconnectDelay = 1000;
    console.log(' Kraken WebSocket connected - real-time prices active');

    // Subscribe to ticker for all tracked tokens
    const subscribeMsg = JSON.stringify({
      method: 'subscribe',
      params: {
        channel: 'ticker',
        symbol: Object.values(KRAKEN_SYMBOLS)
      }
    });
    krakenWs.send(subscribeMsg);
  });

  krakenWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Kraken v2 ticker: {channel: "ticker", type: "snapshot"/"update", data: [{symbol, last, ...}]}
      if (msg.channel !== 'ticker') return;

      for (const item of msg.data) {
        const token = KRAKEN_SYMBOL_TO_TOKEN[item.symbol];
        if (!token) continue;

        const price = parseFloat(item.last);
        if (!price || price <= 0) continue;

        const now = Date.now();
        updateTokenPrice(token, price, now, 'kraken-ws');
        lastWsPriceUpdate = now;
        krakenFailCount = 0;
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  krakenWs.on('close', (code, reason) => {
    krakenWsConnected = false;
    console.log(` Kraken WebSocket closed (code=${code}). Reconnecting in ${krakenWsReconnectDelay/1000}s...`);
    scheduleKrakenWsReconnect();
  });

  krakenWs.on('error', (err) => {
    krakenWsConnected = false;
    console.error('Kraken WebSocket error:', err.message);
  });
}

function scheduleKrakenWsReconnect() {
  if (krakenWsReconnectTimer) clearTimeout(krakenWsReconnectTimer);
  krakenWsReconnectTimer = setTimeout(() => {
    krakenWsReconnectTimer = null;
    initKrakenWebSocket();
    krakenWsReconnectDelay = Math.min(krakenWsReconnectDelay * 2, 30000);
  }, krakenWsReconnectDelay);
}

// Coinbase WebSocket state
let coinbaseWsConnected = false;
let coinbaseWs = null;
let coinbaseWsReconnectDelay = 1000;
let coinbaseWsReconnectTimer = null;

const COINBASE_SYMBOLS = {
  'BTC-USD': 'BTC',
  'ETH-USD': 'ETH',
  'SOL-USD': 'SOL',
  'XRP-USD': 'XRP'
};

function initCoinbaseWebSocket() {
  if (coinbaseWs) {
    try { coinbaseWs.close(); } catch (e) {}
  }

  console.log(' Connecting to Coinbase Advanced Trade WebSocket...');
  coinbaseWs = new WebSocket('wss://advanced-trade-ws.coinbase.com');

  coinbaseWs.on('open', () => {
    coinbaseWsConnected = true;
    coinbaseWsReconnectDelay = 1000;
    console.log(' Coinbase WebSocket connected - real-time prices active');

    const subscribeMsg = JSON.stringify({
      type: 'subscribe',
      product_ids: Object.keys(COINBASE_SYMBOLS),
      channel: 'ticker'
    });
    coinbaseWs.send(subscribeMsg);
  });

  coinbaseWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel !== 'ticker') return;
      if (!msg.events) return;

      for (const event of msg.events) {
        if (!event.tickers) continue;
        for (const ticker of event.tickers) {
          const token = COINBASE_SYMBOLS[ticker.product_id];
          if (!token) continue;
          const price = parseFloat(ticker.price);
          if (!price || price <= 0) continue;
          const now = Date.now();
          updateTokenPrice(token, price, now, 'coinbase-ws');
          lastWsPriceUpdate = now;
        }
      }
    } catch (e) {
      // Ignore parse errors on individual messages
    }
  });

  coinbaseWs.on('close', (code, reason) => {
    coinbaseWsConnected = false;
    console.log(` Coinbase WebSocket closed (code=${code}). Reconnecting in ${coinbaseWsReconnectDelay/1000}s...`);
    scheduleCoinbaseWsReconnect();
  });

  coinbaseWs.on('error', (err) => {
    coinbaseWsConnected = false;
    console.error('Coinbase WebSocket error:', err.message);
  });
}

function scheduleCoinbaseWsReconnect() {
  if (coinbaseWsReconnectTimer) clearTimeout(coinbaseWsReconnectTimer);
  coinbaseWsReconnectTimer = setTimeout(() => {
    coinbaseWsReconnectTimer = null;
    initCoinbaseWebSocket();
    coinbaseWsReconnectDelay = Math.min(coinbaseWsReconnectDelay * 2, 30000);
  }, coinbaseWsReconnectDelay);
}

// Fetch prices from Kraken REST (PRIMARY - fast, US-legal, no API key needed)
async function fetchKrakenPrices() {
  try {
    const pairs = Object.values(KRAKEN_SYMBOLS).map(s => s.replace('/', '')).join(',');
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
    const data = await res.json();

    if (data.error && data.error.length > 0) {
      throw new Error(data.error[0]);
    }

    const now = Date.now();
    let updated = 0;

    // Kraken uses non-standard pair names in response (XXBTZUSD, XETHZUSD, SOLUSD)
    const KRAKEN_RESPONSE_MAP = {
      'XXBTZUSD': 'BTC', 'XBTUSD': 'BTC',
      'XETHZUSD': 'ETH', 'ETHUSD': 'ETH',
      'SOLUSD': 'SOL',
      'XXRPZUSD': 'XRP', 'XRPUSD': 'XRP'
    };

    for (const [pair, ticker] of Object.entries(data.result || {})) {
      const token = KRAKEN_RESPONSE_MAP[pair];
      if (!token) continue;
      const price = parseFloat(ticker.c[0]); // c = last trade [price, volume]
      if (price && price > 0) {
        updateTokenPrice(token, price, now, 'kraken');
        updated++;
      }
    }

    if (updated > 0) krakenFailCount = 0;
    return updated > 0 ? cryptoPrices : null;
  } catch (error) {
    krakenFailCount++;
    if (krakenFailCount <= 3) {
      console.error('Kraken error (will fallback to CoinGecko):', error.message);
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
        updateTokenPrice(token, priceData.usd, now, 'coingecko');
        updated++;
      }
    }

    return updated > 0 ? cryptoPrices : null;
  } catch (error) {
    console.error('CoinGecko error:', error.message);
    return null;
  }
}

// Main price fetch function - tries Kraken first, falls back to CoinGecko
async function fetchCryptoPrices() {
  // Try Kraken first (faster)
  const krakenResult = await fetchKrakenPrices();
  if (krakenResult) {
    return krakenResult;
  }

  // Fall back to CoinGecko
  return await fetchCoinGeckoPrices();
}

// Store extended price history for analysis (last 2 hours)
const priceHistoryExtended = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  priceHistoryExtended[token] = [];
});

// Start price tracking: WebSocket primary, REST fallback every 5s
fetchCryptoPrices(); // Immediate fetch on startup (WebSocket takes a moment to connect)
let priceInterval = setInterval(() => {
  if (!krakenWsConnected && !coinbaseWsConnected) {
    console.log(' Both WebSockets disconnected - falling back to REST polling');
    fetchCryptoPrices();
  } else {
    // Even when WS is connected, check for per-token staleness
    const now = Date.now();
    const staleTokens = Object.entries(cryptoPrices)
      .filter(([, data]) => data?.price && (now - data.timestamp) > 10000)
      .map(([token]) => token);
    if (staleTokens.length > 0) {
      console.log(` WS connected but stale prices for: ${staleTokens.join(', ')} - triggering REST fetch`);
      fetchCryptoPrices();
    }
  }
}, 5000);
initKrakenWebSocket();
initCoinbaseWebSocket();

// ============================================
// BINANCE aggTrade STREAM — buy/sell pressure
// ============================================
const BINANCE_AGG_SYMBOLS = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL' };
const aggTradeVolume = {};
for (const token of Object.values(BINANCE_AGG_SYMBOLS)) {
  aggTradeVolume[token] = { trades: [] }; // { qty, isSell, ts }
}

function recordAggTrade(token, quantity, isSell, timestamp) {
  const bucket = aggTradeVolume[token];
  if (!bucket) return;
  bucket.trades.push({ qty: quantity, isSell, ts: timestamp });
  // Prune older than 30 min (needed for 30-min buy pressure calculation)
  const cutoff = timestamp - 30 * 60 * 1000;
  while (bucket.trades.length > 0 && bucket.trades[0].ts < cutoff) {
    bucket.trades.shift();
  }
}

function getBuyPressure(token) {
  const bucket = aggTradeVolume[token];
  if (!bucket || bucket.trades.length === 0) return { pressure1m: 0, pressure5m: 0, pressure15m: 0, pressure30m: 0 };
  const now = Date.now();
  let buy1 = 0, sell1 = 0, buy5 = 0, sell5 = 0, buy15 = 0, sell15 = 0, buy30 = 0, sell30 = 0;
  for (const t of bucket.trades) {
    const age = now - t.ts;
    if (t.isSell) { sell30 += t.qty; } else { buy30 += t.qty; }
    if (age <= 15 * 60000) {
      if (t.isSell) { sell15 += t.qty; } else { buy15 += t.qty; }
    }
    if (age <= 5 * 60000) {
      if (t.isSell) { sell5 += t.qty; } else { buy5 += t.qty; }
    }
    if (age <= 60000) {
      if (t.isSell) { sell1 += t.qty; } else { buy1 += t.qty; }
    }
  }
  const total1 = buy1 + sell1;
  const total5 = buy5 + sell5;
  const total15 = buy15 + sell15;
  const total30 = buy30 + sell30;
  return {
    pressure1m: total1 > 0 ? (buy1 - sell1) / total1 : 0,
    pressure5m: total5 > 0 ? (buy5 - sell5) / total5 : 0,
    pressure15m: total15 > 0 ? (buy15 - sell15) / total15 : 0,
    pressure30m: total30 > 0 ? (buy30 - sell30) / total30 : 0,
  };
}

let binanceAggWs = null;
let binanceAggWsConnected = false;
let binanceAggReconnectDelay = 1000;

function initBinanceAggTradeWebSocket() {
  const streams = Object.keys(BINANCE_AGG_SYMBOLS).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
  const url = `wss://stream.binance.us:9443/stream?streams=${streams}`;
  try {
    binanceAggWs = new WebSocket(url);
    binanceAggWs.on('open', () => {
      binanceAggWsConnected = true;
      binanceAggReconnectDelay = 1000;
      console.log(' Binance aggTrade WebSocket connected');
    });
    binanceAggWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const d = msg.data;
        if (d && d.e === 'aggTrade') {
          const token = BINANCE_AGG_SYMBOLS[d.s];
          if (token) {
            recordAggTrade(token, parseFloat(d.q), d.m, d.T || Date.now());
          }
        }
      } catch (e) { /* ignore parse errors */ }
    });
    binanceAggWs.on('close', () => {
      binanceAggWsConnected = false;
      console.log(` Binance aggTrade WS closed, reconnecting in ${binanceAggReconnectDelay / 1000}s`);
      setTimeout(initBinanceAggTradeWebSocket, binanceAggReconnectDelay);
      binanceAggReconnectDelay = Math.min(30000, binanceAggReconnectDelay * 2);
    });
    binanceAggWs.on('error', (err) => {
      console.log(' Binance aggTrade WS error:', err.message);
      try { binanceAggWs.close(); } catch (e) {}
    });
  } catch (err) {
    console.log(' Binance aggTrade WS init error:', err.message);
    setTimeout(initBinanceAggTradeWebSocket, binanceAggReconnectDelay);
    binanceAggReconnectDelay = Math.min(30000, binanceAggReconnectDelay * 2);
  }
}
initBinanceAggTradeWebSocket();



// ============================================
// FUNDING RATE via OKX (US-accessible, no auth)
// ============================================
const OKX_FUNDING_INSTRUMENTS = { 'BTC-USDT-SWAP': 'BTC', 'ETH-USDT-SWAP': 'ETH', 'SOL-USDT-SWAP': 'SOL' };
const fundingRates = {};

async function fetchFundingRates() {
  try {
    for (const [instId, token] of Object.entries(OKX_FUNDING_INSTRUMENTS)) {
      const resp = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, { timeout: 8000 });
      if (!resp.ok) continue;
      const data = await resp.json();
      const rate = parseFloat(data.data?.[0]?.fundingRate);
      if (isFinite(rate)) {
        fundingRates[token] = { rate, timestamp: Date.now() };
      }
    }
    const summary = Object.entries(fundingRates).map(([t, d]) => `${t}=${(d.rate * 100).toFixed(4)}%`).join(', ');
    console.log(` Funding rates (OKX): ${summary}`);
  } catch (err) {
    console.log(' Funding rate fetch error:', err.message);
  }
}

function getFundingRate(token) {
  const entry = fundingRates[token];
  if (!entry || Date.now() - entry.timestamp > 10 * 60 * 1000) return 0;
  return entry.rate;
}

// Poll funding rates every 60s
fetchFundingRates();
setInterval(fetchFundingRates, 60000);

// ============================================
// RISK MANAGEMENT
// ============================================


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
        console.log(` Cleaned up stale synced bet: ${bet.ticker}`);
      }
    }
  }

  if (cleanedCount > 0) {
    console.log(` Cleaned up ${cleanedCount} stale synced bets`);
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
    console.log(` Synced position: ${pos.ticker} | ${contracts} contracts @ ${pos.average_price || '?'}c | exposure: $${(totalCost / 100).toFixed(2)}`);
  }

  if (syncedCount > 0) {
    console.log(` Synced ${syncedCount} existing Kalshi positions to bet history`);
  }

  // Save user state if any changes were made
  if ((syncedCount > 0 || cleanedCount > 0) && userId) {
    saveUserState(userId);
  }
}

// Get total risk across all positions
// Now accepts optional userState for per-user tracking
function getRiskByType(userState = null) {
  let totalRisk = 0;

  const userBetHistory = userState?.betHistory || betHistory;
  const userPortfolio = userState?.portfolio || portfolio;

  // Track which tickers we already counted (to avoid double-counting)
  const countedTickers = new Set();

  // 1) Count from betHistory - most reliable since we set totalCost ourselves
  for (const bet of userBetHistory) {
    if (!bet.ticker) continue;
    if (isTickerExpired(bet.ticker)) continue;
    if (bet.status === 'settled' || bet.status === 'closed') continue;
    countedTickers.add(bet.ticker);
    totalRisk += bet.totalCost || (bet.count * bet.price) || 0;
  }

  // 2) Count Kalshi positions we don't already have in betHistory
  if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
    for (const pos of userPortfolio.positions) {
      if (!pos.ticker || countedTickers.has(pos.ticker)) continue;
      if (isTickerExpired(pos.ticker)) continue;
      const contracts = Math.abs(pos.position || 0);
      if (contracts <= 0) continue;

      let exposure = pos.market_exposure || 0;
      if (exposure > 0 && exposure <= 1) exposure = Math.round(exposure * 100);
      let avgPrice = pos.average_price || 0;
      if (avgPrice > 0 && avgPrice <= 1) avgPrice = Math.round(avgPrice * 100);

      totalRisk += exposure > 0 ? exposure : (avgPrice > 0 ? contracts * avgPrice : contracts * 75);
    }
  }

  return { total: totalRisk };
}

function getCurrentRiskFromPortfolio(userState = null) {
  const { total } = getRiskByType(userState);
  return total;
}

// Extract token symbol from market ticker (e.g., KXBTC-24... -> BTC, KXSOL1H... -> SOL)
function getTokenFromTicker(ticker) {
  if (!ticker) return null;
  const upper = ticker.toUpperCase();
  // Check known tokens first (handles KXBTC15M, etc.)
  for (const token of Object.keys(TRACKED_TOKENS)) {
    if (upper.includes(`KX${token}`)) return token;
  }
  // Fallback: extract letters after KX, stopping at digits or known suffixes
  const match = upper.match(/KX([A-Z]{2,5}?)(?:15M|D|\d|-)/);
  if (match) return match[1];
  return null;
}

// Check if a market ticker has expired (settled + 5 min grace period)
// Kalshi tickers use Eastern Time (ET), not UTC
function isTickerExpired(ticker) {
  if (!ticker) return false;
  const match = ticker.match(/(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/);
  if (!match) return false;
  const [, yearSuffix, monthStr, day, hour, minute] = match;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const year = 2000 + parseInt(yearSuffix);
  const mon = months[monthStr] || 0;
  const d = parseInt(day);
  // Determine ET→UTC offset (EST=5h, EDT=4h)
  // US DST: 2nd Sunday of March → 1st Sunday of November
  let isDST = false;
  if (mon > 2 && mon < 10) isDST = true; // Apr-Oct: always EDT
  else if (mon === 2) { // March: EDT after 2nd Sunday
    const firstDow = new Date(year, 2, 1).getDay();
    const secondSun = firstDow === 0 ? 8 : 15 - firstDow;
    isDST = d >= secondSun;
  } else if (mon === 10) { // November: EDT before 1st Sunday
    const firstDow = new Date(year, 10, 1).getDay();
    const firstSun = firstDow === 0 ? 1 : 8 - firstDow;
    isDST = d < firstSun;
  }
  const etOffset = isDST ? 4 : 5;
  const expiry = new Date(Date.UTC(year, mon, d, parseInt(hour) + etOffset, parseInt(minute)));
  return Date.now() > expiry.getTime() + 5 * 60 * 1000;
}

// Filter positions array to remove expired markets
function filterExpiredPositions(positions, log = false) {
  return positions.filter(p => {
    if (isTickerExpired(p.ticker)) {
      if (log) console.log(` -- Filtered expired position: ${p.ticker}`);
      return false;
    }
    return true;
  });
}

const CYCLE_WINDOW_MS = 15 * 60 * 1000; // 15-minute market cycle window

// Get total exposure per token across all positions
function getExposureByToken(userState = null) {
  const tokenExposure = {};

  const userBetHistory = userState?.betHistory || betHistory;
  const userPortfolio = userState?.portfolio || portfolio;
  const countedTickers = new Set();

  // 1) Count from betHistory first - we know totalCost is in cents
  for (const bet of userBetHistory) {
    if (!bet.ticker) continue;
    if (isTickerExpired(bet.ticker)) continue;
    if (bet.status === 'settled' || bet.status === 'closed') continue;

    countedTickers.add(bet.ticker);
    const betRisk = bet.totalCost || (bet.count * bet.price) || 0;
    const token = getTokenFromTicker(bet.ticker) || bet.assetType;
    if (token) {
      tokenExposure[token] = (tokenExposure[token] || 0) + betRisk;
    }
  }

  // 2) Count Kalshi positions not already in betHistory
  if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
    for (const pos of userPortfolio.positions) {
      if (!pos.ticker || countedTickers.has(pos.ticker)) continue;
      if (isTickerExpired(pos.ticker)) continue;
      const contracts = Math.abs(pos.position || 0);
      if (contracts <= 0) continue;

      let exposure = pos.market_exposure || 0;
      if (exposure > 0 && exposure <= 1) exposure = Math.round(exposure * 100);
      let avgPrice = pos.average_price || 0;
      if (avgPrice > 0 && avgPrice <= 1) avgPrice = Math.round(avgPrice * 100);

      const posRisk = exposure > 0 ? exposure : (avgPrice > 0 ? contracts * avgPrice : contracts * 75);
      const token = getTokenFromTicker(pos.ticker);
      if (token) {
        tokenExposure[token] = (tokenExposure[token] || 0) + posRisk;
      }
    }
  }

  return tokenExposure;
}

// Get max allowed per token per 15-min cycle (configurable, bankroll-proportional)
function getMaxPerTokenPerCycle(userConfig = null) {
  const cfg = userConfig || config;
  const fixedLimit = cfg.riskLimits.maxPerTokenPerCycle || cfg.riskLimits.maxPerToken || 500;
  const bankroll = cfg.bankroll || 0;
  // Don't risk more than 12% of bankroll per token per cycle (aggressive but user-requested 2-3x sizing)
  const proportionalLimit = Math.round(bankroll * 0.12);
  return Math.min(fixedLimit, Math.max(proportionalLimit, 50)); // Floor 50¢
}

// Get max total spend across ALL tokens per 15-min cycle (bankroll-proportional)
function getMaxTotalPerCycle(userConfig = null) {
  const cfg = userConfig || config;
  const fixedTotal = cfg.riskLimits?.maxTotalPerCycle || 1500;
  const bankroll = cfg.bankroll || 0;
  // Don't risk more than 35% of bankroll total per cycle (matching 12% per-token × 3-4 tokens)
  const proportionalTotal = Math.round(bankroll * 0.35);
  return Math.min(fixedTotal, Math.max(proportionalTotal, 100)); // Floor $1
}

// Get total rolling spend across ALL tokens in the cycle window
function getRollingTotalSpend(userId = null, windowMs = CYCLE_WINDOW_MS) {
  // betHistory is source of truth — only counts pending (unsettled) bets
  const userState = userId ? userStates.get(userId) : null;
  const userBetHistory = userState?.betHistory || betHistory;
  return computeRollingSpendFromHistory(userBetHistory, null, windowMs);
}

// Get remaining total budget for the cycle
function getRemainingTotalBudget(userConfig = null, userId = null) {
  const maxTotal = getMaxTotalPerCycle(userConfig);
  const totalSpend = getRollingTotalSpend(userId, CYCLE_WINDOW_MS);
  return Math.max(0, maxTotal - totalSpend);
}

// HARD CAP validation - ensures bet won't exceed ANY limit before placing
// This is the final safety check to prevent exposure limit violations
function validateBetWontExceedLimits(ticker, betCostCents, userState, userConfig, userId = null) {
  const token = getTokenFromTicker(ticker);
  const resolvedUserId = userId || userState?.userId || 'default';

  // Check 1: Per-token per-cycle limit (rolling 15-min spend)
  const maxPerCycle = getMaxPerTokenPerCycle(userConfig);
  if (token) {
    const cycleSpend = getRollingSpendByToken(resolvedUserId, token, CYCLE_WINDOW_MS);
    if (cycleSpend + betCostCents > maxPerCycle) {
      return { valid: false, reason: `Would exceed ${token} cycle limit: $${((cycleSpend + betCostCents)/100).toFixed(2)} > $${(maxPerCycle/100).toFixed(2)}` };
    }
  }

  // Check 1.5: Total cycle budget (umbrella across all tokens)
  const maxTotalCycle = getMaxTotalPerCycle(userConfig);
  const totalCycleSpend = getRollingTotalSpend(resolvedUserId, CYCLE_WINDOW_MS);
  if (totalCycleSpend + betCostCents > maxTotalCycle) {
    return { valid: false, reason: `Would exceed total cycle budget: $${((totalCycleSpend + betCostCents)/100).toFixed(2)} > $${(maxTotalCycle/100).toFixed(2)}` };
  }

  // Check 2: Per-market cap (scale-in accumulation limit)
  // Derive from maxPerTokenPerCycle if not explicitly set, so raising per-token limit also raises per-market
  const maxPerMarket = userConfig?.riskLimits?.maxPerMarket || getMaxPerTokenPerCycle(userConfig);
  const existingMarketExposure = getExposureForTicker(ticker, userState);
  const newMarketExposure = existingMarketExposure + betCostCents;
  if (newMarketExposure > maxPerMarket) {
    return { valid: false, reason: `Would exceed per-market limit on ${ticker}: $${(newMarketExposure/100).toFixed(2)} > $${(maxPerMarket/100).toFixed(2)}` };
  }

  // Check 3: Per-token 2hr rolling spend (8 cycles worth = safety net)
  if (token) {
    const tokenRollingSpend = getRollingSpendByToken(resolvedUserId, token);
    const tokenRollingCap = getMaxPerTokenPerCycle(userConfig) * 8;
    if (tokenRollingSpend + betCostCents > tokenRollingCap) {
      return { valid: false, reason: `Rolling ${token} spend $${((tokenRollingSpend + betCostCents)/100).toFixed(2)} would exceed 2hr cap $${(tokenRollingCap/100).toFixed(2)}` };
    }
  }

  return { valid: true };
}

// Get total exposure for a specific ticker (across all bets on that market)
function getExposureForTicker(ticker, userState = null) {
  const userBetHistory = userState?.betHistory || betHistory;
  let exposure = 0;
  for (const bet of userBetHistory) {
    if (bet.ticker !== ticker) continue;
    if (isTickerExpired(bet.ticker)) continue;
    if (bet.status === 'settled' || bet.status === 'closed') continue;
    exposure += bet.totalCost || (bet.count * bet.price) || 0;
  }
  // Also check Kalshi positions
  const userPortfolio = userState?.portfolio || portfolio;
  if (userPortfolio.positions && Array.isArray(userPortfolio.positions)) {
    for (const pos of userPortfolio.positions) {
      if (pos.ticker !== ticker) continue;
      if (isTickerExpired(pos.ticker)) continue;
      // Only add if not already counted from betHistory
      const alreadyCounted = userBetHistory.some(b => b.ticker === ticker && b.status !== 'settled' && b.status !== 'closed');
      if (!alreadyCounted) {
        const contracts = Math.abs(pos.position || 0);
        let avgPrice = pos.average_price || 0;
        if (avgPrice > 0 && avgPrice <= 1) avgPrice = Math.round(avgPrice * 100);
        exposure += pos.market_exposure || (contracts * avgPrice) || 0;
      }
    }
  }
  return exposure;
}

// Legacy in-memory spend tracker (kept for trackSpend calls but no longer used for budget checks)
// Budget is now computed solely from betHistory, counting only pending (unsettled) bets
const rollingSpendTracker = new Map(); // userId -> [{amount, token, timestamp}]

function trackSpend(userId, amountCents, token) {
  const key = userId || 'default';
  if (!rollingSpendTracker.has(key)) rollingSpendTracker.set(key, []);
  rollingSpendTracker.get(key).push({ amount: amountCents, token: token || null, timestamp: Date.now() });
}

// Compute rolling spend from betHistory (source of truth, survives restarts)
// Only counts pending (unsettled) bets — settled bets free up budget immediately
function getRollingSpend(userId, windowMs = 2 * 60 * 60 * 1000) {
  const userState = userId ? userStates.get(userId) : null;
  const userBetHistory = userState?.betHistory || betHistory;
  return computeRollingSpendFromHistory(userBetHistory, null, windowMs);
}

function getRollingSpendByToken(userId, token, windowMs = 2 * 60 * 60 * 1000) {
  // betHistory is source of truth — only counts pending (unsettled) bets
  const userState = userId ? userStates.get(userId) : null;
  const userBetHistory = userState?.betHistory || betHistory;
  return computeRollingSpendFromHistory(userBetHistory, token, windowMs);
}

// Derive rolling spend from betHistory this is restart-proof
// Only counts PENDING (unsettled) bets — settled bets no longer represent active exposure
function computeRollingSpendFromHistory(betHistoryArr, token, windowMs = 2 * 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  let total = 0;
  for (const bet of betHistoryArr) {
    if (bet.outcome === 'won' || bet.outcome === 'lost') continue; // Settled, exposure resolved
    const ts = new Date(bet.timestamp).getTime();
    if (ts < cutoff) continue; // Old bet, skip
    if (token) {
      const betToken = getTokenFromTicker(bet.ticker) || bet.assetType;
      if (betToken !== token) continue;
    }
    total += bet.totalCost || 0;
  }
  return total;
}

function isBankrollTooLow(userConfig) {
  const cfg = userConfig || config;
  const minBankroll = cfg.minBankrollCents || 200;
  const bankroll = cfg.bankroll || 0;
  return bankroll < minBankroll;
}

// Get remaining budget for a specific token (rolling 15-min cycle spend)
function getRemainingTokenBudget(ticker, assetType, userState = null, userConfig = null, userId = null) {
  const token = getTokenFromTicker(ticker) || assetType;
  const cycleLimit = getMaxPerTokenPerCycle(userConfig);
  if (!token) return cycleLimit;
  const resolvedUserId = userId || userState?.userId || 'default';
  const cycleSpend = getRollingSpendByToken(resolvedUserId, token, CYCLE_WINDOW_MS);
  return Math.max(0, cycleLimit - cycleSpend);
}

// KALSHI API - module imported from ./kalshiAPI.js (see imports at top)

// ============================================
// MARKET ANALYSIS
// ============================================

let marketCache = { data: null, lastFetch: 0, ttl: 15000 };

// Settled market result cache — once settled, results never change
// Prevents repeated API calls for the same settled markets on every portfolio/performance poll
const settledMarketCache = new Map(); // ticker -> { title, result, status, closeTime }

async function getMarketDataCached(ticker, userConfig = null) {
  // Return cached result for settled markets (they never change)
  if (settledMarketCache.has(ticker)) {
    return settledMarketCache.get(ticker);
  }
  try {
    const data = await kalshiRequest('GET', `/markets/${ticker}`, null, userConfig);
    if (data.market) {
      const entry = {
        ticker,
        title: data.market.title || ticker,
        result: data.market.result || data.market.market_result,
        status: data.market.status,
        closeTime: data.market.close_time
      };
      // Cache settled markets permanently (result won't change)
      if (entry.result && (entry.status === 'settled' || entry.status === 'finalized')) {
        settledMarketCache.set(ticker, entry);
      }
      return entry;
    }
  } catch (e) {
    // ignore
  }
  return { ticker, title: ticker, result: null, status: 'unknown' };
}

// Fetch multiple market details with throttled concurrency (max 3 at a time)
async function getMarketDataBatch(tickers, userConfig = null) {
  const results = {};
  const uncached = [];

  // Separate cached from uncached
  for (const ticker of tickers) {
    if (settledMarketCache.has(ticker)) {
      results[ticker] = settledMarketCache.get(ticker);
    } else {
      uncached.push(ticker);
    }
  }

  // Fetch uncached in small batches to avoid rate limiting
  const BATCH_SIZE = 3;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(ticker => getMarketDataCached(ticker, userConfig))
    );
    for (const entry of batchResults) {
      if (entry) results[entry.ticker] = entry;
    }
    // Small delay between batches if more to fetch
    if (i + BATCH_SIZE < uncached.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}

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

    // Kalshi API v2 returns: { orderbook: { yes: [[price_cents, qty], ...], no: [[price_cents, qty], ...] } }
    // Binary market: YES bids = demand to buy YES, NO bids = demand to buy NO
    // A NO bid at X¢ is equivalent to a YES ask at (100-X)¢
    const ob = response.orderbook || response;
    const yesBids = Array.isArray(ob.yes) ? ob.yes : []; // [[price, qty], ...] sorted highest first
    const noBids = Array.isArray(ob.no) ? ob.no : [];

    const orderbook = {
      ticker,
      // YES side
      bestYesBid: yesBids.length > 0 ? yesBids[0][0] : 0,
      bestYesAsk: noBids.length > 0 ? (100 - noBids[0][0]) : 0,
      yesSpread: 0,
      yesLiquidityAtBest: yesBids.length > 0 ? (yesBids[0][1] || 0) : 0,
      yesTotalDepth: yesBids.reduce((sum, e) => sum + (e[1] || 0), 0),
      // NO side
      bestNoBid: noBids.length > 0 ? noBids[0][0] : 0,
      bestNoAsk: yesBids.length > 0 ? (100 - yesBids[0][0]) : 0,
      noSpread: 0,
      noLiquidityAtBest: noBids.length > 0 ? (noBids[0][1] || 0) : 0,
      noTotalDepth: noBids.reduce((sum, e) => sum + (e[1] || 0), 0),
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
    // Only log non-404 errors -- 404s are expected for expired/settled markets
    if (!error.message?.includes('404')) {
      console.log(`[Candles] Error fetching ${ticker}:`, error.message);
    }
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
        reasons.push(` CRITICAL: Only ${minutesLeft.toFixed(1)}min left`);
      } else if (minutesLeft < 5) {
        urgencyScore += 20;
        reasons.push(` Urgent: ${minutesLeft.toFixed(1)}min left`);
      } else if (minutesLeft < 8) {
        urgencyScore += 10;
        reasons.push(` ${minutesLeft.toFixed(1)}min remaining`);
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
      reasons.push(` Momentum against us: ${momentum.direction} (${(momentum.strength*100).toFixed(0)}% strength)`);
    }
  }

  // 3. PROFIT-AT-RISK (0-25 points)
  // Higher profits are worth protecting more aggressively
  if (profitPercent >= 50) {
    urgencyScore += 25;
    reasons.push(` Large profit at risk: ${profitPercent.toFixed(1)}%`);
  } else if (profitPercent >= 30) {
    urgencyScore += 15;
    reasons.push(` Good profit at risk: ${profitPercent.toFixed(1)}%`);
  } else if (profitPercent >= 15) {
    urgencyScore += 8;
    reasons.push(` Moderate profit: ${profitPercent.toFixed(1)}%`);
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
          reasons.push(` Price very close to strike (${pctFromStrike.toFixed(2)}%)`);
        } else if (pctFromStrike < 0.3) {
          urgencyScore += 12;
          reasons.push(` Price near strike (${pctFromStrike.toFixed(2)}%)`);
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
    console.log(`[TakeProfit] ${ticker}: Using market_exposure fallback for avgCost: ${avgCost}c`);
  }

  if (contracts === 0 || avgCost === 0) {
    console.log(`[StopLoss] ${ticker}: Skipping - no position data (contracts=${contracts}, avgCost=${avgCost})`);
    return { shouldExit: false, reason: 'No valid position data (missing avg_price and market_exposure)' };
  }

  // Fetch current orderbook for exit price
  const orderbook = await fetchOrderbook(ticker, cfg);

  // Determine current bid (what we can sell for)
  const side = position.side || (position.position > 0 ? 'yes' : 'no');
  let currentBid = side === 'yes' ? orderbook.bestYesBid : orderbook.bestNoBid;
  const spread = side === 'yes' ? orderbook.yesSpread : orderbook.noSpread;

  // If no bid exists on our side, infer price from opposite side
  if (!currentBid || currentBid <= 0) {
    const oppositeAsk = side === 'yes' ? orderbook.bestNoAsk : orderbook.bestYesAsk;
    const oppositeBid = side === 'yes' ? orderbook.bestNoBid : orderbook.bestYesBid;
    if (oppositeAsk && oppositeAsk > 0) {
      currentBid = 100 - oppositeAsk;
      console.log(`[StopLoss] ${ticker}: No ${side} bid inferred ${currentBid}c from opposite ask (${oppositeAsk}c)`);
    } else if (oppositeBid && oppositeBid > 0) {
      currentBid = 100 - oppositeBid;
      console.log(`[StopLoss] ${ticker}: No ${side} bid inferred ${currentBid}c from opposite bid (${oppositeBid}c)`);
    } else {
      console.log(`[StopLoss] ${ticker}: No bids on either side skipping (no liquidity)`);
      return { shouldExit: false, reason: 'No liquidity no bids on either side of orderbook' };
    }
    // Clamp inferred price to at least 1c
    if (currentBid < 1) currentBid = 1;
  }

  // Calculate current profit WITH KALSHI FEES
  // Kalshi charges taker fee on sells: ceil(0.07 -- contracts -- price -- (1 - price)), capped at 2c/contract
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

  // Log position status for debugging
  console.log(`[StopLoss] ${ticker}: avgCost=${avgCost}c, bid=${currentBid}c, profit=${profitPercent.toFixed(1)}%`);

  // Get market for stop-loss calculations (needed before stop-loss check)
  const marketsForStopLoss = marketCache.data || [];
  const marketForStopLoss = marketsForStopLoss.find(m => m.ticker === ticker);

  // ============================================
  // STOP-LOSS CHECK - Cut losses before they get worse
  // BUG FIX: Read from BOTH activeMonitoring AND limitOrderSettings (user's UI setting)
  // ============================================
  const stopLossThreshold = cfg.activeMonitoring?.stopLossThreshold
    || cfg.limitOrderSettings?.stopLoss?.threshold
    || -40;

  const stopLossEnabled = cfg.activeMonitoring?.stopLossEnabled === true;

  if (stopLossEnabled) {
    console.log(`[StopLoss] ${ticker}: Checking ${profitPercent.toFixed(1)}% vs threshold ${stopLossThreshold}%`);

    if (profitPercent <= stopLossThreshold) {
      // Loss exceeds threshold - cut it now
      console.log(` [StopLoss] TRIGGERED for ${ticker}: ${profitPercent.toFixed(1)}% <= ${stopLossThreshold}%`);
      return {
        shouldExit: true,
        reason: ` STOP-LOSS: Position at ${profitPercent.toFixed(1)}% (threshold: ${stopLossThreshold}%)`,
        urgencyScore: 100,
        urgencyReasons: [`Stop-loss triggered at ${profitPercent.toFixed(1)}% (threshold: ${stopLossThreshold}%)`],
        analysis: { profitPercent, netProfit, currentBid, avgCost, totalSellFee, spreadCost, stopLossTriggered: true, stopLossThreshold }
      };
    }

    // Time-based stop-loss: If <3 min left AND loss exceeds half of user's threshold, cut losses
    // BUG FIX: Was hardcoded -25%, now respects user's stopLossThreshold (uses half as time-critical trigger)
    const timeCriticalThreshold = Math.max(stopLossThreshold / 2, -30); // At least -30%, but scales with user setting
    if (marketForStopLoss && profitPercent < timeCriticalThreshold) {
      const timeRemaining = marketForStopLoss.close_time ? new Date(marketForStopLoss.close_time).getTime() - Date.now() : null;
      const timeCriticalWindow = 3 * 60 * 1000; // 3min
      if (timeRemaining && timeRemaining < timeCriticalWindow) {
        return {
          shouldExit: true,
          reason: ` TIME STOP-LOSS: ${profitPercent.toFixed(1)}% loss with <${(timeCriticalWindow/60000).toFixed(0)}min left - cutting losses (time-critical threshold: ${timeCriticalThreshold}%)`,
          urgencyScore: 90,
          urgencyReasons: [`Time-critical stop-loss: ${profitPercent.toFixed(1)}% loss, ${(timeRemaining/60000).toFixed(1)}min left`],
          analysis: { profitPercent, netProfit, currentBid, avgCost, totalSellFee, spreadCost, timeRemaining, stopLossTriggered: true }
        };
      }
    }
  } else {
    console.log(`[StopLoss] ${ticker}: DISABLED by config, skipping check (profit: ${profitPercent.toFixed(1)}%)`);
  }

  // ============================================
  // COIN-FLIP PREVENTION - Exit when price is at strike near expiry
  // Uses DATA-DRIVEN LEARNED THRESHOLDS when available
  // BUG FIX: Only force exit on LOSING positions, let profitable ones ride
  // ============================================
  // Check if coin-flip prevention is enabled (default: true, can be disabled in activeMonitoring)
  const coinFlipEnabled = cfg.activeMonitoring?.coinFlipPreventionEnabled !== false;

  // If price is very close to strike AND time is running out, exit to avoid gambling
  if (coinFlipEnabled && marketForStopLoss) {
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

        // BUG FIX: Only exit losing positions OR positions very close to expiry (<1 min)
        // Profitable positions should ride unless we're about to expire
        const isLosing = profitPercent < 0;
        const veryCloseToExpiry = timeRemaining && timeRemaining < 1 * 60 * 1000; // <1 min

        // If within learned coin-flip threshold AND <3 min left - this is a coin flip
        if (pctFromStrike < coinFlipThreshold && timeRemaining && timeRemaining < timeBuffer) {
          // Only exit if losing OR very close to expiry
          if (isLosing || veryCloseToExpiry) {
            console.log(`[TakeProfit] ${ticker}: COIN-FLIP PREVENTION - price ${pctFromStrike.toFixed(3)}% from strike with ${(timeRemaining/60000).toFixed(1)}min left (threshold: ${coinFlipThreshold}%)`);
            return {
              shouldExit: true,
              reason: ` COIN-FLIP EXIT: Price only ${pctFromStrike.toFixed(2)}% from strike with <${(timeBuffer/60000).toFixed(0)}min left - avoiding gamble (learned threshold: ${coinFlipThreshold}%)`,
              urgencyScore: 95,
              urgencyReasons: [`Coin-flip prevention: ${pctFromStrike.toFixed(2)}% from strike, ${(timeRemaining/60000).toFixed(1)}min left`],
              analysis: { profitPercent, netProfit, currentBid, avgCost, pctFromStrike, timeRemaining, coinFlipExit: true, learnedThreshold: coinFlipThreshold }
            };
          } else {
            console.log(`[TakeProfit] ${ticker}: COIN-FLIP territory but position is PROFITABLE (${profitPercent.toFixed(1)}%) - letting it ride`);
          }
        }

        // Slightly wider threshold with less time - nearStrikeThreshold from strike AND <2 min
        const nearStrikeTimeBuffer = 2 * 60 * 1000; // 2min
        if (pctFromStrike < nearStrikeThreshold && timeRemaining && timeRemaining < nearStrikeTimeBuffer) {
          // Only exit if losing OR very close to expiry
          if (isLosing || veryCloseToExpiry) {
            console.log(`[TakeProfit] ${ticker}: COIN-FLIP PREVENTION - price ${pctFromStrike.toFixed(3)}% from strike with ${(timeRemaining/60000).toFixed(1)}min left (near-strike threshold: ${nearStrikeThreshold}%)`);
            return {
              shouldExit: true,
              reason: ` COIN-FLIP EXIT: Price ${pctFromStrike.toFixed(2)}% from strike with <${(nearStrikeTimeBuffer/60000).toFixed(0)}min left - too risky (near-strike threshold: ${nearStrikeThreshold}%)`,
              urgencyScore: 95,
              urgencyReasons: [`Coin-flip prevention: ${pctFromStrike.toFixed(2)}% from strike, ${(timeRemaining/60000).toFixed(1)}min left`],
              analysis: { profitPercent, netProfit, currentBid, avgCost, pctFromStrike, timeRemaining, coinFlipExit: true, learnedThreshold: nearStrikeThreshold }
            };
          } else {
            console.log(`[TakeProfit] ${ticker}: Near-strike but position is PROFITABLE (${profitPercent.toFixed(1)}%) - letting it ride`);
          }
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
    const token = parsed.cryptoType;
    const priceData = cryptoPrices[token];
    if (priceData?.price) {
      analysis = evaluateOpportunityEmpirical(parsed, priceData.price, learnedParams, orderbook, cfg, momentum);
      if (analysis) {
        probWin = side === 'yes'
          ? analysis.probYesWins / 100
          : analysis.probNoWins / 100;
      }
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
  // If we bought at 75-85c (high implied probability), take smaller profits
  // BUT: Don't sell too early - wait for time pressure OR higher profit to justify fees
  // Kalshi fees (~2-3c round trip) eat into small profits significantly
  const easyProfitEnabled = activeMonitoring.easyProfitEnabled !== false; // Default true
  const easyProfitMinPrice = activeMonitoring.easyProfitMinPrice || 75; // 75c = 75% implied prob
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
    const easyProfitTimeWindow = 5; // 5min
    if (timeRemainingMin !== null && timeRemainingMin < easyProfitTimeWindow && profitPercent >= easyProfitThreshold) {
      shouldExit = true;
      exitReason = `EASY PROFIT: High-confidence (${avgCost}c) at +${profitPercent.toFixed(1)}% with ${timeRemainingMin.toFixed(1)}min left - securing gains`;
    } else if (profitPercent >= easyProfitEarlyThreshold) {
      // Higher profit justifies early exit even with fees
      shouldExit = true;
      exitReason = `EASY PROFIT: High-confidence (${avgCost}c) at +${profitPercent.toFixed(1)}% - profit high enough to justify fees`;
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
    exitReason = `EV exit (${evExit.toFixed(0)}c) > EV hold (${adjustedEvHold.toFixed(0)}c)`;
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
    const timeCriticalMs = 3 * 60 * 1000; // 3min
    const timeCriticalLabel = `${(timeCriticalMs/60000).toFixed(0)}min`;
    if (timeRemaining && timeRemaining < timeCriticalMs && profitPercent >= 5) {
      // High probability? Let it ride - EV of holding to settlement is better
      if (probWin >= 0.75) {
        // Don't exit - expected value of holding is higher
        console.log(`[TakeProfit] ${ticker}: High prob (${(probWin*100).toFixed(0)}%) with <${timeCriticalLabel} left - letting it ride`);
      } else if (probWin >= 0.60 && evHold > evExit * 1.5) {
        // Medium-high prob with much better EV hold - also let ride
        console.log(`[TakeProfit] ${ticker}: ${(probWin*100).toFixed(0)}% prob, EV hold (${evHold.toFixed(0)}c) >> EV exit (${evExit.toFixed(0)}c) - holding`);
      } else {
        // Lower probability or EV doesn't favor holding - take the profit
        shouldExit = true;
        exitReason = `TIME CRITICAL: <${timeCriticalLabel} left, ${(probWin*100).toFixed(0)}% prob, securing ${profitPercent.toFixed(1)}% profit`;
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
    ? ` EXIT: ${exitReason}`
    : ` HOLD: Profit ${profitPercent.toFixed(1)}%, urgency ${urgencyScore}, waiting for better exit`;

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
async function executeTakeProfitExit(position, analysis, userConfig = null, userId = null) {
  const cfg = userConfig || config;
  const settings = cfg.takeProfitSettings || {};

  // Only bypass logOnly mode for stop-loss if stop-loss is explicitly enabled
  const stopLossEnabled = cfg.activeMonitoring?.stopLossEnabled === true;
  const isStopLoss = stopLossEnabled && (analysis.stopLossTriggered || analysis.profitPercent < 0);

  // Safety check - don't execute if logOnly mode (but ALWAYS execute stop-loss)
  if (!isStopLoss && (settings.logOnly || !settings.autoExecute)) {
    console.log(`\n [TakeProfit] RECOMMENDATION (not executing - logOnly mode):`);
    console.log(` ${position.ticker}`);
    console.log(` Profit: ${analysis.profitPercent.toFixed(1)}% | Net: $${(analysis.netProfit/100).toFixed(2)}`);
    console.log(` Urgency: ${analysis.urgencyScore}/100`);
    console.log(` EV exit: ${analysis.evExit?.toFixed(0) || '?'}c vs EV hold: ${analysis.evHold?.toFixed(0) || '?'}c`);
    if (analysis.momentum) {
      console.log(` Momentum: ${analysis.momentum.direction} (${(analysis.momentum.strength*100).toFixed(0)}%)`);
    }
    return { executed: false, reason: 'Log only mode - would have exited' };
  }

  if (isStopLoss) {
    console.log(`\n [STOP-LOSS] EXECUTING (bypassing logOnly - protecting position):`);
  }

  try {
    const ticker = position.ticker;
    const contracts = Math.abs(position.position || 0);
    const side = position.side || (position.position > 0 ? 'yes' : 'no');

    // Place sell order at current bid (or slightly below for faster fill)
    const sellPrice = Math.max(1, analysis.currentBid - 1); // 1 cent below bid for faster fill

    // SAFETY: Refuse to sell at catastrophically low prices (e.g., empty orderbook 1c)
    // Exception: allow if < 1 minute to expiry (position genuinely expiring worthless)
    const minSellPrice = Math.max(1, Math.round(analysis.avgCost * 0.3));
    const nearExpiry = analysis.timeRemaining != null && analysis.timeRemaining < 1 * 60 * 1000;
    if (sellPrice < minSellPrice && !nearExpiry) {
      console.log(`\n [SELL GUARD] Refusing to sell ${ticker} at ${sellPrice}c below 30% of entry (${analysis.avgCost}c). Min sell: ${minSellPrice}c`);
      console.log(` This likely means the orderbook is empty/thin. Position may still be worth more.`);
      return { executed: false, reason: `Sell price ${sellPrice}c too far below entry ${analysis.avgCost}c (floor: ${minSellPrice}c)` };
    }

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

    console.log(`\n [TakeProfit] EXECUTING EXIT:`);
    console.log(` ${ticker} | ${contracts} contracts @ ${sellPrice}c`);
    console.log(` Locking in ${analysis.profitPercent.toFixed(1)}% profit ($${(analysis.netProfit/100).toFixed(2)})`);
    console.log(` Urgency score: ${analysis.urgencyScore}/100`);
    console.log(` Order: ${JSON.stringify(orderRequest)}`);

    const response = await kalshiRequest('POST', '/portfolio/orders', orderRequest, cfg);

    if (response.order) {
      const filledCount = response.order.filled_count || 0;
      const fillPrice = response.order.average_fill_price || sellPrice;

      console.log(` Order ${response.order.order_id}: ${filledCount}/${contracts} filled @ ${fillPrice}c`);

      if (filledCount > 0) {
        const actualProfit = (fillPrice - analysis.avgCost) * filledCount;
        console.log(` Realized profit: $${(actualProfit/100).toFixed(2)}`);
      }

      const result = {
        executed: true,
        orderId: response.order.order_id,
        filledCount,
        fillPrice,
        realizedProfit: (response.order.average_fill_price - analysis.avgCost) * filledCount,
        reason: filledCount === contracts ? 'Fully filled' : `Partial fill: ${filledCount}/${contracts}`
      };

      // Record execution to history
      recordTakeProfitExecution(ticker, isStopLoss ? 'stop-loss' : 'take-profit', analysis, result, userId);

      return result;
    }

    console.log(` No order in response`);
    const noOrderResult = { executed: false, reason: 'No order in response' };
    recordTakeProfitExecution(ticker, isStopLoss ? 'stop-loss' : 'take-profit', analysis, noOrderResult, userId);
    return noOrderResult;

  } catch (error) {
    console.error(` Exit failed: ${error.message}`);
    const errorResult = { executed: false, reason: error.message };
    recordTakeProfitExecution(ticker, isStopLoss ? 'stop-loss' : 'take-profit', analysis, errorResult, userId);
    return errorResult;
  }
}

/**
 * Scan all positions for take-profit opportunities
 * Smart scanning: evaluates all positions and executes optimal exits
 */
async function scanTakeProfitOpportunities(userConfig = null, userPortfolio = null, userId = null) {
  const cfg = userConfig || config;
  const pf = userPortfolio || portfolio;
  const settings = cfg.takeProfitSettings || {};
  const limitSettings = cfg.limitOrderSettings || {};

  // If take-profit is disabled AND stop-loss is disabled, nothing to do
  const takeProfitEnabled = settings.enabled !== false; // default true for backwards compat
  const stopLossEnabled = cfg.activeMonitoring?.stopLossEnabled === true;
  if (!takeProfitEnabled && !stopLossEnabled) {
    return [];
  }

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
          const result = await executeTakeProfitExit(position, evaluation.analysis, cfg, userId);
          opportunities[opportunities.length - 1].executionResult = result;
        } else {
          // Log the recommendation
          await executeTakeProfitExit(position, evaluation.analysis, cfg, userId);
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

    console.log(`\n [TakeProfit] Position Summary:`);
    console.log(` ${positions.length} positions | ${exitCount} to exit | ${holdCount} to hold`);

    for (const status of positionStatuses) {
      const icon = status.shouldExit ? '' : '';
      console.log(` ${icon} ${status.ticker}: ${status.profit}% profit, urgency ${status.urgency}`);
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
            userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
          }
        } catch (e) {
          console.log('[TakeProfit] Could not refresh positions:', e.message);
        }
      }

      await scanTakeProfitOpportunities(userConfig, userPortfolio, userId);
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
    // Fetch 15-minute BTC, ETH, SOL, XRP markets
    const cryptoSeries = [
      'KXBTC15M', // Bitcoin 15-minute up/down
      'KXETH15M', // Ethereum 15-minute up/down
      'KXSOL15M', // Solana 15-minute up/down
      'KXXRP15M', // XRP 15-minute up/down
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

    // Filter for valid 15-minute markets
    const cryptoMarkets = allMarkets.filter(m => {
      const ticker = (m.ticker || '').toUpperCase();
      if (!ticker.includes('15M')) return false;

      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;

      // Time window: 30s to 20min
      if (!timeRemaining || timeRemaining <= 30000 || timeRemaining >= 20 * 60 * 1000) return false;

      return true;
    });

    console.log(` Fetched ${allMarkets.length} markets, ${cryptoMarkets.length} valid 15min ${Object.keys(TRACKED_TOKENS).join('/')}`);

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
      title.includes('or more') || title.includes('over') || title.includes(' up') ||
      title.includes('at least') || title.includes('or higher')) {
    marketType = 'above'; // YES = price above strike
  } else if (title.includes('below') || title.includes('<=') || title.includes('lower') ||
             title.includes('or less') || title.includes('under') || title.includes(' down') ||
             title.includes('or lower')) {
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
    marketDuration: 15,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    volume: parseInt(market.volume) || 0
  };
}

// Calculate Kalshi taker fee
// Formula: ceil(0.07 -- contracts -- price -- (1 - price))
// Capped at $0.02 (2 cents) per contract
function calculateKalshiFee(contracts, priceInDollars) {
  // Price should be between 0 and 1 (e.g., 0.65 for 65 cents)
  const price = Math.min(1, Math.max(0, priceInDollars));
  const feePerContract = Math.ceil(0.07 * price * (1 - price) * 100) / 100; // In dollars
  const cappedFeePerContract = Math.min(0.02, feePerContract); // Cap at 2 cents
  const totalFeeDollars = cappedFeePerContract * contracts;
  return Math.round(totalFeeDollars * 100); // Return in cents
}

function calculateKalshiMakerFee(contracts, priceInDollars) {
  // Kalshi maker fee: ceil(0.0175 * price * (1-price)), capped at 2c
  // At 50c: ~0.44c vs taker 1.75c. At most prices: effectively zero after rounding.
  const price = Math.min(1, Math.max(0, priceInDollars));
  const feePerContract = Math.ceil(0.0175 * price * (1 - price) * 100) / 100;
  const cappedFeePerContract = Math.min(0.02, feePerContract);
  return Math.round(cappedFeePerContract * contracts * 100); // cents
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
      .map(m => {
        const parsed = parseMarket(m);
        const token = parsed.cryptoType;
        const priceData = cryptoPrices[token];
        if (!priceData?.price) return null;
        const result = evaluateOpportunityEmpirical(parsed, priceData.price, learnedParams, null, null);
        if (!result) return null;
        return { ...parsed, ...result, marketCategory: 'crypto',
          betSide: result.side, betPrice: result.marketPrice, betPriceCents: result.marketPriceCents };
      })
      .filter(m => {
        if (m === null) return false;
        if (m.edge < 0.5) return false;
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

    // Fetch 15-minute crypto markets (BTC, ETH, SOL, XRP)
    const cryptoMarkets = await fetchCryptoMarkets();
    const userConfig = req.userState?.config || config;

    // Analyze crypto opportunities
    const allAnalyzed = cryptoMarkets
      .map(m => {
        const parsed = parseMarket(m);
        const token = parsed.cryptoType;
        const priceData = cryptoPrices[token];
        if (!priceData?.price) return null;
        const result = evaluateOpportunityEmpirical(parsed, priceData.price, learnedParams, null, userConfig);
        if (!result) return null;
        return { ...parsed, ...result, marketCategory: 'crypto', marketTimeframe: '15min',
          betSide: result.side, betPrice: result.marketPrice, betPriceCents: result.marketPriceCents };
      })
      .filter(m => m !== null);

    // Best card per token (4 cards total)
    const tokenSlots = [];
    for (const token of Object.keys(TRACKED_TOKENS)) {
      const tokenOpps = allAnalyzed.filter(m => m.assetType === token || m.cryptoType === token);

      if (tokenOpps.length > 0) {
        tokenOpps.sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));
        tokenOpps[0].hasActiveMarket = true;
        tokenSlots.push(tokenOpps[0]);
      } else {
        const currentPrice = cryptoPrices[token]?.price || 0;
        tokenSlots.push({
          assetType: token, cryptoType: token, hasActiveMarket: false, isPlaceholder: true,
          isRecommended: false, filterReason: 'Waiting for next market', currentPrice,
          title: `${token} 15-Minute Up/Down`, winProbability: '--', edge: 0,
          betSide: '--', betPrice: 0, betPriceCents: 0, marketCategory: 'crypto', marketTimeframe: '15min'
        });
      }
    }

    // Sort: active markets first, then by win probability
    const allOpportunities = showAll
      ? tokenSlots.sort((a, b) => {
          if (a.isPlaceholder && !b.isPlaceholder) return 1;
          if (!a.isPlaceholder && b.isPlaceholder) return -1;
          return parseFloat(b.winProbability || 0) - parseFloat(a.winProbability || 0);
        })
      : tokenSlots;

    // Refresh positions before calculating risk (user-specific)
    const userPortfolio = req.userState?.portfolio || portfolio;
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
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
        current: riskByType.total,
        currentDollars: (riskByType.total / 100).toFixed(2),
        maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
        byToken: getExposureByToken(req.userState),
        positionCount: (userPortfolio.positions || []).length,
        rollingSpendByToken: Object.fromEntries(Object.keys(TRACKED_TOKENS).map(t => [t, getRollingSpendByToken(req.userId, t, CYCLE_WINDOW_MS)])),
        rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
        maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
        totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
        remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
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
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
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
      if (bet.status === 'settled' || bet.status === 'closed') {
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

    console.log(` Risk: Kalshi=$${(kalshiRisk/100).toFixed(2)} (${kalshiTickers.size} positions), Local=$${(localRisk/100).toFixed(2)} (${unsettledBets.length} bets), Total=$${(currentRisk/100).toFixed(2)}`);

    res.json({
      success: true,
      risk: {
        current: currentRisk,
        currentDollars: (currentRisk / 100).toFixed(2),
        positionCount: kalshiTickers.size,
        unsettledBetCount: unsettledBets.length
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
  const { maxPerTokenPerCycle, maxPerToken, maxTotalPerCycle } = req.body;

  // Use per-user config
  const userConfig = req.userState?.config;
  if (!userConfig) {
    return res.status(401).json({ success: false, error: 'Must be logged in to update settings' });
  }

  // Ensure riskLimits structure exists
  if (!userConfig.riskLimits) {
    userConfig.riskLimits = JSON.parse(JSON.stringify(DEFAULT_CONFIG.riskLimits));
  }

  // Max per token per cycle (e.g., max $5 on all SOL markets per 15-min cycle)
  if (maxPerTokenPerCycle !== undefined) {
    userConfig.riskLimits.maxPerTokenPerCycle = Math.max(200, Math.min(50000, parseInt(maxPerTokenPerCycle) || 500));
  }
  // Legacy: if client sends old maxPerToken, store as maxPerTokenPerCycle
  if (maxPerToken !== undefined && maxPerTokenPerCycle === undefined) {
    userConfig.riskLimits.maxPerTokenPerCycle = Math.max(200, Math.min(50000, parseInt(maxPerToken) || 500));
  }
  // Sync maxPerMarket with maxPerTokenPerCycle so per-market cap doesn't silently block larger bets
  userConfig.riskLimits.maxPerMarket = userConfig.riskLimits.maxPerTokenPerCycle;
  // Max total spend across all tokens per cycle (umbrella cap)
  if (maxTotalPerCycle !== undefined) {
    userConfig.riskLimits.maxTotalPerCycle = Math.max(200, Math.min(100000, parseInt(maxTotalPerCycle) || 1500));
  }
  // Ensure total cycle cap is at least as large as per-token cap
  if (userConfig.riskLimits.maxTotalPerCycle < userConfig.riskLimits.maxPerTokenPerCycle) {
    userConfig.riskLimits.maxTotalPerCycle = userConfig.riskLimits.maxPerTokenPerCycle;
  }

  console.log(` Risk settings updated for user ${req.userId}:`, JSON.stringify(userConfig.riskLimits));

  // Save to per-user state file
  saveUserState(req.userId);

  res.json({
    success: true,
    riskLimits: userConfig.riskLimits,
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

  console.log(` Scale-in settings updated for user ${req.userId}:`, JSON.stringify(userConfig.scaleIn));
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
      const threshold = Math.max(-90, Math.min(-5, parseInt(stopLoss.threshold) || -40));
      userConfig.limitOrderSettings.stopLoss.threshold = threshold;
      // BUG FIX: Also sync to activeMonitoring so evaluateTakeProfit uses the user's setting
      if (!userConfig.activeMonitoring) {
        userConfig.activeMonitoring = JSON.parse(JSON.stringify(DEFAULT_CONFIG.activeMonitoring));
      }
      userConfig.activeMonitoring.stopLossThreshold = threshold;
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

  console.log(` Limit order settings updated for user ${req.userId}:`, JSON.stringify(userConfig.limitOrderSettings));
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
      Promise.resolve(sentiment.getRecentNews(20)),
      sentiment.getRedditSentiment()
    ]);

    const overall = sentiment.calculateOverallSentiment(news, reddit);

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
      alerts: sentiment.getRecentAlerts().slice(0, 10),
      config: {
        newsInterval: sentiment.NEWS_CONFIG.checkIntervalMs,
        urgencyThreshold: sentiment.NEWS_CONFIG.urgencyThreshold,
        maxNewsAge: sentiment.NEWS_CONFIG.maxNewsAge
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

  const news = sentiment.getRecentNews(limit, maxAgeMinutes * 60 * 1000);

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
    count: sentiment.getRecentAlerts().length,
    alerts: sentiment.getRecentAlerts().slice(0, limit)
  });
});

// Manually trigger news check
app.post('/api/news/check', async (req, res) => {
  try {
    const newArticles = await sentiment.fetchAllNews();

    res.json({
      success: true,
      newArticles: newArticles.length,
      totalCached: sentiment.getNewsCache().length,
      alerts: sentiment.getRecentAlerts().slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Reddit sentiment data
app.get('/api/reddit/sentiment', async (req, res) => {
  try {
    const reddit = await sentiment.getRedditSentiment();

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

    // SAFETY: Bankroll floor check
    if (isBankrollTooLow(userConfig)) {
      return res.status(400).json({
        success: false,
        error: `Balance too low ($${((userConfig.bankroll || 0)/100).toFixed(2)}). Minimum $${((userConfig.minBankrollCents || 200)/100).toFixed(2)} required.`
      });
    }

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions before bet:', e.message);
      }
    }

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

    // Calculate bet size based on per-token-per-cycle limit AND total cycle budget
    const remainingTokenBudget = getRemainingTokenBudget(ticker, market.assetType, req.userState, userConfig, req.userId);
    const remainingTotalBudget = getRemainingTotalBudget(userConfig, req.userId);
    const effectiveBudget = Math.min(remainingTokenBudget, remainingTotalBudget);
    const maxPerTokenPerCycle = getMaxPerTokenPerCycle(userConfig);

    const TARGET_BET_CENTS = effectiveBudget;

    if (effectiveBudget < priceCents) {
      const token = getTokenFromTicker(ticker) || market.assetType || 'token';
      const tokenLimit = remainingTokenBudget < priceCents;
      const reason = tokenLimit ? `${token} token cycle limit` : 'total cycle budget';
      return res.status(400).json({
        success: false,
        error: `Cycle limit reached (${reason}). Only $${(effectiveBudget/100).toFixed(2)} remaining.`
      });
    }

    const count = Math.floor(TARGET_BET_CENTS / priceCents);

    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: `Contract price too high (${priceCents}c). Max price: 99c`
      });
    }

    const totalCost = count * priceCents;

    // HARD LIMIT CHECK: Validate bet won't exceed ANY limit (including rolling spend)
    const validation = validateBetWontExceedLimits(ticker, totalCost, req.userState, userConfig, req.userId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: `Bet blocked: ${validation.reason}` });
    }

    console.log(`Bet: ${ticker} | ${side} | price=${priceCents}c | count=${count} | total=${totalCost}c`);

    const betRecord = {
      id: Date.now().toString(),
      ticker,
      title: market.title,
      token: getTokenFromTicker(ticker) || market.assetType,
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
      userConfig.bankroll = (userConfig.bankroll ?? 10000) - betRecord.totalCost;
      trackSpend(req.userId, betRecord.totalCost, getTokenFromTicker(ticker) || market.assetType);

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
        marketType: ticker?.includes('15M') ? '15min' : 'daily'
      });

      // Save user state
      if (req.userId) saveUserState(req.userId);

      const simRisk = getRiskByType(req.userState);
      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: (userConfig.bankroll ?? 10000) / 100,
        risk: {
          current: simRisk.total,
          currentDollars: (simRisk.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: (userPortfolio.positions || []).length,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });
    }

    // Real bet - use limit order slightly above ask to ensure fill
    // Add 2 cent buffer to improve fill rate
    const baseFillSlippage1 = userConfig.selectivityRules?.fillSlippageCents ?? 3;
    const fillSlippage = baseFillSlippage1;
    const fillPrice = Math.min(priceCents + fillSlippage, 99);

    // Generate idempotency key to prevent duplicate orders on timeout/retry
    const clientOrderId = `shimi-${ticker}-${side}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const orderRequest = {
      ticker,
      client_order_id: clientOrderId,
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

    console.log(`Placing order (ask: ${priceCents}c, bid: ${fillPrice}c):`, JSON.stringify(orderRequest));

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
        // Cancel the unfilled order so it doesn't sit on Kalshi's book
        if (order.order_id) {
          try {
            await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
            console.log(`Cancelled unfilled order ${order.order_id}`);
          } catch (cancelErr) {
            console.log(`Could not cancel order ${order.order_id}:`, cancelErr.message);
          }
        }
        return res.status(400).json({
          success: false,
          error: `Order not filled. Status: ${status}. No liquidity at current price.`
        });
      }

      // Cancel remaining resting order on partial fills
      if (filledCount > 0 && filledCount < count && order.order_id) {
        try {
          await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
          console.log(`Cancelled partially-filled order ${order.order_id} (filled ${filledCount}/${count})`);
        } catch (cancelErr) {
          console.log(`Could not cancel partial order ${order.order_id}:`, cancelErr.message);
        }
      }

      // Update bet record with actual fill info
      betRecord.status = status === 'filled' ? 'filled' : 'partial';
      betRecord.orderId = order.order_id;
      betRecord.filledCount = filledCount;
      betRecord.avgPrice = order.average_fill_price || priceCents;
      betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
      userBetHistory.unshift(betRecord);
      trackSpend(req.userId, betRecord.totalCost, getTokenFromTicker(ticker) || market.assetType);

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
        marketType: ticker?.includes('15M') ? '15min' : 'daily'
      });

      // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
      // Stop-loss and take-profit are now handled by active monitoring (evaluateTakeProfit)
      // which runs every 15 seconds and executes market sells when thresholds are hit

      try {
        const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
        userPortfolio.balance = balanceData.balance || 0;
        userConfig.bankroll = userPortfolio.balance;
      } catch (e) {
        console.log('Could not refresh balance after bet:', e.message);
      }

      // Refresh positions for risk tracking
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
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
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: (userPortfolio.positions || []).length,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });

      console.log(` Bet placed. Exposure: $${(riskByType.total / 100).toFixed(2)}`);
    } catch (orderError) {
      console.error('Kalshi order error:', orderError.message);
      res.status(400).json({ success: false, error: 'Order failed. Check your balance and try again.' });
    }

  } catch (error) {
    console.error('Error placing bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel all open/resting orders on Kalshi
app.post('/api/cancel-all-orders', async (req, res) => {
  try {
    const userConfig = req.userState?.config || config;

    if (!userConfig.isAuthenticated) {
      return res.json({ success: true, message: 'Not authenticated - no orders to cancel', cancelled: 0 });
    }

    // Fetch all open orders
    const ordersData = await kalshiRequest('GET', '/portfolio/orders?status=resting', null, userConfig);
    const orders = ordersData.orders || [];

    if (orders.length === 0) {
      return res.json({ success: true, message: 'No open orders to cancel', cancelled: 0 });
    }

    console.log(`Cancelling ${orders.length} open orders...`);

    // Cancel each order
    let cancelled = 0;
    let failed = 0;
    for (const order of orders) {
      try {
        await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
        console.log(` Cancelled order ${order.order_id} (${order.ticker})`);
        cancelled++;
      } catch (err) {
        console.log(` Failed to cancel order ${order.order_id}: ${err.message}`);
        failed++;
      }
    }

    res.json({
      success: true,
      message: `Cancelled ${cancelled} orders${failed > 0 ? `, ${failed} failed` : ''}`,
      cancelled,
      failed,
      total: orders.length
    });

  } catch (error) {
    console.error('Error cancelling orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto-bet on best opportunity (Place Best Bet button) - now supports all markets
app.post('/api/crypto/auto-bet', async (req, res) => {
  try {
    const userConfig = req.userState?.config || config;
    const userPortfolio = req.userState?.portfolio || portfolio;
    const userBetHistory = req.userState?.betHistory || betHistory;

    // SAFETY: Bankroll floor check
    if (isBankrollTooLow(userConfig)) {
      return res.json({
        success: true,
        message: `Balance too low ($${((userConfig.bankroll || 0)/100).toFixed(2)}). Minimum $${((userConfig.minBankrollCents || 200)/100).toFixed(2)} required.`,
        bet: null
      });
    }

    // CRITICAL: Refresh positions from Kalshi FIRST to get accurate risk
    if (userConfig.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
        // Sync existing Kalshi positions to betHistory for accurate exposure tracking
        syncKalshiPositionsToBetHistory(req.userState, userPortfolio.positions, req.userId);
      } catch (e) {
        console.log('Could not refresh positions before auto-bet:', e.message);
      }
    }

    // Fetch crypto markets only (BTC, ETH, SOL 15-minute markets)
    const cryptoMarkets = await fetchCryptoMarkets();
    const now = Date.now();

    // Clean up old bets from tracking (shorter TTL for unfilled)
    for (const [ticker, bet] of recentBets.entries()) {
      const maxAge = bet.unfilled ? 10 * 60 * 1000 : 30 * 60 * 1000;
      if (now - bet.timestamp > maxAge) {
        recentBets.delete(ticker);
      }
    }
    // Clean up expired unfilled cooldowns
    for (const [key, cd] of unfilledCooldowns.entries()) {
      if (now - cd.timestamp > cd.cooldownMs) unfilledCooldowns.delete(key);
    }

    // Analyze crypto opportunities
    const opportunities = cryptoMarkets
      .map(m => {
        const parsed = parseMarket(m);
        const token = parsed.cryptoType;
        const priceData = cryptoPrices[token];
        if (!priceData?.price) return null;
        const result = evaluateOpportunityEmpirical(parsed, priceData.price, learnedParams, null, userConfig);
        if (!result) return null;
        return { ...parsed, ...result, marketCategory: 'crypto' };
      })
      .filter(m => {
        if (m === null) return false;
        // REQUIRE minimum WIN PROBABILITY for auto-betting (learned from historical data)
        const winProb = parseFloat(m.winProbability) || 0;
        const minAutoProb = getMinAutoWinProbability();
        if (winProb < minAutoProb) return false;

        // Check if we already bet on this market
        const betKey = `${req.userId ?? 'default'}:${m.ticker}`;

        // Fix 2: Check unfilled cooldown before anything else
        const cooldown = unfilledCooldowns.get(betKey);
        if (cooldown && now - cooldown.timestamp < cooldown.cooldownMs) {
          return false; // Still in cooldown from unfilled order
        }

        if (recentBets.has(betKey)) {
          const existing = recentBets.get(betKey);
          if (existing.unfilled) {
            // Allow retry on same side, still block side flips
            const currentSide = (m.betSide || m.side || '').toUpperCase();
            if (existing.side && currentSide && existing.side.toUpperCase() !== currentSide) {
              return false; // Side flip blocked even on unfilled
            }
            // Same side retry allowed — fall through
          } else {
            // Normal scale-in logic
            if (shouldAllowScaleIn(m.ticker, winProb, m.betSide, userConfig, req.userId)) {
              m.isScaleIn = true;
            } else {
              return false;
            }
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
        message: `Scanning ${Object.keys(TRACKED_TOKENS).length} markets (${Object.keys(TRACKED_TOKENS).join(', ')}) - no auto-bet opportunities yet`,
        bet: null,
        scanned: Object.keys(TRACKED_TOKENS).length
      });
    }

    const best = opportunities[0];

    const category = best.marketCategory || 'crypto';
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType, req.userState, userConfig, req.userId);
    const remainingTotalBudget = getRemainingTotalBudget(userConfig, req.userId);
    const effectiveBudget = Math.min(remainingTokenBudget, remainingTotalBudget);
    console.log(`Auto-bet found [${category}]: ${best.title} | Win prob: ${best.winProbability}% | Side: ${best.betSide}`);

    // Check per-token limit AND total cycle budget
    if (effectiveBudget < 10) {
      const token = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
      const tokenLimit = remainingTokenBudget < 10;
      const reason = tokenLimit ? `${token} token cycle limit` : 'total cycle budget';
      console.log(`Token limit reached: ${reason}`);
      return res.json({
        success: true,
        message: `Cycle limit reached (${reason}). Token: ${(remainingTokenBudget/100).toFixed(2)}, Total: ${(remainingTotalBudget/100).toFixed(2)}`,
        bet: null,
        risk: getRiskByType(req.userState)
      });
    }

    // DEFENSE-IN-DEPTH: Check if Kalshi portfolio has opposite-side position on same ticker
    if (userConfig.isAuthenticated && userPortfolio.positions?.length > 0) {
      const existingPos = userPortfolio.positions.find(p => p.ticker === best.ticker);
      if (existingPos && Math.abs(existingPos.position || 0) > 0) {
        const existingSide = existingPos.position > 0 ? 'YES' : 'NO';
        const newSide = best.betSide?.toUpperCase();
        if (existingSide !== newSide) {
          console.log(` OPPOSITE POSITION BLOCKED: Already holding ${existingSide} on ${best.ticker}, refusing ${newSide} bet`);
          return res.json({
            success: true,
            message: `Blocked: Already holding ${existingSide} on ${best.ticker}, refusing opposite ${newSide} bet`,
            bet: null,
            risk: getRiskByType(req.userState)
          });
        }
      }
    }

    // Cap bet at effective budget (min of token and total cycle budget)
    const MAX_BET_CENTS = effectiveBudget;

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      return res.json({ success: true, message: 'Bet size too small for token budget', bet: null });
    }

    // Ensure we don't exceed budget
    const totalCost = count * priceCents;

    // HARD LIMIT CHECK: Validate bet won't exceed ANY limit
    const validation = validateBetWontExceedLimits(best.ticker, totalCost, req.userState, req.userState?.config, req.userId);
    if (!validation.valid) {
      console.log(` Bet blocked: ${validation.reason}`);
      return res.json({
        success: true,
        message: `Bet blocked: ${validation.reason}`,
        bet: null,
        risk: getRiskByType(req.userState)
      });
    }

    // Get existing bet info for scale-in tracking
    const autoBetKey = `${req.userId ?? 'default'}:${best.ticker}`;
    const existingBet = recentBets.get(autoBetKey);
    const newBetCount = best.isScaleIn ? ((existingBet?.betCount || 1) + 1) : 1;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      marketCategory: category,
      token: best.cryptoType || best.assetType || getTokenFromTicker(best.ticker),
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
    recentBets.set(autoBetKey, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      betCount: newBetCount
    });
    if (best.isScaleIn) {
      console.log(` Scale-in bet #${newBetCount} on ${best.ticker} at ${best.winProbability}%`);
    }

    if (!userConfig.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      userBetHistory.unshift(betRecord);
      userConfig.bankroll -= betRecord.totalCost;
      trackSpend(req.userId, betRecord.totalCost, getTokenFromTicker(best.ticker) || best.cryptoType || best.assetType);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // Save user state
      if (req.userId) saveUserState(req.userId);

      const simRiskAuto = getRiskByType(req.userState);
      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        opportunity: best,
        newBalance: userConfig.bankroll / 100,
        risk: {
          current: simRiskAuto.total,
          currentDollars: (simRiskAuto.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: (userPortfolio.positions || []).length,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });
    }

    // Real bet - use limit order slightly above ask to ensure fill
    const baseFillSlippage2 = userConfig.selectivityRules?.fillSlippageCents ?? 3;
    const fillSlippage = baseFillSlippage2;
    const fillPrice = Math.min(priceCents + fillSlippage, 99);

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

    console.log(`Auto-bet placing order (ask: ${priceCents}c, bid: ${fillPrice}c):`, JSON.stringify(orderRequest));

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
        // Cancel the unfilled order so it doesn't sit on Kalshi's book
        if (order.order_id) {
          try {
            await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
            console.log(`Cancelled unfilled order ${order.order_id}`);
          } catch (cancelErr) {
            console.log(`Could not cancel order ${order.order_id}:`, cancelErr.message);
          }
        }
        // Keep side tracking, just mark unfilled (Fix 1)
        const unfilledEntry = recentBets.get(autoBetKey);
        if (unfilledEntry) unfilledEntry.unfilled = true;
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
      trackSpend(req.userId, betRecord.totalCost, getTokenFromTicker(best.ticker) || best.cryptoType || best.assetType);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: req.userId,
        count: filledCount,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: betRecord.avgPrice,
        marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
      // Stop-loss and take-profit handled by active monitoring (evaluateTakeProfit)

      try {
        const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
        userPortfolio.balance = balanceData.balance || 0;
        userConfig.bankroll = userPortfolio.balance;
      } catch (e) {
        console.log('Could not refresh balance after auto-bet:', e.message);
      }

      // Refresh positions for accurate risk calculation
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig);
        userPortfolio.positions = filterExpiredPositions((posData.market_positions || posData.positions || []).filter(p => Math.abs(p.position || 0) > 0));
      } catch (e) {
        console.log('Could not refresh positions after auto-bet:', e.message);
      }

      const riskByType = getRiskByType(req.userState);

      // Save user state after successful bet
      if (req.userId) saveUserState(req.userId);

      // Clear unfilled cooldown on successful fill (Fix 2)
      unfilledCooldowns.delete(autoBetKey);

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
          currentDollars: (riskByType.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: (userPortfolio.positions || []).length,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });
    } catch (orderError) {
      console.error('Kalshi auto-bet order error:', orderError.message);
      const errEntry = recentBets.get(autoBetKey);
      if (errEntry) errEntry.unfilled = true;
      res.status(400).json({ success: false, error: 'Order failed. Check your balance and try again.' });
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

// Maker fee savings tracker: accumulates taker-maker fee difference on each maker fill
let makerFeeSavings = { totalCents: 0, fillCount: 0, fallbackCount: 0 };

// Track insufficient balance to avoid spamming Kalshi API
let insufficientBalanceUntil = 0; // timestamp when we can try again
// Concurrency guard: prevent overlapping runAutoBet() calls that bypass risk limits
let autoBetRunning = false;

async function runAutoBet(userId = null) {
  // Prevent concurrent runs — setInterval can fire while previous run is still awaiting API calls
  if (autoBetRunning) {
    console.log(' AUTO-BET: Previous cycle still running, skipping');
    return;
  }
  autoBetRunning = true;
  try {
  return await _runAutoBetInner(userId);
  } finally {
    autoBetRunning = false;
  }
}

async function _runAutoBetInner(userId = null) {
  // Global kill switch check halts all betting immediately
  if (isKillSwitchActive()) {
    console.log(' KILL SWITCH: Skipping auto-bet cycle');
    return;
  }

  // Insufficient balance backoff: don't spam Kalshi after balance error
  if (Date.now() < insufficientBalanceUntil) {
    const waitSec = Math.round((insufficientBalanceUntil - Date.now()) / 1000);
    console.log(` BALANCE BACKOFF: Skipping scan, insufficient balance cooldown (${waitSec}s remaining)`);
    lastScanStatus.status = 'error';
    lastScanStatus.statusMessage = `Insufficient balance - waiting ${waitSec}s`;
    return;
  }
  try {
    // Get user-specific state if userId provided (async to ensure DB state is loaded)
    const userState = userId ? await getUserStateAsync(userId) : null;
    const userConfig = userState?.config || config;
    const userPortfolio = userState?.portfolio || portfolio;
    const userBetHistory = userState?.betHistory || betHistory;

    console.log('\n- ========== AUTO-BET SCAN ==========');
    if (userId) console.log(` User: ${userId}`);

    // Refresh balance from Kalshi BEFORE bankroll floor check (prevents stale cache blocking bets)
    if (userConfig.isAuthenticated) {
      try {
        const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
        userPortfolio.balance = balanceData.balance || 0;
        userConfig.bankroll = userPortfolio.balance;
        console.log(` Fresh balance: $${(userPortfolio.balance / 100).toFixed(2)}`);
      } catch (e) {
        console.log(' Could not refresh balance:', e.message);
      }
    }

    // SAFETY CHECK 1: Bankroll floor don't bet if balance too low
    if (isBankrollTooLow(userConfig)) {
      const minBankroll = userConfig.minBankrollCents || 200;
      console.log(` BANKROLL FLOOR: Balance $${((userConfig.bankroll || 0)/100).toFixed(2)} < minimum $${(minBankroll/100).toFixed(2)} auto-bet paused`);
      lastScanStatus = {
        ...lastScanStatus,
        timestamp: new Date().toISOString(),
        status: 'bankroll_floor',
        statusMessage: `Balance too low ($${((userConfig.bankroll || 0)/100).toFixed(2)} < $${(minBankroll/100).toFixed(2)} min)`,
        blockedReasons: ['Bankroll below minimum floor']
      };
      console.log('========================================\n');
      return;
    }

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

    // Parallel fetch: positions + markets simultaneously (saves ~500-1000ms per cycle)
    const positionsPromise = userConfig.isAuthenticated
      ? kalshiRequest('GET', '/portfolio/positions?status=open', null, userConfig).catch(e => {
          console.log(' Could not refresh positions:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const marketsPromise = fetchCryptoMarkets();

    const [posData, cryptoMarkets] = await Promise.all([positionsPromise, marketsPromise]);

    // Process positions result
    if (posData && userConfig.isAuthenticated) {
      if (!posData.market_positions) {
        console.warn(' Unexpected Kalshi positions response shape:', Object.keys(posData).join(', '));
      }
      userPortfolio.positions = filterExpiredPositions(
        (posData.market_positions || posData.positions || [])
          .filter(p => Math.abs(p.position || 0) > 0), // Filter ghost positions (0 contracts)
        true // log filtered positions
      );
      syncKalshiPositionsToBetHistory(userState, userPortfolio.positions, userId);
      console.log(` Refreshed positions: ${userPortfolio.positions.length} open positions from Kalshi`);
      if (userPortfolio.positions.length > 0) {
        userPortfolio.positions.forEach(p => {
          const token = getTokenFromTicker(p.ticker);
          console.log(` Position: ${p.ticker} (${token}) | contracts=${p.position} | avg_price=${p.average_price} | market_exposure=${p.market_exposure}`);
        });
        const tokenExposure = getExposureByToken(userState);
        console.log(` Calculated token exposure:`);
        for (const [token, exposure] of Object.entries(tokenExposure)) {
          console.log(` ${token}: $${(exposure/100).toFixed(2)} exposure (cycle limit $${(getMaxPerTokenPerCycle(userConfig)/100).toFixed(2)})`);
        }
      }
      // Show rolling spend per token (actual budget tracking)
      const rollingSpend = Object.fromEntries(Object.keys(TRACKED_TOKENS).map(t => [t, getRollingSpendByToken(userId, t, CYCLE_WINDOW_MS)]));
      const totalSpend = Object.values(rollingSpend).reduce((sum, v) => sum + v, 0);
      const maxPerCycle = getMaxPerTokenPerCycle(userConfig);
      const maxTotal = getMaxTotalPerCycle(userConfig);
      console.log(`Pre-bet rolling spend (15min): ${JSON.stringify(
        Object.fromEntries(Object.entries(rollingSpend).map(([k,v]) => [k, '$'+(v/100).toFixed(2)]))
      )} | Total: $${(totalSpend/100).toFixed(2)}/$${(maxTotal/100).toFixed(2)} | Per-token limit: $${(maxPerCycle/100).toFixed(2)}`);

      // AUTO-SELL REMOVED: Positions ride to expiry (no take-profit/stop-loss exits)
    }

    // SAFETY CHECK 2: Max open positions — limit exposure, not frequency
    // Check AFTER positions are refreshed from Kalshi for accuracy
    const openPositions = (userPortfolio.positions || [])
      .filter(p => Math.abs(p.position || 0) > 0).length;
    const maxOpenPositions = userConfig.maxOpenPositions || 8;
    if (openPositions >= maxOpenPositions) {
      console.log(` POSITION CAP: ${openPositions}/${maxOpenPositions} positions open, waiting for exits`);
      lastScanStatus = {
        ...lastScanStatus,
        timestamp: new Date().toISOString(),
        status: 'position_cap',
        statusMessage: `${openPositions} open positions (max ${maxOpenPositions})`,
        blockedReasons: [`${openPositions}/${maxOpenPositions} positions open`]
      };
      console.log('========================================\n');
      return;
    }

    const now = Date.now();

    // Clean up old bets (shorter TTL for unfilled)
    for (const [ticker, bet] of recentBets.entries()) {
      const maxAge = bet.unfilled ? 10 * 60 * 1000 : 30 * 60 * 1000;
      if (now - bet.timestamp > maxAge) {
        recentBets.delete(ticker);
      }
    }
    // Clean up expired unfilled cooldowns
    for (const [key, cd] of unfilledCooldowns.entries()) {
      if (now - cd.timestamp > cd.cooldownMs) unfilledCooldowns.delete(key);
    }

    // Fix 4: Dynamic scan throttle — reduce frequency during low-liquidity hours
    const utcHour = new Date().getUTCHours();
    const isLowLiquidityHour = utcHour >= 0 && utcHour < 6; // midnight-6 AM UTC
    if (isLowLiquidityHour) {
      if (!runAutoBet._lastFullRun) runAutoBet._lastFullRun = 0;
      if (now - runAutoBet._lastFullRun < 30000) return; // Max 1 scan per 30s overnight
    }
    runAutoBet._lastFullRun = now;

    console.log(` Fetched: ${cryptoMarkets.length} crypto markets (${Object.keys(TRACKED_TOKENS).join(', ')})`);
    console.log(` Recent bets tracking: ${recentBets.size} markets`);

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
      console.log(` SITTING OUT: ${globalSitOut.reasons.join(', ')}`);
      lastScanStatus.status = 'sitting_out';
      lastScanStatus.statusMessage = globalSitOut.reasons[0];
      lastScanStatus.blockedReasons = globalSitOut.reasons;
      console.log('========================================\n');
      return;
    }

    if (isOffPeakHours()) {
      console.log(` OFF-PEAK MODE: Trading cautiously (higher thresholds, 50% position size, +2c slippage)`);
    }

    // Analyze crypto opportunities with EMPIRICAL evaluation
    const analysisPromises = cryptoMarkets.map(async (m) => {
      const parsed = parseMarket(m);
      if (!parsed.cryptoType || !parsed.strikePrice) return null;

      // Get current price for this token - skip if missing or stale (>60s old)
      const priceData = cryptoPrices[parsed.cryptoType];
      if (!priceData?.price) return null;
      const priceAge = Date.now() - priceData.timestamp;
      if (priceAge > 60000) {
        console.log(` Stale price for ${parsed.cryptoType} in autoBet: ${(priceAge/1000).toFixed(0)}s old - skipping`);
        return null;
      }

      // Price history gate: don't bet without enough data for vol/momentum estimates
      // 10 ticks = enough for basic vol calc (theoretical model needs 10+5 log-returns)
      // Was 30 but REST fallback only delivers ~2 ticks/min when WS is flaky
      const historyLength = priceData.history?.length || 0;
      if (historyLength < 10) {
        console.log(` Waiting for price history on ${parsed.cryptoType}: ${historyLength}/10 ticks - skipping`);
        return null;
      }

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
        orderbook,
        userConfig // Pass user config for selectivity rules
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
    // Single-pass filter with counters (was 3 separate .filter() calls)
    const allOpps = [];
    let withEdgeCount = 0;
    let recommendedCount = 0;
    for (const m of allOppsRaw) {
      if (m === null) continue;
      allOpps.push(m);
      if (m.edge > 0) withEdgeCount++;
      if (m.shouldBet) recommendedCount++;
    }
    const minAutoThreshold = learnedParams.selectivityRules?.minEmpiricalWinRate || 62;

    console.log(` Analyzed: ${allOpps.length} valid | ${withEdgeCount} with edge | ${recommendedCount} recommended`);

    // Log rejection reasons for each market so we can debug why nothing passes
    if (recommendedCount === 0 && allOpps.length > 0) {
      console.log(` Rejection reasons:`);
      for (const m of allOpps) {
        const token = m.cryptoType || m.assetType || getTokenFromTicker(m.ticker);
        const topReason = m.reasons?.[0] || (m.shouldBet ? 'passed' : 'unknown');
        const sig = m.signalStrength || 0;
        const edge = m.edge?.toFixed(1) || '?';
        console.log(`   ${token}: signal=${sig} edge=${edge}% | ${topReason}`);
      }
    }

    // Update scan status
    lastScanStatus.marketsScanned = cryptoMarkets.length;
    lastScanStatus.activeMarkets = allOpps.length;
    lastScanStatus.marketsWithEdge = withEdgeCount;

    // Show signal strength distribution for empirical debugging
    // Signal strength distribution (math-based bucket assignment)
    const bucketNames = ['0-40', '40-60', '60-70', '70-80', '80-90', '90-100'];
    const bucketThresholds = [40, 60, 70, 80, 90, 101]; // upper bounds
    const signalBuckets = Object.fromEntries(bucketNames.map(n => [n, 0]));
    for (const m of allOpps) {
      const sig = m.signalStrength || 0;
      const idx = sig < 40 ? 0 : sig < 60 ? 1 : Math.min(5, 2 + Math.floor((sig - 60) / 10));
      signalBuckets[bucketNames[idx]]++;
    }
    console.log(` Signal strength distribution: ${JSON.stringify(signalBuckets)}`);

    // Show regime status for each token
    console.log(` Volatility regimes:`);
    for (const token of Object.keys(TRACKED_TOKENS)) {
      const regime = detectVolatilityRegime(token);
      console.log(` ${token}: ${regime.regime} (${regime.reason})`);
    }

    // Filter to only empirically recommended opportunities
    const opportunities = allOpps
      .filter(m => {
        // Must pass empirical evaluation
        if (!m.shouldBet) {
          return false;
        }

        // Check if we already bet on this market
        const betKey = `${userId ?? 'default'}:${m.ticker}`;

        // Fix 2: Check unfilled cooldown before anything else
        const cooldown = unfilledCooldowns.get(betKey);
        if (cooldown && now - cooldown.timestamp < cooldown.cooldownMs) {
          return false; // Still in cooldown from unfilled order
        }

        if (recentBets.has(betKey)) {
          const existing = recentBets.get(betKey);
          if (existing.unfilled) {
            // Allow retry on same side, still block side flips (Fix 1)
            const currentSide = (m.betSide || m.side || '').toUpperCase();
            if (existing.side && currentSide && existing.side.toUpperCase() !== currentSide) {
              console.log(` SIDE FLIP BLOCKED (unfilled): ${m.ticker} attempted ${currentSide} but previous attempt was ${existing.side.toUpperCase()}`);
              return false;
            }
            // Same side retry allowed — fall through
          } else {
            // Normal scale-in logic
            const currentWinRate = parseFloat(m.winProbability) || 0;
            if (shouldAllowScaleIn(m.ticker, currentWinRate, m.betSide || m.side, userConfig, userId)) {
              m.isScaleIn = true;
            } else {
              return false;
            }
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
    console.log(` Final: ${opportunities.length} opportunities (${highSignalCount} with signal 80)`);

    // Show top opportunities with empirical details
    if (opportunities.length > 0) {
      console.log(` Top empirical opportunities:`);
      opportunities.slice(0, 3).forEach(m => {
        console.log(` - ${m.title}: signal=${m.signalStrength} | win=${m.winProbability}% @ ${m.marketPriceCents}c | edge=${m.edge?.toFixed(1)}% | regime=${m.regime}`);
      });
    }

    // Show markets that almost qualified (signal 60-70)
    const minSignal = learnedParams.selectivityRules?.minSignalStrength || 60;
    const almostQualified = allOpps.filter(m => {
      const sig = m.signalStrength || 0;
      return sig >= minSignal - 15 && sig < minSignal && m.edge > 0;
    });
    if (almostQualified.length > 0) {
      console.log(` ${almostQualified.length} markets approaching signal threshold:`);
      almostQualified.slice(0, 3).forEach(m => {
        const rejectionReason = m.reasons?.[0] || 'Unknown';
        console.log(` - ${m.title}: signal=${m.signalStrength} | ${rejectionReason}`);
      });
    }

    if (opportunities.length === 0) {
      console.log(' No empirically valid opportunities - waiting for next scan...');
      console.log('========================================\n');

      // Update status with reason
      lastScanStatus.status = 'no_opportunities';
      lastScanStatus.statusMessage = `Scanning ${Object.keys(TRACKED_TOKENS).length} markets (${Object.keys(TRACKED_TOKENS).join(', ')}) - waiting for high-signal opportunity`;
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

    // CORRELATION GUARD: Limit tokens bet per 15-min window to reduce correlated losses
    // Crypto tokens are 60-80% correlated — betting 4 tokens same direction ≈ 1 bet with 4x risk
    const maxTokensPerWindow = userConfig.maxTokensPerWindow || 2;
    const windowMs = 15 * 60 * 1000; // 15-minute correlation window
    const tokensInWindow = new Set();
    for (const [key, entry] of recentBets.entries()) {
      if (now - entry.timestamp < windowMs && !entry.unfilled) {
        const betToken = key.split(':')[1] ? getTokenFromTicker(key.split(':')[1]) : null;
        if (betToken) tokensInWindow.add(betToken);
      }
    }
    // Filter out opportunities for tokens that would exceed the per-window limit
    // BUG FIX: Use incremental tracking so tokens added in THIS scan count toward the limit.
    // Old code used .filter() which didn't update tokensInWindow between iterations,
    // so an empty recentBets let all 4 tokens through in the same scan.
    const tokensThisScan = new Set(tokensInWindow);
    const correlationFiltered = [];
    for (const m of opportunities) {
      const oppToken = m.cryptoType || m.assetType || getTokenFromTicker(m.ticker);
      if (tokensThisScan.has(oppToken)) {
        correlationFiltered.push(m); // Already bet this token, allow scale-in
      } else if (tokensThisScan.size >= maxTokensPerWindow) {
        console.log(` CORRELATION GUARD: Skipping ${oppToken} — already have ${[...tokensThisScan].join(', ')} this window (max ${maxTokensPerWindow})`);
      } else {
        tokensThisScan.add(oppToken); // New token, count it toward the limit
        correlationFiltered.push(m);
      }
    }
    if (correlationFiltered.length === 0 && opportunities.length > 0) {
      console.log(` All ${opportunities.length} opportunities blocked by correlation guard (${[...tokensInWindow].join(', ')} already bet)`);
      lastScanStatus.status = 'no_opportunities';
      lastScanStatus.statusMessage = `Correlation guard: ${[...tokensInWindow].join(', ')} already bet this 15min window`;
      console.log('========================================\n');
      return;
    }
    const finalOpportunities = correlationFiltered.length > 0 ? correlationFiltered : opportunities;

    lastScanStatus.opportunitiesFound = finalOpportunities.length;

    // Always show the best opportunity found
    const best = finalOpportunities[0];
    const category = best.marketCategory || 'crypto';

    // Display EMPIRICAL analysis for best opportunity
    console.log(`\n BEST EMPIRICAL OPPORTUNITY [${category.toUpperCase()}]:`);
    console.log(` ${best.title}`);
    console.log(` Signal Strength: ${best.signalStrength}/100`);
    console.log(` Side: ${best.betSide} @ ${best.marketPriceCents}c | Win rate: ${best.winProbability}% (empirical)`);
    console.log(` Current: $${best.currentPrice?.toFixed(2) || 'N/A'} | Strike: $${best.strikePrice?.toFixed(2) || 'N/A'}`);
    console.log(` Distance: ${best.absDistance?.toFixed(2)}% from strike | Regime: ${best.regime}`);
    console.log(` Edge: +${best.edge?.toFixed(1)}% (after fees) | Sample size: ${best.sampleSize}`);

    // MOMENTUM CONFIRMATION - Check if price trend supports our bet direction
    const token = best.assetType || best.cryptoType || getTokenFromTicker(best.ticker);
    const priceHistory = cryptoPrices[token]?.history || [];
    const momentum = calculateMomentumMultiTimeframe(priceHistory);
    const isBullish = momentum.direction === 'bullish';
    const isBearish = momentum.direction === 'bearish';
    const betIsBullish = best.betSide === 'YES' && best.marketType !== 'below' ||
                         best.betSide === 'NO' && best.marketType === 'below';

    const momentumAligned = (betIsBullish && isBullish) || (!betIsBullish && isBearish);
    const momentumOpposed = (betIsBullish && isBearish) || (!betIsBullish && isBullish);

    console.log(` Momentum: ${momentum.direction} (5m: ${(momentum.m5*100).toFixed(2)}%, 15m: ${(momentum.m15*100).toFixed(2)}%)`);

    // Apply momentum adjustment to edge
    const momentumSettings = userConfig.momentumSettings || {};
    if (momentumSettings.enabled !== false) {
      if (momentumAligned && momentum.strength === 'strong') {
        console.log(` Momentum ALIGNED with bet (+${momentumSettings.alignmentBonus || 2}% edge bonus)`);
      } else if (momentumOpposed && momentum.strength === 'strong') {
        console.log(` Momentum OPPOSED to bet - consider skipping`);
        // If momentum strongly opposes and we don't have great edge, skip
        if (best.edge < 8 && momentum.strength === 'strong') {
          console.log(` Skipping bet: momentum strongly opposed with only ${best.edge.toFixed(1)}% edge`);
          lastScanStatus.status = 'momentum_opposed';
          lastScanStatus.statusMessage = `Momentum ${momentum.direction} opposes ${best.betSide} bet`;
          lastScanStatus.blockedReasons.push(`Momentum opposed: ${momentum.direction} vs ${best.betSide}`);
          console.log('========================================\n');
          return;
        }
      }
    }

    // Show other good opportunities
    if (opportunities.length > 1) {
      console.log(` + ${opportunities.length - 1} more opportunities with signal ${minSignal}`);
    }

    // Check per-token limit
    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType, userState, userConfig, userId);
    const remainingTotalBudget = getRemainingTotalBudget(userConfig, userId);
    const effectiveBudget = Math.min(remainingTokenBudget, remainingTotalBudget);
    const tokenName = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
    if (effectiveBudget < 10) {
      const tokenLimit = remainingTokenBudget < 10;
      const reason = tokenLimit ? `${tokenName} token cycle limit` : 'total cycle budget';
      console.log(`Token limit reached: ${reason}`);
      console.log('========================================\n');

      lastScanStatus.status = 'token_limit';
      lastScanStatus.statusMessage = `Cycle limit reached: ${reason}`;
      lastScanStatus.blockedReasons.push(`${reason}: token=$${(remainingTokenBudget/100).toFixed(2)}, total=$${(remainingTotalBudget/100).toFixed(2)}`);
      return;
    }

    // DEFENSE-IN-DEPTH: Check if Kalshi portfolio has opposite-side position on same ticker
    // This catches edge cases where recentBets was cleared but we still hold a position
    if (userConfig.isAuthenticated && userPortfolio.positions?.length > 0) {
      const existingPos = userPortfolio.positions.find(p => p.ticker === best.ticker);
      if (existingPos && Math.abs(existingPos.position || 0) > 0) {
        const existingSide = existingPos.position > 0 ? 'YES' : 'NO';
        const newSide = best.betSide?.toUpperCase();
        if (existingSide !== newSide) {
          console.log(` OPPOSITE POSITION BLOCKED: Already holding ${existingSide} on ${best.ticker}, refusing ${newSide} bet`);
          lastScanStatus.status = 'opposite_position';
          lastScanStatus.statusMessage = `Already holding ${existingSide} on ${best.ticker}`;
          lastScanStatus.blockedReasons.push(`Opposite position: holding ${existingSide}, tried ${newSide}`);
          console.log('========================================\n');
          return;
        }
      }
    }

    // Display confidence based on signal strength
    const confidenceLevel = best.signalStrength >= 85 ? ' HIGH CONFIDENCE (empirical)' :
                           best.signalStrength >= 75 ? ' GOOD SIGNAL' : ' MODERATE SIGNAL';
    console.log(` ${confidenceLevel}`);
    console.log(` Token budget for ${tokenName}: $${(remainingTokenBudget/100).toFixed(2)} remaining`);
    console.log(` Total cycle budget: $${(getRemainingTotalBudget(userConfig, userId)/100).toFixed(2)} remaining of $${(getMaxTotalPerCycle(userConfig)/100).toFixed(2)}`);
    console.log(` Effective budget: $${(effectiveBudget/100).toFixed(2)} (min of token=$${(remainingTokenBudget/100).toFixed(2)}, total=$${(remainingTotalBudget/100).toFixed(2)})`);

    // Cap bet at effective budget (min of token and total cycle budget)
    const hardCapCents = effectiveBudget;

    const priceCents = Math.round(best.betPrice * 100);

    // Guard against extreme prices — penny bets (<15¢) bleed bankroll fast
    const HARD_PRICE_FLOOR = 15; // Never buy below 15¢ — implies <15% win probability
    const HARD_PRICE_CEILING = 95; // Never buy above 95¢ — risk/reward too poor
    if (priceCents < HARD_PRICE_FLOOR || priceCents > HARD_PRICE_CEILING) {
      console.log(` Skipping extreme price ${priceCents}c (floor=${HARD_PRICE_FLOOR}c, ceiling=${HARD_PRICE_CEILING}c)`);
      lastScanStatus.status = 'price_extreme';
      lastScanStatus.statusMessage = `Price ${priceCents}c outside ${HARD_PRICE_FLOOR}-${HARD_PRICE_CEILING}c range`;
      console.log('========================================\n');
      return;
    }

    // 1/2-Kelly sizing: moderately aggressive, user-requested bigger bets
    const bankroll = userConfig.bankroll || 0;
    const kellyFraction = bankroll > 0
      ? 0.5 * (best.edge / 100) / Math.max(0.01, 1 - best.betPrice)
      : 0;
    // Confidence scaling: reduce bet size when data is sparse
    const sampleSize = best.sampleSize || 0;
    const confidenceScale = sampleSize >= 200 ? 1.0 :
                             sampleSize >= 100 ? 0.85 :
                             sampleSize >= 50  ? 0.65 :
                             sampleSize >= 20  ? 0.45 : 0.25;
    const kellyBet = Math.max(0, Math.round(kellyFraction * bankroll * confidenceScale));
    // In low-vol or strong correlation, be more aggressive (1/2 Kelly instead of 3/8)
    const isLowVol = best.regime === 'low';
    const hasStrongCorrelation = (best.correlationBoost || 0) >= 8;
    const aggKellyBet = (isLowVol || hasStrongCorrelation)
      ? Math.max(0, Math.round(0.5 * (best.edge / 100) / Math.max(0.01, 1 - best.betPrice) * bankroll * confidenceScale))
      : kellyBet;
    // Floor at $2 minimum so Kelly buys a few contracts, then cap at cycle budget
    const MIN_BET_CENTS = 200;
    const MAX_BET_CENTS = Math.min(hardCapCents, Math.max(MIN_BET_CENTS, aggKellyBet));

    console.log(` Bet sizing: Kelly=${(kellyFraction*100).toFixed(1)}% bankroll=$${(bankroll/100).toFixed(2)} kellyBet=$${(aggKellyBet/100).toFixed(2)}${isLowVol ? ' (1/2 low-vol)' : ''}${hasStrongCorrelation ? ' (1/2 corr)' : ''} confidence=${(confidenceScale*100).toFixed(0)}% (${sampleSize} samples) capped=$${(MAX_BET_CENTS/100).toFixed(2)} (cycle limit $${(getMaxPerTokenPerCycle(userConfig)/100).toFixed(2)}/token)`);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      console.log(' Bet size too small for risk budget');
      lastScanStatus.status = 'bet_too_small';
      lastScanStatus.statusMessage = `Bet size too small (price ${priceCents}c > budget $${(MAX_BET_CENTS/100).toFixed(2)})`;
      lastScanStatus.blockedReasons.push(`Budget too low for ${priceCents}c contract`);
      return;
    }

    // Ensure we don't exceed budget
    const totalCost = count * priceCents;

    // HARD LIMIT CHECK: Validate bet won't exceed ANY limit
    const validation = validateBetWontExceedLimits(best.ticker, totalCost, userState, userConfig, userId);
    if (!validation.valid) {
      console.log(` Bet blocked: ${validation.reason}`);
      lastScanStatus.status = 'limit_exceeded';
      lastScanStatus.statusMessage = validation.reason;
      return;
    }

    // Get existing bet info for scale-in tracking
    const runBetKey = `${userId ?? 'default'}:${best.ticker}`;
    const existingBet = recentBets.get(runBetKey);
    const newBetCount = best.isScaleIn ? ((existingBet?.betCount || 1) + 1) : 1;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      marketCategory: category,
      token: best.cryptoType || best.assetType || getTokenFromTicker(best.ticker),
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

    // Record for empirical rate limiting (with side for saturation tracking)
    recordEmpiricalBet(best.token || best.cryptoType, best.betSide, best.isFavoredSideBet !== false);

    if (best.isScaleIn) {
      console.log(` SCALE-IN: Adding bet #${newBetCount} on ${best.ticker} (signal increased to ${best.signalStrength})`);
    }

    // Define assetName early - used in both simulated and real bet logging
    const assetName = best.cryptoType || best.assetType || getTokenFromTicker(best.ticker) || 'unknown';

    if (!userConfig.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      userBetHistory.unshift(betRecord);
      userConfig.bankroll -= betRecord.totalCost;
      trackSpend(userId, betRecord.totalCost, getTokenFromTicker(best.ticker) || best.cryptoType || best.assetType);

      // Mark recentBets AFTER simulated bet is recorded
      recentBets.set(runBetKey, {
        timestamp: now,
        side: best.betSide,
        probability: parseFloat(best.winProbability),
        signalStrength: best.signalStrength,
        regime: best.regime,
        betCount: newBetCount
      });

      // Track for performance analysis
      trackBet({
        ...betRecord,
        userId: userId,
        token: best.assetType || best.cryptoType || getTokenFromTicker(best.ticker),
        predictedProb: parseFloat(best.winProbability),
        marketPrice: priceCents,
        strikePrice: best.strikePrice,
        currentPrice: best.currentPrice,
        marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
        expiryTime: best.expiry || best.close_time
      });

      // Save user state
      if (userId) saveUserState(userId);

      // Discord alert — simulated bet placed
      sendDiscordAlert({
        title: `SIM BET: ${betRecord.side} on ${assetName}`,
        color: 0x3498db,
        fields: [
          { name: 'Ticker', value: best.ticker || 'N/A', inline: true },
          { name: 'Contracts', value: `${count} @ ${priceCents}c`, inline: true },
          { name: 'Cost', value: `$${(betRecord.totalCost / 100).toFixed(2)}`, inline: true },
          { name: 'Edge', value: `+${best.edge.toFixed(1)}%`, inline: true },
          { name: 'Win Prob', value: `${best.winProbability}%`, inline: true },
        ],
      });

      console.log(`\n SIMULATED BET PLACED:`);
      console.log(` ${betRecord.side.toUpperCase()} on ${assetName}`);
      console.log(` ${count} contracts @ ${priceCents}c = $${(betRecord.totalCost/100).toFixed(2)}`);
      console.log(` Edge: +${best.edge.toFixed(1)}% | Win prob: ${best.winProbability}%`);
      console.log(` New balance: $${(userConfig.bankroll/100).toFixed(2)}`);
      console.log('========================================\n');

      lastScanStatus.status = 'bet_placed';
      lastScanStatus.statusMessage = `Simulated ${best.betSide} on ${assetName} (${count}x @ ${priceCents}c)`;
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

    // Determine maker vs taker mode for this order
    const makerCfg = userConfig.makerMode || {};
    const useMaker = makerCfg.enabled !== false && (best.timeRemaining || 15) >= (makerCfg.minTimeForMaker || 3);

    let fillPrice;
    if (useMaker) {
      // MAKER ORDER: post at ask - 1c (undercut the current ask to rest as top-of-book bid)
      // BUG FIX: Using bestBid+1 fails when bid side is empty/sparse (e.g. NO bestBid=1c, ask=57c)
      // Instead, post 1c below the ask — saves 1c vs taker and sits at top of bid book
      let makerAsk = priceCents; // fallback: use market ask
      try {
        const freshOb = await fetchOrderbook(best.ticker, userConfig);
        if (freshOb) {
          const obAsk = best.betSide.toLowerCase() === 'yes' ? (freshOb.bestYesAsk || priceCents) : (freshOb.bestNoAsk || priceCents);
          // Only use orderbook ask if reasonable (within 5c of market ask)
          if (obAsk > 0 && Math.abs(obAsk - priceCents) <= 5) {
            makerAsk = obAsk;
          }
        }
      } catch (obErr) {
        console.log(` Orderbook fetch failed for maker: ${obErr.message}, using market ask`);
      }
      fillPrice = Math.min(Math.max(makerAsk - 1, 1), 99);
      console.log(` MAKER ORDER: posting at ${fillPrice}c (ask=${makerAsk}c, market=${priceCents}c)`);
    } else {
      // TAKER ORDER: existing logic — limit order above ask to ensure fill
      const baseFillSlippage3 = userConfig.selectivityRules?.fillSlippageCents ?? 3;
      const offPeakFillBonus = isOffPeakHours() ? 1 : 0;
      const fillSlippage = (best.regime === 'low' ? Math.max(1, baseFillSlippage3 - 2) : baseFillSlippage3) + offPeakFillBonus;
      fillPrice = Math.min(priceCents + fillSlippage, 99);
      console.log(` TAKER ORDER: posting at ${fillPrice}c (ask=${priceCents}c, slippage=${fillSlippage}c)`);
    }

    // Fix 1: Track the attempt BEFORE placing order so side-flip protection works even on unfilled orders
    recentBets.set(runBetKey, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      signalStrength: best.signalStrength,
      regime: best.regime,
      betCount: newBetCount,
      unfilled: true  // Will be cleared on successful fill
    });

    console.log(`\n PLACING REAL BET...`);
    // Generate idempotency key to prevent duplicate orders on timeout/retry
    const clientOrderId = `shimi-${best.ticker}-${best.betSide}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const orderRequest = {
      ticker: best.ticker,
      client_order_id: clientOrderId,
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
    console.log(` Order (ask: ${priceCents}c, bid: ${fillPrice}c): ${JSON.stringify(orderRequest)}`);

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest, userConfig);
    console.log(` Response: ${JSON.stringify(orderResponse)}`);

    let order = orderResponse.order;
    if (!order) {
      console.error(' No order in response');
      const noOrderEntry = recentBets.get(runBetKey);
      if (noOrderEntry) noOrderEntry.unfilled = true;
      console.log('========================================\n');
      return;
    }

    // Check if order was filled - poll behavior depends on maker vs taker
    let status = order.status;
    let filledCount = order.fill_count || order.filled_count || 0;
    const maxPolls = useMaker ? 10 : 5; // Maker: 10s, Taker: 5s

    if (filledCount === 0 && status === 'resting' && order.order_id) {
      for (let pollAttempt = 1; pollAttempt <= maxPolls; pollAttempt++) {
        await sleep(1000);
        try {
          const checkResp = await kalshiRequest('GET', `/portfolio/orders/${order.order_id}`, null, userConfig);
          const updated = checkResp.order;
          if (updated) {
            filledCount = updated.fill_count || updated.filled_count || 0;
            status = updated.status;
            if (filledCount > 0) {
              console.log(` Order filled after ${pollAttempt} poll(s): ${filledCount}/${count} contracts`);
              order = updated;
              break;
            }
            if (status !== 'resting') break;
          }
        } catch (pollErr) {
          console.log(` Poll ${pollAttempt} error:`, pollErr.message);
        }
      }
    }

    // MAKER->TAKER FALLBACK: if maker unfilled after 10s, cancel and re-place as taker
    if (filledCount === 0 && useMaker && (makerCfg.fallbackToTaker !== false)) {
      console.log(` MAKER->TAKER FALLBACK: maker unfilled after ${maxPolls}s, switching to taker`);
      makerFeeSavings.fallbackCount++;
      // Cancel maker order
      if (order.order_id) {
        try {
          await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
          console.log(` Cancelled maker order ${order.order_id}`);
        } catch (cancelErr) {
          console.log(` Could not cancel maker order ${order.order_id}:`, cancelErr.message);
        }
      }
      // Use original market ask + slippage for taker fallback (orderbook ask can be stale/extreme)
      const takerPrice = Math.min(priceCents + 3, 99);
      const takerOrderId = `shimi-${best.ticker}-${best.betSide}-taker-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const takerRequest = {
        ticker: best.ticker,
        client_order_id: takerOrderId,
        action: 'buy',
        side: best.betSide.toLowerCase(),
        type: 'limit',
        count
      };
      if (best.betSide.toLowerCase() === 'yes') {
        takerRequest.yes_price = takerPrice;
      } else {
        takerRequest.no_price = takerPrice;
      }
      console.log(` Taker fallback order at ${takerPrice}c: ${JSON.stringify(takerRequest)}`);
      try {
        const takerResp = await kalshiRequest('POST', '/portfolio/orders', takerRequest, userConfig);
        order = takerResp.order;
        if (order) {
          status = order.status;
          filledCount = order.fill_count || order.filled_count || 0;
          // Poll 3 more times for taker
          if (filledCount === 0 && status === 'resting' && order.order_id) {
            for (let p = 1; p <= 3; p++) {
              await sleep(1000);
              try {
                const chk = await kalshiRequest('GET', `/portfolio/orders/${order.order_id}`, null, userConfig);
                if (chk.order) {
                  filledCount = chk.order.fill_count || chk.order.filled_count || 0;
                  status = chk.order.status;
                  if (filledCount > 0) { order = chk.order; break; }
                  if (status !== 'resting') break;
                }
              } catch (e) { /* ignore */ }
            }
          }
        }
      } catch (takerErr) {
        console.log(` Taker fallback failed: ${takerErr.message}`);
      }
    }

    if (filledCount === 0) {
      // Cancel the unfilled order so it doesn't sit on Kalshi's book
      if (order && order.order_id) {
        try {
          await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
          console.log(` Cancelled unfilled order ${order.order_id}`);
        } catch (cancelErr) {
          console.log(` Could not cancel order ${order.order_id}:`, cancelErr.message);
        }
      }
      console.error(`Order not filled after polling. Status: ${status}. No liquidity at ${fillPrice}c.`);
      const polledEntry = recentBets.get(runBetKey);
      if (polledEntry) polledEntry.unfilled = true;

      // Fix 2: Record unfilled cooldown with exponential backoff
      const cdEntry = unfilledCooldowns.get(runBetKey) || { consecutiveUnfills: 0 };
      cdEntry.consecutiveUnfills++;
      cdEntry.timestamp = Date.now();
      cdEntry.cooldownMs = Math.min(
        UNFILLED_MAX_COOLDOWN_MS,
        UNFILLED_BASE_COOLDOWN_MS * Math.pow(1.5, cdEntry.consecutiveUnfills - 1)
      );
      unfilledCooldowns.set(runBetKey, cdEntry);
      console.log(` Unfilled cooldown: ${(cdEntry.cooldownMs/1000).toFixed(0)}s (${cdEntry.consecutiveUnfills} consecutive)`);

      console.log('========================================\n');
      return;
    }

    // Track maker fee savings on successful maker fills
    if (useMaker && filledCount > 0) {
      const takerFee = calculateKalshiFee(filledCount, fillPrice / 100);
      const makerFee = calculateKalshiMakerFee(filledCount, fillPrice / 100);
      const savedCents = takerFee - makerFee;
      makerFeeSavings.totalCents += savedCents;
      makerFeeSavings.fillCount++;
      console.log(` Maker fill saved ${savedCents}c in fees (total: ${makerFeeSavings.totalCents}c / ${makerFeeSavings.fillCount} fills)`);
    }

    // EXEC-3: Cancel remaining resting order on partial fills
    if (filledCount > 0 && filledCount < count && order.order_id) {
      try {
        await kalshiRequest('DELETE', `/portfolio/orders/${order.order_id}`, null, userConfig);
        console.log(` Cancelled partially-filled order ${order.order_id} (filled ${filledCount}/${count})`);
      } catch (cancelErr) {
        console.log(` Could not cancel partial order ${order.order_id}:`, cancelErr.message);
      }
    }

    // Update bet record with actual fill info
    betRecord.status = status === 'filled' ? 'filled' : 'partial';
    betRecord.orderId = order.order_id;
    betRecord.filledCount = filledCount;
    betRecord.avgPrice = order.average_fill_price || priceCents;
    betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
    userBetHistory.unshift(betRecord);
    trackSpend(userId, betRecord.totalCost, getTokenFromTicker(best.ticker) || best.cryptoType || best.assetType);

    // Mark recentBets with unfilled: false on successful fill (Fix 1)
    recentBets.set(runBetKey, {
      timestamp: now,
      side: best.betSide,
      probability: parseFloat(best.winProbability),
      signalStrength: best.signalStrength,
      regime: best.regime,
      betCount: newBetCount,
      unfilled: false  // Successfully filled
    });

    // Clear unfilled cooldown on successful fill (Fix 2)
    unfilledCooldowns.delete(runBetKey);

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
      marketType: best.ticker?.includes('15M') ? '15min' : 'daily',
      expiryTime: best.expiry || best.close_time
    });

    // NOTE: Limit orders removed - Kalshi doesn't support them for crypto markets
    // Stop-loss and take-profit handled by active monitoring (evaluateTakeProfit)

    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      userConfig.bankroll = balanceData.balance || 0;
    } catch (e) {
      console.log('Could not refresh balance after auto-bet:', e.message);
    }

    // Save user state after successful bet
    if (userId) saveUserState(userId);

    // Discord alert — real bet filled
    sendDiscordAlert({
      title: `LIVE BET: ${betRecord.side} on ${assetName}`,
      color: 0x3498db,
      fields: [
        { name: 'Ticker', value: best.ticker || 'N/A', inline: true },
        { name: 'Contracts', value: `${filledCount} @ ${betRecord.avgPrice}c`, inline: true },
        { name: 'Cost', value: `$${(betRecord.totalCost / 100).toFixed(2)}`, inline: true },
        { name: 'Edge', value: `+${best.edge.toFixed(1)}%`, inline: true },
        { name: 'Win Prob', value: `${best.winProbability}%`, inline: true },
        { name: 'Order', value: order.order_id || 'N/A', inline: true },
      ],
    });

    console.log(`\n REAL BET FILLED:`);
    console.log(` ${betRecord.side.toUpperCase()} on ${best.cryptoType || best.assetType}`);
    console.log(` ${filledCount} contracts @ ${betRecord.avgPrice}c`);
    console.log(` Edge: +${best.edge.toFixed(1)}% | New balance: $${(userConfig.bankroll/100).toFixed(2)}`);
    console.log('========================================\n');

    // assetName already defined above
    lastScanStatus.status = 'bet_placed';
    lastScanStatus.statusMessage = `LIVE ${best.betSide} on ${assetName} (${filledCount}x @ ${betRecord.avgPrice}c)`;
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
    console.error(' Auto-bet error:', error.message);
    console.error(' Stack:', error.stack);
    console.log('========================================\n');

    // Fix 5: Track 429 rate limit errors
    if (error.message && error.message.includes('429')) {
      recent429Count++;
    }

    // Insufficient balance: back off for 5 minutes to avoid spamming Kalshi
    if (error.message && error.message.includes('insufficient_balance')) {
      const backoffMs = 5 * 60 * 1000; // 5 minutes
      insufficientBalanceUntil = Date.now() + backoffMs;
      console.log(` BALANCE BACKOFF: Pausing bets for 5 minutes due to insufficient balance`);
      lastScanStatus.status = 'error';
      lastScanStatus.statusMessage = 'Insufficient balance - paused for 5 min';
    } else {
      lastScanStatus.status = 'error';
      lastScanStatus.statusMessage = `Error: ${error.message}`;
    }
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

    // AUTO-SELL REMOVED: No take-profit/stop-loss scanning — positions ride to expiry

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

    // NOTE: Do NOT stop take-profit scanning when auto-bet is disabled
    // Position protection (stop-loss) should always run to protect open positions
    // stopTakeProfitScanning(req.userId); // REMOVED - keep monitoring active

    res.json({ success: true, message: 'Auto-betting disabled (position monitoring still active)', autoBetEnabled: false });
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
    console.log(` Restoring auto-bet interval for user ${req.userId}`);
    runAutoBet(req.userId);
    userAutoBetIntervals.set(req.userId, setInterval(() => runAutoBet(req.userId), 10000));

    // AUTO-SELL REMOVED: No take-profit/stop-loss scanning
  }

  res.json({
    success: true,
    autoBetEnabled: userConfig.autoBetEnabled,
    intervalRunning: req.userId ? userAutoBetIntervals.has(req.userId) : false,
    makerFeeSavings: {
      totalDollars: (makerFeeSavings.totalCents / 100).toFixed(2),
      fillCount: makerFeeSavings.fillCount,
      fallbackCount: makerFeeSavings.fallbackCount
    },
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
  betsByToken: new Map(), // Token -> count of bets in last hour
  lastSpikeTimes: new Map(), // Token -> timestamp of last detected spike
  recentSidesByToken: new Map(), // Token -> [{side, timestamp}] for saturation tracking
  recentUnfavoredBets: [] // [{timestamp}] for unfavored frequency limiting
};

// Volatility regime cache (30s TTL) - called 3x+ per 10s scan for display
const volatilityRegimeCache = new Map();
const VOLATILITY_CACHE_TTL = 30000;

/**
 * Detect current volatility regime for a token
 * @param {string} token - 'BTC', 'ETH', or 'SOL'
 * @param {Array} priceHistory - Recent price history
 * @returns {object} Regime info: { regime: 'low'|'medium'|'high'|'spike', reason: string }
 */
function detectVolatilityRegime(token, priceHistory = null) {
  const now = Date.now();

  // Return cached result if available and not stale (skip cache if custom history provided)
  if (!priceHistory) {
    const cached = volatilityRegimeCache.get(token);
    if (cached && (now - cached.timestamp) < VOLATILITY_CACHE_TTL) {
      return cached.result;
    }
  }

  const result = _detectVolatilityRegimeInner(token, priceHistory);

  // Cache result (only for default history lookups)
  if (!priceHistory) {
    volatilityRegimeCache.set(token, { result, timestamp: now });
  }

  return result;
}

function _detectVolatilityRegimeInner(token, priceHistory = null) {
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

  // Realized displacement+range — comparable to avgSettlementDistance units
  const firstPrice = windowPrices[0].price;
  const lastPrice = windowPrices[windowPrices.length - 1].price;
  const prices = windowPrices.map(p => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // Displacement: same unit as settlement distance (|end-start|/start %)
  const displacement = Math.abs(lastPrice - firstPrice) / firstPrice * 100;
  // Range: captures vol even during round-trips
  const range = (maxPrice - minPrice) / firstPrice * 100;
  // Average of both for robustness
  const volatility = (displacement + range) / 2;

  // Get token-specific volatility thresholds from learned data
  const tokenData = learnedParams.byToken[token];
  const avgVol = tokenData?.avgSettlementDistance || DEFAULT_EMPIRICAL_TABLES.byToken[token]?.avgSettlementDistance || 0.3;

  console.log(` Vol regime: ${token} disp=${displacement.toFixed(4)}% range=${range.toFixed(4)}% vol=${volatility.toFixed(4)}% vs avg=${avgVol.toFixed(4)}% → ${volatility < avgVol * 0.7 ? 'low' : volatility > avgVol * 1.5 ? 'high' : 'medium'}`);

  // Classify regime based on current vs historical volatility
  if (volatility < avgVol * 0.7) {
    return {
      regime: 'low',
      reason: `Low vol (${volatility.toFixed(3)}% vs avg ${avgVol.toFixed(3)}%)`,
      multiplier: 1.15,
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
    'low': 10, // Calm market = safer to bet
    'medium': 0, // Normal conditions
    'high': -10, // Volatile = riskier
    'spike': -15 // Don't bet
  };
  score += regimePoints[regime] || 0;

  // Time sweet spot contribution: 0-8 points
  // Optimal: 2-5 minutes (enough data, high certainty near expiry)
  let timePoints = 0;
  if (timeRemaining >= 2 && timeRemaining <= 5) {
    timePoints = 8; // Near expiry with data = highest certainty
  } else if (timeRemaining > 5 && timeRemaining <= 10) {
    timePoints = 5; // Good data, reasonable time horizon
  } else if (timeRemaining > 10 && timeRemaining <= 13) {
    timePoints = 2; // Data still accumulating
  } else if (timeRemaining > 13) {
    timePoints = 0; // Too early, limited data
  } else {
    timePoints = 3; // <2 min: very late but confirmed positions still valuable
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
/**
 * Check if current time is off-peak hours (07:00-13:00 UTC)
 * During off-peak, the bot trades cautiously instead of sitting out.
 */
function isOffPeakHours() {
  const utcHour = new Date().getUTCHours();
  return utcHour >= 7 && utcHour < 13;
}

function shouldSitOut(tables, token = null) {
  const reasons = [];

  // Check if we have sufficient data
  if ((tables?.sampleSize || learnedParams.sampleSize) < 100) {
    reasons.push('Insufficient historical data for empirical betting');
  }

  // Fix 5: Liquidity drought — too many unfilled orders recently
  const recentUnfills = [...unfilledCooldowns.values()]
    .filter(cd => Date.now() - cd.timestamp < 5 * 60 * 1000);
  if (recentUnfills.length >= 4) {
    reasons.push(`${recentUnfills.length} unfilled orders in 5min - liquidity drought`);
  }

  // Fix 5: Rate limit pressure
  if (Date.now() - last429ResetTime > 5 * 60 * 1000) {
    recent429Count = 0;
    last429ResetTime = Date.now();
  }
  if (recent429Count > 5) {
    reasons.push(`${recent429Count} rate-limit errors - backing off`);
  }

  // Economic calendar — sit out during FOMC, CPI, NFP
  const activeEvent = getActiveEconomicEvent();
  if (activeEvent) {
    reasons.push(`Economic event: ${activeEvent.name} (sit out ${activeEvent.sitOutMinutes}min window)`);
  }

  // maxBetsPerHour — prevent overtrading in choppy markets
  const maxPerHour = config?.selectivityRules?.maxBetsPerHour ?? 15;
  const oneHourAgo = Date.now() - 3600000;
  const recentBetCount = (performanceData.bets || []).filter(b => {
    const ts = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ts > oneHourAgo;
  }).length;
  if (recentBetCount >= maxPerHour) {
    reasons.push(`${recentBetCount} bets in last hour (max ${maxPerHour})`);
  }

  // Off-peak hours: 07:00-13:00 UTC (2AM-8AM EST)
  // Instead of sitting out, we trade cautiously with tighter thresholds (Polymarket-style).
  // The off-peak flag is checked downstream in evaluateOpportunityEmpirical() and bet sizing.
  // Reduced maxBetsPerHour during off-peak to limit exposure in thin books.
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 7 && utcHour < 13) {
    const offPeakMaxPerHour = Math.min(8, Math.floor(maxPerHour * 0.5));
    if (recentBetCount >= offPeakMaxPerHour) {
      reasons.push(`Off-peak rate cap: ${recentBetCount} bets in last hour (max ${offPeakMaxPerHour} during 07-13 UTC)`);
    }
  }

  return {
    sitOut: reasons.length > 0,
    reasons
  };
}

/**
 * Look up empirical win rate for a given distance from strike
 * Uses REALISTIC probabilities based on distance, not the misleading favoredWinRate
 *
 * The favoredWinRate (99.96%) was causing massive overconfidence because:
 * - It measures "if favored, how often does favored win" which is nearly always
 * - But the market already prices this in
 * - Real edge requires knowing something the market doesn't
 *
 * This function now uses distance-based probability that accounts for:
 * - Crypto volatility (prices can move 1-2% in minutes)
 * - Market efficiency (prices reflect collective wisdom)
 * - Historical settlement patterns
 *
 * @param {number} pctFromStrike - Absolute percentage distance from strike
 * @param {string} token - Optional token for token-specific adjustments
 * @returns {object} { winRate: number, sampleSize: number, bucket: number }
 */
function lookupEmpiricalWinRate(pctFromStrike, token = null) {
  const absDistance = Math.abs(pctFromStrike);

  // Prefer per-token distance tables (SOL at 0.3% ≠ BTC at 0.3%)
  // Fall back to global tables if token-specific data is insufficient
  const tokenDistData = token && learnedParams.byToken?.[token]?.winRateByDistance;
  const tokenBucketCount = tokenDistData ? Object.keys(tokenDistData).length : 0;
  const useTokenTables = tokenBucketCount >= 5; // Need at least 5 populated buckets
  const winRateData = useTokenTables ? tokenDistData : (learnedParams.winRateByDistance || DEFAULT_EMPIRICAL_TABLES.winRateByDistance);
  // Get sorted bucket keys from learned data
  const buckets = Object.keys(winRateData).map(Number).sort((a, b) => a - b);

  // Find the enclosing buckets for interpolation
  let lowerBucket = null, upperBucket = null;
  let lowerData = null, upperData = null;

  for (let i = 0; i < buckets.length; i++) {
    if (absDistance <= buckets[i]) {
      upperBucket = buckets[i];
      upperData = winRateData[upperBucket];
      if (i > 0) {
        lowerBucket = buckets[i - 1];
        lowerData = winRateData[lowerBucket];
      }
      break;
    }
  }

  // If beyond all buckets, use the largest
  if (!upperBucket) {
    upperBucket = buckets[buckets.length - 1];
    upperData = winRateData[upperBucket];
    if (buckets.length > 1) {
      lowerBucket = buckets[buckets.length - 2];
      lowerData = winRateData[lowerBucket];
    }
  }

  const sampleSize = upperData?.count || 0;
  const bucket = upperBucket;

  // USE LEARNED DATA: Interpolate between learned buckets when sufficient data exists
  // This replaces the hardcoded curve and actually uses the empirical tables we built
  let winRate;
  const MIN_SAMPLES_FOR_LEARNED = 20; // Need enough data to trust the bucket

  if (upperData && upperData.count >= MIN_SAMPLES_FOR_LEARNED && upperData.favoredWinRate) {
    if (lowerData && lowerData.count >= MIN_SAMPLES_FOR_LEARNED && lowerData.favoredWinRate && lowerBucket !== null) {
      // Interpolate between the two enclosing buckets
      const range = upperBucket - lowerBucket;
      const t = range > 0 ? (absDistance - lowerBucket) / range : 0;
      winRate = lowerData.favoredWinRate + t * (upperData.favoredWinRate - lowerData.favoredWinRate);
    } else {
      // Only upper bucket available (distance below smallest bucket)
      // Scale down from the bucket's win rate toward 50% as distance approaches 0
      const t = upperBucket > 0 ? absDistance / upperBucket : 0;
      winRate = 50 + t * (upperData.favoredWinRate - 50);
    }
  } else {
    // FALLBACK: Hardcoded curve when learned data is insufficient
    if (absDistance <= 0.1) {
      winRate = 55 + (absDistance * 70); // 55-62%
    } else if (absDistance <= 0.2) {
      winRate = 62 + ((absDistance - 0.1) * 60); // 62-68%
    } else if (absDistance <= 0.3) {
      winRate = 68 + ((absDistance - 0.2) * 50); // 68-73%
    } else if (absDistance <= 0.5) {
      winRate = 73 + ((absDistance - 0.3) * 25); // 73-78%
    } else if (absDistance <= 0.75) {
      winRate = 78 + ((absDistance - 0.5) * 16); // 78-82%
    } else if (absDistance <= 1.0) {
      winRate = 82 + ((absDistance - 0.75) * 16); // 82-86%
    } else if (absDistance <= 1.5) {
      winRate = 86 + ((absDistance - 1.0) * 6); // 86-89%
    } else if (absDistance <= 2.0) {
      winRate = 89 + ((absDistance - 1.5) * 4); // 89-91%
    } else {
      winRate = Math.min(95, 91 + ((absDistance - 2.0) * 1.3));
    }
  }

  // Cap at 95% - never assume certainty regardless of source
  winRate = Math.min(95, winRate);

  return {
    winRate,
    sampleSize,
    bucket,
    surpriseRate: 100 - winRate,
    usedLearnedData: !!(upperData && upperData.count >= MIN_SAMPLES_FOR_LEARNED),
    usedTokenTables: useTokenTables
  };
}

/**
 * Performance-based win rate calibration: compare predicted vs actual outcomes
 * to correct overconfident/underconfident predictions using real bet results.
 * @param {number} predictedProb - Predicted win probability (0-100)
 * @param {string} token - Token (BTC, ETH, SOL, XRP)
 * @returns {number} Calibration adjustment (negative = was overconfident)
 */
function getCalibrationAdjustment(predictedProb, token) {
  const settled = performanceData.bets.filter(b =>
    b.outcome !== 'pending' && b.token === token
  );
  if (settled.length < 20) return 0; // Not enough data

  // Group by predicted probability bucket (10% buckets)
  const bucketSize = 10;
  const bucketMin = Math.floor(predictedProb / bucketSize) * bucketSize;
  const bucketMax = bucketMin + bucketSize;
  const inBucket = settled.filter(b =>
    b.predictedProb >= bucketMin && b.predictedProb < bucketMax
  );
  if (inBucket.length < 5) return 0; // Not enough in this bucket

  const actualWinRate = inBucket.filter(b => b.outcome === 'won').length / inBucket.length * 100;
  const avgPredicted = inBucket.reduce((s, b) => s + b.predictedProb, 0) / inBucket.length;

  // How much were we off? Negative = we were overconfident
  const calibrationError = actualWinRate - avgPredicted;

  // Apply 50% of the correction (conservative — don't overcorrect)
  return calibrationError * 0.5;
}

/**
 * Cross-token correlation signal: detect when a leader token moves but a follower hasn't repriced
 * BTC leads, ETH/SOL/XRP follow with 30-120 second lag
 * @param {string} token - The follower token being evaluated
 * @returns {object} { hasCorrelationSignal, leaderToken, leaderMove, expectedFollowerMove, actualFollowerMove, signalBoost }
 */
function getCorrelationSignal(token) {
  const noSignal = { hasCorrelationSignal: false, leaderToken: null, leaderMove: 0, expectedFollowerMove: 0, actualFollowerMove: 0, signalBoost: 0 };
  const corrPairs = learnedParams.correlationPairs || DEFAULT_EMPIRICAL_TABLES.correlationPairs || {};

  // Check each potential leader
  for (const leader of ['BTC', 'ETH']) {
    if (leader === token) continue; // can't be your own leader
    const pairStrength = corrPairs[leader]?.[token];
    if (!pairStrength) continue;

    const leaderData = cryptoPrices[leader];
    const followerData = cryptoPrices[token];
    if (!leaderData || !followerData || leaderData.price <= 0 || followerData.price <= 0) continue;

    // Get leader's price change over last 2 minutes
    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    const leaderHistory = leaderData.history || [];
    let leaderOldPrice = null;
    for (let i = leaderHistory.length - 1; i >= 0; i--) {
      const entry = leaderHistory[i];
      if (entry && entry.time <= twoMinAgo) {
        leaderOldPrice = entry.price;
        break;
      }
    }
    if (!leaderOldPrice) continue;

    const leaderMove = (leaderData.price - leaderOldPrice) / leaderOldPrice;
    if (Math.abs(leaderMove) < 0.003) continue; // Leader must move >0.3% in 2 min

    // Check follower's actual move over same period
    let followerOldPrice = null;
    const followerHistory = followerData.history || [];
    for (let i = followerHistory.length - 1; i >= 0; i--) {
      const entry = followerHistory[i];
      if (entry && entry.time <= twoMinAgo) {
        followerOldPrice = entry.price;
        break;
      }
    }
    if (!followerOldPrice) continue;

    const actualFollowerMove = (followerData.price - followerOldPrice) / followerOldPrice;
    const expectedFollowerMove = leaderMove * pairStrength;

    // Signal: follower has moved less than half of expected → lagging, contract mispriced
    if (Math.abs(actualFollowerMove) < Math.abs(expectedFollowerMove) * 0.5) {
      // Signal boost: 5-12 points based on magnitude and correlation strength
      const moveMagnitude = Math.min(1, Math.abs(leaderMove) / 0.01); // 0-1 scale (1% = max)
      const lagRatio = 1 - (Math.abs(actualFollowerMove) / Math.max(0.0001, Math.abs(expectedFollowerMove)));
      const signalBoost = Math.round(5 + 7 * moveMagnitude * pairStrength * lagRatio);
      const clampedBoost = Math.min(12, Math.max(5, signalBoost));

      return {
        hasCorrelationSignal: true,
        leaderToken: leader,
        leaderMove,
        expectedFollowerMove,
        actualFollowerMove,
        signalBoost: clampedBoost
      };
    }
  }

  return noSignal;
}

/**
 * Evaluate a market opportunity using pure empirical data
 * @param {object} parsed - Parsed market data
 * @param {object} currentPrice - Current crypto price
 * @param {object} tables - Empirical lookup tables
 * @param {object} orderbook - Orderbook data (optional)
 * @param {object} userConfig - User config with selectivity rules (optional)
 * @returns {object} { shouldBet, signalStrength, side, edge, winRate, reasons }
 */
function evaluateOpportunityEmpirical(parsed, currentPrice, tables = null, orderbook = null, userConfig = null, momentumData = null) {
  const empiricalTables = tables || learnedParams;
  // Merge user's selectivity rules with defaults (user settings take precedence)
  const userRules = userConfig?.selectivityRules || {};
  const token = parsed.cryptoType;
  const strikePrice = parsed.strikePrice;
  const ticker = parsed.ticker || '';
  const timeRemaining = parsed.timeRemainingMinutes || 15;

  // Helper: all early exits must include UI display fields so the dashboard never shows "undefined @ NaN"
  function earlyExit(reason) {
    return {
      shouldBet: false, reasons: [reason],
      isRecommended: false, isLocked: true,
      betSide: '--', side: '--', betPrice: 0, betPriceCents: 0,
      marketPrice: 0, marketPriceCents: 0,
      filterReason: reason, filterReasons: [reason],
      signalStrength: 0, edge: 0, winRate: 0, winProbability: '0',
      token, timeRemaining, currentPrice,
      assetType: token,
      timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining)
    };
  }

  // Basic validation
  if (!token || !strikePrice || !currentPrice) {
    return earlyExit('Missing required data');
  }

  // Price staleness gate — stale prices lead to incorrect distance calculations
  const priceAge = Date.now() - (cryptoPrices[token]?.timestamp || 0);
  if (priceAge > 60000) {
    return earlyExit(`Stale price (${Math.round(priceAge / 1000)}s old)`);
  }

  // Reject non-directional markets (between/range) — we can only model above/below
  if (!parsed.marketType || parsed.marketType === 'between') {
    return earlyExit(`Unsupported market type: ${parsed.marketType || 'unknown'}`);
  }

  // Filter phantom markets: no real orders on one side
  if (!parsed.yesAsk || parsed.yesAsk <= 0.01 || !parsed.noAsk || parsed.noAsk <= 0.01) {
    return earlyExit('No real orders (phantom market)');
  }

  // Minimum orderbook depth gate — prevent orders into completely empty books
  if (orderbook) {
    const totalDepth = (orderbook.yesTotalDepth || 0) + (orderbook.noTotalDepth || 0);
    if (totalDepth < 1) {
      return earlyExit(`Empty orderbook: 0 contracts`);
    }
  }

  // Calculate distance from strike
  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice) * 100;
  const absDistance = Math.abs(pctFromStrike);

  // SANITY CHECK: For 15-minute markets, distance > 5% is impossible (BTC would need to move ~$3400).
  // This catches bad floor_strike values from Kalshi API (e.g. $15 range floor instead of actual strike).
  if (absDistance > 5) {
    return earlyExit(`Bad strike price: $${strikePrice.toFixed(2)} vs current $${currentPrice.toFixed(2)} (${absDistance.toFixed(1)}% distance)`);
  }

  // Detect volatility regime
  const regime = detectVolatilityRegime(token);

  // Check for sit-out conditions
  if (regime.sitOut) {
    return { ...earlyExit(`Volatility spike: ${regime.reason}`), regime: regime.regime };
  }

  // Look up empirical win rate
  const lookupDistance = absDistance;
  const empirical = lookupEmpiricalWinRate(lookupDistance, token);

  // Get token-specific optimal entry windows
  const tokenData = empiricalTables.byToken?.[token] || DEFAULT_EMPIRICAL_TABLES.byToken[token];
  const entryWindows = tokenData?.optimalEntryWindows || {};

  // Check if within optimal entry window
  const withinDistanceWindow = absDistance >= (entryWindows.distanceMin || 0.5) &&
                               absDistance <= (entryWindows.distanceMax || 3.0);
  const scaledTimeMin = entryWindows.timeMin || 2;
  const scaledTimeMax = entryWindows.timeMax || 10;
  const withinTimeWindow = timeRemaining >= scaledTimeMin &&
                           timeRemaining <= scaledTimeMax;

  // Determine bet side: evaluate BOTH sides and pick the one with better edge
  const isAboveStrike = currentPrice > strikePrice;
  let favoredSide, unfavoredSide, favoredPrice, unfavoredPrice;

  if (parsed.marketType === 'above') {
    // YES wins if price >= strike at expiry
    if (isAboveStrike) {
      favoredSide = 'YES'; unfavoredSide = 'NO';
      favoredPrice = parsed.yesAsk || 0.5; unfavoredPrice = parsed.noAsk || 0.5;
    } else {
      favoredSide = 'NO'; unfavoredSide = 'YES';
      favoredPrice = parsed.noAsk || 0.5; unfavoredPrice = parsed.yesAsk || 0.5;
    }
  } else {
    // Below market: YES wins if price < strike
    if (isAboveStrike) {
      favoredSide = 'NO'; unfavoredSide = 'YES';
      favoredPrice = parsed.noAsk || 0.5; unfavoredPrice = parsed.yesAsk || 0.5;
    } else {
      favoredSide = 'YES'; unfavoredSide = 'NO';
      favoredPrice = parsed.yesAsk || 0.5; unfavoredPrice = parsed.noAsk || 0.5;
    }
  }

  // Compute gross edge for both sides, adjusted for YES/NO bias
  // SOL has 4.44% NO bias (NO wins more often), so shift edge toward NO
  const noBias = learnedParams.byToken?.[token]?.noBias || 0;
  const biasAdj = (noBias > 0 && learnedParams.byToken?.[token]?.sampleSize >= 100) ? noBias / 2 : 0;
  let favoredWinRate = empirical.winRate;
  let unfavoredWinRate = 100 - empirical.winRate;
  if (biasAdj > 0) {
    if (favoredSide === 'YES') {
      // YES is favored but historically underperforms — penalize YES edge, boost NO
      favoredWinRate -= biasAdj;
      unfavoredWinRate += biasAdj;
    } else {
      // NO is favored AND has historical advantage — boost NO edge
      favoredWinRate += biasAdj;
      unfavoredWinRate -= biasAdj;
    }
    console.log(` NO-bias adj: ${token} bias=${noBias.toFixed(1)}% adj=±${biasAdj.toFixed(1)}% → favored(${favoredSide})=${favoredWinRate.toFixed(1)}% unfavored=${unfavoredWinRate.toFixed(1)}%`);
  }
  const favoredGrossEdge = favoredWinRate - (favoredPrice * 100);
  const unfavoredGrossEdge = unfavoredWinRate - (unfavoredPrice * 100);

  // Pick the side with higher positive gross edge
  // Guard rail: skip unfavored if ask price is too low (high risk underdog bet)
  let betSide, marketPrice, isFavoredSideBet;
  const unfavoredMinPrice = 0.35; // 35c floor: below this you're a <35% underdog, too risky
  const unfavoredViable = unfavoredPrice >= unfavoredMinPrice && unfavoredGrossEdge > favoredGrossEdge && unfavoredGrossEdge > 0;
  if (unfavoredViable) {
    betSide = unfavoredSide;
    marketPrice = unfavoredPrice;
    isFavoredSideBet = false;
    console.log(` Dual-side: unfavored ${betSide} edge ${unfavoredGrossEdge.toFixed(1)}% > favored ${favoredSide} edge ${favoredGrossEdge.toFixed(1)}%`);
  } else {
    betSide = favoredSide;
    marketPrice = favoredPrice;
    isFavoredSideBet = true;
  }

  const marketPriceCents = Math.round(marketPrice * 100);

  // DEBUG: Log price values to trace mismatch
  const obDepth = orderbook ? `depth=${(orderbook.yesTotalDepth||0)+(orderbook.noTotalDepth||0)} (Y:${orderbook.yesTotalDepth||0} N:${orderbook.noTotalDepth||0})` : 'no-ob';
  console.log(` ${token} prices: yesAsk=${(parsed.yesAsk*100).toFixed(0)}c noAsk=${(parsed.noAsk*100).toFixed(0)}c | betSide=${betSide}${isFavoredSideBet ? '' : ' (unfavored)'} | marketPrice=${marketPriceCents}c | ${obDepth}`);

  // Check price window - allow up to 97c for high-confidence near-expiry bets
  const withinPriceWindow = marketPriceCents >= (entryWindows.priceMin || 40) &&
                            marketPriceCents <= (entryWindows.priceMax || 95);

  // STALE MOMENTUM: Flag for soft penalty instead of hard block
  // Markets >90c with >5min left are likely priced in, but edge calc handles this naturally
  const staleMomentumThreshold = 5; // 5min
  const isStaleMomentum = marketPriceCents > 90 && timeRemaining > staleMomentumThreshold;

  // EDGE CALCULATION: Use distance-based empirical win rate vs market implied probability
  // Our win rate comes from how often the favored side wins at this distance from strike
  // Market price reflects what others are willing to pay - our edge is when we have better data

  const marketImpliedProb = marketPrice * 100; // Market price as probability (e.g., 80c = 80%)

  // Use bias-adjusted win rates (accounts for YES/NO settlement bias per token)
  // favoredWinRate and unfavoredWinRate already incorporate NO-bias from lines above
  let adjustedWinRate = isFavoredSideBet ? favoredWinRate : unfavoredWinRate;

  // VOLATILITY-TIME THEORETICAL MODEL: z-score-based probability from price history
  // During low-vol hours, empirical tables underestimate probability because they average all conditions
  // The theoretical model uses current volatility to compute a more accurate probability
  let theoreticalWinRate = null;
  let theoreticalWeight = 0;
  const priceHistory = cryptoPrices[token]?.history || [];
  if (priceHistory.length >= 10) {
    // Compute log-return std dev (NO floor we want raw volatility for accurate z-score)
    const histArr = [...priceHistory]; // spread ring buffer to array
    const logReturns = [];
    for (let i = 1; i < histArr.length; i++) {
      if (histArr[i].price && histArr[i-1].price) {
        logReturns.push(Math.log(histArr[i].price / histArr[i-1].price));
      }
    }
    if (logReturns.length >= 5) {
      const meanRet = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - meanRet, 2), 0) / logReturns.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) {
        // No price movement theoretical model has no information, skip it
        // (theoreticalWeight stays 0, no blending applied)
      } else {
        // Scale to remaining time
        const avgInterval = (histArr[histArr.length - 1].time - histArr[0].time) / (histArr.length - 1);
        const ticksInRemaining = (timeRemaining * 60 * 1000) / avgInterval;
        const volRemaining = stdDev * Math.sqrt(Math.max(1, ticksInRemaining));

        // Z-score: how many std devs is the distance from strike?
        const zScore = (absDistance / 100) / Math.max(volRemaining, 1e-10);
        theoreticalWinRate = Math.min(98, normalCDF(zScore) * 100);
        // Invert theoretical for unfavored side
        if (!isFavoredSideBet) {
          theoreticalWinRate = 100 - theoreticalWinRate;
        }

        // Determine blend weight based on vol regime
        const tokenData = learnedParams.byToken?.[token];
        const typicalVol = tokenData?.avgSettlementDistance || DEFAULT_EMPIRICAL_TABLES.byToken[token]?.avgSettlementDistance || 0.3;
        const currentVol = (regime.volatility !== undefined) ? regime.volatility : (stdDev * 100);
        const volRatio = currentVol / Math.max(typicalVol, 0.01);

        // Time bonus: near expiry, theoretical model is more reliable
        const timeBonusThreshold = 5; // 5min
        const timeBonus = timeRemaining < timeBonusThreshold ? Math.max(0, (timeBonusThreshold - timeRemaining) / timeBonusThreshold) : 0;

        if (volRatio < 0.15) {
          // Ultra-low vol (< 15% of avg): z-score model is extremely reliable
          // Price is barely moving, distance from strike is very predictive
          theoreticalWeight = 0.65 + timeBonus * 0.20;
        } else if (volRatio < 0.5) {
          // Very low vol: 50% base + up to 20% near expiry
          theoreticalWeight = 0.50 + timeBonus * 0.20;
        } else if (volRatio < 0.8) {
          // Low vol: 20% base + up to 15% near expiry
          theoreticalWeight = 0.20 + timeBonus * 0.15;
        } else if (volRatio < 1.3) {
          // Normal vol: 0-10% (near expiry only)
          theoreticalWeight = timeBonus * 0.10;
        } else {
          // High vol: 0% (empirical tables are better)
          theoreticalWeight = 0;
        }

        // Cap theoretical model weight for unfavored bets (empirical data more reliable for long shots)
        if (!isFavoredSideBet) {
          theoreticalWeight = Math.min(theoreticalWeight, 0.25);
        }

        // Only blend when theoretical > empirical (boost confidence in calm conditions)
        if (theoreticalWeight > 0 && theoreticalWinRate > adjustedWinRate) {
          const blendedWinRate = adjustedWinRate * (1 - theoreticalWeight) + theoreticalWinRate * theoreticalWeight;
          console.log(` Vol-time model: theoretical=${theoreticalWinRate.toFixed(1)}% (weight=${(theoreticalWeight*100).toFixed(0)}%) | empirical=${adjustedWinRate.toFixed(1)}% blended=${blendedWinRate.toFixed(1)}% [volRatio=${volRatio.toFixed(2)}, z=${zScore.toFixed(2)}]`);
          adjustedWinRate = blendedWinRate;
        }
      }
    }
  }

  // Apply regime multiplier for BOTH directions
  // Skip if theoretical model already handled volatility (theoreticalWeight > 0 means vol was blended in)
  if (regime.multiplier && regime.multiplier !== 1 && theoreticalWeight === 0) {
    const empiricalEdge = adjustedWinRate - marketImpliedProb;
    if (regime.multiplier < 1) {
      // High vol: shrink edge toward market price
      adjustedWinRate = marketImpliedProb + (empiricalEdge * regime.multiplier);
    } else {
      // Low vol: modestly boost edge (cap at 5% boost)
      const boost = Math.min(5, empiricalEdge * (regime.multiplier - 1));
      adjustedWinRate = adjustedWinRate + boost;
    }
  }

  // ML MODEL BLENDING: Blend ML prediction with empirical win rate (max 30% weight)
  let mlPrediction = null;
  let mlWeight = 0;
  const mlModelState = getMLModel();
  if (mlModelState.trainedOn >= 200 && mlModelState.performance?.accuracy >= 0.55) {
    const priceHistory = cryptoPrices[token]?.history || [];
    const momentum = calculateMomentumMultiTimeframe(priceHistory);
    const spreadVal = orderbook ? (betSide === 'YES' ? orderbook.yesSpread : orderbook.noSpread) || 0 : 0;

    // Compute cross-token and advanced features for ML
    const btcHistory = cryptoPrices['BTC']?.history || [];
    const btcMom = token !== 'BTC' ? calculateMomentumMultiTimeframe(btcHistory) : { m1: 0 };
    // Volatility of volatility: std dev of recent vol readings (regime stability)
    const recentVols = (cryptoPrices[token]?.history || []).slice(-30)
      .map(h => h.price).filter(p => p > 0);
    let volOfVol = 0;
    if (recentVols.length >= 10) {
      const returns = recentVols.slice(1).map((p, i) => Math.abs(Math.log(p / recentVols[i])));
      const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
      volOfVol = Math.sqrt(returns.reduce((a, b) => a + (b - avgRet) ** 2, 0) / returns.length);
    }
    // Order imbalance from orderbook: (bidSize - askSize) / (bidSize + askSize)
    let orderImbalance = 0;
    if (orderbook) {
      const bidDepth = betSide === 'YES'
        ? (orderbook.yesTotalDepth || 0) : (orderbook.noTotalDepth || 0);
      const askDepth = betSide === 'YES'
        ? (orderbook.noTotalDepth || 0) : (orderbook.yesTotalDepth || 0);
      if (bidDepth + askDepth > 0) {
        orderImbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
      }
    }

    const buyPressure = getBuyPressure(token);
    const features = extractMLFeatures({
      absDistance,
      timeRemaining,
      token,
      side: betSide,
      momentum1m: (parseFloat(momentum.m1) || 0) * 100,
      momentum5m: (parseFloat(momentum.m5) || 0) * 100,
      volatility: cryptoPrices[token]?.volatility || 0.02,
      marketImpliedProb,
      spread: spreadVal,
      btcMomentum1m: (parseFloat(btcMom.m1) || 0) * 100,
      volOfVol,
      orderImbalance,
      buyPressure1m: buyPressure.pressure1m,
      buyPressure5m: buyPressure.pressure5m,
      fundingRate: getFundingRate(token),
      durationRatio: 1,
      buyPressure15m: buyPressure.pressure15m,
      buyPressure30m: buyPressure.pressure30m,
      trajectoryScore: 0,
      crossTimeframeSignal: 0,
    });

    mlPrediction = mlPredict(features);
    if (mlPrediction !== null && isFinite(mlPrediction) && mlPrediction > 0 && mlPrediction < 1) {
      // Scale ML weight by accuracy above baseline (55%)
      // At 55% accuracy: 0% weight, at 70% accuracy: 30% weight
      mlWeight = Math.min(0.30, Math.max(0, (mlModelState.performance.accuracy - 0.55) * 2));
      // ML predicts favored side win probability; invert for unfavored bets
      const mlWinRate = isFavoredSideBet ? mlPrediction * 100 : (1 - mlPrediction) * 100;
      const blendedWinRate = adjustedWinRate * (1 - mlWeight) + mlWinRate * mlWeight;
      console.log(` ML blend: ml=${mlWinRate.toFixed(1)}% (weight=${(mlWeight*100).toFixed(0)}%) blended=${blendedWinRate.toFixed(1)}% (was ${adjustedWinRate.toFixed(1)}%)`);
      adjustedWinRate = blendedWinRate;
    }
  }

  // PERFORMANCE CALIBRATION: adjust predicted win rate based on actual bet outcomes
  const calibrationAdj = getCalibrationAdjustment(adjustedWinRate, token);
  if (calibrationAdj !== 0) {
    adjustedWinRate += calibrationAdj;
    console.log(` Calibration: ${calibrationAdj > 0 ? '+' : ''}${calibrationAdj.toFixed(1)}% (actual vs predicted) → ${adjustedWinRate.toFixed(1)}%`);
  }

  // TIME-DECAY ADJUSTMENT: less time remaining = higher probability favored side holds
  // Only apply when theoretical model wasn't already blended in (prevents double time bonus)
  // The theoretical model already accounts for time via z-scores in low-vol regimes.
  const timeDecayThreshold = 5; // 5min
  if (theoreticalWeight === 0 && isFavoredSideBet && timeRemaining <= timeDecayThreshold && timeRemaining > 0 && adjustedWinRate < 93) {
    const gapTo95 = 95 - adjustedWinRate;
    const timeDecay = (timeDecayThreshold - timeRemaining) / timeDecayThreshold; // 0 at threshold, 1 at 0min
    // Scale boost by distance: farther from strike = stronger time-decay advantage
    const distanceScale = Math.min(1, absDistance / 0.5); // full effect at 0.5%+
    const timeBoost = gapTo95 * 0.08 * timeDecay * distanceScale;
    if (timeBoost > 0.5) {
      adjustedWinRate += timeBoost;
      console.log(` Time-decay boost: +${timeBoost.toFixed(1)}% (${timeRemaining.toFixed(1)}min left, ${absDistance.toFixed(2)}% dist) → ${adjustedWinRate.toFixed(1)}%`);
    }
  }

  // HARD CAP: win rate can never exceed 98% regardless of stacking adjustments
  if (adjustedWinRate > 98) {
    console.log(` Win rate capped: ${adjustedWinRate.toFixed(1)}% → 98%`);
    adjustedWinRate = 98;
  }

  // DYNAMIC FEE CALCULATION - Kalshi formula: ceil(0.07 * contracts * price * (1-price))
  // Maker mode: multiplier 1.75 instead of 7 (Kalshi charges ~75% less for resting orders)
  const makerModeConfig = userConfig?.makerMode || {};
  const useMakerFees = makerModeConfig.enabled !== false && timeRemaining >= (makerModeConfig.minTimeForMaker || 3);

  console.log(` Edge calc: win=${adjustedWinRate.toFixed(1)}% vs market=${marketImpliedProb.toFixed(0)}% @ distance=${absDistance.toFixed(2)}% | fees=${useMakerFees ? 'MAKER(1.75x)' : 'TAKER(7x)'} timeLeft=${timeRemaining.toFixed(1)}min`);
  const feeMultiplier = useMakerFees ? 1.75 : 7;
  const feePerContract = Math.min(2, Math.ceil(feeMultiplier * marketPrice * (1 - marketPrice))) / 100;
  const feePct = (feePerContract / marketPrice) * 100;

  // Add spread cost penalty if orderbook data available
  // BUG FIX: spread is in cents, convert to percentage of market price
  let spreadPenalty = 0;
  if (orderbook) {
    const spread = betSide === 'YES' ? orderbook.yesSpread : orderbook.noSpread;
    if (spread && spread > 0 && spread < 50) {
      spreadPenalty = (spread / 2) / marketPrice;
    }
  }

  // Account for fill slippage: maker orders rest at our price (0 slippage), taker pays crossing spread
  const offPeak = isOffPeakHours();
  let slippagePct = 0;
  if (!useMakerFees) {
    const baseSlippageCents = userRules.fillSlippageCents ?? 3;
    const offPeakSlippageBonus = offPeak ? 2 : 0;
    const slippageCents = regime.regime === 'low' ? Math.max(1, baseSlippageCents - 2) + offPeakSlippageBonus : baseSlippageCents + offPeakSlippageBonus;
    slippagePct = (slippageCents / (marketPrice * 100)) * 100;
  }
  // Maker fill uncertainty: 1% edge discount to compensate for lower fill probability
  const fillUncertaintyPenalty = useMakerFees ? 1.0 : 0;
  const grossEdge = adjustedWinRate - marketImpliedProb;
  const netEdge = grossEdge - feePct - spreadPenalty - slippagePct - fillUncertaintyPenalty;

  // Calculate signal strength
  const signalStrength = calculateSignalStrength(
    adjustedWinRate,
    netEdge,
    empirical.sampleSize,
    regime.regime,
    timeRemaining
  );

  // Get selectivity rules - code defaults are authoritative, user config overrides
  // learned_params.json selectivityRules are ignored (may have stale thresholds)
  const rules = { ...DEFAULT_EMPIRICAL_TABLES.selectivityRules, ...userRules };

  // Build rejection reasons - only hard rejections for genuine deal-breakers
  const reasons = [];

  if (isFavoredSideBet) {
    // Favored bets: standard win rate and edge thresholds
    // Off-peak: raise floor by +4% (only high-conviction bets in thin books)
    const baseMinWinRate = rules.minEmpiricalWinRate || 64;
    let effectiveMinWinRate = regime.regime === 'low'
      ? Math.max(60, baseMinWinRate - 4)
      : offPeak ? baseMinWinRate + 4
      : baseMinWinRate;

    // Strong edge override: high edge compensates for borderline win rate
    // Kelly sizes these bets small automatically, limiting downside
    const edgeOverrides = rules.edgeOverrideThresholds || [
      { minEdge: 15, minWinRate: 52 },
      { minEdge: 10, minWinRate: 55 },
    ];
    for (const ov of edgeOverrides) {
      if (netEdge >= ov.minEdge && effectiveMinWinRate > ov.minWinRate) {
        console.log(` EDGE OVERRIDE: edge=${netEdge.toFixed(1)}% >= ${ov.minEdge}% → winRate floor ${effectiveMinWinRate}% → ${ov.minWinRate}%`);
        effectiveMinWinRate = ov.minWinRate;
        break;
      }
    }

    if (adjustedWinRate < effectiveMinWinRate) {
      const suffix = regime.regime === 'low' ? ' (low-vol reduced)' : offPeak ? ' (off-peak raised)' : '';
      reasons.push(`Win rate ${adjustedWinRate.toFixed(1)}% < ${effectiveMinWinRate}%${suffix}`);
    }

    // In low vol, outcomes are more predictable - smaller edge is acceptable
    // With 6% base, low-vol reduces to 3% (allows more bets through in calm markets)
    // Off-peak: raise edge floor by +3% (compensate for wider spreads in thin books)
    const baseMinEdge = rules.minEdgeAfterFees || 6;
    // Favorite-longshot bias: scale edge requirement inversely with contract price
    // High-price contracts (70c+) have low fees + high win rates → base edge sufficient
    // Mid-range (30-50c) has highest fees → require extra edge. Longshots (<30c) need even more.
    const priceTierBonus = marketPriceCents >= 70 ? 0
      : marketPriceCents >= 50 ? 0
      : marketPriceCents >= 30 ? 3
      : 5;
    const effectiveMinEdge = regime.regime === 'low'
      ? Math.max(3.0, baseMinEdge + priceTierBonus - 3)
      : offPeak ? baseMinEdge + priceTierBonus + 3
      : baseMinEdge + priceTierBonus;
    if (netEdge < effectiveMinEdge) {
      const suffix = regime.regime === 'low' ? ' (low-vol reduced)' : offPeak ? ' (off-peak raised)' : '';
      const tierSuffix = priceTierBonus > 0 ? ` (+${priceTierBonus}% longshot)` : '';
      reasons.push(`Edge ${netEdge.toFixed(1)}% < ${effectiveMinEdge}%${suffix}${tierSuffix}`);
    }

    // Token-specific coin-flip penalty: SOL has 64% coin-flip rate at close distances
    // Skip in low-vol: tight distances are expected, theoretical model already adjusts
    // Use 1.5x threshold (not 2x) — SOL avg settlement 0.36%, 2x0.4=0.8% would block everything
    const coinFlipDist = getCoinFlipThreshold(token);
    if (regime.regime !== 'low' && absDistance < coinFlipDist * 1.5) {
      reasons.push(`Coin-flip territory: ${absDistance.toFixed(3)}% < ${(coinFlipDist * 1.5).toFixed(3)}% (1.5x ${token} threshold)`);
    }
  } else {
    // Unfavored bets at near-zero distance are coin flips — model has no signal
    const coinFlipDist = getCoinFlipThreshold(token);
    if (absDistance < coinFlipDist) {
      reasons.push(`Unfavored at coin-flip distance: ${absDistance.toFixed(3)}% < ${coinFlipDist}% threshold`);
    }

    // Unfavored bets: skip win rate filter (inherently <50%), require higher edge + cheap price
    const minUnfavoredEdge = rules.minUnfavoredEdge || 8;
    if (netEdge < minUnfavoredEdge) {
      reasons.push(`Unfavored edge ${netEdge.toFixed(1)}% < ${minUnfavoredEdge}%`);
    }
    if (marketPriceCents < 20) {
      reasons.push(`Unfavored price ${marketPriceCents}c < 20c min`);
    }
    if (marketPriceCents > 40) {
      reasons.push(`Unfavored price ${marketPriceCents}c > 40c max`);
    }
    const maxUnfavoredPerHour = rules.maxUnfavoredPerHour || 1; // Tightened from 2: limit long-shot exposure
    if (getRecentUnfavoredBetCount() >= maxUnfavoredPerHour) {
      reasons.push(`Unfavored frequency cap: ${getRecentUnfavoredBetCount()} >= ${maxUnfavoredPerHour}/hr`);
    }
  }

  // Hard block: no bets too early in the market (need price data to accumulate)
  // 15M: max 8min (or 12 in low vol). Strong signals get +2min extension.
  const baseMaxTime = regime.regime === 'low' ? 12 : 8;
  const strongSignalBypass = (signalStrength >= (rules.strongSignalMinSignal || 70)) &&
                             (netEdge >= (rules.strongSignalMinEdge || 6));
  const maxTimeRemaining = strongSignalBypass ? baseMaxTime + 2 : baseMaxTime;
  if (timeRemaining > maxTimeRemaining) {
    reasons.push(`Too early: ${timeRemaining.toFixed(1)}min remaining > ${maxTimeRemaining.toFixed(0)}min max`);
  }
  if (strongSignalBypass && timeRemaining <= maxTimeRemaining && timeRemaining > baseMaxTime) {
    console.log(` STRONG SIGNAL BYPASS: ${timeRemaining.toFixed(1)}min > base ${baseMaxTime}min, signal=${signalStrength} edge=${netEdge.toFixed(1)}%`);
  }

  // Apply soft penalties for distance/time instead of hard rejections
  let adjustedSignalStrength = signalStrength;
  let windowPenalties = [];

  // Favorite-longshot bias: graduated price tiers based on academic evidence (300K+ Kalshi contracts)
  // Sweet spot: 60-85c contracts have systematic positive returns. Cheap longshots (<20c) lose 60%+
  if (marketPriceCents >= 60 && marketPriceCents <= 85) {
    adjustedSignalStrength += 3;
    windowPenalties.push(`price sweet-spot +3pts (${marketPriceCents}c in 60-85c zone)`);
  } else if (marketPriceCents >= 40 && marketPriceCents < 55) {
    adjustedSignalStrength += -3;
    windowPenalties.push(`price coin-flip -3pts (${marketPriceCents}c in 40-55c zone)`);
  } else if (marketPriceCents >= 20 && marketPriceCents < 40) {
    adjustedSignalStrength += -8;
    windowPenalties.push(`price longshot -8pts (${marketPriceCents}c in 20-40c zone)`);
  } else if (!withinPriceWindow) {
    const pricePenalty = marketPriceCents < (entryWindows.priceMin || 40) ? -10 : -8;
    adjustedSignalStrength += pricePenalty;
    windowPenalties.push(`price-window ${pricePenalty}pts (${marketPriceCents}c outside [${entryWindows.priceMin || 40}-${entryWindows.priceMax || 95}c])`);
  }

  if (!withinDistanceWindow) {
    const dMin = entryWindows.distanceMin || 0.1;
    const dMax = entryWindows.distanceMax || 5.0;
    const farOutside = absDistance < dMin * 0.5 || absDistance > dMax * 1.5;
    const basePenalty = farOutside ? -20 : -10;

    if (regime.regime === 'low') {
      // In low vol, scale penalty by how extreme the vol compression is
      // Ultra-low vol (< 10% of avg) = nearly zero penalty (distances SHOULD be tiny)
      // Moderate low vol (50-70% of avg) = half penalty
      const tokenAvgVol = (learnedParams.byToken?.[token]?.avgSettlementDistance ||
                           DEFAULT_EMPIRICAL_TABLES.byToken[token]?.avgSettlementDistance || 0.3);
      const currentVol = regime.volatility !== undefined ? regime.volatility : tokenAvgVol * 0.5;
      const volRatio = Math.min(1, currentVol / Math.max(tokenAvgVol, 0.01));
      // volRatio 0.0 = zero penalty, 0.5 = quarter penalty, 0.7 = half penalty
      const volScale = Math.min(1, volRatio * 1.5);
      const penalty = Math.round(basePenalty * volScale);
      adjustedSignalStrength += penalty;
      windowPenalties.push(`distance ${penalty}pts (low-vol scaled, volRatio=${volRatio.toFixed(2)})`);
    } else {
      adjustedSignalStrength += basePenalty;
      windowPenalties.push(`distance ${basePenalty}pts`);
    }
  }

  if (!withinTimeWindow) {
    if (timeRemaining < scaledTimeMin && netEdge > 3) {
      // Near expiry with confirmed edge = BONUS, not penalty
      const bonus = Math.min(10, Math.round(netEdge));
      adjustedSignalStrength += bonus;
      windowPenalties.push(`late-game confirmed +${bonus}pts`);
    } else {
      // Gradient time penalty based on how far outside the window we are
      const tMax = scaledTimeMax;
      let penalty;
      if (timeRemaining > tMax + 5) penalty = -20;
      else if (timeRemaining > tMax + 3) penalty = -15;
      else if (timeRemaining > tMax + 1) penalty = -10;
      else penalty = -5;

      // In low vol, prices are more stable — time matters less
      // Steeper reduction (0.3x) since hard block already widened to 12min
      if (regime.regime === 'low') {
        penalty = Math.round(penalty * 0.3); // 70% reduction in low vol
      }

      adjustedSignalStrength += penalty;
      windowPenalties.push(`time ${penalty}pts (${timeRemaining.toFixed(1)}min left)`);
    }
  }

  // Early-entry penalty: within time window but still far from optimal (>6min penalized)
  const earlyEntryThreshold = 6;
  if (withinTimeWindow && timeRemaining > earlyEntryThreshold) {
    const earlyScale = regime.regime === 'low' ? 2 : 4;
    const earlyPenalty = -Math.round(Math.min(12, (timeRemaining - earlyEntryThreshold) * earlyScale));
    adjustedSignalStrength += earlyPenalty;
    windowPenalties.push(`early-entry ${earlyPenalty}pts`);
  }

  // Stale momentum: soft penalty instead of hard block
  if (isStaleMomentum) {
    adjustedSignalStrength += -15;
    windowPenalties.push(`stale momentum -15pts`);
  }

  // SPREAD-WIDTH SIGNAL: tight spread = market makers agree (more reliable), wide = uncertainty
  // Spread is already used as a cost (spreadPenalty), but it's also information about confidence
  if (orderbook) {
    const spread = betSide === 'YES' ? orderbook.yesSpread : orderbook.noSpread;
    if (spread !== undefined && spread > 0) {
      // Only apply spread signal when we have real data (spread > 0, not missing)
      if (spread <= 2) {
        // Very tight spread: high agreement, boost confidence
        adjustedSignalStrength += 4;
        windowPenalties.push(`tight spread +4pts (${spread}c)`);
      } else if (spread <= 4) {
        // Normal spread: slight boost
        adjustedSignalStrength += 2;
        windowPenalties.push(`normal spread +2pts (${spread}c)`);
      } else if (spread >= 7) {
        // Wide spread: uncertainty, penalize
        adjustedSignalStrength += -5;
        windowPenalties.push(`wide spread -5pts (${spread}c)`);
      }
    }
  }

  // Fix 3: Soft signal penalty for low orderbook depth on our side
  if (orderbook) {
    const sideDepth = betSide === 'YES'
      ? (orderbook.yesTotalDepth || 0) : (orderbook.noTotalDepth || 0);
    if (sideDepth < 10) {
      const depthPenalty = sideDepth < 5 ? -8 : -4;
      adjustedSignalStrength += depthPenalty;
      windowPenalties.push(`low depth ${depthPenalty}pts (${sideDepth} contracts)`);
    }
  }

  // Funding rate contrarian signal
  // Positive funding = longs pay shorts (overcrowded longs → bearish bias → favor NO)
  // Negative funding = shorts pay longs (overcrowded shorts → bullish bias → favor YES)
  const fundRate = getFundingRate(token);
  if (Math.abs(fundRate) > 0.0005) {
    const contrarian = (fundRate > 0 && betSide === 'NO') || (fundRate < 0 && betSide === 'YES');
    const fundAdj = contrarian ? 3 : -3;
    adjustedSignalStrength += fundAdj;
    windowPenalties.push(`funding ${fundAdj > 0 ? '+' : ''}${fundAdj}pts (rate=${(fundRate * 100).toFixed(4)}%)`);
  }

  // NO bias: win rate adjustment already applied in edge calculation (lines ~6659-6674)
  // Removed duplicate signal strength adjustment here to prevent double-counting

  // YES SIDE PENALTY: Reduced from -15 to -5. The NO-bias win rate adjustment
  // (lines ~6750-6766) already reduces YES edge in the edge calculation.
  // -15 was double-counting and blocking ALL YES bets, leaving the bot unable to trade
  // when price is above strike (which is >50% of the time).
  if (betSide === 'YES') {
    const yesPenalty = -5;
    adjustedSignalStrength += yesPenalty;
    windowPenalties.push(`YES-side ${yesPenalty}pts (caution)`);
  }

  // Cross-token correlation: detect when a leader (BTC/ETH) moves but this token's contract hasn't repriced
  const corrSignal = getCorrelationSignal(token);
  if (corrSignal.hasCorrelationSignal) {
    // Verify the correlation direction matches our bet side
    const leaderDirection = corrSignal.leaderMove > 0 ? 'YES' : 'NO';
    if (betSide === leaderDirection) {
      adjustedSignalStrength += corrSignal.signalBoost;
      windowPenalties.push(`correlation +${corrSignal.signalBoost}pts (${corrSignal.leaderToken} ${corrSignal.leaderMove > 0 ? '+' : ''}${(corrSignal.leaderMove*100).toFixed(2)}%)`);
    }
  }

  // Same-side saturation: penalize one-sided streaks per token
  // Tokens with high NO bias (like SOL 4.44%) trigger at 2 consecutive YES bets
  const tokenNoBiasForSat = learnedParams.byToken?.[token]?.noBias || 0;
  const saturationThreshold = (betSide === 'YES' && tokenNoBiasForSat > 3) ? 2 : 3;
  const consecutiveSameSide = getConsecutiveSameSideCount(token, betSide);
  if (consecutiveSameSide >= saturationThreshold) {
    const saturationPenalty = -Math.min(12, 5 * (consecutiveSameSide - (saturationThreshold - 1)));
    adjustedSignalStrength += saturationPenalty;
    windowPenalties.push(`saturation ${saturationPenalty}pts (${consecutiveSameSide}x ${betSide})`);
  }

  if (windowPenalties.length > 0) {
    console.log(` Window penalties: ${windowPenalties.join(', ')} signal ${signalStrength}→${adjustedSignalStrength}`);
  }

  // Low vol = more predictable outcomes, modest signal reduction allowed
  // Off-peak: raise signal floor by +8 (only strong signals in thin books)
  const baseMinSignal = rules.minSignalStrength || 58;
  const effectiveMinSignal = regime.regime === 'low' ? Math.max(46, baseMinSignal - 12)
    : offPeak ? baseMinSignal + 8
    : baseMinSignal;

  // SOL: NO bias and saturation penalties already handle side selection naturally.
  // No extra signal floor or YES hard block — let the penalty system do its job.
  if (adjustedSignalStrength < effectiveMinSignal) {
    const suffix = regime.regime === 'low' ? ' (low-vol reduced)' : offPeak ? ' (off-peak raised)' : '';
    reasons.push(`Signal ${adjustedSignalStrength} < ${effectiveMinSignal}${suffix}${token === 'SOL' ? ' (SOL)' : ''}`);
  }

  // Final decision
  const shouldBet = reasons.length === 0 && adjustedSignalStrength >= effectiveMinSignal;

  // Fee in cents for display
  const feeCents = calculateKalshiFee(1, marketPrice);

  // Profit calculations (for $1 worth of contracts)
  const contractsFor1Dollar = marketPriceCents > 0 ? Math.floor(100 / marketPriceCents) : 0;
  const totalCostCents = contractsFor1Dollar * marketPriceCents;
  const payoutIfWinCents = contractsFor1Dollar * 100;
  const profitIfWinCents = payoutIfWinCents - totalCostCents - feeCents;
  const expectedProfitVal = (adjustedWinRate / 100) * profitIfWinCents - ((1 - adjustedWinRate / 100) * (totalCostCents + feeCents));
  const profitPotentialVal = totalCostCents > 0 ? (profitIfWinCents / totalCostCents) * 100 : 0;

  // probYesWins / probNoWins: needed by take-profit EV calc
  const probYesWins = betSide === 'YES' ? adjustedWinRate : (100 - adjustedWinRate);
  const probNoWins = 100 - probYesWins;

  return {
    shouldBet,
    signalStrength: adjustedSignalStrength,
    rawSignalStrength: signalStrength,
    side: betSide,
    edge: netEdge,
    grossEdge,
    winRate: adjustedWinRate,
    rawWinRate: empirical.winRate,
    marketImpliedProb,
    marketPrice,
    marketPriceCents,
    pctFromStrike: parseFloat(pctFromStrike.toFixed(2)),
    absDistance: parseFloat(absDistance.toFixed(2)),
    regime: regime.regime,
    regimeMultiplier: regime.multiplier,
    sampleSize: empirical.sampleSize,
    bucket: empirical.bucket,
    usedTokenTables: empirical.usedTokenTables || false,
    withinDistanceWindow,
    withinTimeWindow,
    withinPriceWindow,
    timeRemaining,
    token,
    isFavoredSideBet,
    reasons,
    // UI display aliases
    betSide,
    betPrice: marketPrice,
    betPriceCents: marketPriceCents,
    winProbability: adjustedWinRate.toFixed(1),
    isRecommended: shouldBet,
    filterReason: reasons.length > 0 ? reasons[0] : (shouldBet ? null : `Edge ${netEdge.toFixed(1)}%`),
    filterReasons: reasons,
    isObviousBet: adjustedWinRate >= 70,
    isHighProb: adjustedWinRate >= 60,
    isLocked: !shouldBet,
    probYesWins,
    probNoWins,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    confidence: adjustedWinRate.toFixed(0) + '%',
    dataPoints: empirical.sampleSize,
    correlationBoost: corrSignal.hasCorrelationSignal ? corrSignal.signalBoost : 0,
    analysisMethod: 'empirical_unified',
    assetType: token,
    currentPrice,
    profitIfWin: profitIfWinCents,
    expectedProfit: expectedProfitVal.toFixed(1),
    profitPotential: profitPotentialVal,
    contractsFor1Dollar,
    feeCents,
    recommendedBet: 100,
    momentum: momentumData?.direction || 'neutral',
    momentumStrength: momentumData?.strength || 0,
    spreadPenalty,
    orderbookData: orderbook ? {
      yesSpread: orderbook.yesSpread,
      noSpread: orderbook.noSpread,
      yesLiquidity: orderbook.yesLiquidityAtBest,
      noLiquidity: orderbook.noLiquidityAtBest
    } : null
  };
}

/**
 * Build comprehensive empirical lookup tables from settlement data
 * @param {Array} settlements - Array of settlement objects
 * @returns {object} Complete empirical tables
 */
function buildEmpiricalLookupTables(settlements) {
  if (!settlements || settlements.length < 100) {
    console.log(` Insufficient data for empirical tables: ${settlements?.length || 0} settlements`);
    return null;
  }

  console.log(` Building empirical tables from ${settlements.length} settlements...`);

  const tables = JSON.parse(JSON.stringify(DEFAULT_EMPIRICAL_TABLES));
  tables.sampleSize = settlements.length;
  tables.lastUpdated = new Date().toISOString();

  // Process settlements for distance analysis
  // IMPORTANT: Use bettingTimePct (price at betting time) if available, otherwise fall back to settlement distance
  // This addresses the model design flaw - we want to measure "at betting time, what was the distance?"
  const enrichedCount = settlements.filter(s => s.bettingTimePct !== undefined).length;
  if (enrichedCount > 0) {
    console.log(` Using betting-time data for ${enrichedCount}/${settlements.length} settlements`);
  }

  const distances = settlements.map(s => {
    // Prefer betting-time distance if available (from candlestick enrichment)
    // This is the "correct" way to measure - distance when betting, not at settlement
    const usesBettingTime = s.bettingTimePct !== undefined;
    let pctFromStrike = usesBettingTime
      ? Math.abs(s.bettingTimePct)
      : Math.abs((s.settlementPrice - s.strikePrice) / s.strikePrice * 100);



    // For determining "favored side", use betting-time direction if available
    const wasAboveStrike = usesBettingTime
      ? s.bettingTimePct > 0
      : s.settlementPrice > s.strikePrice;
    const wasBelowStrike = usesBettingTime
      ? s.bettingTimePct < 0
      : s.settlementPrice < s.strikePrice;

    return {
      pctFromStrike,
      result: s.result,
      token: s.token,
      wasAboveStrike,
      wasBelowStrike,
      closeTime: s.closeTime,
      usesBettingTime
    };
  });

  // Build win rate by distance buckets - per-bucket (non-cumulative) counting
  // Each bucket counts only samples in its range (prevBucket, currentBucket]
  const distanceBuckets = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0];
  // Caps raised for small distances: settlement-time data is biased (closer at settlement than
  // at betting time), but the old caps (62/68/73) were too low -- they made the learned tables
  // no better than the hardcoded fallback curve, negating the whole point of empirical learning.
  // New caps: allow data to speak more, especially at close distances where sample sizes are large.
  // The safety net is the 95% hard cap and the fee/slippage deduction in edge calculation.
  const distanceCaps = {
    0.1: 68, 0.2: 74, 0.3: 78, 0.5: 82, 0.75: 86, 1.0: 89, 1.5: 91, 2.0: 93, 3.0: 95, 5.0: 95
  };

  // Sort distances by pctFromStrike ascending
  distances.sort((a, b) => a.pctFromStrike - b.pctFromStrike);

  // Single pass with per-bucket (non-cumulative) counts
  let distIdx = 0;

  for (let bucketIdx = 0; bucketIdx < distanceBuckets.length; bucketIdx++) {
    const bucket = distanceBuckets[bucketIdx];
    const prevBucket = bucketIdx > 0 ? distanceBuckets[bucketIdx - 1] : 0;
    let bucketCount = 0;
    let bucketFavoredWins = 0;

    // Advance through sorted distances in range (prevBucket, bucket]
    while (distIdx < distances.length && distances[distIdx].pctFromStrike <= bucket) {
      const d = distances[distIdx];
      // Only count if in this bucket's range (above previous bucket threshold)
      if (d.pctFromStrike > prevBucket) {
        bucketCount++;
        const yesFavored = d.wasAboveStrike;
        const noFavored = d.wasBelowStrike;
        const yesWon = d.result === 'yes';
        const noWon = d.result === 'no';
        if ((yesFavored && yesWon) || (noFavored && noWon)) {
          bucketFavoredWins++;
        }
      }
      distIdx++;
    }

    if (bucketCount < 5) continue;

    const capForBucket = distanceCaps[bucket] || 91;
    const rawWinRate = (bucketFavoredWins / bucketCount * 100);
    const favoredWinRate = Math.min(capForBucket, rawWinRate);

    if (rawWinRate > capForBucket) {
      console.log(`[Learn] Distance ${bucket}%: raw ${rawWinRate.toFixed(1)}% capped to ${capForBucket}%`);
    }

    tables.winRateByDistance[bucket] = {
      count: bucketCount,
      favoredWinRate: parseFloat(favoredWinRate.toFixed(2)),
      surpriseRate: parseFloat((100 - favoredWinRate).toFixed(2))
    };
  }

  // Build token-specific stats
  const tokens = Object.keys(TRACKED_TOKENS);
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

    // Build per-token distance tables (token-specific win rates by distance bucket)
    // SOL at 0.3% behaves very differently from BTC at 0.3% due to volatility differences
    const tokenWinRateByDistance = {};
    const sortedTokenSettlements = [...tokenSettlements].sort((a, b) => a.pctFromStrike - b.pctFromStrike);
    let tokenDistIdx = 0;

    for (let bucketIdx = 0; bucketIdx < distanceBuckets.length; bucketIdx++) {
      const bucket = distanceBuckets[bucketIdx];
      const prevBucket = bucketIdx > 0 ? distanceBuckets[bucketIdx - 1] : 0;
      let bCount = 0, bFavoredWins = 0;

      while (tokenDistIdx < sortedTokenSettlements.length && sortedTokenSettlements[tokenDistIdx].pctFromStrike <= bucket) {
        const d = sortedTokenSettlements[tokenDistIdx];
        if (d.pctFromStrike > prevBucket) {
          bCount++;
          const yesFavored = d.wasAboveStrike;
          const noFavored = d.wasBelowStrike;
          const yesWon = d.result === 'yes';
          const noWon = d.result === 'no';
          if ((yesFavored && yesWon) || (noFavored && noWon)) bFavoredWins++;
        }
        tokenDistIdx++;
      }

      // Require 15+ samples per bucket for token-specific tables (smaller than global 5)
      if (bCount >= 15) {
        const capForBucket = distanceCaps[bucket] || 91;
        const rawRate = (bFavoredWins / bCount * 100);
        tokenWinRateByDistance[bucket] = {
          count: bCount,
          favoredWinRate: parseFloat(Math.min(capForBucket, rawRate).toFixed(2)),
          surpriseRate: parseFloat((100 - Math.min(capForBucket, rawRate)).toFixed(2))
        };
      }
    }

    tables.byToken[token] = {
      ...tables.byToken[token],
      sampleSize: tokenSettlements.length,
      avgSettlementDistance: parseFloat(avgDistance.toFixed(4)),
      settlementDistanceStdDev: parseFloat(stdDev.toFixed(4)),
      yesWinRate: parseFloat(yesWinRate.toFixed(2)),
      noWinRate: parseFloat(noWinRate.toFixed(2)),
      noBias: parseFloat((noWinRate - yesWinRate).toFixed(2)),
      winRateByDistance: tokenWinRateByDistance
    };

    const tokenBucketCount = Object.keys(tokenWinRateByDistance).length;
    if (tokenBucketCount > 0) {
      console.log(` ${token}: built ${tokenBucketCount} per-token distance buckets`);
    }

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

  console.log(` Built empirical tables:`);
  console.log(` Sample size: ${settlements.length}`);
  console.log(` Win rate buckets: ${Object.keys(tables.winRateByDistance).filter(k => tables.winRateByDistance[k].count > 0).length}`);
  console.log(` Min auto win rate: ${minWinRateForAuto}%`);
  for (const token of tokens) {
    const data = tables.byToken[token];
    console.log(` ${token}: ${data.sampleSize} samples, avg distance ${data.avgSettlementDistance?.toFixed(3)}%, NO bias ${data.noBias}%`);
  }

  return tables;
}

/**
 * Record a bet for rate limiting tracking
 * @param {string} token - Token that was bet on
 * @param {string} [side] - 'YES' or 'NO' for saturation tracking
 * @param {boolean} [isFavoredSideBet] - true if favored side, false if unfavored
 */
function recordEmpiricalBet(token, side, isFavoredSideBet = true) {
  const now = Date.now();
  const currentCount = empiricalBetTracking.betsByToken.get(token) || 0;
  empiricalBetTracking.betsByToken.set(token, currentCount + 1);

  // Track unfavored bets for frequency limiting
  if (!isFavoredSideBet) {
    empiricalBetTracking.recentUnfavoredBets.push({ timestamp: now });
    // Prune entries older than 1 hour
    const oneHourAgo = now - 60 * 60 * 1000;
    while (empiricalBetTracking.recentUnfavoredBets.length > 0 && empiricalBetTracking.recentUnfavoredBets[0].timestamp < oneHourAgo) {
      empiricalBetTracking.recentUnfavoredBets.shift();
    }
  }

  // Track bet side for saturation detection
  if (side) {
    if (!empiricalBetTracking.recentSidesByToken.has(token)) {
      empiricalBetTracking.recentSidesByToken.set(token, []);
    }
    const sides = empiricalBetTracking.recentSidesByToken.get(token);
    sides.push({ side, timestamp: now });
    // Keep only last 2 hours of side data
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    while (sides.length > 0 && sides[0].timestamp < twoHoursAgo) {
      sides.shift();
    }
  }

  // Reset token counts periodically
  if (Math.random() < 0.1) {
    // Reset token counts every hour
    for (const [t, count] of empiricalBetTracking.betsByToken) {
      if (count > 0) {
        empiricalBetTracking.betsByToken.set(t, Math.max(0, count - 1));
      }
    }
  }
}

/**
 * Count consecutive same-side bets from most recent backward
 * @param {string} token - Token to check
 * @param {string} side - 'YES' or 'NO'
 * @returns {number} Consecutive count of same-side bets
 */
function getConsecutiveSameSideCount(token, side) {
  const sides = empiricalBetTracking.recentSidesByToken.get(token);
  if (!sides || sides.length === 0) return 0;
  let count = 0;
  for (let i = sides.length - 1; i >= 0; i--) {
    if (sides[i].side === side) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Count unfavored bets placed in the last hour
 * @returns {number} Number of unfavored bets in last hour
 */
function getRecentUnfavoredBetCount() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  // Prune stale entries
  while (empiricalBetTracking.recentUnfavoredBets.length > 0 && empiricalBetTracking.recentUnfavoredBets[0].timestamp < oneHourAgo) {
    empiricalBetTracking.recentUnfavoredBets.shift();
  }
  return empiricalBetTracking.recentUnfavoredBets.length;
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
async function fetchBulkHistoricalData(token = 'all', maxPages = 1000, userConfig = null) {
  const cfg = userConfig || config;
  const tokens = token === 'all' ? Object.keys(TRACKED_TOKENS) : [token.toUpperCase()];
  const allSettlements = [];

  for (const t of tokens) {
    console.log(` Fetching ${t} historical data...`);
    let tokenSettlements = 0;

    // Fetch 15-minute settled markets
    for (const series of [`KX${t}15M`]) {
      let cursor = null;
      let page = 0;

      // IMPROVED: Use /markets endpoint directly with status=settled
      // This is 10x more efficient: 1000/page vs 100/page events + individual market fetches
      while (page < maxPages) {
        try {
          const url = cursor
            ? `/markets?limit=1000&series_ticker=${series}&status=settled&cursor=${cursor}`
            : `/markets?limit=1000&series_ticker=${series}&status=settled`;

          const response = await kalshiRequest('GET', url, null, cfg);

          if (response.markets && response.markets.length > 0) {
            for (const market of response.markets) {
              if (market.floor_strike !== undefined) {
                const settlementPrice = market.expiration_value !== undefined
                  ? parseFloat(market.expiration_value)
                  : null;

                const result = market.result || market.market_result;

                if (settlementPrice !== null && result) {
                  allSettlements.push({
                    ticker: market.ticker,
                    eventTicker: market.event_ticker,
                    token: t,
                    strikePrice: market.floor_strike,
                    settlementPrice: settlementPrice,
                    result: result,
                    closeTime: market.close_time,
                    settledTime: market.settlement_ts || market.settled_time,
                    volume: market.volume || 0,
                    marketType: '15min'
                  });
                  tokenSettlements++;
                }
              }
            }
          }

          cursor = response.cursor;
          page++;

          console.log(` ${series} page ${page}: ${tokenSettlements} ${t} settlements collected`);

          if (!cursor || !response.markets || response.markets.length === 0) break;
          await sleep(300); // Rate limit protection
        } catch (err) {
          console.error(` Error fetching page ${page} for ${series}:`, err.message);
          if (err.message.includes('429')) {
            console.log(` Rate limited, waiting 5s...`);
            await sleep(5000);
            continue;
          }
          break;
        }
      }
    }

    console.log(` ${t}: ${tokenSettlements} settlements collected`);
  }

  console.log(` Total settlements collected: ${allSettlements.length}`);
  return allSettlements;
}

// Legacy function kept for backwards compatibility - redirects to new implementation
async function fetchBulkHistoricalDataLegacy(token = 'all', maxPages = 1000, userConfig = null) {
  const cfg = userConfig || config;
  const tokens = token === 'all' ? Object.keys(TRACKED_TOKENS) : [token.toUpperCase()];
  const allSettlements = [];

  for (const t of tokens) {
    console.log(` [Legacy] Fetching ${t} historical data via events...`);
    const series = `KX${t}15M`;
    const allEvents = [];
    let cursor = null;
    let page = 0;

    while (page < maxPages) {
      try {
        const url = cursor
          ? `/events?limit=200&series_ticker=${series}&status=settled&cursor=${cursor}`
          : `/events?limit=200&series_ticker=${series}&status=settled`;

        const response = await kalshiRequest('GET', url, null, cfg);

        if (response.events && response.events.length > 0) {
          allEvents.push(...response.events);
        }

        cursor = response.cursor;
        page++;

        console.log(` Page ${page}: ${allEvents.length} events total`);

        if (!cursor || !response.events || response.events.length === 0) break;
        await sleep(500);
      } catch (err) {
        console.error(` Error fetching page ${page} for ${t}:`, err.message);
        break;
      }
    }

    console.log(` Fetching market details for ${allEvents.length} ${t} events...`);

    const BATCH_SIZE = 3;
    let processedCount = 0;
    let consecutiveErrors = 0;

    for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
      const batch = allEvents.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(event =>
          kalshiRequest('GET', `/markets?event_ticker=${event.event_ticker}`, null, cfg)
            .then(data => ({ event, market: data.markets?.[0] }))
        )
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.market) {
          const { event, market } = result.value;
          if (market.floor_strike && market.expiration_value !== undefined) {
            allSettlements.push({
              ticker: market.ticker,
              eventTicker: event.event_ticker,
              token: t,
              strikePrice: market.floor_strike,
              settlementPrice: parseFloat(market.expiration_value),
              result: market.result,
              closeTime: market.close_time,
              volume: market.volume || 0
            });
          }
          consecutiveErrors = 0;
        } else if (result.status === 'rejected') {
          const err = result.reason;
          if (err?.message?.includes('429')) {
            consecutiveErrors++;
          }
        }
        processedCount++;
      }

      if (processedCount % 100 < BATCH_SIZE) {
        console.log(` Processed ${processedCount}/${allEvents.length} ${t} markets...`);
      }

      const baseDelay = consecutiveErrors > 0
        ? Math.min(5000, 500 * Math.pow(2, consecutiveErrors))
        : 750;
      if (consecutiveErrors > 0) {
        console.log(` Rate limited, backing off ${baseDelay}ms...`);
      }
      await sleep(baseDelay);
    }

    const tokenSettlements = allSettlements.filter(s => s.token === t).length;
    console.log(` ${t}: ${tokenSettlements} settlements with valid data`);
  }

  return allSettlements;
}

/**
 * Try to enrich settlements with "betting time" price data from historical candlesticks
 * This addresses the model design flaw where we only had settlement-time data
 * Note: Kalshi may not retain candlestick history for settled markets - this is best-effort
 *
 * @param {Array} settlements - Array of settlement objects with closeTime
 * @param {object} userConfig - User configuration for API auth
 * @returns {Array} Enriched settlements (with bettingTimePct if available)
 */
async function enrichSettlementsWithCandlesticks(settlements, userConfig = null) {
  const cfg = userConfig || config;
  console.log(` Attempting to enrich ${settlements.length} settlements with candlestick data...`);

  let enrichedCount = 0;
  let failedCount = 0;
  const sampleSize = Math.min(100, settlements.length); // Only try a sample to avoid rate limits

  // Take a random sample of settlements to test if candlestick data is available
  const sample = settlements
    .filter(s => s.ticker && s.closeTime)
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize);

  for (const settlement of sample) {
    try {
      // Fetch candlesticks for this market (1-minute candles, 15 data points)
      const candleData = await fetchCandlesticks(settlement.ticker, 1, 15, cfg);

      if (candleData && candleData.length > 0) {
        // Find the candle approximately 5 minutes before close
        const closeTime = new Date(settlement.closeTime).getTime();
        const targetTime = closeTime - 5 * 60 * 1000; // 5 min before close

        // Find closest candle to target time
        let closestCandle = null;
        let minDiff = Infinity;

        for (const candle of candleData) {
          const candleTime = new Date(candle.timestamp || candle.time).getTime();
          const diff = Math.abs(candleTime - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            closestCandle = candle;
          }
        }

        if (closestCandle && minDiff < 10 * 60 * 1000) { // Within 10 minutes
          // Use the candle's closing price as the "betting time" price
          const bettingTimePrice = closestCandle.close || closestCandle.price;
          if (bettingTimePrice && settlement.strikePrice) {
            const bettingTimePct = ((bettingTimePrice - settlement.strikePrice) / settlement.strikePrice) * 100;
            settlement.bettingTimePrice = bettingTimePrice;
            settlement.bettingTimePct = parseFloat(bettingTimePct.toFixed(4));
            settlement.candleTimestamp = closestCandle.timestamp || closestCandle.time;
            enrichedCount++;
          }
        }
      }

      await sleep(250); // Rate limit
    } catch (err) {
      failedCount++;
      // Kalshi likely doesn't retain candlestick history for settled markets
      if (failedCount >= 10 && enrichedCount === 0) {
        console.log(` Candlestick enrichment not available (${failedCount} failures, 0 successes)`);
        break; // Stop trying if it's clearly not working
      }
    }
  }

  if (enrichedCount > 0) {
    console.log(` Enriched ${enrichedCount}/${sampleSize} settlements with betting-time data`);
  } else {
    console.log(` No candlestick data available for historical settlements (expected - Kalshi may not retain this)`);
    console.log(` Using prospective data collection instead for future model training`);
  }

  return settlements;
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
  console.log(' Starting EMPIRICAL TABLES build from historical data...');

  try {
    const settlements = await fetchBulkHistoricalData('all', 1000, userConfig);

    if (settlements.length < 100) {
      console.log(` Insufficient data for learning: only ${settlements.length} settlements`);
      return { success: false, error: 'Insufficient data', sampleSize: settlements.length };
    }

    // Candlestick enrichment disabled — Kalshi does not retain candlestick history
    // for settled markets, so this burns ~100 API calls on startup for zero data.
    // Prospective snapshots (price_snapshots.json) provide betting-time data instead.

    // Merge settled price snapshots into settlements — these have betting-time distances
    // which fix the settlement-time bias (market settling 0.5% away may have been 2% at bet time)
    const settledSnapshots = priceSnapshots.filter(s => s.settledResult !== null);
    if (settledSnapshots.length > 0) {
      let snapshotSettlements = 0;
      for (const snap of settledSnapshots) {
        settlements.push({
          ticker: snap.ticker,
          token: snap.token,
          strikePrice: snap.strikePrice,
          settlementPrice: snap.currentPrice, // Price at snapshot time
          result: snap.settledResult,
          closeTime: snap.timestamp,
          bettingTimePct: snap.pctFromStrike, // Key: this is the distance when observed, not at settlement
          marketType: '15min'
        });
        snapshotSettlements++;
      }
      console.log(` Merged ${snapshotSettlements} settled snapshots with betting-time distances`);
    }

    // Build comprehensive empirical tables using the new function
    const empiricalTables = buildEmpiricalLookupTables(settlements);

    if (!empiricalTables) {
      console.log(' Failed to build empirical tables');
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

    console.log(`\n EMPIRICAL TABLES BUILD COMPLETE!`);
    console.log(` Sample size: ${settlements.length}`);
    console.log(` Win rate buckets: ${Object.keys(empiricalTables.winRateByDistance).filter(k => empiricalTables.winRateByDistance[k].count > 0).length}`);
    console.log(` Confidence: ${(empiricalTables.confidence * 100).toFixed(0)}%`);
    console.log(`\n Selectivity Rules:`);
    console.log(` Min signal strength: ${empiricalTables.selectivityRules.minSignalStrength}`);
    console.log(` Min empirical win rate: ${empiricalTables.selectivityRules.minEmpiricalWinRate}%`);
    console.log(` Min edge after fees: ${empiricalTables.selectivityRules.minEdgeAfterFees}%`);
    console.log(`\n Win Rate by Distance (favored side):`);
    for (const [bucket, data] of Object.entries(empiricalTables.winRateByDistance)) {
      if (data.count > 0) {
        console.log(` ${bucket}%: ${data.favoredWinRate}% win rate (n=${data.count})`);
      }
    }
    console.log(`\n Token Analysis:`);
    for (const [token, data] of Object.entries(learnedParams.byToken)) {
      console.log(` ${token}: ${data.sampleSize} samples | avg dist ${data.avgSettlementDistance?.toFixed(3)}% | NO bias ${data.noBias}% | vol rank ${data.volatilityRank}`);
      if (data.optimalEntryWindows) {
        console.log(` Entry window: distance [${data.optimalEntryWindows.distanceMin}-${data.optimalEntryWindows.distanceMax}%]`);
      }
    }

    // Train ML model on the same settlements
    let mlResult = null;
    try {
      const mlTrainingData = buildMLTrainingData(settlements);
      console.log(`\n ML: Built ${mlTrainingData.length} training samples from ${settlements.length} settlements`);
      if (mlTrainingData.length >= 200) {
        mlResult = trainMLModel(mlTrainingData);
      }
    } catch (mlErr) {
      console.error(' ML training failed (non-fatal):', mlErr.message);
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
      probabilityThresholds: learnedParams.probabilityThresholds,
      mlModel: mlResult ? {
        trained: true,
        accuracy: mlResult.valAccuracy,
        trainAccuracy: mlResult.trainAccuracy,
        topFeatures: mlResult.topFeatures
      } : { trained: false, reason: mlResult?.reason || 'Unknown' }
    };
  } catch (err) {
    console.error(' Learning failed:', err.message);
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

// Dead code removed: getEmpiricalWinRate() was superseded by lookupEmpiricalWinRate()

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
      ? Object.keys(TRACKED_TOKENS).map(t => `KX${t}15M`)
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
      const token = getTokenFromTicker(ticker) || 'UNKNOWN';

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

    console.log(` Bulk settlement fetch requested: token=${token}, maxPages=${maxPages}`);

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

    console.log(` Running settlement analysis: token=${token}, maxPages=${maxPages}`);

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
    console.log(` Learn request: queryUserId=${queryUserId}, reqUserAuth=${req.userState?.config?.isAuthenticated}`);
    if (queryUserId) {
      const state = getUserState(queryUserId);
      console.log(` Loaded state for ${queryUserId}: isAuth=${state?.config?.isAuthenticated}, hasKey=${!!state?.config?.apiKeyId}`);
      if (state?.config?.isAuthenticated && state?.config?.apiKeyId) {
        userConfig = state.config;
        console.log(` Using credentials from user ${queryUserId}`);
      }
    }

    console.log(` Manual learning triggered via API (auth=${userConfig.isAuthenticated}, key=${!!userConfig.apiKeyId})`);

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
// PROSPECTIVE DATA COLLECTION API
// ============================================

// Manually trigger a price snapshot for all active markets
// POST /api/historical/snapshot
app.post('/api/historical/snapshot', async (req, res) => {
  try {
    const tokens = Object.keys(TRACKED_TOKENS);
    let snapshotCount = 0;

    for (const token of tokens) {
      const price = cryptoPrices[token]?.price;
      if (!price) continue;

      // Get active markets for this token
      const series = `KX${token}15M`;
      const marketsResponse = await kalshiRequest('GET', `/markets?series_ticker=${series}&status=open`, null, config);
      const markets = marketsResponse.markets || [];

      for (const market of markets) {
        recordPriceSnapshot(market, price, token);
        snapshotCount++;
      }
    }

    savePriceSnapshots();

    res.json({
      success: true,
      message: `Recorded ${snapshotCount} price snapshots`,
      totalSnapshots: priceSnapshots.length
    });
  } catch (error) {
    console.error('Snapshot error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get prospective data analysis
// GET /api/historical/prospective
app.get('/api/historical/prospective', (req, res) => {
  const analysis = analyzeProspectiveData();
  res.json({
    success: analysis.success,
    totalSnapshots: priceSnapshots.length,
    settledCount: priceSnapshots.filter(s => s.settledResult !== null).length,
    pendingCount: priceSnapshots.filter(s => s.settledResult === null).length,
    analysis: analysis.analysis || null,
    error: analysis.error || null
  });
});

// ============================================
// TAKE-PROFIT API (Phase 5)
// ============================================

// Get take-profit execution history (per-user)
app.get('/api/take-profit/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const userId = req.userId || 'anonymous';

  // Filter history to only show current user's executions
  const userHistory = takeProfitHistory.filter(h => h.userId === userId);
  const history = userHistory.slice(-limit).reverse(); // Most recent first

  // Calculate summary stats (for this user only)
  const executions = history.filter(h => h.executed);
  const stopLosses = executions.filter(h => h.type === 'stop-loss');
  const takeProfits = executions.filter(h => h.type === 'take-profit');
  const totalRealized = executions.reduce((sum, h) => sum + (h.realizedProfit || 0), 0);

  res.json({
    success: true,
    history,
    stats: {
      totalExecutions: executions.length,
      stopLossCount: stopLosses.length,
      takeProfitCount: takeProfits.length,
      totalRealizedCents: totalRealized,
      avgProfitPercent: executions.length > 0
        ? executions.reduce((sum, h) => sum + h.profitPercent, 0) / executions.length
        : 0
    }
  });
});

// ============================================
// SELECTIVITY RULES API (Model Edge Thresholds)
// ============================================

// Get current selectivity rules
app.get('/api/model/selectivity', (req, res) => {
  const userConfig = req.userState?.config || config;
  res.json({
    success: true,
    selectivityRules: userConfig.selectivityRules || learnedParams.selectivityRules,
    modelConfidence: learnedParams.confidence || 0.5,
    lastUpdated: learnedParams.lastUpdated || null
  });
});

// Update selectivity rules (allows adjusting min edge threshold)
app.post('/api/model/selectivity', (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'Please login first' });
  }

  const userConfig = req.userState.config;
  const updates = req.body;

  // Validate and merge updates
  const validFields = ['minSignalStrength', 'minEmpiricalWinRate', 'minEdgeAfterFees', 'maxBetsPerToken', 'maxBetsPerHour'];
  const current = userConfig.selectivityRules || { ...learnedParams.selectivityRules };

  for (const field of validFields) {
    if (updates[field] !== undefined) {
      // Validate ranges
      if (field === 'minEdgeAfterFees' && (updates[field] < 1 || updates[field] > 20)) {
        return res.status(400).json({ success: false, error: 'minEdgeAfterFees must be between 1 and 20' });
      }
      if (field === 'minSignalStrength' && (updates[field] < 50 || updates[field] > 95)) {
        return res.status(400).json({ success: false, error: 'minSignalStrength must be between 50 and 95' });
      }
      if (field === 'minEmpiricalWinRate' && (updates[field] < 50 || updates[field] > 90)) {
        return res.status(400).json({ success: false, error: 'minEmpiricalWinRate must be between 50 and 90' });
      }
      if (field === 'maxBetsPerHour' && (updates[field] < 1 || updates[field] > 100)) {
        return res.status(400).json({ success: false, error: 'maxBetsPerHour must be between 1 and 100' });
      }
      current[field] = updates[field];
    }
  }

  userConfig.selectivityRules = current;
  saveUserState(req.userId);

  res.json({
    success: true,
    message: 'Selectivity rules updated',
    selectivityRules: current
  });
});

// ML Model status endpoint
app.get('/api/model/ml-status', (req, res) => {
  const ml = getMLModel();
  // For GBDT: use feature importance; for logistic: use weights
  const topFeatures = ml.modelType === 'gbdt' && ml.featureImportance
    ? Object.entries(ml.featureImportance)
        .map(([name, imp]) => ({ name, weight: imp, absWeight: imp }))
        .sort((a, b) => b.absWeight - a.absWeight)
        .slice(0, 10)
    : Object.entries(ml.weights || {})
        .map(([name, weight]) => ({ name, weight, absWeight: Math.abs(weight) }))
        .sort((a, b) => b.absWeight - a.absWeight)
        .slice(0, 10);

  res.json({
    success: true,
    mlModel: {
      version: ml.version,
      modelType: ml.modelType || 'logistic',
      trainedOn: ml.trainedOn,
      lastUpdated: ml.lastUpdated,
      isActive: ml.trainedOn >= 200 && (ml.performance?.accuracy || 0) >= 0.55,
      performance: ml.performance,
      topFeatures,
      featureCount: ML_FEATURE_NAMES.length,
      treeCount: ml.trees?.length || 0,
      blendWeight: ml.trainedOn >= 200 && (ml.performance?.accuracy || 0) >= 0.55
        ? Math.min(0.30, Math.max(0, ((ml.performance?.accuracy || 0) - 0.55) * 2))
        : 0
    }
  });
});

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
    const opportunities = await scanTakeProfitOpportunities(userConfig, userPortfolio, req.userId);
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
// Simple in-memory rate limiter for auth endpoints
const authRateLimiter = {
  attempts: new Map(), // ip -> [{timestamp}]
  maxAttempts: 20,
  windowMs: 15 * 60 * 1000, // 15 minutes
  check(ip) {
    const now = Date.now();
    const attempts = this.attempts.get(ip) || [];
    const recent = attempts.filter(t => now - t < this.windowMs);
    this.attempts.set(ip, recent);
    if (recent.length >= this.maxAttempts) return false;
    recent.push(now);
    return true;
  }
};

app.post('/api/auth/register', async (req, res) => {
  if (!authRateLimiter.check(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Please try again later.' });
  }
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
  if (!authRateLimiter.check(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Please try again later.' });
  }
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await auth.loginUser(email, password);

    // User state is automatically loaded via middleware when they make authenticated requests
    console.log(` User logged in: ${email}`);

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
app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const userId = auth.verifyToken(token);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const userInfo = await auth.getUserInfo(userId);
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
      console.log(`"' Saved Kalshi credentials for user ${req.userId}`);

      // Update WebSocket with valid credentials
      if (kalshiWs) {
        kalshiWs.setCredentials(userConfig.apiKeyId, userConfig.privateKey);
      }

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

    // Stop auto-bet and take-profit intervals before clearing credentials
    if (userAutoBetIntervals.has(req.userId)) {
      clearInterval(userAutoBetIntervals.get(req.userId));
      userAutoBetIntervals.delete(req.userId);
      console.log(` Stopped auto-bet interval for ${req.userId}`);
    }
    stopTakeProfitScanning(req.userId);
    userConfig.autoBetEnabled = false;

    // Clear Kalshi credentials
    userConfig.apiKeyId = null;
    userConfig.privateKey = null;
    userConfig.isAuthenticated = false;

    // Reset portfolio to simulated state
    req.userState.portfolio = { balance: 2500, positions: [] }; // $25 simulated
    userConfig.bankroll = 2500;

    // Save user state
    saveUserState(req.userId);

    console.log(` User ${req.userId} disconnected from Kalshi`);

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

      // Fetch recent fills (completed trades) - last 50
      let realBetHistory = [];
      const marketData = {};
      try {
        const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=50', null, userConfig);
        let fills = fillsData.fills || [];

        // Filter out old fills - only show bets from today onwards
        // This gives users a "fresh start" without deleting Kalshi history
        const historyStartDate = userConfig.historyStartDate || '2026-02-05T03:00:00Z';
        fills = fills.filter(fill => {
          const fillTime = new Date(fill.created_time || fill.ts || 0);
          return fillTime >= new Date(historyStartDate);
        });

        // Filter out sell fills - these are take-profit exits, not bets
        fills = fills.filter(fill => (fill.action || 'buy').toLowerCase() !== 'sell');

        // Transform fills into our bet history format
        realBetHistory = fills.map(fill => {
          const count = fill.count || 1;
          // Kalshi API v2 uses yes_price/no_price (integer cents).
          // fall back to fill.price for older data.
          const fillSide = (fill.side || '').toLowerCase();
          let priceCents = fillSide === 'yes'
            ? (fill.yes_price || fill.price || 0)
            : (fill.no_price || fill.price || 0);
          if (priceCents > 0 && priceCents <= 1) {
            // Price is a decimal probability, convert to cents
            priceCents = Math.round(priceCents * 100);
          }
          // Total cost = number of contracts -- price per contract (in cents)
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

        // Aggregate fills by ticker+side (scale-in / partial fills become one record)
        const aggMap = new Map();
        for (const bet of realBetHistory) {
          const key = `${bet.ticker}|${(bet.side || '').toLowerCase()}`;
          if (aggMap.has(key)) {
            const agg = aggMap.get(key);
            agg.count += bet.count;
            agg.totalCost += bet.totalCost;
            // Keep earliest timestamp
            if (new Date(bet.timestamp) < new Date(agg.timestamp)) {
              agg.timestamp = bet.timestamp;
            }
          } else {
            aggMap.set(key, { ...bet });
          }
        }
        realBetHistory = Array.from(aggMap.values()).map(bet => ({
          ...bet,
          price: bet.count > 0 ? Math.round(bet.totalCost / bet.count) : 0
        }));

        // Get market data including settlement results — uses cache for settled markets
        const uniqueTickers = [...new Set(realBetHistory.map(b => b.ticker))].slice(0, 50);
        const batchResults = await getMarketDataBatch(uniqueTickers, userConfig);
        Object.assign(marketData, batchResults);

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

      // Merge with in-memory history (dedup by ticker+side)
      const combinedHistory = [...realBetHistory];
      const fillTickers = new Set(realBetHistory.map(b => `${b.ticker}|${(b.side || '').toLowerCase()}`));
      userBetHistory.forEach(memBet => {
        const key = `${memBet.ticker}|${(memBet.side || '').toLowerCase()}`;
        if (!fillTickers.has(key)) {
          combinedHistory.push(memBet);
        }
      });

      // Enrich pending/unknown betHistory entries with market data from Kalshi
      // Without this, old bets that fall out of the fills limit stay "pending" forever
      const stillPending = combinedHistory.filter(b =>
        b.outcome !== 'won' && b.outcome !== 'lost' && b.ticker && !marketData[b.ticker]
      );
      if (stillPending.length > 0) {
        const extraTickers = [...new Set(stillPending.map(b => b.ticker))].slice(0, 10);
        const extraResults = await getMarketDataBatch(extraTickers, userConfig);
        Object.assign(marketData, extraResults);
      }

      // Update all pending/unknown entries with available market data
      for (const bet of combinedHistory) {
        if (bet.outcome === 'won' || bet.outcome === 'lost') continue;
        const market = marketData[bet.ticker];
        if (!market?.result) continue;
        const wonBet = (bet.side || '').toLowerCase() === market.result;
        bet.outcome = wonBet ? 'won' : 'lost';
        bet.status = 'settled';
        bet.payout = wonBet ? (bet.count || 0) * 100 : 0;
        bet.profit = wonBet ? bet.payout - (bet.totalCost || 0) : -(bet.totalCost || 0);
        if (market.title) bet.title = market.title;
        if (market.closeTime) bet.closeTime = market.closeTime;
      }

      // Back-fill betHistory entries from enriched fill data so they persist
      for (const fillBet of realBetHistory) {
        if (fillBet.outcome !== 'won' && fillBet.outcome !== 'lost') continue;
        const match = userBetHistory.find(b =>
          b.ticker === fillBet.ticker &&
          (b.side || '').toLowerCase() === (fillBet.side || '').toLowerCase() &&
          b.outcome !== 'won' && b.outcome !== 'lost'
        );
        if (match) {
          match.outcome = fillBet.outcome;
          match.profit = fillBet.profit;
          match.status = 'settled';
          match.payout = fillBet.payout;
        }
      }

      // Sort by timestamp descending
      combinedHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate totals
      const settled = combinedHistory.filter(b => b.outcome === 'won' || b.outcome === 'lost');
      const totalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);
      const wins = settled.filter(b => b.outcome === 'won').length;
      const losses = settled.filter(b => b.outcome === 'lost').length;

      // Save updated state
      if (req.userId) saveUserState(req.userId);

      // AUTO-SELL REMOVED: No take-profit/stop-loss scanning

      // Calculate risk for response
      const portfolioRisk = getRiskByType(req.userState);

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
        },
        risk: {
          current: portfolioRisk.total,
          currentDollars: (portfolioRisk.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: (userPortfolio.positions || []).length,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });
    } else {
      // Return simulated data
      const simRisk = getRiskByType(req.userState);

      res.json({
        success: true,
        simulated: true,
        balance: userConfig.bankroll / 100,
        betHistory: userBetHistory.slice(0, 20),
        stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 },
        risk: {
          current: simRisk.total,
          currentDollars: (simRisk.total / 100).toFixed(2),
          maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
          byToken: getExposureByToken(req.userState),
          positionCount: 0,
          rollingSpendByToken: {
            BTC: getRollingSpendByToken(req.userId, 'BTC', CYCLE_WINDOW_MS),
            ETH: getRollingSpendByToken(req.userId, 'ETH', CYCLE_WINDOW_MS),
            SOL: getRollingSpendByToken(req.userId, 'SOL', CYCLE_WINDOW_MS)
          },
          rollingTokenCap: getMaxPerTokenPerCycle(userConfig),
          maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
          totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
          remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId)
        }
      });
    }
  } catch (error) {
    console.error('Portfolio error:', error.message);
    const userConfig = req.userState?.config || config;
    const userBetHistory = req.userState?.betHistory || betHistory;
    const errRisk = getRiskByType(req.userState);
    res.json({
      success: true,
      simulated: !userConfig.isAuthenticated,
      balance: userConfig.bankroll / 100,
      betHistory: userBetHistory.slice(0, 20),
      stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 },
      risk: {
        current: errRisk.total,
        currentDollars: (errRisk.total / 100).toFixed(2),
        maxPerTokenPerCycle: getMaxPerTokenPerCycle(userConfig),
        maxTotalPerCycle: getMaxTotalPerCycle(userConfig),
        totalCycleSpend: getRollingTotalSpend(req.userId, CYCLE_WINDOW_MS),
        remainingTotalBudget: getRemainingTotalBudget(userConfig, req.userId),
        byToken: getExposureByToken(req.userState),
        positionCount: 0
      },
      error: error.message
    });
  }
});

// Quick balance refresh - fetches only balance from Kalshi
app.get('/api/balance/refresh', async (req, res) => {
  const userConfig = req.userState?.config || config;
  const userPortfolio = req.userState?.portfolio || portfolio;

  try {
    if (userConfig.isAuthenticated) {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      const newBalance = balanceData.balance || 0;
      userPortfolio.balance = newBalance;
      if (req.userId) saveUserState(req.userId);
      res.json({ success: true, balance: newBalance / 100 });
    } else {
      res.json({ success: true, balance: userConfig.bankroll / 100 });
    }
  } catch (error) {
    console.error('Balance refresh error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Calculate portfolio worth (balance + positions value)
app.get('/api/portfolio/worth', async (req, res) => {
  const userConfig = req.userState?.config || config;
  const userPortfolio = req.userState?.portfolio || portfolio;

  try {
    let cashBalance = userConfig.bankroll;
    let positionsValue = 0;

    if (userConfig.isAuthenticated) {
      // Fetch balance
      const balanceData = await kalshiRequest('GET', '/portfolio/balance', null, userConfig);
      cashBalance = balanceData.balance || 0;
      userPortfolio.balance = cashBalance;

      // Calculate positions value
      if (userPortfolio.positions?.length > 0) {
        for (const position of userPortfolio.positions) {
          // Use market bid price as liquidation value
          const contracts = position.yes_count || position.no_count || position.count || 0;
          const avgCost = position.average_price || position.avg_price || 0;
          positionsValue += contracts * avgCost;
        }
      }

      if (req.userId) saveUserState(req.userId);
    }

    const totalWorth = cashBalance + positionsValue;
    res.json({
      success: true,
      worth: totalWorth / 100,
      cashBalance: cashBalance / 100,
      positionsValue: positionsValue / 100,
      positionCount: userPortfolio.positions?.length || 0
    });
  } catch (error) {
    console.error('Portfolio worth error:', error.message);
    res.status(500).json({ success: false, error: error.message });
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
        let fills = fillsData.fills || [];

        // Filter out old fills - only show bets from historyStartDate onwards
        const historyStartDate = userConfig.historyStartDate || '2026-02-05T03:00:00Z';
        fills = fills.filter(fill => {
          const fillTime = new Date(fill.created_time || fill.ts || 0);
          return fillTime >= new Date(historyStartDate);
        });

        // Filter out sell fills - these are take-profit exits, not bets
        fills = fills.filter(fill => (fill.action || 'buy').toLowerCase() !== 'sell');

        // Get unique tickers to fetch market results — uses cache for settled markets
        const uniqueTickers = [...new Set(fills.map(f => f.ticker))].slice(0, 50);
        const marketData = await getMarketDataBatch(uniqueTickers, userConfig);

        // Process fills into raw bet records
        let bets = fills.map(fill => {
          const count = fill.count || 1;
          const fillSide = (fill.side || '').toLowerCase();
          let priceCents = fillSide === 'yes'
            ? (fill.yes_price || fill.price || 0)
            : (fill.no_price || fill.price || 0);
          if (priceCents > 0 && priceCents <= 1) priceCents = Math.round(priceCents * 100);
          const totalCost = count * priceCents;

          return {
            ticker: fill.ticker,
            side: fillSide,
            count,
            price: priceCents,
            totalCost,
            timestamp: fill.created_time || fill.ts,
            outcome: 'pending',
            profit: 0,
            token: getTokenFromTicker(fill.ticker)
          };
        });

        // Aggregate fills by ticker+side
        const perfAggMap = new Map();
        for (const bet of bets) {
          const key = `${bet.ticker}|${bet.side}`;
          if (perfAggMap.has(key)) {
            const agg = perfAggMap.get(key);
            agg.count += bet.count;
            agg.totalCost += bet.totalCost;
            if (new Date(bet.timestamp) < new Date(agg.timestamp)) {
              agg.timestamp = bet.timestamp;
            }
          } else {
            perfAggMap.set(key, { ...bet });
          }
        }
        bets = Array.from(perfAggMap.values()).map(bet => ({
          ...bet,
          price: bet.count > 0 ? Math.round(bet.totalCost / bet.count) : 0
        }));

        // Compute outcomes on aggregated records
        bets = bets.map(bet => {
          const market = marketData[bet.ticker] || {};
          const result = market.result;
          if (result) {
            const won = bet.side === result;
            return {
              ...bet,
              outcome: won ? 'won' : 'lost',
              profit: won ? (bet.count * 100 - bet.totalCost) : -bet.totalCost
            };
          }
          return bet;
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
    if (data.bets >= 1) { // Only include buckets with at least 1 bet
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

// Clear user's bet history (cards on the History tab)
app.delete('/api/history', (req, res) => {
  const userState = req.userState;
  if (!userState) {
    return res.status(400).json({ success: false, error: 'No user state' });
  }

  // Clear in-memory bet history
  userState.betHistory.length = 0;

  // For authenticated users, advance historyStartDate so old Kalshi fills are hidden
  const userConfig = userState.config || config;
  userConfig.historyStartDate = new Date().toISOString();

  // Persist to database
  if (req.userId) saveUserState(req.userId);

  res.json({ success: true, message: 'Bet history cleared' });
});

// Global kill switch endpoints halt/resume all betting
app.post('/api/kill-switch/activate', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    fs.writeFileSync(KILL_SWITCH_FILE, `Activated by ${req.userId} at ${new Date().toISOString()}`);
    globalKillSwitch = true;
    // Stop all user auto-bet intervals
    for (const [uid, interval] of userAutoBetIntervals) {
      clearInterval(interval);
      userAutoBetIntervals.delete(uid);
    }
    console.error(` KILL SWITCH ACTIVATED by ${req.userId}`);
    res.json({ success: true, message: 'Kill switch activated all betting halted' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/kill-switch/deactivate', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    if (fs.existsSync(KILL_SWITCH_FILE)) fs.unlinkSync(KILL_SWITCH_FILE);
    globalKillSwitch = false;
    console.log(` Kill switch deactivated by ${req.userId}`);
    res.json({ success: true, message: 'Kill switch deactivated betting can resume' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/kill-switch/status', (req, res) => {
  res.json({ active: isKillSwitchActive() });
});

// ============================================
// COPY TRADING ENDPOINTS
// ============================================

// Get copy trading status
app.get('/api/copy-trading/status', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  res.json({ success: true, ...getCopyTradingStatus(req.userId) });
});

// Add a leader account to copy
app.post('/api/copy-trading/leaders', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const { name, apiKeyId, privateKey, scaleFactor, maxBetCents, marketsFilter } = req.body;
  if (!apiKeyId || !privateKey) {
    return res.status(400).json({ success: false, error: 'API key ID and private key are required' });
  }

  // Validate the leader credentials by fetching their balance
  try {
    const testConfig = { apiKeyId, privateKey, isAuthenticated: true };
    await kalshiRequest('GET', '/portfolio/balance', null, testConfig);
  } catch (err) {
    return res.status(400).json({ success: false, error: `Invalid leader credentials: ${err.message}` });
  }

  const leader = addLeader(req.userId, { name, apiKeyId, privateKey, scaleFactor, maxBetCents, marketsFilter });

  // Persist to DB
  const userConfig = req.userState.config;
  userConfig.copyTrading = serializeCopyState(req.userId);
  await saveUserState(req.userId);

  res.json({ success: true, leader: { ...leader, privateKey: undefined, apiKeyId: leader.apiKeyId?.slice(0, 8) + '...' } });
});

// Remove a leader
app.delete('/api/copy-trading/leaders/:leaderId', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const removed = removeLeader(req.userId, req.params.leaderId);
  if (!removed) {
    return res.status(404).json({ success: false, error: 'Leader not found' });
  }

  // Persist
  const userConfig = req.userState.config;
  userConfig.copyTrading = serializeCopyState(req.userId);
  await saveUserState(req.userId);

  res.json({ success: true });
});

// Update a leader's settings
app.put('/api/copy-trading/leaders/:leaderId', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const updated = updateLeader(req.userId, req.params.leaderId, req.body);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Leader not found' });
  }

  // Persist
  const userConfig = req.userState.config;
  userConfig.copyTrading = serializeCopyState(req.userId);
  await saveUserState(req.userId);

  res.json({ success: true, leader: { ...updated, privateKey: undefined, apiKeyId: updated.apiKeyId?.slice(0, 8) + '...' } });
});

// Toggle copy trading on/off
app.post('/api/copy-trading/toggle', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const { enabled, intervalSeconds = 15 } = req.body;
  const userConfig = req.userState.config;

  if (!userConfig.isAuthenticated) {
    return res.status(400).json({ success: false, error: 'Connect your Kalshi account first' });
  }

  const status = getCopyTradingStatus(req.userId);
  if (status.stats.activeLeaders === 0) {
    return res.status(400).json({ success: false, error: 'Add at least one leader account first' });
  }

  if (enabled && !status.running) {
    const result = startCopyTrading(req.userId, userConfig, intervalSeconds * 1000);
    if (!result.success) return res.status(400).json(result);
    res.json({ success: true, message: `Copy trading enabled (polling every ${intervalSeconds}s)`, running: true });
  } else if (!enabled && status.running) {
    stopCopyTrading(req.userId);
    res.json({ success: true, message: 'Copy trading stopped', running: false });
  } else {
    res.json({ success: true, message: `Copy trading ${status.running ? 'already running' : 'already stopped'}`, running: status.running });
  }
});

// Get copy trading activity log
app.get('/api/copy-trading/activity', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const status = getCopyTradingStatus(req.userId);
  res.json({ success: true, activity: status.recentActivity });
});

// ============================================
// POLYMARKET COPY TRADING ENDPOINTS
// ============================================

// Get Polymarket tracker status
app.get('/api/poly-trading/status', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  res.json({ success: true, ...getPolyTrackerStatus(req.userId) });
});

// Add a Polymarket wallet to track
app.post('/api/poly-trading/wallets', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const { name, walletAddress, scaleFactor, maxBetCents, assetsFilter, maxCopiesPerHour, timeframes } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  // Validate wallet by fetching positions
  try {
    const positions = await fetchPolyPositions(walletAddress, 1);
    if (!Array.isArray(positions)) {
      return res.status(400).json({ success: false, error: 'Could not verify wallet - no data returned' });
    }
  } catch (err) {
    return res.status(400).json({ success: false, error: `Could not verify wallet: ${err.message}` });
  }

  try {
    const wallet = addPolyWallet(req.userId, { name, walletAddress, scaleFactor, maxBetCents, assetsFilter, maxCopiesPerHour, timeframes });

    // Persist
    const userConfig = req.userState.config;
    userConfig.polyTrading = serializePolyState(req.userId);
    await saveUserState(req.userId);

    // Fetch profile info for response
    const profile = await fetchPolyProfile(walletAddress);

    res.json({ success: true, wallet, profile });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove a tracked wallet
app.delete('/api/poly-trading/wallets/:walletId', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const removed = removePolyWallet(req.userId, req.params.walletId);
  if (!removed) return res.status(404).json({ success: false, error: 'Wallet not found' });

  const userConfig = req.userState.config;
  userConfig.polyTrading = serializePolyState(req.userId);
  await saveUserState(req.userId);

  res.json({ success: true });
});

// Update wallet settings
app.put('/api/poly-trading/wallets/:walletId', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const updated = updatePolyWallet(req.userId, req.params.walletId, req.body);
  if (!updated) return res.status(404).json({ success: false, error: 'Wallet not found' });

  const userConfig = req.userState.config;
  userConfig.polyTrading = serializePolyState(req.userId);
  await saveUserState(req.userId);

  res.json({ success: true, wallet: updated });
});

// Toggle Polymarket copy trading on/off
app.post('/api/poly-trading/toggle', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  const { enabled, intervalSeconds = 20 } = req.body;
  const userConfig = req.userState.config;

  if (!userConfig.isAuthenticated) {
    return res.status(400).json({ success: false, error: 'Connect your Kalshi account first (needed to place copy trades)' });
  }

  const status = getPolyTrackerStatus(req.userId);
  if (status.stats.activeWallets === 0) {
    return res.status(400).json({ success: false, error: 'Add at least one Polymarket wallet first' });
  }

  if (enabled && !status.running) {
    const result = startPolyTracker(req.userId, userConfig, intervalSeconds * 1000);
    if (!result.success) return res.status(400).json(result);
    res.json({ success: true, message: `Polymarket copy trading enabled (polling every ${intervalSeconds}s)`, running: true });
  } else if (!enabled && status.running) {
    stopPolyTracker(req.userId);
    res.json({ success: true, message: 'Polymarket copy trading stopped', running: false });
  } else {
    res.json({ success: true, running: status.running });
  }
});

// Preview: fetch a Polymarket wallet's current positions
app.get('/api/poly-trading/preview/:walletAddress', async (req, res) => {
  try {
    const positions = await fetchPolyPositions(req.params.walletAddress, 20);
    const profile = await fetchPolyProfile(req.params.walletAddress);
    res.json({ success: true, positions: positions || [], profile });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================
// WALLET ANALYZER ENDPOINTS
// ============================================

// Analyze a Polymarket wallet's trading strategy
app.get('/api/wallet-analysis/:walletAddress', async (req, res) => {
  const { walletAddress } = req.params;
  const depth = parseInt(req.query.depth) || 200;

  try {
    const analysis = await analyzeWallet(walletAddress, { depth: Math.min(depth, 500) });
    res.json(analysis);
  } catch (err) {
    console.error(`Wallet analysis error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick check: just detect if a wallet is using both-sides strategy
app.get('/api/wallet-analysis/:walletAddress/quick', async (req, res) => {
  try {
    const analysis = await analyzeWallet(req.params.walletAddress, { depth: 50, includePositions: false });
    if (!analysis.success) return res.status(400).json(analysis);

    res.json({
      success: true,
      walletAddress: analysis.walletAddress,
      profileName: analysis.profileName,
      primaryStrategy: analysis.strategy.primaryStrategy,
      strategies: analysis.strategy.strategies,
      confidence: analysis.strategy.confidence,
      summary: analysis.strategy.summary,
      bothSidesMarkets: analysis.arbitrage.bothSidesMarkets,
      pureArbitrageMarkets: analysis.arbitrage.pureArbitrageMarkets,
      tradesAnalyzed: analysis.tradesAnalyzed,
      isBot: analysis.timing.isBot,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Economic calendar endpoint
app.get('/api/economic-calendar', (req, res) => {
  const now = Date.now();
  const activeEvent = getActiveEconomicEvent();
  const upcoming = economicCalendar
    .filter(e => new Date(e.datetime).getTime() > now)
    .slice(0, 10);
  res.json({ activeEvent, upcoming, totalEvents: economicCalendar.length });
});

// Daily P&L endpoint
app.get('/api/daily-pnl', (req, res) => {
  res.json({ today: dailyStats, history: dailyPnlHistory });
});

// Debug endpoint to see raw Kalshi data (uses global server credentials)
app.get('/api/debug/kalshi-fills', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
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

    // Fetch market data for each unique ticker — uses cache for settled markets
    const uniqueTickers = [...new Set(fills.map(f => f.ticker))].slice(0, 20);
    const marketResults = await getMarketDataBatch(uniqueTickers, useConfig);

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
        yes_price: f.yes_price,
        no_price: f.no_price,
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

// Start HTTP server first (so Render detects the port), then initialize database
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(` Shimi Crypto Bot running on port ${PORT}`);

  // Initialize database after port is open
  try {
    await initDatabase();
    console.log(` Tracking ${Object.keys(TRACKED_TOKENS).length} tokens: ${Object.keys(TRACKED_TOKENS).join(', ')}`);
    console.log(` Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);
    console.log(` Performance tracking: ${performanceData.bets.length} historical bets loaded`);
  } catch (err) {
    console.error(' Database initialization failed:', err.message);
  }

  // Auto-load Kalshi credentials from environment
  try {
    await loadCredentialsFromEnv();
  } catch (err) {
    console.error(' Failed to load credentials:', err.message);
  }

  // Initialize WebSocket for real-time market data (Phase 1)
  console.log(` Initializing Kalshi WebSocket connection...`);
  try {
    initializeWebSocket();
  } catch (err) {
    console.log(` WebSocket initialization failed (falling back to REST): ${err.message}`);
  }

  // Check pending settlements every 2 minutes
  setInterval(async () => {
    try {
      await checkPendingSettlements();
    } catch (err) {
      console.log('Settlement check error:', err.message);
    }
  }, 2 * 60 * 1000);

  // Prospective data collection scheduler removed: was making 3 extra Kalshi API calls/min
  // contributing to 429 rate limits, and never produced usable data (price_snapshots.json was empty).
  // The 12,452-settlement empirical tables from buildEmpiricalLookupTables are sufficient.

  // Daily P&L rollover check every 60 seconds
  setInterval(rolloverDailyStats, 60000);

  // Keep-alive: Self-ping every 10 minutes to prevent Render free tier from spinning down
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${RENDER_URL}/api/health`)
      .then(() => console.log(' Keep-alive ping successful'))
      .catch(() => {}); // Silently ignore errors
  }, 10 * 60 * 1000);

  // ============================================
  // THRESHOLD LEARNING SCHEDULE
  // ============================================
  // Run learning on startup if data is stale, then daily thereafter

  // Initial learning check (skipped if we already have adequate data from Docker image)
  // On Render free plan, filesystem is ephemeral — learned_params.json always loads from
  // the Docker build, so lastUpdated will always appear stale after a few hours.
  // With 12k+ samples already baked in, there's no value in re-fetching on every restart.
  setTimeout(async () => {
    if (hasAdequateLearnedData()) {
      // Data is good enough — skip the expensive API calls on startup
      console.log(` Learned data adequate (${learnedParams.sampleSize} samples, ${Object.keys(learnedParams.winRateByDistance || {}).length} buckets) — skipping startup learning`);
      console.log(` Last updated: ${learnedParams.lastUpdated} (stale=${isLearningDataStale()} but data sufficient)`);
      for (const [token, data] of Object.entries(learnedParams.byToken)) {
        if (data.sampleSize > 0) {
          console.log(` ${token}: ${data.sampleSize} samples, avg dist ${data.avgSettlementDistance?.toFixed(3)}%`);
        }
      }
    } else if (isLearningDataStale()) {
      console.log(' Insufficient learned data and stale, triggering learning update...');
      try {
        await updateLearnedParameters();
      } catch (err) {
        console.log(` Initial learning failed: ${err.message}`);
      }
    } else {
      console.log(` Learned thresholds are current (last updated: ${learnedParams.lastUpdated})`);
      console.log(` Global threshold: ${learnedParams.thresholds.coinFlipExit}%`);
      for (const [token, data] of Object.entries(learnedParams.byToken)) {
        if (data.sampleSize > 0) {
          console.log(` ${token}: ${data.coinFlipThreshold}% (${data.sampleSize} samples)`);
        }
      }
    }
  }, 30000);

  // Schedule daily learning updates (run at ~4 AM server time to minimize impact)
  setInterval(async () => {
    const hour = new Date().getHours();
    // Only run between 4-5 AM to minimize impact on trading
    if (hour === 4) {
      console.log(' Running scheduled daily threshold learning...');
      try {
        await updateLearnedParameters();
      } catch (err) {
        console.log(` Scheduled learning failed: ${err.message}`);
      }
    }
  }, 60 * 60 * 1000); // Check every hour

  // Auto-retrain empirical tables when enough new snapshot data accumulates
  let lastAutoRetrain = Date.now();
  setInterval(async () => {
    const hoursSinceRetrain = (Date.now() - lastAutoRetrain) / 3600000;
    const snapshotCount = priceSnapshots?.length || 0;
    if (hoursSinceRetrain >= 6 && snapshotCount >= 50) {
      console.log(` Auto-retrain: ${snapshotCount} snapshots, ${hoursSinceRetrain.toFixed(1)}h since last`);
      try {
        // Fetch fresh settlements and rebuild tables
        await updateLearnedParameters();
        lastAutoRetrain = Date.now();
      } catch (err) {
        console.log(` Auto-retrain failed: ${err.message}`);
      }
    }
  }, 600000); // Check every 10 min

  server.on('error', (err) => {
    console.error('Server error:', err.message);
  });
});

// Graceful shutdown flush debounced writes before exit
function gracefulShutdown(signal) {
  console.log(`\n ${signal} received flushing data before exit...`);
  // Cancel all pending debounced timers (they won't fire in time)
  for (const [key, timer] of Object.entries(_debouncedTimers)) {
    if (timer) {
      clearTimeout(timer);
      _debouncedTimers[key] = null;
    }
  }
  // Direct synchronous writes bypass debouncing since we're shutting down
  try {
    if (takeProfitHistory.length > MAX_TP_HISTORY) {
      takeProfitHistory = takeProfitHistory.slice(-MAX_TP_HISTORY);
    }
    fs.writeFileSync(TAKE_PROFIT_HISTORY_FILE, JSON.stringify(takeProfitHistory, null, 2));
    console.log(' Saved take-profit history');
  } catch (e) { console.error(' Failed to save take-profit history:', e.message); }
  try {
    performanceData.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(performanceData, null, 2));
    console.log(' Saved performance data');
  } catch (e) { console.error(' Failed to save performance data:', e.message); }
  try {
    if (priceSnapshots.length > MAX_SNAPSHOTS) {
      priceSnapshots = priceSnapshots.slice(-MAX_SNAPSHOTS);
    }
    fs.writeFileSync(PRICE_SNAPSHOTS_FILE, JSON.stringify(priceSnapshots, null, 2));
    console.log(' Saved price snapshots');
  } catch (e) { console.error(' Failed to save price snapshots:', e.message); }
  try {
    if (dailyPnlHistory.length > 30) dailyPnlHistory = dailyPnlHistory.slice(-30);
    fs.writeFileSync(DAILY_PNL_FILE, JSON.stringify(dailyPnlHistory, null, 2));
    console.log(' Saved daily P&L history');
  } catch (e) { console.error(' Failed to save daily P&L history:', e.message); }
  console.log(' Goodbye!');
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
