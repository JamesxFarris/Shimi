// POLYMARKET TRACKER
// Monitors a Polymarket wallet's trades and maps them to Kalshi markets for copy trading.
//
// Polymarket Data API (public, no auth needed):
//   GET https://data-api.polymarket.com/activity?user=<wallet>&limit=20
//   GET https://data-api.polymarket.com/positions?user=<wallet>&limit=50
//
// Flow:
//   1. Poll a Polymarket wallet's activity for new trades
//   2. Parse the market title/slug to extract asset, direction, timeframe
//   3. Find the equivalent Kalshi market
//   4. Place matching bet on Kalshi via the copy trading engine

import fetch from 'node-fetch';
import { kalshiRequest } from './kalshiAPI.js';

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';

// ============================================
// POLYMARKET WALLET TRACKING
// ============================================

// In-memory state per user
const polyTrackerStates = new Map();

function getPolyState(userId) {
  if (!polyTrackerStates.has(userId)) {
    polyTrackerStates.set(userId, {
      wallets: [],      // Array of tracked Polymarket wallets
      activity: [],     // Recent mirrored trade log (last 100)
      running: false,
      intervalHandle: null,
    });
  }
  return polyTrackerStates.get(userId);
}

// ============================================
// WALLET MANAGEMENT
// ============================================

function addPolyWallet(userId, { name, walletAddress, scaleFactor = 1.0, maxBetCents = 500, assetsFilter = null }) {
  const state = getPolyState(userId);
  const id = `poly_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Normalize wallet address
  const addr = walletAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(addr)) {
    throw new Error('Invalid Ethereum wallet address');
  }

  const wallet = {
    id,
    name: name || `Polymarket ${state.wallets.length + 1}`,
    walletAddress: addr,
    scaleFactor: Math.max(0.01, Math.min(10, scaleFactor)),
    maxBetCents: Math.max(50, Math.min(10000, maxBetCents)),
    assetsFilter,  // null = all, or ['BTC', 'ETH', 'SOL']
    enabled: true,
    addedAt: new Date().toISOString(),
    lastPollAt: null,
    lastTradeTimestamp: null,
    lastTradeHash: null,
    stats: {
      totalCopied: 0,
      totalSkipped: 0,
      totalNoMatch: 0,
      totalErrored: 0,
    },
  };

  state.wallets.push(wallet);
  return wallet;
}

function removePolyWallet(userId, walletId) {
  const state = getPolyState(userId);
  const idx = state.wallets.findIndex(w => w.id === walletId);
  if (idx === -1) return false;
  state.wallets.splice(idx, 1);
  return true;
}

function updatePolyWallet(userId, walletId, updates) {
  const state = getPolyState(userId);
  const wallet = state.wallets.find(w => w.id === walletId);
  if (!wallet) return null;

  if (updates.name !== undefined) wallet.name = updates.name;
  if (updates.scaleFactor !== undefined) wallet.scaleFactor = Math.max(0.01, Math.min(10, updates.scaleFactor));
  if (updates.maxBetCents !== undefined) wallet.maxBetCents = Math.max(50, Math.min(10000, updates.maxBetCents));
  if (updates.assetsFilter !== undefined) wallet.assetsFilter = updates.assetsFilter;
  if (updates.enabled !== undefined) wallet.enabled = updates.enabled;

  return wallet;
}

function getPolyWallets(userId) {
  const state = getPolyState(userId);
  return state.wallets.map(w => ({
    id: w.id,
    name: w.name,
    walletAddress: w.walletAddress,
    scaleFactor: w.scaleFactor,
    maxBetCents: w.maxBetCents,
    assetsFilter: w.assetsFilter,
    enabled: w.enabled,
    addedAt: w.addedAt,
    lastPollAt: w.lastPollAt,
    stats: w.stats,
  }));
}

// ============================================
// POLYMARKET API
// ============================================

async function fetchPolyActivity(walletAddress, limit = 20) {
  const url = `${POLYMARKET_DATA_API}/activity?user=${walletAddress}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Shimi/1.0' },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`Polymarket API error ${res.status}`);
  return res.json();
}

