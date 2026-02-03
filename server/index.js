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

// ============================================
// AUTHENTICATION
// ============================================
// Set SHIMI_PASSWORD environment variable to protect your API
const AUTH_PASSWORD = process.env.SHIMI_PASSWORD || null;

// Auth middleware - checks for password in header
function requireAuth(req, res, next) {
  // If no password is set, allow all requests (for local development)
  if (!AUTH_PASSWORD) {
    return next();
  }

  const providedPassword = req.headers['x-shimi-password'] || req.headers['authorization']?.replace('Bearer ', '');

  if (providedPassword === AUTH_PASSWORD) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized. Set x-shimi-password header.',
    requiresAuth: true
  });
}

// Login endpoint - verify password
app.post('/api/auth/login', express.json(), (req, res) => {
  const { password } = req.body;

  // If no password is configured, always succeed
  if (!AUTH_PASSWORD) {
    return res.json({ success: true, message: 'No password required' });
  }

  if (password === AUTH_PASSWORD) {
    return res.json({ success: true, message: 'Authenticated' });
  }

  return res.status(401).json({ success: false, error: 'Invalid password' });
});

// Check if auth is required
app.get('/api/auth/status', (req, res) => {
  const providedPassword = req.headers['x-shimi-password'] || req.headers['authorization']?.replace('Bearer ', '');
  const isAuthenticated = !AUTH_PASSWORD || providedPassword === AUTH_PASSWORD;

  res.json({
    success: true,
    requiresAuth: !!AUTH_PASSWORD,
    isAuthenticated
  });
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.use(cors());
app.use(express.json());

// Apply auth to all /api routes EXCEPT auth endpoints and health check
app.use('/api', (req, res, next) => {
  // Skip auth for these paths (paths are relative to /api mount point)
  const publicPaths = [
    '/auth/login',
    '/auth/status',
    '/health',
    '/jsonbin-status',
    '/jsonbin-create',
    '/jsonbin-sync',
    '/ml-model',
    '/import-fills',
    '/reset-tracking',
    '/fix-summary',
    '/deduplicate-bets'
  ];
  if (publicPaths.includes(req.path)) {
    return next();
  }
  return requireAuth(req, res, next);
});

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// ============================================
// CONFIGURATION
// ============================================

let config = {
  apiKeyId: null,
  privateKey: null,
  isAuthenticated: false,
  bankroll: 2500, // cents ($25.00)
  maxBetPercent: 15,
  minEdge: 3, // 3% minimum - lowered for more action
  autoBetEnabled: false,
  // Risk management settings (in cents)
  riskLimits: {
    maxPerBet: 500,      // $5.00 max per bet
    maxPerToken: 500,    // $5.00 max per token
    maxTotal: 1500       // $15.00 total max exposure
  },
  // Scale-in settings: add to position when probability improves
  scaleIn: {
    enabled: true,
    minProbabilityIncrease: 15,  // Only scale in if prob increased by 15%+ (60% → 75%)
    maxBetsPerMarket: 3,         // Maximum times to bet on same market
    minTimeBetweenBets: 60000    // At least 1 minute between bets on same market
  },
  // Degen mode: allow low-probability bets (15-39¢) when momentum is strong
  degenMode: {
    enabled: false,
    minPrice: 15,                // Minimum contract price in cents
    maxPrice: 39,                // Maximum price for degen bets (above this = normal safe bet)
    requireStrongMomentum: true, // All momentum timeframes must align
    maxTimeMinutes: 5,           // Only in final 5 minutes
    maxBetMultiplier: 0.5        // Bet half the normal Kelly size for these
  }
};

// ============================================
// PROFILES SYSTEM
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
    }
  } catch (err) {
    console.log('Could not load profiles:', err.message);
  }
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

// Switch to a profile (loads their Kalshi credentials)
function switchToProfile(profileId) {
  const profile = profiles[profileId];
  if (!profile) return false;

  activeProfileId = profileId;

  // Load this profile's Kalshi credentials
  if (profile.kalshiApiKeyId && profile.kalshiPrivateKey) {
    config.apiKeyId = profile.kalshiApiKeyId;
    config.privateKey = profile.kalshiPrivateKey;
    config.isAuthenticated = true;
  } else {
    config.apiKeyId = null;
    config.privateKey = null;
    config.isAuthenticated = false;
  }

  // Load profile settings
  if (profile.settings) {
    config.riskLimits = { ...config.riskLimits, ...profile.settings.riskLimits };
    config.degenMode = { ...config.degenMode, ...profile.settings.degenMode };
  }

  // Reset portfolio for this user
  portfolio = { balance: 0, positions: [] };
  betHistory = profile.betHistory || [];

  saveProfiles();
  console.log(`👤 Switched to profile: ${profile.name}`);
  return true;
}

// Save current state to active profile
function saveToActiveProfile() {
  if (!activeProfileId || !profiles[activeProfileId]) return;

  profiles[activeProfileId].kalshiApiKeyId = config.apiKeyId;
  profiles[activeProfileId].kalshiPrivateKey = config.privateKey;
  profiles[activeProfileId].settings = {
    riskLimits: config.riskLimits,
    degenMode: config.degenMode
  };
  profiles[activeProfileId].betHistory = betHistory;
  profiles[activeProfileId].lastActive = new Date().toISOString();

  saveProfiles();
}

// Initialize profiles on startup
loadProfiles();

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
// Now uses JSONBin (via performanceData) for persistence on Render

function loadAutoBetState() {
  // First check if it's in performanceData (loaded from JSONBin)
  if (performanceData.autoBetState) {
    console.log(`🔄 Loaded auto-bet state from cloud: ${performanceData.autoBetState.enabled ? 'ENABLED' : 'disabled'}`);
    return performanceData.autoBetState;
  }

  // Fallback to local file (for local development)
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log(`🔄 Loaded auto-bet state from file: ${data.enabled ? 'ENABLED' : 'disabled'}`);
      return data;
    }
  } catch (err) {
    console.log('Could not load auto-bet state:', err.message);
  }
  return { enabled: false, intervalSeconds: 15 };
}

function saveAutoBetState(enabled, intervalSeconds = 15) {
  const state = {
    enabled,
    intervalSeconds,
    savedAt: new Date().toISOString()
  };

  // Save to performanceData (which syncs to JSONBin)
  performanceData.autoBetState = state;
  savePerformanceData(); // This will sync to JSONBin

  // Also save locally as backup
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // Ignore - Render filesystem is read-only
  }

  console.log(`💾 Saved auto-bet state: ${enabled ? 'ENABLED' : 'disabled'} (syncing to cloud)`);
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
      degenMode: config.degenMode,
      minEdge: config.minEdge,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`💾 Saved settings: $${config.riskLimits.maxTotal / 100} max exposure, degen=${config.degenMode.enabled}`);
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

// ============================================
// JSONBIN.IO CLOUD STORAGE (for persistent stats)
// ============================================
// Set these env vars on Render:
//   JSONBIN_API_KEY = your JSONBin.io API key (free at jsonbin.io)
//   JSONBIN_BIN_ID = your bin ID (created after first save)

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
let JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

// Load performance data from JSONBin (cloud) or file (local fallback)
async function loadPerformanceData() {
  // Try JSONBin first if configured
  if (JSONBIN_API_KEY && JSONBIN_BIN_ID) {
    try {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Access-Key': JSONBIN_API_KEY }
      });
      if (res.ok) {
        const json = await res.json();
        performanceData = json.record;
        console.log(`☁️ Loaded ${performanceData.bets?.length || 0} bets from JSONBin (cloud)`);
        return;
      }
    } catch (err) {
      console.log('JSONBin load failed, trying local file:', err.message);
    }
  }

  // Fallback to local file
  try {
    if (fs.existsSync(PERFORMANCE_FILE)) {
      const data = fs.readFileSync(PERFORMANCE_FILE, 'utf8');
      performanceData = JSON.parse(data);
      console.log(`📊 Loaded ${performanceData.bets.length} historical bets (local file)`);
    }
  } catch (err) {
    console.log('Could not load performance data:', err.message);
  }
}

// Save performance data to JSONBin (cloud) and file (local backup)
let saveTimeout = null;
function savePerformanceData() {
  performanceData.lastUpdated = new Date().toISOString();

  // Always save locally as backup
  try {
    fs.writeFileSync(PERFORMANCE_FILE, JSON.stringify(performanceData, null, 2));
  } catch (err) {
    // Ignore local save errors on Render (read-only filesystem)
  }

  // Debounce cloud saves (max once per 5 seconds to avoid rate limits)
  if (JSONBIN_API_KEY) {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveToJsonBin(), 5000);
  }
}

// Trim data to stay under JSONBin free tier limit (100KB)
function trimDataForJsonBin(data) {
  const MAX_SIZE_KB = 90; // Stay under 100KB limit with buffer
  const MAX_BETS = 500;   // Hard cap on bets to keep

  // Create a copy to trim
  const trimmed = JSON.parse(JSON.stringify(data));

  // First, limit bets array to most recent
  if (trimmed.bets && trimmed.bets.length > MAX_BETS) {
    // Sort by timestamp descending and keep newest
    trimmed.bets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    trimmed.bets = trimmed.bets.slice(0, MAX_BETS);
    console.log(`☁️ Trimmed bets to ${MAX_BETS} most recent`);
  }

  // Check size and trim more if needed
  let jsonStr = JSON.stringify(trimmed);
  let sizeKB = jsonStr.length / 1024;

  while (sizeKB > MAX_SIZE_KB && trimmed.bets.length > 50) {
    // Remove oldest 10% of bets
    const removeCount = Math.max(10, Math.floor(trimmed.bets.length * 0.1));
    trimmed.bets = trimmed.bets.slice(0, trimmed.bets.length - removeCount);
    jsonStr = JSON.stringify(trimmed);
    sizeKB = jsonStr.length / 1024;
    console.log(`☁️ Trimmed to ${trimmed.bets.length} bets (${sizeKB.toFixed(1)}KB)`);
  }

  return trimmed;
}

// Actual JSONBin save (debounced)
async function saveToJsonBin() {
  if (!JSONBIN_API_KEY) {
    console.log('⚠️ JSONBin: No API key configured');
    return { success: false, error: 'No API key' };
  }

  try {
    // Trim data to stay under free tier limit
    const dataToSave = trimDataForJsonBin(performanceData);

    if (JSONBIN_BIN_ID) {
      // Update existing bin
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': JSONBIN_API_KEY
        },
        body: JSON.stringify(dataToSave)
      });
      if (res.ok) {
        console.log(`☁️ Saved ${dataToSave.bets?.length || 0} bets to JSONBin`);
        return { success: true, binId: JSONBIN_BIN_ID, action: 'updated' };
      } else {
        const errText = await res.text();
        console.log(`☁️ JSONBin update failed: ${res.status} - ${errText}`);
        return { success: false, error: errText };
      }
    } else {
      // Create new bin
      console.log('☁️ Creating new JSONBin...');
      const res = await fetch('https://api.jsonbin.io/v3/b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': JSONBIN_API_KEY,
          'X-Bin-Name': 'shimi-performance-data'
        },
        body: JSON.stringify(dataToSave)
      });
      if (res.ok) {
        const json = await res.json();
        JSONBIN_BIN_ID = json.metadata.id;
        console.log(`☁️ ========================================`);
        console.log(`☁️ CREATED NEW JSONBIN: ${JSONBIN_BIN_ID}`);
        console.log(`☁️ ADD THIS TO RENDER ENV VARS:`);
        console.log(`☁️ JSONBIN_BIN_ID=${JSONBIN_BIN_ID}`);
        console.log(`☁️ ========================================`);
        return { success: true, binId: JSONBIN_BIN_ID, action: 'created' };
      } else {
        const errText = await res.text();
        console.log(`☁️ JSONBin create failed: ${res.status} - ${errText}`);
        return { success: false, error: errText };
      }
    }
  } catch (err) {
    console.log('JSONBin save error:', err.message);
    return { success: false, error: err.message };
  }
}

