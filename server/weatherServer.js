// WEATHER SERVER
// Clean, focused Express server for Kalshi weather market betting.
// Replaces the monolithic index.js — no crypto code, no ML, no copy trading.
//
// Dependencies: express, cors, pg, bcryptjs, jsonwebtoken, node-fetch
// Imports:      db.js, auth.js, kalshiAPI.js, weatherBot.js

import express from 'express';
import cors from 'cors';
import { pool, initDatabase } from './db.js';
import { registerUser, loginUser, verifyToken, getUserInfo } from './auth.js';
import { kalshiRequest } from './kalshiAPI.js';
import { scanWeatherMarkets, calcWeatherBetSize, WEATHER_CITIES } from './weatherBot.js';

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// ──────────────────────────────────────────────
// USER STATE  (in-memory cache + DB persistence)
// ──────────────────────────────────────────────

const userStates = new Map(); // userId → { config, portfolio, betHistory }

const DEFAULT_CONFIG = {
  isAuthenticated: false,
  apiKeyId: null,
  privateKey: null,
  weatherBetting: {
    enabled: false,
    minEdge: 0.10,
    minLiquidity: 500,
    maxHoursToClose: 30,
    minHoursToClose: 2,
    makerMode: true,
    kellyFraction: 0.50,
    maxDollarsPerBet: 10,
    maxBankrollPct: 0.35,
    scanIntervalMinutes: 5,
  },
};

async function loadUserState(userId) {
  if (userStates.has(userId)) return userStates.get(userId);

  const result = await pool.query(
    'SELECT config, portfolio, bet_history FROM user_data WHERE user_id = $1',
    [userId]
  );

  let state;
  if (result.rows.length > 0) {
    const row = result.rows[0];
    state = {
      config: { ...DEFAULT_CONFIG, ...row.config, weatherBetting: { ...DEFAULT_CONFIG.weatherBetting, ...(row.config?.weatherBetting || {}) } },
      portfolio: row.portfolio || { balance: 0, positions: [] },
      betHistory: row.bet_history || [],
    };
  } else {
    state = {
      config: { ...DEFAULT_CONFIG, weatherBetting: { ...DEFAULT_CONFIG.weatherBetting } },
      portfolio: { balance: 0, positions: [] },
      betHistory: [],
    };
  }

  userStates.set(userId, state);
  return state;
}

async function saveUserState(userId) {
  const state = userStates.get(userId);
  if (!state) return;
  await pool.query(
    `INSERT INTO user_data (user_id, config, portfolio, bet_history, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET config = $2, portfolio = $3, bet_history = $4, updated_at = NOW()`,
    [userId, state.config, state.portfolio, state.betHistory]
  );
}

// Auth middleware — verifies JWT and attaches userId + userState to request
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });

  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ success: false, error: 'Invalid or expired token' });

  try {
    req.userId = userId;
    req.userState = await loadUserState(userId);
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load user state' });
  }
}