async function fetchPolyPositions(walletAddress, limit = 50) {
  const url = `${POLYMARKET_DATA_API}/positions?user=${walletAddress}&sizeThreshold=0.1&limit=${limit}&sortBy=CURRENT&sortDirection=DESC`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Shimi/1.0' },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`Polymarket API error ${res.status}`);
  return res.json();
}

async function fetchPolyProfile(walletAddress) {
  const url = `${POLYMARKET_DATA_API}/profiles?user=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Shimi/1.0' },
      timeout: 10000,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ============================================
// MARKET TITLE PARSING
// ============================================

// Parse Polymarket crypto market titles into structured data
// Examples:
//   "Bitcoin Up or Down (15 min) Feb 14, 2026, 3:00 PM" → { asset: 'BTC', timeframe: '15m' }
//   "Ethereum Up or Down (15 min)" → { asset: 'ETH', timeframe: '15m' }
//   "Will the price of Bitcoin be above $66,000 on February 14?" → { asset: 'BTC', strike: 66000, direction: 'above' }
//   "Solana Up or Down" → { asset: 'SOL' }

const ASSET_MAP = {
  'bitcoin': 'BTC',
  'btc': 'BTC',
  'ethereum': 'ETH',
  'eth': 'ETH',
  'solana': 'SOL',
  'sol': 'SOL',
  'xrp': 'XRP',
  'ripple': 'XRP',
  'dogecoin': 'DOGE',
  'doge': 'DOGE',
  'cardano': 'ADA',
  'ada': 'ADA',
  'avalanche': 'AVAX',
  'avax': 'AVAX',
  'chainlink': 'LINK',
  'link': 'LINK',
  'polygon': 'MATIC',
  'matic': 'MATIC',
  'polkadot': 'DOT',
  'dot': 'DOT',
};

// Kalshi crypto market ticker prefixes
const KALSHI_TICKER_PREFIX = {
  'BTC': 'KXBTC',
  'ETH': 'KXETH',
  'SOL': 'KXSOL',
  'XRP': 'KXXRP',
  'DOGE': 'KXDOGE',
  'ADA': 'KXADA',
  'AVAX': 'KXAVAX',
  'LINK': 'KXLINK',
  'MATIC': 'KXMATIC',
  'DOT': 'KXDOT',
};

function parsePolyMarketTitle(title, slug, outcome) {
  const titleLower = (title || '').toLowerCase();
  const slugLower = (slug || '').toLowerCase();

  // Detect asset
  let asset = null;
  for (const [keyword, symbol] of Object.entries(ASSET_MAP)) {
    if (titleLower.includes(keyword) || slugLower.includes(keyword)) {
      asset = symbol;
      break;
    }
  }

  // Detect from slug patterns like "eth-updown-15m-..." or "btc-updown-15m-..."
  if (!asset) {
    const slugMatch = slugLower.match(/^(btc|eth|sol|xrp|doge|ada|avax|link|matic|dot)/);
    if (slugMatch) asset = slugMatch[1].toUpperCase();
  }

  if (!asset) return null; // Not a crypto market we can match

  // Detect timeframe
  let timeframe = null;
  if (titleLower.includes('15 min') || slugLower.includes('15m')) timeframe = '15m';
  else if (titleLower.includes('1 hour') || slugLower.includes('1h')) timeframe = '1h';
  else if (titleLower.includes('4 hour') || slugLower.includes('4h')) timeframe = '4h';

  // Detect direction from outcome
  let direction = null;
  const outcomeLower = (outcome || '').toLowerCase();
  if (outcomeLower === 'up' || outcomeLower === 'yes' || outcomeLower === 'above') {
    direction = 'up';
  } else if (outcomeLower === 'down' || outcomeLower === 'no' || outcomeLower === 'below') {
    direction = 'down';
  }

  // Try to detect strike price
  let strike = null;
  const strikeMatch = (title || '').match(/\$([0-9,]+(?:\.\d+)?)/);
  if (strikeMatch) {
    strike = parseFloat(strikeMatch[1].replace(/,/g, ''));
  }

  return { asset, timeframe, direction, strike };
}

// ============================================
// KALSHI MARKET MATCHING
// ============================================

// Cache of active Kalshi markets (refreshed periodically)
let kalshiMarketCache = { markets: [], lastFetched: 0 };
const CACHE_TTL_MS = 30000; // 30 seconds

async function refreshKalshiMarkets(followerConfig) {
  const now = Date.now();
  if (now - kalshiMarketCache.lastFetched < CACHE_TTL_MS && kalshiMarketCache.markets.length > 0) {
    return kalshiMarketCache.markets;
  }

  try {
    // Fetch active crypto markets from Kalshi
    const data = await kalshiRequest('GET', '/markets?status=active&series_ticker=KXBTC,KXETH,KXSOL,KXXRP&limit=200', null, followerConfig);
    kalshiMarketCache.markets = data.markets || [];
    kalshiMarketCache.lastFetched = now;
    return kalshiMarketCache.markets;
  } catch (err) {
    console.error(' Failed to fetch Kalshi markets for matching:', err.message);
    return kalshiMarketCache.markets; // Return stale cache
  }
}

function findMatchingKalshiMarket(parsed, kalshiMarkets) {
  if (!parsed || !parsed.asset) return null;

  const prefix = KALSHI_TICKER_PREFIX[parsed.asset];
  if (!prefix) return null;

  // Filter to markets matching the asset
  const assetMarkets = kalshiMarkets.filter(m =>
    m.ticker?.startsWith(prefix) || m.event_ticker?.startsWith(prefix)
  );

  if (assetMarkets.length === 0) return null;

  // For 15-minute up/down markets, find the closest active market
  // Kalshi 15m crypto markets have tickers like KXBTC-26FEB14-T1530-B66000
  // We want the one that's currently active (closest to expiry but still open)
  const now = new Date();

  let bestMatch = null;
  let bestTimeDiff = Infinity;

  for (const market of assetMarkets) {
    // Prefer markets that are still open and close soon (active 15m windows)
    const closeTime = market.close_time ? new Date(market.close_time) : null;
    if (!closeTime || closeTime < now) continue;

    const timeDiff = closeTime - now;

    // If we have a strike from Polymarket, try to match it
    if (parsed.strike) {
      const tickerStrike = extractStrikeFromTicker(market.ticker);
      if (tickerStrike && Math.abs(tickerStrike - parsed.strike) / parsed.strike > 0.02) {
        continue; // Strike too far off (>2% difference)
      }
    }

    // Prefer the closest-to-expiry active market
    if (timeDiff < bestTimeDiff) {
      bestTimeDiff = timeDiff;
      bestMatch = market;
    }
  }

  return bestMatch;
}

function extractStrikeFromTicker(ticker) {
  // Kalshi tickers like KXBTC-26FEB14-T1530-B66000
  // The B66000 part is the strike price
  const match = (ticker || '').match(/[BA](\d+(?:\.\d+)?)/);
  if (match) return parseFloat(match[1]);
  return null;
}

// ============================================
// TRADE MIRRORING
// ============================================

async function mirrorPolyTrade(trade, wallet, followerConfig) {
  const parsed = parsePolyMarketTitle(trade.title, trade.slug, trade.outcome);

  if (!parsed) {
    return {
      status: 'no_match',
      reason: 'not_crypto',
      polyTitle: trade.title,
      polyOutcome: trade.outcome,
      walletName: wallet.name,
      timestamp: new Date().toISOString(),
    };
  }

  // Apply asset filter
  if (wallet.assetsFilter && wallet.assetsFilter.length > 0) {
    if (!wallet.assetsFilter.includes(parsed.asset)) {
      return {
        status: 'skipped',
        reason: 'asset_filter',
        asset: parsed.asset,
        polyTitle: trade.title,
        walletName: wallet.name,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Find matching Kalshi market
  const kalshiMarkets = await refreshKalshiMarkets(followerConfig);
  const kalshiMarket = findMatchingKalshiMarket(parsed, kalshiMarkets);

  if (!kalshiMarket) {
    return {
      status: 'no_match',
      reason: 'no_kalshi_equivalent',
      asset: parsed.asset,
      direction: parsed.direction,
      polyTitle: trade.title,
      walletName: wallet.name,
      timestamp: new Date().toISOString(),
    };
  }

  // Map direction: Polymarket "Up" → Kalshi "Yes", Polymarket "Down" → Kalshi "No"
  const kalshiSide = parsed.direction === 'up' ? 'yes' : 'no';

  // Calculate contract count based on USDC size and scale factor
  const polyUsdcSize = parseFloat(trade.usdcSize || trade.size || 1);
  const scaledUsdCents = Math.round(polyUsdcSize * 100 * wallet.scaleFactor);

  // Estimate contracts: divide total $ by estimated price per contract
  // Kalshi crypto markets are typically in the 30-70 cent range
  const estPricePerContract = 50; // 50 cents as default estimate
  let copyCount = Math.max(1, Math.round(scaledUsdCents / estPricePerContract));

  // Cap by maxBetCents
  const totalCost = copyCount * estPricePerContract;
  if (totalCost > wallet.maxBetCents) {
    copyCount = Math.max(1, Math.floor(wallet.maxBetCents / estPricePerContract));
  }

  // Place order on Kalshi
  const orderBody = {
    ticker: kalshiMarket.ticker,
    action: 'buy',
    side: kalshiSide,
    type: 'market',
    count: copyCount,
  };

  try {
    const result = await kalshiRequest('POST', '/portfolio/orders', orderBody, followerConfig);
    return {
      status: 'copied',
      polyTitle: trade.title,
      polyOutcome: trade.outcome,
      polyUsdcSize: polyUsdcSize.toFixed(2),
      asset: parsed.asset,
      direction: parsed.direction,
      kalshiTicker: kalshiMarket.ticker,
      kalshiSide,
      copyCount,
      orderId: result.order?.order_id,
      walletName: wallet.name,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'error',
      polyTitle: trade.title,
      asset: parsed.asset,
      kalshiTicker: kalshiMarket.ticker,
      error: err.message,
      walletName: wallet.name,
      timestamp: new Date().toISOString(),
    };
  }
}

// ============================================
// POLLING LOOP
// ============================================

async function pollPolyWallet(wallet) {
  const trades = await fetchPolyActivity(wallet.walletAddress, 20);

  if (!Array.isArray(trades) || trades.length === 0) {
    wallet.lastPollAt = new Date().toISOString();
    return [];
  }

  // Only process BUY trades (not sells/redemptions)
  const buyTrades = trades.filter(t => t.type === 'TRADE' && t.side === 'BUY');

  if (buyTrades.length === 0) {
    wallet.lastPollAt = new Date().toISOString();
    return [];
  }

  // First poll: record latest trade and don't copy (avoid copying history)
  if (!wallet.lastTradeTimestamp) {
    const latest = buyTrades[0];
    wallet.lastTradeTimestamp = latest.timestamp;
    wallet.lastTradeHash = latest.transactionHash;
    wallet.lastPollAt = new Date().toISOString();
    console.log(` POLY TRACKER [${wallet.name}]: Initial sync - recorded latest trade at ${latest.timestamp}`);
    return [];
  }

  // Find new trades since last poll
  const newTrades = buyTrades.filter(t => {
    if (t.transactionHash === wallet.lastTradeHash) return false;
    return t.timestamp > wallet.lastTradeTimestamp;
  });

  // Update last seen
  if (newTrades.length > 0) {
    const latest = newTrades[0];
    wallet.lastTradeTimestamp = latest.timestamp;
    wallet.lastTradeHash = latest.transactionHash;
  }
  wallet.lastPollAt = new Date().toISOString();

  return newTrades;
}

async function runPolyCycle(userId, followerConfig) {
  const state = getPolyState(userId);

  for (const wallet of state.wallets) {
    if (!wallet.enabled) continue;

    try {
      const newTrades = await pollPolyWallet(wallet);

      for (const trade of newTrades) {
        const result = await mirrorPolyTrade(trade, wallet, followerConfig);

        // Log activity
        state.activity.unshift(result);
        if (state.activity.length > 100) state.activity.length = 100;

        // Update stats
        if (result.status === 'copied') {
          wallet.stats.totalCopied++;
          console.log(` POLY COPY [${wallet.name}]: ${result.copyCount}x ${result.kalshiSide} ${result.kalshiTicker} (from ${result.polyTitle})`);
        } else if (result.status === 'skipped') {
          wallet.stats.totalSkipped++;
        } else if (result.status === 'no_match') {
          wallet.stats.totalNoMatch++;
          console.log(` POLY NO MATCH [${wallet.name}]: ${result.reason} - ${result.polyTitle}`);
        } else if (result.status === 'error') {
          wallet.stats.totalErrored++;
          console.error(` POLY ERROR [${wallet.name}]: ${result.error}`);
        }
      }

      if (newTrades.length > 0) {
        console.log(` POLY TRACKER [${wallet.name}]: Processed ${newTrades.length} new trades`);
      }
    } catch (err) {
      console.error(` POLY POLL ERROR [${wallet.name}]: ${err.message}`);
      wallet.stats.totalErrored++;
    }
  }
}

// ============================================
// START / STOP
// ============================================

function startPolyTracker(userId, followerConfig, intervalMs = 20000) {
  const state = getPolyState(userId);

  if (state.running) {
    return { success: false, error: 'Polymarket tracker already running' };
  }

  state.running = true;

  // Run immediately
  runPolyCycle(userId, followerConfig).catch(err =>
    console.error(`Poly tracker initial cycle error: ${err.message}`)
  );

  state.intervalHandle = setInterval(() => {
    runPolyCycle(userId, followerConfig).catch(err =>
      console.error(`Poly tracker cycle error: ${err.message}`)
    );
  }, intervalMs);

  console.log(` Polymarket tracker started for user ${userId} (${state.wallets.filter(w => w.enabled).length} wallets, ${intervalMs}ms interval)`);
  return { success: true };
}

function stopPolyTracker(userId) {
  const state = getPolyState(userId);

  if (!state.running) {
    return { success: false, error: 'Polymarket tracker not running' };
  }

  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }

  state.running = false;
  console.log(` Polymarket tracker stopped for user ${userId}`);
  return { success: true };
}

function getPolyTrackerStatus(userId) {
  const state = getPolyState(userId);
  return {
    running: state.running,
    wallets: getPolyWallets(userId),
    recentActivity: state.activity.slice(0, 20),
    stats: {
      totalWallets: state.wallets.length,
      activeWallets: state.wallets.filter(w => w.enabled).length,
      totalCopied: state.wallets.reduce((s, w) => s + w.stats.totalCopied, 0),
      totalSkipped: state.wallets.reduce((s, w) => s + w.stats.totalSkipped, 0),
      totalNoMatch: state.wallets.reduce((s, w) => s + w.stats.totalNoMatch, 0),
      totalErrored: state.wallets.reduce((s, w) => s + w.stats.totalErrored, 0),
    },
  };
}

// ============================================
// SERIALIZATION
// ============================================

function serializePolyState(userId) {
  const state = getPolyState(userId);
  return {
    wallets: state.wallets.map(w => ({
      id: w.id,
      name: w.name,
      walletAddress: w.walletAddress,
      scaleFactor: w.scaleFactor,
      maxBetCents: w.maxBetCents,
      assetsFilter: w.assetsFilter,
      enabled: w.enabled,
      addedAt: w.addedAt,
      lastTradeTimestamp: w.lastTradeTimestamp,
      lastTradeHash: w.lastTradeHash,
      stats: w.stats,
    })),
    activity: state.activity.slice(0, 50),
  };
}

function loadPolyState(userId, saved) {
  if (!saved || !saved.wallets) return;
  const state = getPolyState(userId);
  state.wallets = saved.wallets.map(w => ({
    ...w,
    lastPollAt: null,
  }));
  state.activity = saved.activity || [];
}

// ============================================
// EXPORTS
// ============================================

export {
  addPolyWallet,
  removePolyWallet,
  updatePolyWallet,
  getPolyWallets,
  startPolyTracker,
  stopPolyTracker,
  getPolyTrackerStatus,
  runPolyCycle,
  serializePolyState,
  loadPolyState,
  fetchPolyPositions,
  fetchPolyProfile,
  parsePolyMarketTitle,
};