// Track a new bet
function trackBet(betInfo) {
  const now = new Date();
  const token = betInfo.token || betInfo.assetType || getTokenFromTicker(betInfo.ticker);

  // DEDUPLICATION: Check if we already have this bet
  // Match by: ticker + side + similar timestamp (within 60 seconds) + similar price
  const existingBet = performanceData.bets.find(b => {
    if (b.ticker !== betInfo.ticker) return false;
    if (b.side !== betInfo.side) return false;
    const timeDiff = Math.abs(new Date(b.timestamp).getTime() - now.getTime());
    if (timeDiff > 60000) return false; // More than 60 seconds apart
    const priceDiff = Math.abs((b.price || 0) - (betInfo.price || 0));
    if (priceDiff > 5) return false; // More than 5 cents difference
    return true;
  });

  if (existingBet) {
    console.log(`📋 Skipping duplicate bet: ${betInfo.ticker} ${betInfo.side} (already tracked)`);
    return existingBet; // Return existing bet instead of creating duplicate
  }

  // Calculate ML features
  const currentPrice = betInfo.currentPrice || 0;
  const strikePrice = betInfo.strikePrice || 0;
  const distanceFromStrike = strikePrice > 0 ? ((currentPrice - strikePrice) / strikePrice) * 100 : 0;

  // Time features
  const expiryTime = betInfo.expiryTime ? new Date(betInfo.expiryTime).getTime() : null;
  const timeRemainingMs = expiryTime ? expiryTime - now.getTime() : null;
  const timeRemainingMinutes = timeRemainingMs ? Math.round(timeRemainingMs / 60000) : null;

  // Get volatility if available (from price tracking)
  let volatility = null;
  if (token && typeof cryptoPrices !== 'undefined' && cryptoPrices[token]) {
    volatility = cryptoPrices[token].volatility || null;
  }

  const bet = {
    id: betInfo.id || Date.now().toString(),
    timestamp: now.toISOString(),
    ticker: betInfo.ticker,
    title: betInfo.title,
    token,
    side: betInfo.side,
    contracts: betInfo.count || 1,
    price: betInfo.price,           // cents
    totalCost: betInfo.totalCost,   // cents
    predictedProb: betInfo.predictedProb || parseFloat(betInfo.winProbability) || 0,
    marketPrice: betInfo.marketPrice || betInfo.price,
    edge: betInfo.edge || 0,
    strikePrice,
    currentPriceAtBet: currentPrice,
    expiryTime: betInfo.expiryTime,
    marketType: betInfo.marketType || (betInfo.ticker?.includes('1H') ? 'hourly' :
                                        betInfo.ticker?.includes('15M') ? '15min' : 'daily'),

    // === ML FEATURES ===
    // Time features (useful for detecting time-of-day patterns)
    hourOfDay: now.getHours(),
    dayOfWeek: now.getDay(),  // 0=Sunday, 6=Saturday
    minuteOfHour: now.getMinutes(),

    // Price features
    distanceFromStrikePct: parseFloat(distanceFromStrike.toFixed(4)),  // % above/below strike
    priceToStrikeRatio: strikePrice > 0 ? parseFloat((currentPrice / strikePrice).toFixed(6)) : null,

    // Time remaining feature
    timeRemainingMinutes,

    // Volatility feature (if available)
    volatilityAtBet: volatility,

    // Market sentiment (implied from price)
    impliedProb: betInfo.marketPrice ? betInfo.marketPrice : betInfo.price,  // What market thinks

    // Outcome tracking (filled in later)
    outcome: 'pending',  // 'won' | 'lost' | 'pending'
    settlementPrice: null,
    actualProfit: null,  // cents
    settledAt: null,

    // ML features for training (extracted at bet time)
    mlFeatures: null  // Will be populated below
  };

  // Extract and store ML features for later training
  try {
    const priceData = token && typeof cryptoPrices !== 'undefined' ? cryptoPrices[token] : null;
    bet.mlFeatures = extractMLFeatures({
      ...betInfo,
      token,
      strikePrice,
      currentPrice,
      timeRemainingMinutes,
      volatility,
      betSide: betInfo.side
    }, priceData);
  } catch (err) {
    console.log('Could not extract ML features:', err.message);
  }

  performanceData.bets.push(bet);
  performanceData.summary.totalBets++;
  performanceData.summary.pending++;
  performanceData.summary.totalWagered += bet.totalCost;

  savePerformanceData();
  console.log(`🧠 TRACKED BET #${performanceData.bets.length}: ${bet.side} on ${bet.token} @ ${bet.price}¢ (${bet.predictedProb.toFixed(1)}% pred)`);

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

  // Update ML model with this outcome
  try {
    updateMLModel(bet, outcome);
  } catch (err) {
    console.log('ML model update error:', err.message);
  }

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

// Recalculate ALL summary statistics from bets array
function recalculateSummary() {
  const bets = performanceData.bets || [];
  const settled = bets.filter(b => b.outcome === 'won' || b.outcome === 'lost');
  const pending = bets.filter(b => b.outcome === 'pending' || !b.outcome);
  const wins = bets.filter(b => b.outcome === 'won');
  const losses = bets.filter(b => b.outcome === 'lost');

  // Recalculate totals from actual data
  performanceData.summary.totalBets = bets.length;
  performanceData.summary.wins = wins.length;
  performanceData.summary.losses = losses.length;
  performanceData.summary.pending = pending.length;

  // Total wagered
  performanceData.summary.totalWagered = bets.reduce((sum, b) => sum + (b.totalCost || 0), 0);

  // Total profit (wins - losses)
  const winProfit = wins.reduce((sum, b) => sum + (b.actualProfit || 0), 0);
  const lossAmount = losses.reduce((sum, b) => sum + (b.totalCost || 0), 0);
  performanceData.summary.totalProfit = winProfit - lossAmount;

  // Win rate
  performanceData.summary.winRate = settled.length > 0
    ? (wins.length / settled.length) * 100
    : 0;

  // Average predicted probability
  performanceData.summary.avgPredictedProb = settled.length > 0
    ? settled.reduce((sum, b) => sum + (b.predictedProb || 50), 0) / settled.length
    : 0;

  // Calculate calibration (predicted vs actual win rates by bucket)
  const calibration = {};
  for (const [bucket, data] of Object.entries(performanceData.byProbBucket || {})) {
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

  console.log(`📊 Recalculated: ${bets.length} total, ${wins.length} wins, ${losses.length} losses, ${pending.length} pending`);
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

// ============================================
// ML LEARNING SYSTEM
// ============================================
// Online learning model that improves with each settled bet

const ML_MODEL_FILE = path.join(__dirname, 'ml_model.json');

// Feature weights - learned from outcomes
let mlModel = {
  version: 1,
  trainedOn: 0,  // Number of settled bets used for training
  lastUpdated: null,

  // Feature weights (initialized to neutral, learned over time)
  weights: {
    // Distance from strike features
    distanceFromStrike: 0,      // How far price is from target
    distanceSquared: 0,         // Non-linear distance effect

    // Time features
    timeRemaining: 0,           // Minutes left
    timeUrgency: 0,             // 1/timeRemaining (urgency increases as expiry nears)

    // Momentum features
    momentum1m: 0,              // 1-minute momentum
    momentum5m: 0,              // 5-minute momentum
    momentumAlignment: 0,       // Do short and long momentum agree?

    // Volatility features
    volatility: 0,              // Current volatility
    volToDistance: 0,           // Volatility relative to distance from strike

    // Market price features
    marketImpliedProb: 0,       // What market thinks
    priceDeviation: 0,          // Our prediction vs market

    // Confidence features
    signalStrength: 0,          // How strong is our signal

    // Token-specific biases (learned)
    tokenBTC: 0,
    tokenETH: 0,
    tokenSOL: 0,

    // Time-of-day patterns
    hourMorning: 0,             // 6am-12pm
    hourAfternoon: 0,           // 12pm-6pm
    hourEvening: 0,             // 6pm-12am
    hourNight: 0,               // 12am-6am

    // Side bias
    sideYes: 0,
    sideNo: 0
  },

  // Running statistics for normalization
  featureStats: {},

  // Learning rate (how fast to adapt)
  learningRate: 0.1,

  // Performance tracking
  performance: {
    predictions: [],  // Recent predictions vs outcomes
    accuracy: 0,
    avgAdjustment: 0
  }
};

// Load ML model from file/JSONBin
function loadMLModel() {
  try {
    if (fs.existsSync(ML_MODEL_FILE)) {
      const data = fs.readFileSync(ML_MODEL_FILE, 'utf8');
      mlModel = { ...mlModel, ...JSON.parse(data) };
      console.log(`🧠 ML Model loaded: trained on ${mlModel.trainedOn} bets`);
    }
  } catch (err) {
    console.log('Could not load ML model, using defaults');
  }
}

// Save ML model
function saveMLModel() {
  try {
    mlModel.lastUpdated = new Date().toISOString();
    fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(mlModel, null, 2));
  } catch (err) {
    // Ignore save errors on read-only filesystem
  }
}

// Extract ML features from a bet opportunity
function extractMLFeatures(opportunity, priceData) {
  const now = new Date();
  const hour = now.getHours();

  const currentPrice = priceData?.price || opportunity.currentPrice || 0;
  const strikePrice = opportunity.strikePrice || currentPrice;
  const distanceFromStrike = strikePrice > 0 ? ((currentPrice - strikePrice) / strikePrice) * 100 : 0;
  const timeRemaining = opportunity.timeRemainingMinutes || 15;
  const volatility = priceData?.volatility || opportunity.volatility || 0.02;
  const momentum = priceData?.momentum || opportunity.momentum || {};

  return {
    // Distance features
    distanceFromStrike: distanceFromStrike,
    distanceSquared: distanceFromStrike * distanceFromStrike * Math.sign(distanceFromStrike),
    absDistance: Math.abs(distanceFromStrike),

    // Time features
    timeRemaining: timeRemaining,
    timeUrgency: timeRemaining > 0 ? 1 / timeRemaining : 1,
    isLastMinute: timeRemaining <= 2 ? 1 : 0,

    // Momentum features
    momentum1m: momentum.pct1m || 0,
    momentum5m: momentum.pct5m || 0,
    momentumAlignment: (momentum.pct1m || 0) * (momentum.pct5m || 0) > 0 ? 1 : -1,
    momentumStrength: Math.abs(momentum.pct1m || 0) + Math.abs(momentum.pct5m || 0),

    // Volatility features
    volatility: volatility * 100,
    volToDistance: Math.abs(distanceFromStrike) / (volatility * 100 + 0.01),

    // Market features
    marketImpliedProb: opportunity.marketPrice || opportunity.betPrice * 100 || 50,
    priceDeviation: (opportunity.winProbability || 50) - (opportunity.marketPrice || 50),

    // Signal strength
    signalStrength: opportunity.confidence === 'high' ? 2 : opportunity.confidence === 'medium' ? 1 : 0,
    edge: opportunity.edge || 0,

    // Token indicators (one-hot)
    tokenBTC: opportunity.token === 'BTC' || opportunity.assetType === 'BTC' ? 1 : 0,
    tokenETH: opportunity.token === 'ETH' || opportunity.assetType === 'ETH' ? 1 : 0,
    tokenSOL: opportunity.token === 'SOL' || opportunity.assetType === 'SOL' ? 1 : 0,

    // Time-of-day indicators
    hourMorning: hour >= 6 && hour < 12 ? 1 : 0,
    hourAfternoon: hour >= 12 && hour < 18 ? 1 : 0,
    hourEvening: hour >= 18 && hour < 24 ? 1 : 0,
    hourNight: hour >= 0 && hour < 6 ? 1 : 0,

    // Side indicators
    sideYes: opportunity.betSide?.toLowerCase() === 'yes' ? 1 : 0,
    sideNo: opportunity.betSide?.toLowerCase() === 'no' ? 1 : 0
  };
}

// Calculate ML adjustment to probability
function getMLAdjustment(features) {
  if (mlModel.trainedOn < 10) {
    // Not enough training data yet
    return { adjustment: 0, confidence: 'low', reason: 'insufficient_training_data' };
  }

  let adjustment = 0;
  const contributions = {};

  // Calculate weighted sum of features
  for (const [feature, weight] of Object.entries(mlModel.weights)) {
    if (features[feature] !== undefined && weight !== 0) {
      const contribution = features[feature] * weight;
      adjustment += contribution;
      if (Math.abs(contribution) > 0.5) {
        contributions[feature] = contribution.toFixed(2);
      }
    }
  }

  // Clamp adjustment to reasonable range (-15% to +15%)
  adjustment = Math.max(-15, Math.min(15, adjustment));

  const confidence = mlModel.trainedOn >= 50 ? 'high' : mlModel.trainedOn >= 20 ? 'medium' : 'low';

  return {
    adjustment: parseFloat(adjustment.toFixed(2)),
    confidence,
    trainedOn: mlModel.trainedOn,
    topContributions: contributions,
    reason: Object.keys(contributions).length > 0
      ? `Key factors: ${Object.keys(contributions).join(', ')}`
      : 'No strong signals'
  };
}

// Apply ML adjustment to a probability prediction
function applyMLAdjustment(baseProbability, features) {
  const mlResult = getMLAdjustment(features);

  // Blend ML adjustment with base probability
  // Use less ML influence when confidence is low
  const influenceMultiplier = mlResult.confidence === 'high' ? 1.0 :
                              mlResult.confidence === 'medium' ? 0.6 : 0.3;

  const adjustedProb = baseProbability + (mlResult.adjustment * influenceMultiplier);

  // Clamp to valid probability range
  const finalProb = Math.max(5, Math.min(95, adjustedProb));

  return {
    baseProbability,
    mlAdjustment: mlResult.adjustment * influenceMultiplier,
    finalProbability: parseFloat(finalProb.toFixed(1)),
    mlConfidence: mlResult.confidence,
    mlDetails: mlResult
  };
}

// Update ML model with outcome (called when bet settles)
function updateMLModel(bet, outcome) {
  if (!bet.mlFeatures) return;

  const features = bet.mlFeatures;
  const won = outcome === 'won' ? 1 : 0;
  const predictedProb = (bet.predictedProb || 50) / 100;  // Convert to 0-1
  const error = won - predictedProb;  // Positive if we underestimated, negative if overestimated

  // Online learning: adjust weights based on error
  const lr = mlModel.learningRate;

  for (const [feature, value] of Object.entries(features)) {
    if (mlModel.weights[feature] !== undefined && value !== 0) {
      // Gradient descent update
      mlModel.weights[feature] += lr * error * value;

      // Regularization: keep weights from getting too extreme
      mlModel.weights[feature] *= 0.99;
    }
  }

  mlModel.trainedOn++;

  // Track recent prediction accuracy
  mlModel.performance.predictions.push({
    predicted: predictedProb,
    actual: won,
    error: Math.abs(error)
  });

  // Keep only last 100 predictions
  if (mlModel.performance.predictions.length > 100) {
    mlModel.performance.predictions.shift();
  }

  // Update accuracy metrics
  const recentPreds = mlModel.performance.predictions;
  mlModel.performance.accuracy = recentPreds.filter(p =>
    (p.predicted >= 0.5 && p.actual === 1) || (p.predicted < 0.5 && p.actual === 0)
  ).length / recentPreds.length;

  mlModel.performance.avgAdjustment = recentPreds.reduce((sum, p) => sum + p.error, 0) / recentPreds.length;

  saveMLModel();

  console.log(`🧠 ML Model updated: ${mlModel.trainedOn} training samples, ${(mlModel.performance.accuracy * 100).toFixed(1)}% accuracy`);
}

// Get ML model status for API
function getMLModelStatus() {
  return {
    version: mlModel.version,
    trainedOn: mlModel.trainedOn,
    lastUpdated: mlModel.lastUpdated,
    accuracy: mlModel.performance.accuracy ? (mlModel.performance.accuracy * 100).toFixed(1) + '%' : 'N/A',
    avgError: mlModel.performance.avgAdjustment ? (mlModel.performance.avgAdjustment * 100).toFixed(1) + '%' : 'N/A',
    learningRate: mlModel.learningRate,
    status: mlModel.trainedOn >= 50 ? 'trained' : mlModel.trainedOn >= 10 ? 'learning' : 'collecting_data',
    topWeights: Object.entries(mlModel.weights)
      .filter(([k, v]) => Math.abs(v) > 0.1)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 10)
      .map(([feature, weight]) => ({ feature, weight: weight.toFixed(3) }))
  };
}

// Load ML model on startup
loadMLModel();

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

// Load performance data on startup (async)
(async () => {
  await loadPerformanceData();
})();

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

// Track pending exposure per token (bets placed that may not be in positions yet)
// Key: token (BTC, ETH, etc.), Value: { amount: cents, timestamp }
// This prevents over-betting on same token before Kalshi positions update
const pendingTokenExposure = new Map();

// Add pending exposure for a token
function addPendingExposure(token, amountCents) {
  if (!token) {
    console.log(`⚠️ addPendingExposure called with no token!`);
    return;
  }
  const current = pendingTokenExposure.get(token) || { amount: 0, timestamp: Date.now() };
  current.amount += amountCents;
  current.timestamp = Date.now();
  pendingTokenExposure.set(token, current);
  console.log(`   📝 PENDING EXPOSURE: ${token} +$${(amountCents/100).toFixed(2)} → NOW $${(current.amount/100).toFixed(2)} total pending`);

  // Log all pending exposure
  const allPending = [];
  for (const [t, d] of pendingTokenExposure.entries()) {
    allPending.push(`${t}=$${(d.amount/100).toFixed(2)}`);
  }
  console.log(`   📝 All pending: ${allPending.join(', ')}`);
}

// Clean up old pending exposure (older than 2 minutes - positions should have updated by then)
function cleanupPendingExposure() {
  const now = Date.now();
  const EXPIRY = 2 * 60 * 1000; // 2 minutes (was 5, reduced for faster cleanup)
  for (const [token, data] of pendingTokenExposure.entries()) {
    if (now - data.timestamp > EXPIRY) {
      pendingTokenExposure.delete(token);
    }
  }
}

// Clean up settled positions from portfolio cache
// This removes positions for markets that have likely expired
function cleanupSettledPositions() {
  if (!portfolio.positions || !Array.isArray(portfolio.positions)) return;

  const now = Date.now();
  const beforeCount = portfolio.positions.length;

  portfolio.positions = portfolio.positions.filter(pos => {
    // Check if this is a 15-minute crypto market
    if (pos.ticker && pos.ticker.includes('15M')) {
      // Check if we have a close_time or can infer expiry
      if (pos.close_time) {
        const closeTime = new Date(pos.close_time).getTime();
        if (now > closeTime) {
          console.log(`   🧹 Removing expired position: ${pos.ticker} (expired ${Math.round((now - closeTime) / 1000)}s ago)`);
          return false;
        }
      }
      // Also check if the bet is in our settled list
      const settledBet = performanceData.bets.find(b =>
        b.ticker === pos.ticker &&
        (b.outcome === 'won' || b.outcome === 'lost')
      );
      if (settledBet) {
        console.log(`   🧹 Removing settled position: ${pos.ticker} (${settledBet.outcome})`);
        return false;
      }
    }
    return true;
  });

  if (beforeCount > portfolio.positions.length) {
    console.log(`   🧹 Cleaned up ${beforeCount - portfolio.positions.length} settled positions`);
  }
}

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
const AUTO_BET_MIN_EDGE = 2;      // 2% edge for auto (lowered for more volume)
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

// Binance symbol mapping (PRIMARY - faster, <1s latency)
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

// Fetch prices from Binance (PRIMARY - very fast)
async function fetchBinancePrices() {
  try {
    const symbols = Object.values(BINANCE_SYMBOLS);
    // Use Binance.US for US-based users (api.binance.com blocks US IPs)
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

// ============================================
// MOMENTUM BETTING SIGNAL - Our actual edge
// ============================================
// For 15-min markets: follow recent momentum
// This is simpler and more profitable than complex probability models

function getMomentumBetSignal(token) {
  const history = priceHistoryExtended[token];
  if (!history || history.length < 10) {
    return { direction: 'neutral', strength: 0, ret1: 0, ret2: 0, ret5: 0 };
  }

  const now = Date.now();
  const latest = history[history.length - 1];
  if (!latest || now - latest.time > 60000) {
    return { direction: 'neutral', strength: 0, ret1: 0, ret2: 0, ret5: 0 };
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

  const price1min = findPriceAt(60);
  const price2min = findPriceAt(120);
  const price5min = findPriceAt(300);

  const ret1 = ((latestPrice - price1min) / price1min) * 100;
  const ret2 = ((latestPrice - price2min) / price2min) * 100;
  const ret5 = ((latestPrice - price5min) / price5min) * 100;

  // Simple: what direction is price moving?
  let direction = 'neutral';
  let strength = 0;

  if (ret1 > 0.005 && ret2 > 0) {
    direction = 'up';
    strength = Math.abs(ret2);
  } else if (ret1 < -0.005 && ret2 < 0) {
    direction = 'down';
    strength = Math.abs(ret2);
  } else if (Math.abs(ret2) > 0.02) {
    direction = ret2 > 0 ? 'up' : 'down';
    strength = Math.abs(ret2);
  }

  return { direction, strength, ret1, ret2, ret5 };
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
  // With Binance (3s updates), we can detect momentum faster than Kalshi prices adjust
  const momentum = calculateMomentumMultiTimeframe(allHistory);
  const shortMomentum = calculateMomentum(allHistory, 2); // Last 2 minutes
  const veryShortMomentum = calculateMomentum(allHistory, 1); // Last 1 minute (Binance speed advantage)

  let momentumAdjust = 0;
  // Very short-term momentum with fast Binance data = our biggest edge
  if (veryShortMomentum.strength === 'strong') {
    momentumAdjust = veryShortMomentum.direction === 'up' ? 0.18 : -0.18;
  } else if (shortMomentum.strength === 'strong') {
    momentumAdjust = shortMomentum.direction === 'up' ? 0.15 : -0.15;
  } else if (shortMomentum.strength === 'moderate') {
    momentumAdjust = shortMomentum.direction === 'up' ? 0.10 : -0.10;
  } else if (momentum.aligned) {
    momentumAdjust = momentum.direction === 'bullish' ? 0.06 : -0.06;
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

  // With Binance fast data, we can trust our momentum signals more
  // Only apply shrinkage when momentum is weak (uncertain)
  const hasStrongMomentumSignal = veryShortMomentum.strength === 'strong' ||
                                   shortMomentum.strength === 'strong' ||
                                   shortMomentum.strength === 'moderate';

  if (!hasStrongMomentumSignal) {
    // Weak momentum = less confident = shrink toward 50%
    const uncertaintyFactor = 0.88; // Less shrinkage with faster data (was 0.85)
    ensembleProbAbove = 0.5 + (ensembleProbAbove - 0.5) * uncertaintyFactor;
  }
  // Strong momentum = trust the signal, no shrinkage

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

// Start price tracking (every 3 seconds with Binance, faster = better edge detection)
const PRICE_REFRESH_MS = 3000;
let priceInterval = setInterval(fetchCryptoPrices, PRICE_REFRESH_MS);
fetchCryptoPrices().then(() => {
  console.log(`📊 Price source: ${priceSource.toUpperCase()} (refreshing every ${PRICE_REFRESH_MS/1000}s)`);
});

// Check for settled bets every 30 seconds
const SETTLEMENT_CHECK_MS = 30000;
setInterval(checkPendingSettlements, SETTLEMENT_CHECK_MS);
console.log(`📊 Settlement check: every ${SETTLEMENT_CHECK_MS/1000}s`);

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

// DISABLED: S&P 500 price tracking (focusing on crypto only)
// let indexPriceInterval = setInterval(fetchIndexPrice, 15000);
// fetchIndexPrice();

// ============================================
// RISK MANAGEMENT
// ============================================

// Risk limits are now configurable via config.riskLimits
function getMaxRisk() {
  return config.riskLimits.maxTotal || 1500;
}

function getMaxPerBet() {
  return config.riskLimits.maxPerBet;
}

// Kelly Criterion bet sizing - mathematically optimal for long-term growth
// Uses Half Kelly (50%) - balance of growth and capital preservation
// Returns 0 if bet would be below $1 minimum (skip small edge bets)
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

  // Use Half Kelly (50%) - good balance of growth and safety
  const KELLY_FRACTION = 0.50;
  const adjustedKelly = kellyFraction * KELLY_FRACTION;

  // Cap Kelly at 15% of bankroll for any single bet (risk management)
  const cappedKelly = Math.min(adjustedKelly, 0.15);

  // Calculate bet size in cents
  let betSize = Math.floor(bankrollCents * cappedKelly);

  // Cap at max per bet
  betSize = Math.min(betSize, maxBetCents);

  // Minimum bet of $1 (100 cents) - skip if Kelly suggests less
  // This avoids taking tiny edge bets that aren't worth the exposure
  const MIN_BET_CENTS = 100;
  if (betSize < MIN_BET_CENTS) return 0;

  return betSize;
}

function getMaxTotalRisk() {
  return config.riskLimits.maxTotal || 1500;
}

// Get current total exposure - counts Kalshi positions + pending bets
function getCurrentExposure() {
  // Clean up old pending exposure first
  cleanupPendingExposure();

  // Also clean up settled positions from portfolio cache
  cleanupSettledPositions();

  let totalExposure = 0;

  // Count actual Kalshi positions
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        let posExposure;

        // Check market_exposure first (most accurate if available)
        if (pos.market_exposure && pos.market_exposure > 0) {
          posExposure = pos.market_exposure;
        } else {
          // Fall back to calculating from average_price
          let avgPrice = pos.average_price || 75; // Conservative fallback (was 50)
          // Kalshi returns average_price as decimal (0.85) not cents (85)
          if (avgPrice > 0 && avgPrice <= 1) {
            avgPrice = Math.round(avgPrice * 100);
          }
          posExposure = contracts * avgPrice;
        }

        const token = getTokenFromTicker(pos.ticker);
        console.log(`   📊 Position: ${pos.ticker} (${token}) | ${contracts} contracts | exposure=$${(posExposure/100).toFixed(2)} | avg_price=${pos.average_price} | market_exposure=${pos.market_exposure}`);
        totalExposure += posExposure;
      }
    }
  }

  // Add pending exposure (bets placed recently that may not be in positions yet)
  let pendingTotal = 0;
  for (const [token, data] of pendingTokenExposure.entries()) {
    pendingTotal += data.amount;
  }
  if (pendingTotal > 0) {
    console.log(`   📊 Pending exposure: $${(pendingTotal/100).toFixed(2)}`);
    totalExposure += pendingTotal;
  }

  console.log(`   📊 TOTAL EXPOSURE: $${(totalExposure/100).toFixed(2)}`);
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
  return (getCurrentExposure() + betCostCents) <= getMaxTotalRisk();
}

function getRemainingRiskBudget() {
  return Math.max(0, getMaxTotalRisk() - getCurrentExposure());
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

// Get total exposure per token - counts Kalshi positions + pending bets
function getExposureByToken() {
  // Clean up old pending exposure first
  cleanupPendingExposure();

  const tokenExposure = {};

  // Count actual Kalshi positions
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        let posRisk;

        // Check market_exposure first (most accurate if available)
        if (pos.market_exposure && pos.market_exposure > 0) {
          posRisk = pos.market_exposure;
        } else {
          // Fall back to calculating from average_price
          let avgPrice = pos.average_price || 75; // Conservative fallback (was 50)
          // Kalshi returns average_price as decimal (0.85) not cents (85)
          if (avgPrice > 0 && avgPrice <= 1) {
            avgPrice = Math.round(avgPrice * 100);
          }
          posRisk = contracts * avgPrice;
        }

        const token = getTokenFromTicker(pos.ticker);
        if (token) {
          tokenExposure[token] = (tokenExposure[token] || 0) + posRisk;
        }
      }
    }
  }

  // Add pending exposure (bets placed recently that may not be in positions yet)
  for (const [token, data] of pendingTokenExposure.entries()) {
    tokenExposure[token] = (tokenExposure[token] || 0) + data.amount;
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
  if (!token) {
    console.log(`⚠️ Could not determine token from ticker=${ticker}, assetType=${assetType}`);
    return getMaxPerToken(); // If can't determine token, use full budget
  }

  const tokenExposure = getExposureByToken();
  const currentExposure = tokenExposure[token] || 0;
  const maxPerToken = getMaxPerToken();
  const remaining = Math.max(0, maxPerToken - currentExposure);

  // Debug log for token limit tracking
  console.log(`   💵 Token ${token}: exposure=$${(currentExposure/100).toFixed(2)}, max=$${(maxPerToken/100).toFixed(2)}, remaining=$${(remaining/100).toFixed(2)}`);

  return remaining;
}

// Get timeframe from ticker (15min, hourly, daily)
function getTimeframeFromTicker(ticker) {
  if (!ticker) return '15min';
  const t = ticker.toUpperCase();
  if (t.includes('1H')) return 'hourly';
  if (t.includes('15M')) return '15min';
  if (t.includes('1D') || t.includes('DAILY')) return 'daily';
  return '15min'; // default
}

// Get exposure by market timeframe
function getExposureByTimeframe() {
  cleanupPendingExposure();

  const timeframeExposure = { '15min': 0, 'hourly': 0, 'daily': 0 };

  // Count actual Kalshi positions
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      const contracts = Math.abs(pos.position || 0);
      if (contracts > 0) {
        let posRisk;

        if (pos.market_exposure && pos.market_exposure > 0) {
          posRisk = pos.market_exposure;
        } else {
          let avgPrice = pos.average_price || 75;
          if (avgPrice > 0 && avgPrice <= 1) {
            avgPrice = Math.round(avgPrice * 100);
          }
          posRisk = contracts * avgPrice;
        }

        const timeframe = getTimeframeFromTicker(pos.ticker);
        timeframeExposure[timeframe] = (timeframeExposure[timeframe] || 0) + posRisk;
      }
    }
  }

  // Add pending exposure by timeframe
  for (const [token, data] of pendingTokenExposure.entries()) {
    // Pending exposure doesn't track timeframe, so skip here
    // (Could enhance pendingTokenExposure to track timeframe if needed)
  }

  return timeframeExposure;
}