// ──────────────────────────────────────────────
// AUTH ROUTES
// ──────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const result = await registerUser(email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const result = await loginUser(email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const userInfo = await getUserInfo(req.userId);
    res.json({ success: true, user: userInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Configure Kalshi API credentials — tests them before saving
app.post('/api/auth/configure', requireAuth, async (req, res) => {
  const { apiKeyId, privateKey } = req.body;
  if (!apiKeyId || !privateKey) {
    return res.status(400).json({ success: false, error: 'apiKeyId and privateKey required' });
  }

  // Normalize private key (handle escaped newlines from JSON env vars)
  const normalizedKey = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;

  const testConfig = { ...req.userState.config, apiKeyId, privateKey: normalizedKey, isAuthenticated: true };
  try {
    const balanceResp = await kalshiRequest('GET', '/portfolio/balance', null, testConfig);
    const balance = balanceResp?.balance?.available_balance ?? 0;
    req.userState.config.apiKeyId = apiKeyId;
    req.userState.config.privateKey = normalizedKey;
    req.userState.config.isAuthenticated = true;
    req.userState.portfolio.balance = balance;
    await saveUserState(req.userId);
    res.json({ success: true, balance: balance / 100 });
  } catch (err) {
    res.status(400).json({ success: false, error: `Credential test failed: ${err.message}` });
  }
});

app.post('/api/auth/disconnect', requireAuth, async (req, res) => {
  stopWeatherBetting(req.userId);
  req.userState.config.apiKeyId = null;
  req.userState.config.privateKey = null;
  req.userState.config.isAuthenticated = false;
  await saveUserState(req.userId);
  res.json({ success: true });
});

app.get('/api/auth/status', requireAuth, (req, res) => {
  const { isAuthenticated, apiKeyId } = req.userState.config;
  res.json({ success: true, isAuthenticated: !!isAuthenticated, hasApiKey: !!apiKeyId });
});

// ──────────────────────────────────────────────
// PORTFOLIO / BALANCE
// ──────────────────────────────────────────────

app.get('/api/portfolio', requireAuth, (req, res) => {
  const { portfolio, betHistory } = req.userState;
  res.json({
    success: true,
    balance: (portfolio.balance || 0) / 100,
    balanceCents: portfolio.balance || 0,
    positions: portfolio.positions || [],
    betHistory: (betHistory || []).slice(-50),
  });
});

app.get('/api/balance/refresh', requireAuth, async (req, res) => {
  if (!req.userState.config.isAuthenticated) {
    return res.status(401).json({ success: false, error: 'Kalshi credentials required' });
  }
  try {
    const balanceResp = await kalshiRequest('GET', '/portfolio/balance', null, req.userState.config);
    const balance = balanceResp?.balance?.available_balance ?? 0;
    req.userState.portfolio.balance = balance;

    try {
      const positionsResp = await kalshiRequest(
        'GET', '/portfolio/positions?limit=100', null, req.userState.config
      );
      req.userState.portfolio.positions = positionsResp?.market_positions || [];
    } catch { /* positions fetch is optional */ }

    await saveUserState(req.userId);
    res.json({ success: true, balance: balance / 100, balanceCents: balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────
// WEATHER BETTING — background loop
// ──────────────────────────────────────────────

const weatherBetIntervals = new Map(); // userId → intervalId
const weatherBetRunning = new Map();   // userId → boolean (concurrency guard)

async function runWeatherBet(userId) {
  if (weatherBetRunning.get(userId)) return;
  weatherBetRunning.set(userId, true);

  try {
    const state = await loadUserState(userId);
    const { config, portfolio } = state;
    const wCfg = config.weatherBetting || {};

    if (!wCfg.enabled) return;

    const balance = portfolio.balance || 0;
    if (balance < 500) { // less than $5
      console.log(`[WEATHER] Bankroll too low ($${(balance / 100).toFixed(2)}) — skipping`);
      return;
    }

    console.log(`\n☁  WEATHER SCAN for ${userId} (balance: $${(balance / 100).toFixed(2)})`);
    const { opportunities } = await scanWeatherMarkets(kalshiRequest, config);
    if (opportunities.length === 0) return;

    const toPlace = opportunities.slice(0, 2); // safety: max 2 bets per scan

    for (const opp of toPlace) {
      try {
        // Skip if already holding this market
        const existing = (portfolio.positions || []).find(p => p.ticker === opp.ticker);
        if (existing) {
          console.log(`[WEATHER] Already holding ${opp.ticker} — skipping`);
          continue;
        }

        // Kelly-size the bet
        const betDollars = calcWeatherBetSize(opp.betModelProb, opp.betPrice, balance / 100, wCfg);
        const contracts = Math.max(1, Math.round(betDollars / opp.betPrice));
        const maxContracts = Math.floor((wCfg.maxDollarsPerBet || 25) / opp.betPrice);
        const finalContracts = Math.min(contracts, maxContracts);
        if (finalContracts < 1) continue;

        const priceInCents = Math.round(opp.betPrice * 100);
        console.log(
          `☁  WEATHER BET: ${opp.betSide} ${opp.city} ${opp.isAboveMarket ? '>=' : 'range'} ${opp.threshold}°F` +
          ` on ${opp.targetDate} | ${finalContracts}x @ ${priceInCents}c` +
          ` | blended: ${(opp.betModelProb * 100).toFixed(1)}%` +
          ` | edge: ${(opp.betEdge * 100).toFixed(1)}%`
        );

        if (!config.isAuthenticated) {
          console.log(`[WEATHER] SIM MODE — would bet ${finalContracts}x ${opp.betSide} @ ${priceInCents}c`);
          recordBet(state, opp, finalContracts, priceInCents);
          continue;
        }

        // Place real limit order
        const orderBody = {
          ticker: opp.ticker,
          client_order_id: `weather-${opp.ticker}-${Date.now()}`,
          type: wCfg.makerMode !== false ? 'limit' : 'market',
          action: 'buy',
          side: opp.betSide.toLowerCase(),
          count: finalContracts,
          expiration_ts: Math.floor((Date.now() + 30000) / 1000), // 30s limit expiry
        };
        if (opp.betSide === 'YES') orderBody.yes_price = priceInCents;
        else orderBody.no_price = priceInCents;

        const orderResp = await kalshiRequest('POST', '/portfolio/orders', orderBody, config);
        if (orderResp?.order) {
          const filled = orderResp.order.filled_count || 0;
          console.log(`[WEATHER] Order: ${orderResp.order.status} | filled ${filled}/${finalContracts}`);
          if (filled > 0) recordBet(state, opp, filled, priceInCents);
        }
      } catch (betErr) {
        console.error(`[WEATHER] Failed to bet on ${opp.ticker}: ${betErr.message}`);
      }
    }

    await saveUserState(userId);
  } catch (err) {
    console.error(`[WEATHER] Scan error for ${userId}: ${err.message}`);
  } finally {
    weatherBetRunning.set(userId, false);
  }
}

function recordBet(state, opp, contracts, priceInCents) {
  if (!state.betHistory) state.betHistory = [];
  state.betHistory.push({
    ticker: opp.ticker,
    side: opp.betSide,
    city: opp.city,
    threshold: opp.threshold,
    targetDate: opp.targetDate,
    contracts,
    priceInCents,
    totalCost: contracts * priceInCents,
    modelProb: opp.betModelProb,
    gfsRawProb: opp.gfsRawProb,
    hrrrForecastHigh: opp.hrrrForecastHigh,
    nbmForecastHigh: opp.nbmForecastHigh,
    edge: opp.betEdge,
    placedAt: new Date().toISOString(),
    settled: false,
    won: null,
    marketType: 'weather',
  });
  if (state.betHistory.length > 500) state.betHistory = state.betHistory.slice(-500);
}

function startWeatherBetting(userId) {
  if (weatherBetIntervals.has(userId)) return;
  loadUserState(userId).then(state => {
    const intervalMin = state.config.weatherBetting?.scanIntervalMinutes || 15;
    const intervalMs = intervalMin * 60 * 1000;
    runWeatherBet(userId).catch(() => {});
    const id = setInterval(() => runWeatherBet(userId).catch(() => {}), intervalMs);
    weatherBetIntervals.set(userId, id);
    console.log(`☁  Weather betting started for ${userId} (every ${intervalMin} min)`);
  });
}

function stopWeatherBetting(userId) {
  const id = weatherBetIntervals.get(userId);
  if (id) {
    clearInterval(id);
    weatherBetIntervals.delete(userId);
    console.log(`☁  Weather betting stopped for ${userId}`);
  }
}

// ──────────────────────────────────────────────
// WEATHER BET ROUTES
// ──────────────────────────────────────────────

// Enable / disable the automated weather scan
app.post('/api/weather-bet/toggle', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  const cfg = req.userState.config;
  if (!cfg.weatherBetting) cfg.weatherBetting = { ...DEFAULT_CONFIG.weatherBetting };
  cfg.weatherBetting.enabled = !!enabled;
  if (enabled) startWeatherBetting(req.userId);
  else stopWeatherBetting(req.userId);
  await saveUserState(req.userId);
  res.json({ success: true, weatherBettingEnabled: cfg.weatherBetting.enabled });
});

// Update weather config parameters
app.post('/api/weather-bet/config', requireAuth, async (req, res) => {
  const cfg = req.userState.config;
  if (!cfg.weatherBetting) cfg.weatherBetting = { ...DEFAULT_CONFIG.weatherBetting };
  const allowed = [
    'minEdge', 'minLiquidity', 'maxHoursToClose', 'minHoursToClose',
    'makerMode', 'kellyFraction', 'maxDollarsPerBet', 'maxBankrollPct', 'scanIntervalMinutes',
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) cfg.weatherBetting[key] = req.body[key];
  }
  await saveUserState(req.userId);
  res.json({ success: true, weatherBetting: cfg.weatherBetting });
});

// On-demand scan — returns current opportunities without placing bets
app.get('/api/weather-bet/opportunities', requireAuth, async (req, res) => {
  try {
    const { opportunities, errors } = await scanWeatherMarkets(kalshiRequest, req.userState.config);
    res.json({ opportunities, errors, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get status + restore interval on server restart
app.get('/api/weather-bet/status', requireAuth, (req, res) => {
  const wCfg = req.userState.config.weatherBetting || {};
  if (wCfg.enabled && !weatherBetIntervals.has(req.userId)) {
    startWeatherBetting(req.userId);
  }
  res.json({
    enabled: !!wCfg.enabled,
    intervalRunning: weatherBetIntervals.has(req.userId),
    config: wCfg,
    cities: Object.entries(WEATHER_CITIES).map(([ticker, c]) => ({
      ticker, name: c.name, station: c.station,
    })),
  });
});

// ──────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', server: 'weather', timestamp: new Date().toISOString() });
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────

await initDatabase();
app.listen(PORT, () => {
  console.log(`\n☁  Shimi Weather Server on port ${PORT}`);
  console.log(`   CORS: ${CORS_ORIGIN}`);
  console.log(`   DB:   ${process.env.DATABASE_URL ? 'connected' : 'DATABASE_URL not set'}`);
});