// Get max allowed (simplified - no more timeframe limits)
function getMaxPerTimeframe(timeframe) {
  return config.riskLimits.maxTotal || 1500;
}

// Get remaining budget (simplified - just use total remaining)
function getRemainingTimeframeBudget(ticker) {
  return getRemainingRiskBudget();
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
  // DISABLED: Focusing on crypto algorithm only
  // S&P 500 / index markets are disabled for now
  return [];
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

  // Calculate bid-ask spread (in cents)
  // Spread is our transaction cost - need edge > spread to profit
  const yesSpreadCents = Math.round((yesAsk - yesBid) * 100);
  const noSpreadCents = Math.round((noAsk - noBid) * 100);

  // Detect market timeframe from ticker
  let marketTimeframe = '15min'; // default
  if (ticker.includes('1H')) {
    marketTimeframe = 'hourly';
  } else if (ticker.includes('15M')) {
    marketTimeframe = '15min';
  } else if (ticker.includes('1D') || ticker.includes('DAILY')) {
    marketTimeframe = 'daily';
  }

  return {
    ticker: market.ticker,
    title: market.title,
    cryptoType,
    strikePrice,
    marketType,
    marketTimeframe,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    yesSpreadCents,
    noSpreadCents,
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
    marketTimeframe: parsed.marketTimeframe || '15min',
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
  const strikePrice = parsed.strikePrice || currentPrice;
  const timeMinutes = parsed.timeRemainingMinutes || 15;
  const yesPrice = parsed.yesAsk || 0.5;
  const noPrice = parsed.noAsk || 0.5;
  const marketTimeframe = parsed.marketTimeframe || '15min';
  const isHourly = marketTimeframe === 'hourly';

  // Get momentum info (not for betting decision, just context)
  const momentum = getMomentumBetSignal(parsed.cryptoType);

  // === PRICE STALENESS DETECTION ===
  // Check if Kalshi price seems stale (hasn't reacted to crypto movement)
  // This is our edge window - market makers haven't updated yet
  const yesPriceCents = Math.round(yesPrice * 100);
  const noPriceCents = Math.round(noPrice * 100);

  // Compare what Kalshi implies vs what our model says
  // If big gap + recent momentum, Kalshi might be stale
  let priceStaleness = 0;
  if (momentum.strength > 0.01) {
    // If crypto moved significantly in last 2 min and Kalshi price seems off
    const recentMove = Math.abs(momentum.ret2 || 0);
    if (recentMove > 0.1) {
      // Crypto moved 0.1%+ in 2 min - check if Kalshi reacted
      // Stale price = our edge opportunity
      priceStaleness = recentMove;
    }
  }

  // === SIMPLE POSITION-BASED STRATEGY ===
  // Core idea: If price is on one side of strike, bet that side
  // The market already prices this - we bet when we think it's underpriced

  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice) * 100;
  const isAboveStrike = currentPrice > strikePrice;
  const isBelowStrike = currentPrice < strikePrice;
  const distanceFromStrike = Math.abs(pctFromStrike);

  // Determine which side to bet
  let betSide = null;
  let betPrice = null;
  let betPriceCents = 0;

  if (isAboveStrike) {
    betSide = 'YES';
    betPrice = yesPrice;
    betPriceCents = Math.round(yesPrice * 100);
  } else if (isBelowStrike) {
    betSide = 'NO';
    betPrice = noPrice;
    betPriceCents = Math.round(noPrice * 100);
  } else {
    // Price exactly at strike - no bet
    return buildNoSignalResult(parsed, currentPrice, strikePrice, timeMinutes, momentum, 'Price at strike');
  }

  // === CONFIDENCE SCORING ===
  // Based on: distance from strike, time remaining, momentum alignment
  let confidence = 'low';
  let score = 0;

  // Distance from strike (most important)
  if (distanceFromStrike >= 0.5) score += 4;      // 0.5%+ away = very strong
  else if (distanceFromStrike >= 0.3) score += 3; // 0.3%+ away = strong
  else if (distanceFromStrike >= 0.15) score += 2; // 0.15%+ away = moderate
  else if (distanceFromStrike >= 0.05) score += 1; // 0.05%+ away = slight
  // Below 0.05% = too close, risky

  // Time remaining (less time = price more likely to stay)
  // Adjust thresholds for hourly markets (4x the time)
  if (isHourly) {
    if (timeMinutes <= 12) score += 3;       // Very little time (hourly)
    else if (timeMinutes <= 20) score += 2;  // Little time
    else if (timeMinutes <= 32) score += 1;  // Some time
    // More than 32 min = lots can change
  } else {
    if (timeMinutes <= 3) score += 3;       // Very little time (15-min)
    else if (timeMinutes <= 5) score += 2;  // Little time
    else if (timeMinutes <= 8) score += 1;  // Some time
    // More than 8 min = lots can change
  }

  // Momentum alignment
  const momentumHelps = (betSide === 'YES' && momentum.direction === 'up') ||
                        (betSide === 'NO' && momentum.direction === 'down');
  const momentumHurts = (betSide === 'YES' && momentum.direction === 'down') ||
                        (betSide === 'NO' && momentum.direction === 'up');

  if (momentumHelps && momentum.strength >= 0.02) score += 2;
  else if (momentumHelps) score += 1;
  else if (momentumHurts && momentum.strength >= 0.05) score -= 2; // Strong opposing momentum is bad
  else if (momentumHurts) score -= 1;

  // Convert score to confidence
  if (score >= 6) confidence = 'very_high';
  else if (score >= 4) confidence = 'high';
  else if (score >= 2) confidence = 'medium';
  else confidence = 'low';

  // === SHOULD WE BET? ===
  // Minimum requirements to bet:
  // 1. Price must be at least 0.03% from strike (not dead even)
  // 2. Market price must be reasonable (15-90 cents)
  // 3. Must have SOME confidence (score >= 1)

  const tooCloseToStrike = distanceFromStrike < 0.03;
  const priceTooLow = betPriceCents < 15;
  const priceTooHigh = betPriceCents > 90;
  const noConfidence = score < 1;

  if (tooCloseToStrike) {
    return buildNoSignalResult(parsed, currentPrice, strikePrice, timeMinutes, momentum,
      `Too close to strike (${distanceFromStrike.toFixed(3)}%)`);
  }

  if (priceTooLow) {
    return buildNoSignalResult(parsed, currentPrice, strikePrice, timeMinutes, momentum,
      `Market price too low (${betPriceCents}¢)`);
  }

  if (priceTooHigh) {
    return buildNoSignalResult(parsed, currentPrice, strikePrice, timeMinutes, momentum,
      `Market price too high (${betPriceCents}¢) - no value`);
  }

  // === CALCULATE EDGE USING ENSEMBLE PROBABILITY ===
  // Use the sophisticated ensemble model instead of fixed adjustments
  // This gives us data-driven edge based on actual probability calculations

  // Get ensemble probability from our statistical model
  const prediction = predictOutcome(parsed.cryptoType, currentPrice, strikePrice, timeMinutes);

  // Use the appropriate probability based on bet side
  // YES bet wins if price ends above strike → use probAbove
  // NO bet wins if price ends below strike → use probBelow
  let ensembleProb = betSide === 'YES' ? prediction.probAbove : prediction.probBelow;

  // Convert to percentage (0-100 scale to match betPriceCents)
  let ourProbability = ensembleProb * 100;

  // Apply confidence-based floor: don't let ensemble go too extreme without confidence
  // This prevents betting on weak signals
  const minProbByConfidence = {
    'very_high': 55,
    'high': 52,
    'medium': 50,
    'low': 48
  };
  ourProbability = Math.max(minProbByConfidence[confidence] || 50, ourProbability);

  // Cap at reasonable bounds
  ourProbability = Math.max(15, Math.min(92, ourProbability));

  // Apply ML adjustment if model has learned enough
  let mlAdjustment = 0;
  if (mlModel.trainedOn >= 10) {
    try {
      const mlFeatures = extractMLFeatures({
        token: parsed.cryptoType,
        strikePrice,
        currentPrice,
        timeRemainingMinutes: timeMinutes,
        volatility: priceData.volatility,
        momentum,
        betSide,
        confidence,
        winProbability: ourProbability,
        marketPrice: betPriceCents,
        edge: ourProbability - betPriceCents
      }, priceData);
      const mlResult = getMLAdjustment(mlFeatures);
      mlAdjustment = mlResult.adjustment * (mlResult.confidence === 'high' ? 1.0 : mlResult.confidence === 'medium' ? 0.6 : 0.3);
      ourProbability = Math.max(15, Math.min(92, ourProbability + mlAdjustment));
    } catch (err) {
      // ML adjustment failed, continue without it
    }
  }

  const edge = ourProbability - betPriceCents;

  // Expected value
  const potentialWin = 100 - betPriceCents;
  const ev = (ourProbability / 100) * potentialWin - ((100 - ourProbability) / 100) * betPriceCents;

  // === SAFE vs DEGEN vs DEGEN-SAFE ===
  // SAFE: Auto-bet will place these
  // DEGEN-SAFE: Auto-bet when degen mode enabled (low price + strong momentum)
  // DEGEN: Manual only - too risky for auto

  // Momentum indicators
  const hasMomentum = momentum.direction !== 'neutral';
  const hasAlignedMomentum = momentum.aligned && momentum.strength >= 1;
  const hasStrongMomentum = momentum.aligned && momentum.strength >= 2;

  // Time limits depend on PRICE and MOMENTUM:
  // HIGH PRICE (60¢+): "Stay the course" bets - price just needs to NOT move much
  //   → More lenient on time, momentum matters less
  //   → Allow up to 12 min regardless of momentum
  // MID PRICE (40-59¢): Could go either way
  //   → Momentum-based time limits
  // LOW PRICE (<40¢): Need price to MOVE toward strike
  //   → Handled by degen mode (requires strong momentum)

  // Time limits depend on PRICE, MOMENTUM, and TIMEFRAME:
  // Hourly markets get ~4x the time thresholds
  let maxTimeForSafe;
  const timeMultiplier = isHourly ? 4 : 1;

  if (betPriceCents >= 60) {
    // High price = high probability = betting on stability
    // These are safe earlier because we're betting price STAYS, not MOVES
    maxTimeForSafe = 15 * timeMultiplier;  // Increased from 12
  } else {
    // Mid price (35-59¢) = use momentum-based limits (loosened for more volume)
    const baseTime = hasStrongMomentum ? 15 : hasAlignedMomentum ? 12 : hasMomentum ? 10 : 8;
    maxTimeForSafe = baseTime * timeMultiplier;
  }

  // Loosened: 35¢+ (was 40¢), score >= 1 (was 2)
  let isSafe = edge > 0 && betPriceCents >= 35 && timeMinutes <= maxTimeForSafe && score >= 1;

  // CRITICAL: Block bets where momentum is actively against us with significant time left
  // This prevents NO bets when price is trending UP (and vice versa)
  // For 15-min: 4+ minutes is risky. For hourly: 16+ minutes is risky.
  const momentumBlockTime = isHourly ? 16 : 4;
  if (momentumHurts && momentum.strength >= 0.01 && timeMinutes > momentumBlockTime) {
    isSafe = false;  // Don't auto-bet against momentum with significant time left
  }

  // Check if qualifies for degen-safe (low price but strong momentum)
  // No hard time limit - momentum is the gatekeeper
  // Betting early before Kalshi adjusts can capture better odds
  const degenSettings = config.degenMode;
  const isDegenSafe = degenSettings.enabled &&
    edge > 0 &&
    betPriceCents >= degenSettings.minPrice &&
    betPriceCents < 40 &&
    (!degenSettings.requireStrongMomentum || hasStrongMomentum);

  const isDegen = edge > 0 && !isSafe && !isDegenSafe; // Everything else with edge is manual only

  // Build reason string
  const dirStr = isAboveStrike ? 'above' : 'below';
  const momStr = momentum.direction !== 'neutral' ? ` | momentum ${momentum.direction}` : '';
  const reason = `Price ${distanceFromStrike.toFixed(2)}% ${dirStr} strike, ${timeMinutes}m left${momStr}`;

  // Calculate Kelly fraction for optimal bet sizing
  // Kelly formula: f* = (p * b - q) / b where p = win prob, q = lose prob, b = odds
  // For binary options: b = (100 - price) / price (what you win vs what you risk)
  // Simplified: kellyFraction = edge / (100 - price)
  const kellyFraction = edge > 0 ? edge / (100 - betPriceCents) : 0;
  // Use Half Kelly for balance of growth and safety
  const halfKelly = kellyFraction * 0.5;
  // Cap Kelly at 15% of bankroll max for any single bet
  const cappedKelly = Math.min(halfKelly, 0.15);

  // Get spread for our bet side
  const spreadCents = betSide === 'YES' ? (parsed.yesSpreadCents || 0) : (parsed.noSpreadCents || 0);

  // Net edge after spread (what we actually keep)
  const netEdge = edge - spreadCents;

  // If spread eats all our edge, this isn't profitable
  const spreadWarning = spreadCents > 0 && edge > 0 && netEdge < 1;

  return {
    ticker: parsed.ticker,
    title: parsed.title,
    cryptoType: parsed.cryptoType,
    assetType: parsed.cryptoType,
    marketType: parsed.marketType,
    marketTimeframe,
    currentPrice,
    strikePrice,
    pctFromStrike: pctFromStrike.toFixed(3),
    timeRemaining: parsed.timeRemaining,
    timeRemainingMinutes: timeMinutes,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    yesAsk: yesPrice,
    noAsk: noPrice,
    betPriceCents,
    betSide,
    betPrice,
    winProbability: ourProbability.toFixed(1),
    ensembleProbability: (ensembleProb * 100).toFixed(1),
    edge: edge,
    spreadCents,       // Bid-ask spread (transaction cost)
    netEdge,           // Edge after spread
    spreadWarning,     // True if spread eats most of our edge
    mlAdjustment: mlAdjustment ? mlAdjustment.toFixed(1) : '0',
    expectedValue: ev.toFixed(2),
    kellyFraction: (kellyFraction * 100).toFixed(1),  // As percentage
    recommendedBetFraction: (cappedKelly * 100).toFixed(1),  // Half Kelly, capped
    isRecommended: edge > 0 && !spreadWarning,  // Don't recommend if spread kills edge
    isDegen,
    isSafe: isSafe && !spreadWarning,  // Not safe if spread eats edge
    isDegenSafe,
    confidence,
    confidenceScore: score,
    momentumSignal: momentum,
    reason: spreadWarning ? `${reason} | ⚠️ Spread (${spreadCents}¢) eats edge` : reason
  };
}

// Helper for no-signal results
function buildNoSignalResult(parsed, currentPrice, strikePrice, timeMinutes, momentum, reason) {
  return {
    ticker: parsed.ticker,
    title: parsed.title,
    cryptoType: parsed.cryptoType,
    assetType: parsed.cryptoType,
    marketType: parsed.marketType,
    currentPrice,
    strikePrice,
    pctFromStrike: (((currentPrice - strikePrice) / strikePrice) * 100).toFixed(3),
    timeRemaining: parsed.timeRemaining,
    timeRemainingMinutes: timeMinutes,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    yesAsk: parsed.yesAsk || 0.5,
    noAsk: parsed.noAsk || 0.5,
    betSide: null,
    betPrice: null,
    betPriceCents: 0,
    winProbability: 50,
    edge: 0,
    expectedValue: 0,
    isRecommended: false,
    isDegen: false,
    isSafe: false,
    confidence: 'none',
    momentumSignal: momentum,
    reason
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

// Get ALL opportunities (crypto only) - unified endpoint
// Add ?showAll=true to include markets without edge (for debugging)
app.get('/api/opportunities/all', async (req, res) => {
  try {
    const showAll = req.query.showAll === 'true';

    // Fetch crypto markets only
    const cryptoMarkets = await fetchCryptoMarkets();

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

    // Combine all analyzed markets (just crypto now)
    const allAnalyzed = cryptoOpps;

    // ALWAYS include BTC, ETH, SOL - pick BEST strike per token
    const coreTokens = ['BTC', 'ETH', 'SOL'];
    const coreMarkets = [];

    for (const token of coreTokens) {
      // Find ALL markets for this token
      const tokenMarkets = cryptoOpps.filter(m =>
        (m.cryptoType === token || m.assetType === token)
      );

      if (tokenMarkets.length > 0) {
        // Pick the one with highest edge (best opportunity)
        const bestMarket = tokenMarkets.reduce((best, current) => {
          const bestEdge = parseFloat(best.edge) || 0;
          const currentEdge = parseFloat(current.edge) || 0;
          return currentEdge > bestEdge ? current : best;
        });

        // Mark as locked if not recommended
        bestMarket.isLocked = !bestMarket.isRecommended;
        bestMarket.isCore = true;
        coreMarkets.push(bestMarket);
      } else {
        // Create placeholder for 15min
        const price = cryptoPrices[token]?.price || 0;
        coreMarkets.push({
          ticker: `KX${token}15M-PLACEHOLDER`,
          title: `${token} 15-min prediction`,
          cryptoType: token,
          assetType: token,
          marketCategory: 'crypto',
          marketTimeframe: '15min',
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
          filterReason: 'No signal'
        });
      }
    }

    // Filter to recommended only, exclude markets already in coreMarkets
    const coreMarketTickers = new Set(coreMarkets.map(m => m.ticker));
    const recommendedOpps = allAnalyzed.filter(m => m.isRecommended && !coreMarketTickers.has(m.ticker));

    // Exclude core tokens entirely (we already have best strike for each)
    const nonCoreRecommended = recommendedOpps.filter(m =>
      !coreTokens.includes(m.cryptoType) && !coreTokens.includes(m.assetType)
    );

    // Core markets first (BTC, ETH, SOL), then other recommended
    const allOpportunities = [...coreMarkets, ...nonCoreRecommended]
      .sort((a, b) => {
        // Core markets first
        if (a.isCore && !b.isCore) return -1;
        if (!a.isCore && b.isCore) return 1;
        // Then by recommended status
        if (a.isRecommended && !b.isRecommended) return -1;
        if (!a.isRecommended && b.isRecommended) return 1;
        // Then by edge
        return parseFloat(b.edge || 0) - parseFloat(a.edge || 0);
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

    // Price display (crypto only - index disabled)
    const priceDisplay = {
      crypto: {},
      source: priceSource,
      refreshMs: PRICE_REFRESH_MS
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
      indexCount: 0,
      prices: priceDisplay,
      risk: {
        current: riskByType.total,
        max: getMaxTotalRisk(),
        remaining: getTotalRemainingBudget(),
        currentDollars: (riskByType.total / 100).toFixed(2),
        maxDollars: (getMaxTotalRisk() / 100).toFixed(2),
        remainingDollars: (getTotalRemainingBudget() / 100).toFixed(2),
        positionCount: portfolio.positions?.length || 0
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
          let avgPrice = pos.average_price || 50;
          // Kalshi returns average_price as decimal (0.85) not cents (85)
          if (avgPrice > 0 && avgPrice <= 1) {
            avgPrice = Math.round(avgPrice * 100);
          }
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
  const { maxPerBet, maxPerToken, maxTotal } = req.body;

  if (maxPerBet !== undefined) {
    config.riskLimits.maxPerBet = Math.max(10, Math.min(1000, parseInt(maxPerBet) || 500));
  }
  if (maxPerToken !== undefined) {
    config.riskLimits.maxPerToken = Math.max(100, Math.min(5000, parseInt(maxPerToken) || 500));
  }
  if (maxTotal !== undefined) {
    config.riskLimits.maxTotal = Math.max(100, Math.min(10000, parseInt(maxTotal) || 1500));
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

// Get degen mode settings
app.get('/api/settings/degen-mode', (req, res) => {
  res.json({
    success: true,
    degenMode: config.degenMode
  });
});

// Update degen mode settings
app.post('/api/settings/degen-mode', (req, res) => {
  const { enabled, minPrice, maxPrice, requireStrongMomentum, maxTimeMinutes, maxBetMultiplier } = req.body;

  if (enabled !== undefined) {
    config.degenMode.enabled = !!enabled;
  }
  if (minPrice !== undefined) {
    config.degenMode.minPrice = Math.max(5, Math.min(39, parseInt(minPrice) || 15));
  }
  if (maxPrice !== undefined) {
    config.degenMode.maxPrice = Math.max(20, Math.min(50, parseInt(maxPrice) || 39));
  }
  if (requireStrongMomentum !== undefined) {
    config.degenMode.requireStrongMomentum = !!requireStrongMomentum;
  }
  if (maxTimeMinutes !== undefined) {
    config.degenMode.maxTimeMinutes = Math.max(1, Math.min(10, parseInt(maxTimeMinutes) || 5));
  }
  if (maxBetMultiplier !== undefined) {
    config.degenMode.maxBetMultiplier = Math.max(0.1, Math.min(1, parseFloat(maxBetMultiplier) || 0.5));
  }

  // Persist to disk
  saveSettings();

  console.log(`🔥 Degen mode ${config.degenMode.enabled ? 'ENABLED' : 'disabled'}:`, JSON.stringify(config.degenMode));

  res.json({
    success: true,
    degenMode: config.degenMode,
    message: `Degen mode ${config.degenMode.enabled ? 'enabled' : 'disabled'}`
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
    const { ticker, side, expectedPrice, count: requestedCount } = req.body;

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

    // Fetch crypto markets
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

    // Use requested count (default 1 for manual bets)
    const count = Math.max(1, Math.min(99, parseInt(requestedCount) || 1));

    if (count * priceCents > getRemainingRiskBudget()) {
      return res.status(400).json({
        success: false,
        error: `Insufficient budget. Need $${((count * priceCents)/100).toFixed(2)}, have $${(getRemainingRiskBudget()/100).toFixed(2)}`
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

      // Track pending exposure for token limit enforcement
      const token = market.assetType || getTokenFromTicker(ticker);
      addPendingExposure(token, betRecord.totalCost);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        token,
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

    // Real bet - check orderbook for liquidity (but NEVER flip sides on manual bets)
    // User chose their side intentionally - respect that choice
    let bestAsk = priceCents;
    const finalSide = side.toLowerCase();
    try {
      const orderbook = await kalshiRequest('GET', `/markets/${ticker}/orderbook`);
      const asks = finalSide === 'yes' ? orderbook.yes : orderbook.no;
      if (asks && asks.length > 0 && asks[0] && asks[0][1] > 0) {
        bestAsk = asks[0][0];
        console.log(`Orderbook check: Best ${finalSide} ask = ${bestAsk}¢, qty = ${asks[0][1]}`);
      } else {
        // No visible liquidity - try anyway, Kalshi often has hidden liquidity
        console.log(`Orderbook appears empty for ${finalSide}, proceeding anyway with market price`);
      }
    } catch (obErr) {
      console.log(`Orderbook fetch failed: ${obErr.message}, using market price`);
    }

    // Use best ask + buffer to ensure fill
    const fillPrice = Math.min(bestAsk + 3, 99);

    const orderRequest = {
      ticker,
      action: 'buy',
      side: finalSide,
      type: 'limit',
      count
    };

    // Add the appropriate price field based on final side (may have flipped)
    if (finalSide === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }

    const flippedNote = finalSide !== side.toLowerCase() ? ` (flipped from ${side})` : '';
    console.log(`Placing order${flippedNote} (ask: ${priceCents}¢, bid: ${fillPrice}¢):`, JSON.stringify(orderRequest));

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

      // Track pending exposure for token limit enforcement
      const token = market.assetType || getTokenFromTicker(ticker);
      addPendingExposure(token, betRecord.totalCost);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        count: filledCount,
        token,
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

    // Fetch crypto markets only
    const cryptoMarkets = await fetchCryptoMarkets();
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

    // Filter
    const opportunities = cryptoOpps
      .filter(m => {
        if (m === null) return false;
        // REQUIRE 55%+ WIN PROBABILITY for auto-betting (lowered from 60% for more volume)
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 55) return false;

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
        message: 'No opportunities with 55%+ win probability found. Waiting...',
        bet: null,
        scanned: totalScanned
      });
    }

    const best = opportunities[0];
    const category = best.marketCategory || 'crypto';
    const maxPerBet = getMaxPerBet();
    const priceCents = Math.round(best.betPrice * 100);

    // Check total exposure limit - must be able to afford at least 1 contract
    const remainingBudget = getRemainingRiskBudget();
    if (remainingBudget < priceCents) {
      console.log(`⚠️ Exposure limit reached - $${(remainingBudget/100).toFixed(2)} remaining < ${priceCents}¢ per contract`);
      return res.json({
        success: true,
        message: `Exposure limit reached ($${(getMaxTotalRisk()/100).toFixed(2)} max). Only $${(remainingBudget/100).toFixed(2)} remaining.`,
        bet: null,
        risk: getRiskByType()
      });
    }

    const remainingTokenBudget = getRemainingTokenBudget(best.ticker, best.assetType || best.cryptoType);
    const remainingTimeframeBudget = getRemainingTimeframeBudget(best.ticker);
    const timeframe = getTimeframeFromTicker(best.ticker);
    console.log(`Auto-bet found [${category}]: ${best.title} | Win prob: ${best.winProbability}% | Side: ${best.betSide} | Price: ${priceCents}¢ | Timeframe: ${timeframe}`);

    // Check per-token limit first - must be able to afford at least 1 contract
    if (remainingTokenBudget < priceCents) {
      const token = getTokenFromTicker(best.ticker) || best.assetType || best.cryptoType || 'token';
      console.log(`⚠️ Token limit reached for ${token} - $${(remainingTokenBudget/100).toFixed(2)} remaining < ${priceCents}¢ per contract`);
      return res.json({
        success: true,
        message: `Token limit reached for ${token}. Only $${(remainingTokenBudget/100).toFixed(2)} remaining of $${(getMaxPerToken()/100).toFixed(2)} max.`,
        bet: null,
        risk: getRiskByType()
      });
    }

    // Check per-timeframe limit
    if (remainingTimeframeBudget < priceCents) {
      console.log(`⚠️ Timeframe limit reached for ${timeframe} - $${(remainingTimeframeBudget/100).toFixed(2)} remaining < ${priceCents}¢ per contract`);
      return res.json({
        success: true,
        message: `${timeframe} market limit reached. Only $${(remainingTimeframeBudget/100).toFixed(2)} remaining of $${(getMaxPerTimeframe(timeframe)/100).toFixed(2)} max.`,
        bet: null,
        risk: getRiskByType()
      });
    }

    // === KELLY CRITERION BET SIZING ===
    // Use Half Kelly (already calculated in opportunity) for optimal bankroll growth
    // Kelly fraction tells us what % of bankroll to bet based on edge
    const kellyFraction = parseFloat(best.recommendedBetFraction) / 100 || 0.05;
    const bankrollCents = config.bankroll || 2500;  // Default $25 if not set
    const MIN_BET_CENTS = 100;  // $1 minimum bet

    // Kelly-based bet size
    let kellyBetCents = Math.round(bankrollCents * kellyFraction);

    // Apply minimum bet floor
    if (kellyBetCents < MIN_BET_CENTS) {
      console.log(`   📊 Kelly suggests $${(kellyBetCents/100).toFixed(2)} but minimum is $1, skipping small edge bet`);
      return res.json({
        success: true,
        message: `Edge too small for Kelly sizing (${(kellyFraction * 100).toFixed(1)}% of bankroll = $${(kellyBetCents/100).toFixed(2)})`,
        bet: null
      });
    }

    // Cap at remaining risk budget, max per bet, token budget, OR timeframe budget - whichever is lowest
    const MAX_BET_CENTS = Math.min(kellyBetCents, maxPerBet, remainingBudget, remainingTokenBudget, remainingTimeframeBudget);

    console.log(`   📊 Kelly sizing: ${(kellyFraction * 100).toFixed(1)}% of $${(bankrollCents/100).toFixed(2)} = $${(kellyBetCents/100).toFixed(2)} → capped at $${(MAX_BET_CENTS/100).toFixed(2)}`);

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

      // Track pending exposure for token limit enforcement
      const token = best.assetType || best.cryptoType || getTokenFromTicker(best.ticker);
      addPendingExposure(token, betRecord.totalCost);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        token,
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

      // Track pending exposure for token limit enforcement
      const token = best.assetType || best.cryptoType || getTokenFromTicker(best.ticker);
      addPendingExposure(token, betRecord.totalCost);

      // Track for performance analysis
      trackBet({
        ...betRecord,
        count: filledCount,
        token,
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

// Safety circuit breaker settings
const SAFETY_MIN_BETS = 20;      // Need at least 20 bets before safety kicks in
const SAFETY_MIN_WINRATE = 40;   // Stop auto-betting if win rate drops below 40%

async function runAutoBet() {
  try {
    console.log('\n🤖 ========== AUTO-BET SCAN ==========');

    // SAFETY CIRCUIT BREAKER: Check win rate before betting
    const completedBets = performanceData.bets.filter(b => b.outcome !== 'pending');
    if (completedBets.length >= SAFETY_MIN_BETS) {
      const wins = completedBets.filter(b => b.outcome === 'won').length;
      const winRate = (wins / completedBets.length) * 100;

      if (winRate < SAFETY_MIN_WINRATE) {
        console.log(`🛑 SAFETY STOP: Win rate ${winRate.toFixed(1)}% < ${SAFETY_MIN_WINRATE}% (${completedBets.length} bets)`);
        console.log('   Auto-betting paused. Manual degen bets still allowed.');
        console.log('========================================\n');

        // Disable auto-bet
        config.autoBetEnabled = false;
        saveAutoBetState(false);

        lastScanStatus.blockedReason = 'safety_stop';
        lastScanStatus.bestOpportunity = {
          title: 'Safety circuit breaker triggered',
          reason: `Win rate ${winRate.toFixed(1)}% below ${SAFETY_MIN_WINRATE}% threshold`
        };
        return;
      }
    }

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

    // Fetch crypto markets only (removed hourly/index markets)
    const cryptoMarkets = await fetchCryptoMarkets();
    const now = Date.now();

    // Clean up old bets (remove bets older than 30 minutes)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    console.log(`📊 Fetched: ${cryptoMarkets.length} crypto markets`);
    console.log(`   Recent bets tracking: ${recentBets.size} markets`);

    // Update scan status
    lastScanStatus.cryptoMarketsFound = cryptoMarkets.length;
    lastScanStatus.indexMarketsFound = 0;

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      });

    // Count before filtering
    const allOpps = cryptoOpps.filter(m => m !== null);
    const withEdge = allOpps.filter(m => m.edge > 0);
    const above50 = allOpps.filter(m => parseFloat(m.winProbability) >= 50);
    const above60 = allOpps.filter(m => parseFloat(m.winProbability) >= 60);

    console.log(`   Analyzed: ${allOpps.length} valid | ${withEdge.length} with edge`);

    // Update scan status
    lastScanStatus.analyzedValid = allOpps.length;
    lastScanStatus.withEdge = withEdge.length;
    lastScanStatus.above60 = above60.length;

    // Show all crypto markets with their status
    const cryptoAnalyzed = allOpps.filter(m => m.marketCategory === 'crypto' || m.cryptoType);
    if (cryptoAnalyzed.length > 0) {
      console.log(`   📈 Crypto markets:`);
      cryptoAnalyzed.forEach(m => {
        const side = m.betSide || '-';
        const price = m.betPriceCents || 0;
        const edge = parseFloat(m.edge) || 0;
        const conf = m.confidence || 'none';
        const status = m.isSafe ? '✅' : (m.isDegen ? '🎲' : '⏸️');
        console.log(`      ${status} ${m.cryptoType}: ${side} @ ${price}¢ | edge ${edge > 0 ? '+' : ''}${edge.toFixed(1)}% | ${conf} | ${m.reason || 'no signal'}`);
      });
    }

    // Show no-bet reasons
    const noEdge = allOpps.filter(m => m.edge <= 0 && m.cryptoType);
    if (noEdge.length > 0 && withEdge.length === 0) {
      console.log(`   ⚠️ No positive edge found. Reasons:`);
      noEdge.slice(0, 3).forEach(m => {
        console.log(`      - ${m.cryptoType}: ${m.reason || 'unknown'}`);
      });
    }

    // Combine and filter - SMART EDGE FILTERING
    // Required edge scales with risk:
    // - High price bets (60¢+) are safer, need less edge
    // - Mid price bets (40-59¢) need moderate edge
    // - Low price bets (<40¢) are risky, need more edge
    function getMinEdgeForPrice(price) {
      if (price >= 70) return 2;   // Very safe, 2% edge OK
      if (price >= 60) return 3;   // Safe, 3% edge
      if (price >= 50) return 4;   // Balanced, 4% edge
      if (price >= 40) return 5;   // Riskier, 5% edge
      return 7;                     // Low price = high risk, need 7%+ edge
    }

    // Log ALL markets for debugging
    console.log(`   🔍 Market breakdown:`);
    const withAnyEdge = allOpps.filter(m => m.edge > 0);
    const withGoodEdge = allOpps.filter(m => m.edge >= 2);
    console.log(`      Total analyzed: ${allOpps.length} | Any edge: ${withAnyEdge.length} | 2%+ edge: ${withGoodEdge.length}`);

    if (withAnyEdge.length > 0) {
      console.log(`   📊 Top 5 by edge:`);
      withAnyEdge.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge)).slice(0, 5).forEach(m => {
        const safeStr = m.isSafe ? '✅SAFE' : (m.isDegen ? '🎲DEGEN' : '');
        const edgeNum = parseFloat(m.edge) || 0;
        const confStr = m.confidence ? ` [${m.confidence}]` : '';
        console.log(`      - ${m.title?.substring(0, 35)}: ${m.betSide} @ ${m.betPriceCents}¢ | edge +${edgeNum.toFixed(1)}%${confStr} ${safeStr}`);
      });
    }

    const opportunities = cryptoOpps
      .filter(m => {
        if (m === null) return false;

        const winProb = parseFloat(m.winProbability) || 0;
        const edge = m.edge || 0;
        const priceCents = m.betPriceCents || 50;

        // Smart edge filter: riskier bets need more edge
        const minEdgeRequired = getMinEdgeForPrice(priceCents);
        if (edge < minEdgeRequired) {
          m.filterReason = `Edge ${edge.toFixed(1)}% < required ${minEdgeRequired}% for ${priceCents}¢ bet`;
          return false;
        }

        // Check if we already bet on this market
        if (recentBets.has(m.ticker)) {
          // Allow scale-in if probability improved significantly
          if (shouldAllowScaleIn(m.ticker, winProb)) {
            m.isScaleIn = true; // Mark as scale-in opportunity
          } else {
            return false; // Skip - already bet and not a valid scale-in
          }
        }

        // Calculate TRUE expected value and ROI for better ranking
        // EV = (prob × profit_if_win) - ((1-prob) × cost_if_lose)
        const prob = winProb / 100;
        const price = priceCents;
        const profitIfWin = 100 - price;  // Win pays $1, cost is price
        const costIfLose = price;
        const trueEV = (prob * profitIfWin) - ((1 - prob) * costIfLose);

        // ROI = EV / cost (profit per dollar risked)
        const roi = price > 0 ? (trueEV / price) * 100 : 0;

        // Profit score combines:
        // - ROI (higher = better return per dollar)
        // - EV (absolute expected profit)
        // - Confidence bonus (higher confidence = trust the edge more)
        const confidenceMultiplier = m.isSafe ? 1.2 : m.isDegenSafe ? 1.0 : 0.8;
        m.trueEV = trueEV;
        m.roi = roi;
        m.evScore = (trueEV * 0.4 + roi * 0.6) * confidenceMultiplier;

        return true;
      })
      // SORT BY PROFIT SCORE (best risk-adjusted bets first)
      .sort((a, b) => b.evScore - a.evScore);

    const highEdgeCount = opportunities.filter(o => parseFloat(o.edge) >= AUTO_BET_MIN_EDGE).length;
    console.log(`   Final: ${opportunities.length} opportunities (${highEdgeCount} with ${AUTO_BET_MIN_EDGE}%+ edge)`);

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
      return edge > 0 && edge < AUTO_BET_MIN_EDGE;
    });
    if (nearThreshold.length > 0) {
      console.log(`   📈 ${nearThreshold.length} markets with small edge (0-${AUTO_BET_MIN_EDGE}%):`);
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
        if (closest.edge < AUTO_BET_MIN_EDGE) {
          reason = `Edge too low: ${parseFloat(closest.edge || 0).toFixed(1)}% (need ${AUTO_BET_MIN_EDGE}%+)`;
        } else if (winProb < 50) {
          reason = `Prob too low: ${winProb}% (need 50%+)`;
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
    const tokenExposure = getExposureByToken();
    console.log(`💰 Exposure: $${(riskByType.total/100).toFixed(2)} / $${(getMaxTotalRisk()/100).toFixed(2)} max`);
    console.log(`   By token: ${Object.entries(tokenExposure).map(([t, e]) => `${t}=$${(e/100).toFixed(2)}`).join(', ') || 'none'}`);
    console.log(`   Remaining: $${(getTotalRemainingBudget()/100).toFixed(2)}`);

    let betsPlaced = 0;
    let totalBetAmount = 0;
    const betResults = [];

    // Process each opportunity (already sorted by EV)
    // AUTO-BET places: safe bets + degen bets (when degen mode enabled)
    const safeOpportunities = opportunities.filter(o => o.isSafe);

    // Filter degen opportunities to respect minPrice/maxPrice limits
    const degenMinPrice = config.degenMode.minPrice || 15;
    const degenMaxPrice = config.degenMode.maxPrice || 39;
    const degenOpportunities = opportunities.filter(o =>
      (o.isDegen || o.isDegenSafe) &&
      o.betPriceCents >= degenMinPrice &&
      o.betPriceCents <= degenMaxPrice
    );

    // When degen mode is enabled, include degen opportunities within price range
    // They'll get smaller bet sizes via the multiplier
    let autoBetOpportunities = [...safeOpportunities];

    if (config.degenMode.enabled && degenOpportunities.length > 0) {
      // Mark all degen opportunities for smaller bet sizing
      degenOpportunities.forEach(o => o.isDegenBet = true);
      autoBetOpportunities = [...safeOpportunities, ...degenOpportunities];
      console.log(`   🔥 DEGEN MODE: Including ${degenOpportunities.length} high-risk bets (${degenMinPrice}-${degenMaxPrice}¢ range)`);
    } else if (degenOpportunities.length > 0) {
      console.log(`   🎲 ${degenOpportunities.length} DEGEN bets skipped (enable degen mode to auto-bet these)`);
    }

    // Log any bets that were too cheap even for degen mode
    const tooChcheap = opportunities.filter(o => (o.isDegen || o.isDegenSafe) && o.betPriceCents < degenMinPrice);
    if (tooChcheap.length > 0) {
      console.log(`   ⚠️ ${tooChcheap.length} bets below ${degenMinPrice}¢ min price - skipped (too risky)`);
    }

    if (autoBetOpportunities.length === 0) {
      const reason = opportunities.length > 0 ? 'degen_only' : 'no_edge';
      console.log(`   📊 ${opportunities.length > 0 ? 'Only degen bets available (enable degen mode)' : 'No opportunities with positive edge'}`);
      lastScanStatus.blockedReason = reason;
      console.log('========================================\n');
      return;
    }

    console.log(`   ✅ ${safeOpportunities.length} SAFE + ${config.degenMode.enabled ? degenOpportunities.length : 0} DEGEN = ${autoBetOpportunities.length} auto-bets`);

    for (const opp of autoBetOpportunities) {
      const tokenName = getTokenFromTicker(opp.ticker) || opp.assetType || opp.cryptoType || 'token';
      const betType = opp.isSafe ? '✅ SAFE' : '🔥 DEGEN';
      const priceCents = Math.round(opp.betPrice * 100);

      // HARD SAFETY CHECK: Never bet below 35¢ unless degen mode is on
      const MIN_SAFE_PRICE = 35;
      if (priceCents < MIN_SAFE_PRICE && !config.degenMode.enabled) {
        console.log(`   ⛔ BLOCKED: ${tokenName} @ ${priceCents}¢ - below ${MIN_SAFE_PRICE}¢ min (degen mode OFF)`);
        continue;
      }

      // Even with degen mode, respect the degen minPrice
      if (priceCents < (config.degenMode.minPrice || 15)) {
        console.log(`   ⛔ BLOCKED: ${tokenName} @ ${priceCents}¢ - below ${config.degenMode.minPrice || 15}¢ degen minimum`);
        continue;
      }

      console.log(`   🔄 Processing ${betType}: ${tokenName} ${opp.betSide} @ ${priceCents}¢ (edge +${parseFloat(opp.edge).toFixed(1)}%)`);

      // Check if we've hit overall limits - must afford at least 1 contract
      if (getTotalRemainingBudget() < priceCents) {
        console.log(`   ⚠️ Exposure limit reached ($${(getTotalRemainingBudget()/100).toFixed(2)} < ${priceCents}¢) - stopping`);
        break;
      }
      const winProb = parseFloat(opp.winProbability);
      const remainingBudget = getRemainingRiskBudget();
      const remainingTokenBudget = getRemainingTokenBudget(opp.ticker, opp.assetType || opp.cryptoType);
      const remainingTimeframeBudget = getRemainingTimeframeBudget(opp.ticker);
      const timeframe = getTimeframeFromTicker(opp.ticker);

      console.log(`      Budget: $${(remainingBudget/100).toFixed(2)} remaining, $${(remainingTokenBudget/100).toFixed(2)} for ${tokenName}, $${(remainingTimeframeBudget/100).toFixed(2)} for ${timeframe}, price=${priceCents}¢`);

      // Skip if budget exhausted
      if (remainingBudget < priceCents) {
        console.log(`   ⏭️ ${tokenName}: Exposure limit reached`);
        continue;
      }

      // Skip if token limit exhausted - must be able to afford at least 1 contract
      if (remainingTokenBudget < priceCents) {
        console.log(`   ⏭️ ${tokenName}: Token limit reached ($${(remainingTokenBudget/100).toFixed(2)} remaining < ${priceCents}¢ per contract)`);
        continue;
      }

      // Skip if timeframe limit exhausted
      if (remainingTimeframeBudget < priceCents) {
        console.log(`   ⏭️ ${tokenName}: ${timeframe} timeframe limit reached ($${(remainingTimeframeBudget/100).toFixed(2)} remaining < ${priceCents}¢ per contract)`);
        continue;
      }

      // Kelly Criterion bet sizing - use actual balance, capped by token budget AND timeframe budget
      const actualBankroll = Math.max(config.bankroll, portfolio.balance || 0);
      let maxBetCents = Math.min(getMaxPerBet(), remainingBudget, remainingTokenBudget, remainingTimeframeBudget);

      // Apply degen mode bet multiplier (bet smaller on risky bets)
      if (opp.isDegenBet || opp.isDegenSafe || opp.isDegen) {
        maxBetCents = Math.floor(maxBetCents * config.degenMode.maxBetMultiplier);
        console.log(`      🔥 Degen bet: ${config.degenMode.maxBetMultiplier}x multiplier → max $${(maxBetCents/100).toFixed(2)}`);
      }

      const kellyBetSize = calculateKellyBet(winProb, priceCents, actualBankroll, maxBetCents);

      console.log(`      Kelly: prob=${winProb.toFixed(1)}%, price=${priceCents}¢, bankroll=$${(actualBankroll/100).toFixed(2)}, max=$${(maxBetCents/100).toFixed(2)}, kelly=${kellyBetSize}¢`);

      // Kelly returns 0 for small edge bets - skip them
      if (kellyBetSize === 0) {
        console.log(`   ⏭️ ${tokenName}: Kelly says skip (edge too small for $1 min bet)`);
        continue;
      }

      // Use Kelly sizing, capped at remaining token budget
      const betSize = Math.min(kellyBetSize, remainingTokenBudget);

      const count = Math.floor(betSize / priceCents);
      if (count < 1) {
        console.log(`   ⏭️ ${tokenName}: Count < 1 (shouldn't happen)`);
        continue;
      }

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
        kellyFraction: (betSize / config.bankroll * 100).toFixed(1) + '%',
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

        // Track pending exposure for token limit enforcement
        addPendingExposure(tokenName, betRecord.totalCost);

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
                // No liquidity shown in orderbook, but market exists - try anyway
                console.log(`   ⚠️ ${tokenName}: Orderbook empty, trying anyway with market price`);
                hasLiquidity = true; // Try anyway - Kalshi may have hidden liquidity
              }
            }
          } catch (obErr) {
            // Orderbook fetch failed, proceed with original price
            console.log(`   ℹ️ ${tokenName}: Orderbook unavailable, using market price`);
            hasLiquidity = true; // Try anyway
          }

          // Always try to place the bet - worst case it gets rejected
          if (!hasLiquidity) {
            hasLiquidity = true; // Try anyway
            console.log(`   ℹ️ ${tokenName}: Proceeding despite liquidity uncertainty`);
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

            // Track pending exposure for token limit enforcement
            addPendingExposure(tokenName, betRecord.totalCost);

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

// Get auto-bet status (for frontend refresh)
app.get('/api/auto-bet/status', (req, res) => {
  res.json({
    success: true,
    autoBetEnabled: config.autoBetEnabled,
    intervalSeconds: performanceData.autoBetState?.intervalSeconds || 15
  });
});

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

      // Save credentials to active profile
      saveToActiveProfile();

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
    hasApiKey: !!config.apiKeyId,
    activeProfile: activeProfileId ? {
      id: activeProfileId,
      name: profiles[activeProfileId]?.name
    } : null
  });
});

// Disconnect from Kalshi
app.post('/api/auth/disconnect', (req, res) => {
  config.apiKeyId = null;
  config.privateKey = null;
  config.isAuthenticated = false;
  portfolio.positions = [];

  console.log('🔌 Disconnected from Kalshi');

  // Save to profile if active
  saveToActiveProfile();

  res.json({
    success: true,
    message: 'Disconnected from Kalshi'
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
    hasKalshi: !!(p.kalshiApiKeyId && p.kalshiPrivateKey),
    hasPin: !!p.pin,
    lastActive: p.lastActive,
    isActive: id === activeProfileId
  }));

  res.json({
    success: true,
    profiles: profileList,
    activeProfileId
  });
});

// Create a new profile
app.post('/api/profiles', (req, res) => {
  const { name, pin } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Name is required' });
  }

  const id = 'profile_' + Date.now();
  profiles[id] = {
    name: name.trim(),
    pin: pin || null,  // Optional PIN for protection
    kalshiApiKeyId: null,
    kalshiPrivateKey: null,
    settings: {
      riskLimits: { ...config.riskLimits },
      degenMode: { ...config.degenMode }
    },
    betHistory: [],
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };

  saveProfiles();
  console.log(`👤 Created profile: ${name} (PIN: ${pin ? 'yes' : 'no'})`);

  res.json({
    success: true,
    profile: { id, name: profiles[id].name, hasPin: !!pin }
  });
});

// Switch to a profile
app.post('/api/profiles/:id/switch', async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!profiles[id]) {
    return res.status(404).json({ success: false, error: 'Profile not found' });
  }

  // Check PIN if profile has one
  if (profiles[id].pin && profiles[id].pin !== pin) {
    return res.status(401).json({ success: false, error: 'Incorrect PIN', requiresPin: true });
  }

  // Save current profile state first
  saveToActiveProfile();

  // Switch to new profile
  switchToProfile(id);

  // Try to fetch balance if connected to Kalshi
  let balance = config.bankroll / 100;
  if (config.isAuthenticated) {
    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;
      balance = portfolio.balance / 100;
    } catch (e) {
      console.log('Could not fetch balance for profile:', e.message);
    }
  }

  res.json({
    success: true,
    profile: {
      id,
      name: profiles[id].name,
      hasKalshi: config.isAuthenticated
    },
    balance,
    isAuthenticated: config.isAuthenticated
  });
});

// Delete a profile
app.delete('/api/profiles/:id', (req, res) => {
  const { id } = req.params;

  if (!profiles[id]) {
    return res.status(404).json({ success: false, error: 'Profile not found' });
  }

  const name = profiles[id].name;
  delete profiles[id];

  // If deleting active profile, clear it
  if (activeProfileId === id) {
    activeProfileId = null;
    config.apiKeyId = null;
    config.privateKey = null;
    config.isAuthenticated = false;
  }

  saveProfiles();
  console.log(`🗑️ Deleted profile: ${name}`);

  res.json({ success: true });
});

// Update active profile's Kalshi credentials (called after connecting)
app.post('/api/profiles/save-credentials', (req, res) => {
  if (!activeProfileId) {
    return res.status(400).json({ success: false, error: 'No active profile' });
  }

  saveToActiveProfile();
  res.json({ success: true });
});

// Log out of current profile (deactivate without deleting)
app.post('/api/profiles/logout', (req, res) => {
  if (activeProfileId) {
    saveToActiveProfile();
    console.log(`👋 Logged out of profile: ${profiles[activeProfileId]?.name}`);
  }

  activeProfileId = null;
  config.apiKeyId = null;
  config.privateKey = null;
  config.isAuthenticated = false;
  portfolio = { balance: 0, positions: [] };
  betHistory = [];

  saveProfiles();

  res.json({ success: true });
});

// Quick balance refresh endpoint
app.get('/api/balance/refresh', async (req, res) => {
  try {
    if (!config.isAuthenticated) {
      return res.json({
        success: true,
        balance: config.bankroll / 100,
        simulated: true
      });
    }

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    portfolio.balance = balanceData.balance || 0;
    config.bankroll = portfolio.balance;

    res.json({
      success: true,
      balance: portfolio.balance / 100,
      simulated: false
    });
  } catch (error) {
    console.error('Balance refresh error:', error.message);
    res.json({
      success: false,
      error: error.message,
      balance: (config.bankroll || portfolio.balance || 0) / 100
    });
  }
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
          const side = fill.side?.toLowerCase();

          // Kalshi API returns the YES price in fill.price
          // If you bought NO, you actually paid (100 - yes_price)
          let yesPriceCents = fill.price || 0;
          if (yesPriceCents > 0 && yesPriceCents <= 1) {
            // Price is a decimal probability, convert to cents
            yesPriceCents = Math.round(yesPriceCents * 100);
          }

          // Calculate actual price paid based on which side was bought
          // NO costs (100 - YES price), YES costs the YES price
          const priceCents = side === 'no' ? (100 - yesPriceCents) : yesPriceCents;

          // Total cost = number of contracts × price per contract (in cents)
          const totalCost = count * priceCents;

          // Debug: log to verify correct pricing
          if (side === 'no') {
            console.log(`Fill NO: ${fill.ticker} | YES price=${yesPriceCents}¢ | NO price=${priceCents}¢ | count=${count} | totalCost=${totalCost}¢`);
          }

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

// JSONBin status and management
app.get('/api/jsonbin-status', async (req, res) => {
  res.json({
    success: true,
    configured: !!JSONBIN_API_KEY,
    hasApiKey: !!JSONBIN_API_KEY,
    hasBinId: !!JSONBIN_BIN_ID,
    binId: JSONBIN_BIN_ID || null,
    message: JSONBIN_API_KEY
      ? (JSONBIN_BIN_ID
          ? `Fully configured. Bin ID: ${JSONBIN_BIN_ID}`
          : 'API key set but no bin ID yet. Call POST /api/jsonbin-create to create one.')
      : 'Not configured. Set JSONBIN_API_KEY in Render environment.',
    betsTracked: performanceData.bets.length
  });
});

// Force create/save JSONBin
app.post('/api/jsonbin-create', async (req, res) => {
  if (!JSONBIN_API_KEY) {
    return res.status(400).json({
      success: false,
      error: 'JSONBIN_API_KEY not set in environment variables'
    });
  }

  const result = await saveToJsonBin();

  if (result.success) {
    res.json({
      success: true,
      binId: JSONBIN_BIN_ID,
      action: result.action,
      message: result.action === 'created'
        ? `Created new bin! Add JSONBIN_BIN_ID=${JSONBIN_BIN_ID} to your Render env vars.`
        : `Updated existing bin ${JSONBIN_BIN_ID}`,
      betsTracked: performanceData.bets.length
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error
    });
  }
});

// Force sync to JSONBin (useful for debugging)
app.post('/api/jsonbin-sync', async (req, res) => {
  if (!JSONBIN_API_KEY) {
    return res.status(400).json({ success: false, error: 'JSONBIN_API_KEY not set' });
  }

  const result = await saveToJsonBin();
  res.json({
    success: result.success,
    betsTracked: performanceData.bets.length,
    pendingBets: performanceData.bets.filter(b => b.outcome === 'pending').length,
    settledBets: performanceData.bets.filter(b => b.outcome !== 'pending').length,
    ...result
  });
});

// Import existing Kalshi fills into tracking (one-time setup)
app.post('/api/import-fills', async (req, res) => {
  if (!config.isAuthenticated) {
    return res.status(400).json({ success: false, error: 'Not authenticated with Kalshi' });
  }

  try {
    // Fetch ALL fills using pagination
    let allFills = [];
    let cursor = null;
    let pages = 0;
    const maxPages = 20; // Safety limit

    do {
      const url = cursor
        ? `/portfolio/fills?limit=100&cursor=${cursor}`
        : '/portfolio/fills?limit=100';
      const fillsData = await kalshiRequest('GET', url);
      const fills = fillsData.fills || [];
      allFills = allFills.concat(fills);
      cursor = fillsData.cursor;
      pages++;
    } while (cursor && pages < maxPages);

    console.log(`📊 Fetched ${allFills.length} total fills from Kalshi (${pages} pages)`);

    if (allFills.length === 0) {
      return res.json({ success: true, imported: 0, message: 'No fills found' });
    }

    // Get unique tickers to check settlement status
    const uniqueTickers = [...new Set(allFills.map(f => f.ticker))];
    const marketResults = {};

    // Fetch market results in batches
    for (const ticker of uniqueTickers) {
      try {
        const marketData = await kalshiRequest('GET', `/markets/${ticker}`);
        if (marketData.market) {
          marketResults[ticker] = {
            result: marketData.market.result, // 'yes' or 'no' or null
            settled: !!marketData.market.result,
            title: marketData.market.title
          };
        }
      } catch (e) {
        // Market may have been removed
      }
    }

    let imported = 0;
    let skipped = 0;
    let settled = 0;

    for (const fill of allFills) {
      // Skip if already tracked (by trade_id)
      const tradeId = fill.trade_id || fill.fill_id;
      const existingBet = performanceData.bets.find(b => b.id === tradeId);
      if (existingBet) {
        skipped++;
        continue;
      }

      const side = fill.side?.toLowerCase() || 'unknown';
      const count = fill.count || 1;
      let priceCents = fill.price || 50;
      if (priceCents > 0 && priceCents <= 1) {
        priceCents = Math.round(priceCents * 100);
      }
      // For NO bets, price is 100 - yes_price
      const actualPrice = side === 'no' ? (100 - priceCents) : priceCents;
      const totalCost = count * actualPrice;
      const token = getTokenFromTicker(fill.ticker);
      const marketInfo = marketResults[fill.ticker] || {};

      // Determine outcome if market settled
      let outcome = 'pending';
      let actualProfit = null;
      if (marketInfo.settled && marketInfo.result) {
        const won = (side === marketInfo.result);
        outcome = won ? 'won' : 'lost';
        actualProfit = won ? (count * 100 - totalCost) : 0; // Win pays $1 per contract
        settled++;
      }

      // Create bet record directly (bypass trackBet to set outcome)
      const bet = {
        id: tradeId,
        timestamp: fill.created_time || new Date().toISOString(),
        ticker: fill.ticker,
        title: marketInfo.title || fill.ticker,
        token,
        side,
        contracts: count,
        price: actualPrice,
        totalCost,
        predictedProb: actualPrice,
        marketPrice: actualPrice,
        edge: 0,
        strikePrice: 0,
        currentPriceAtBet: 0,
        expiryTime: null,
        marketType: fill.ticker?.includes('15M') ? '15min' : fill.ticker?.includes('1H') ? 'hourly' : 'daily',
        outcome,
        settlementPrice: null,
        actualProfit,
        settledAt: outcome !== 'pending' ? new Date().toISOString() : null
      };

      performanceData.bets.push(bet);
      performanceData.summary.totalBets++;
      performanceData.summary.totalWagered += totalCost;

      if (outcome === 'won') {
        performanceData.summary.wins++;
        performanceData.summary.totalProfit += actualProfit;
      } else if (outcome === 'lost') {
        performanceData.summary.losses++;
        performanceData.summary.totalProfit -= totalCost;
      } else {
        performanceData.summary.pending++;
      }

      imported++;
    }

    // Recalculate summary
    recalculateSummary();

    // Force save to JSONBin
    await saveToJsonBin();

    res.json({
      success: true,
      imported,
      skipped,
      settled,
      totalBets: performanceData.bets.length,
      wins: performanceData.summary.wins,
      losses: performanceData.summary.losses,
      pending: performanceData.summary.pending,
      profitCents: performanceData.summary.totalProfit,
      profitDollars: (performanceData.summary.totalProfit / 100).toFixed(2),
      message: `Imported ${imported} fills (${settled} settled, ${imported - settled} pending)`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Deduplicate bets - remove duplicates based on ticker + side + similar timestamp
app.post('/api/deduplicate-bets', async (req, res) => {
  const beforeCount = performanceData.bets.length;

  // Group bets by ticker + side, then dedupe by timestamp proximity
  const seen = new Map();
  const uniqueBets = [];

  for (const bet of performanceData.bets) {
    const key = `${bet.ticker}-${bet.side}`;
    const timestamp = new Date(bet.timestamp).getTime();

    if (!seen.has(key)) {
      seen.set(key, []);
    }

    // Check if we have a similar bet within 60 seconds
    const similar = seen.get(key).find(existing => {
      const timeDiff = Math.abs(existing.timestamp - timestamp);
      return timeDiff < 60000; // Within 60 seconds
    });

    if (!similar) {
      seen.get(key).push({ timestamp, bet });
      uniqueBets.push(bet);
    }
  }

  // Replace bets with deduplicated list
  performanceData.bets = uniqueBets;

  // Recalculate summary
  recalculateSummary();

  // Save to JSONBin
  await saveToJsonBin();

  const removed = beforeCount - uniqueBets.length;
  console.log(`🧹 Deduplicated: removed ${removed} duplicates, ${uniqueBets.length} remaining`);

  res.json({
    success: true,
    before: beforeCount,
    after: uniqueBets.length,
    removed,
    summary: performanceData.summary
  });
});

// Force recalculate all summary stats from bets array
// Use this when summary is out of sync with actual data
app.post('/api/fix-summary', async (req, res) => {
  const bets = performanceData.bets || [];

  console.log(`🔧 Fixing summary... ${bets.length} bets in array`);

  // Completely rebuild summary from scratch
  const wins = bets.filter(b => b.outcome === 'won');
  const losses = bets.filter(b => b.outcome === 'lost');
  const pending = bets.filter(b => b.outcome === 'pending' || !b.outcome);

  performanceData.summary = {
    totalBets: bets.length,
    wins: wins.length,
    losses: losses.length,
    pending: pending.length,
    totalWagered: bets.reduce((sum, b) => sum + (b.totalCost || 0), 0),
    totalProfit: wins.reduce((sum, b) => sum + (b.actualProfit || 0), 0) -
                 losses.reduce((sum, b) => sum + (b.totalCost || 0), 0),
    winRate: (wins.length + losses.length) > 0
      ? (wins.length / (wins.length + losses.length)) * 100
      : 0,
    avgPredictedProb: bets.length > 0
      ? bets.reduce((sum, b) => sum + (b.predictedProb || 50), 0) / bets.length
      : 0,
    calibration: {}
  };

  // Save to JSONBin
  await saveToJsonBin();

  console.log(`✅ Fixed: ${bets.length} total, ${wins.length} wins, ${losses.length} losses, ${pending.length} pending`);

  res.json({
    success: true,
    message: 'Summary rebuilt from bets array',
    summary: performanceData.summary,
    betCount: bets.length
  });
});

// Reset tracking data (use carefully!)
app.post('/api/reset-tracking', async (req, res) => {
  performanceData = {
    bets: [],
    summary: {
      totalBets: 0,
      wins: 0,
      losses: 0,
      pending: 0,
      totalWagered: 0,
      totalProfit: 0,
      winRate: 0,
      avgPredictedProb: 0,
      avgActualWinRate: 0,
      calibration: {}
    },
    byToken: {},
    byProbBucket: {},
    byMarketType: {},
    lastUpdated: null
  };

  // Reset ML model too
  mlModel.trainedOn = 0;
  mlModel.performance.predictions = [];
  mlModel.performance.accuracy = 0;
  for (const key of Object.keys(mlModel.weights)) {
    mlModel.weights[key] = 0;
  }

  await saveToJsonBin();
  saveMLModel();

  res.json({ success: true, message: 'Tracking data and ML model reset' });
});

// Analyze historical data for insights
app.get('/api/analyze-history', (req, res) => {
  const bets = performanceData.bets || [];
  const settled = bets.filter(b => b.outcome === 'won' || b.outcome === 'lost');

  if (settled.length < 5) {
    return res.json({
      success: true,
      message: 'Need at least 5 settled bets for analysis',
      totalBets: bets.length,
      settledBets: settled.length
    });
  }

  // Analyze by token
  const byToken = {};
  settled.forEach(b => {
    const token = b.token || 'unknown';
    if (!byToken[token]) byToken[token] = { wins: 0, losses: 0, profit: 0 };
    if (b.outcome === 'won') {
      byToken[token].wins++;
      byToken[token].profit += (b.actualProfit || 0);
    } else {
      byToken[token].losses++;
      byToken[token].profit -= (b.totalCost || 0);
    }
  });

  // Calculate win rates
  Object.keys(byToken).forEach(token => {
    const t = byToken[token];
    t.total = t.wins + t.losses;
    t.winRate = ((t.wins / t.total) * 100).toFixed(1) + '%';
    t.profitDollars = (t.profit / 100).toFixed(2);
  });

  // Analyze by price bucket
  const byPrice = {
    'cheap_10_25': { wins: 0, losses: 0, label: '10-25¢ (long shots)' },
    'low_26_40': { wins: 0, losses: 0, label: '26-40¢ (risky)' },
    'mid_41_60': { wins: 0, losses: 0, label: '41-60¢ (balanced)' },
    'high_61_80': { wins: 0, losses: 0, label: '61-80¢ (likely)' },
    'safe_81_99': { wins: 0, losses: 0, label: '81-99¢ (very likely)' }
  };

  settled.forEach(b => {
    const price = b.price || 50;
    let bucket;
    if (price <= 25) bucket = 'cheap_10_25';
    else if (price <= 40) bucket = 'low_26_40';
    else if (price <= 60) bucket = 'mid_41_60';
    else if (price <= 80) bucket = 'high_61_80';
    else bucket = 'safe_81_99';

    if (b.outcome === 'won') byPrice[bucket].wins++;
    else byPrice[bucket].losses++;
  });

  Object.keys(byPrice).forEach(bucket => {
    const p = byPrice[bucket];
    p.total = p.wins + p.losses;
    p.winRate = p.total > 0 ? ((p.wins / p.total) * 100).toFixed(1) + '%' : 'N/A';
  });

  // Analyze by time of day (hour)
  const byHour = {};
  settled.forEach(b => {
    if (!b.timestamp) return;
    const hour = new Date(b.timestamp).getHours();
    const period = hour < 6 ? 'night_0_5' : hour < 12 ? 'morning_6_11' : hour < 18 ? 'afternoon_12_17' : 'evening_18_23';
    if (!byHour[period]) byHour[period] = { wins: 0, losses: 0 };
    if (b.outcome === 'won') byHour[period].wins++;
    else byHour[period].losses++;
  });

  Object.keys(byHour).forEach(period => {
    const h = byHour[period];
    h.total = h.wins + h.losses;
    h.winRate = ((h.wins / h.total) * 100).toFixed(1) + '%';
  });

  // Analyze by side
  const bySide = { yes: { wins: 0, losses: 0 }, no: { wins: 0, losses: 0 } };
  settled.forEach(b => {
    const side = (b.side || 'yes').toLowerCase();
    if (b.outcome === 'won') bySide[side].wins++;
    else bySide[side].losses++;
  });
  Object.keys(bySide).forEach(side => {
    const s = bySide[side];
    s.total = s.wins + s.losses;
    s.winRate = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) + '%' : 'N/A';
  });

  // Overall stats
  const totalWins = settled.filter(b => b.outcome === 'won').length;
  const totalLosses = settled.filter(b => b.outcome === 'lost').length;
  const overallWinRate = ((totalWins / settled.length) * 100).toFixed(1);

  // Find best and worst
  const tokensSorted = Object.entries(byToken).sort((a, b) => parseFloat(b[1].winRate) - parseFloat(a[1].winRate));
  const bestToken = tokensSorted[0];
  const worstToken = tokensSorted[tokensSorted.length - 1];

  res.json({
    success: true,
    totalBets: bets.length,
    settledBets: settled.length,
    pendingBets: bets.length - settled.length,
    overall: {
      wins: totalWins,
      losses: totalLosses,
      winRate: overallWinRate + '%'
    },
    insights: {
      bestToken: bestToken ? { token: bestToken[0], ...bestToken[1] } : null,
      worstToken: worstToken ? { token: worstToken[0], ...worstToken[1] } : null,
    },
    byToken,
    byPrice,
    byTimeOfDay: byHour,
    bySide
  });
});

// ML Model status endpoint
app.get('/api/ml-model', (req, res) => {
  res.json({
    success: true,
    model: getMLModelStatus()
  });
});

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
  console.log(`📊 Markets: Crypto 15min + hourly (BTC, ETH, SOL, DOGE, etc.)`);
  console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);
  console.log(`📈 Performance tracking: ${performanceData.bets.length} historical bets loaded`);

  // JSONBin status - detailed logging
  console.log(`☁️ JSONBin Config Check:`);
  console.log(`   JSONBIN_API_KEY: ${JSONBIN_API_KEY ? '✓ SET (' + JSONBIN_API_KEY.substring(0, 10) + '...)' : '✗ NOT SET'}`);
  console.log(`   JSONBIN_BIN_ID: ${JSONBIN_BIN_ID ? '✓ SET (' + JSONBIN_BIN_ID + ')' : '✗ NOT SET'}`);

  if (JSONBIN_API_KEY && JSONBIN_BIN_ID) {
    console.log(`☁️ JSONBin: CONFIGURED - data will persist across deploys`);
    // Verify we can reach JSONBin
    try {
      const testRes = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Access-Key': JSONBIN_API_KEY }
      });
      if (testRes.ok) {
        const testData = await testRes.json();
        console.log(`   ✓ Connection verified - ${testData.record?.bets?.length || 0} bets in cloud`);
      } else {
        console.log(`   ✗ Connection failed: ${testRes.status} ${testRes.statusText}`);
      }
    } catch (err) {
      console.log(`   ✗ Connection error: ${err.message}`);
    }
  } else if (JSONBIN_API_KEY) {
    console.log(`☁️ JSONBin: API key set but NO BIN ID - need to create bin or set JSONBIN_BIN_ID`);
    console.log(`   Call POST /api/jsonbin-create to create a new bin`);
  } else {
    console.log(`⚠️ JSONBin: NOT CONFIGURED - performance data will be LOST on redeploy!`);
    console.log(`   Set JSONBIN_API_KEY and JSONBIN_BIN_ID in Render environment variables`);
  }

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
    if (savedSettings.degenMode) {
      config.degenMode = { ...config.degenMode, ...savedSettings.degenMode };
    }
    if (savedSettings.minEdge !== undefined) {
      config.minEdge = savedSettings.minEdge;
    }
    console.log(`⚙️ Risk limits: $${config.riskLimits.maxPerBet/100}/bet, $${(config.riskLimits.maxTotal || 1500)/100} max exposure`);
    console.log(`🔥 Degen mode: ${config.degenMode.enabled ? 'ENABLED' : 'disabled'}`);
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
