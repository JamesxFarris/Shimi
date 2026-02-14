// COPY TRADING ENGINE
// Monitors "leader" Kalshi accounts and mirrors their trades to the follower's account.
//
// Flow:
//   1. User adds a leader by providing their Kalshi API key (read-only scope is sufficient)
//   2. Engine polls leader's fills every N seconds
//   3. New fills are detected and matching orders placed on the follower's account
//   4. Scale factor controls position sizing relative to leader

import { kalshiRequest } from './kalshiAPI.js';

// ============================================
// LEADER STATE
// ============================================

// In-memory state per user: userId -> CopyTradingState
const copyTradingStates = new Map();

function getCopyState(userId) {
  if (!copyTradingStates.has(userId)) {
    copyTradingStates.set(userId, {
      leaders: [],        // Array of leader configs
      activity: [],       // Recent copy trade activity log (last 100)
      intervals: new Map(), // leaderId -> interval handle
      running: false,
    });
  }
  return copyTradingStates.get(userId);
}

// ============================================
// LEADER MANAGEMENT
// ============================================

function addLeader(userId, { name, apiKeyId, privateKey, scaleFactor = 1.0, maxBetCents = 500, marketsFilter = null }) {
  const state = getCopyState(userId);
  const id = `leader_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const leader = {
    id,
    name: name || `Leader ${state.leaders.length + 1}`,
    apiKeyId,
    privateKey,
    isAuthenticated: true,
    scaleFactor: Math.max(0.01, Math.min(10, scaleFactor)),  // 1% to 1000%
    maxBetCents: Math.max(50, Math.min(10000, maxBetCents)), // $0.50 to $100
    marketsFilter,  // null = all markets, or array of event prefixes like ['KXBTC', 'KXETH']
    enabled: true,
    addedAt: new Date().toISOString(),
    lastPollAt: null,
    lastFillId: null,
    lastFillTime: null,
    stats: {
      totalCopied: 0,
      totalSkipped: 0,
      totalErrored: 0,
      profitCents: 0,
    },
  };

  state.leaders.push(leader);
  return leader;
}

function removeLeader(userId, leaderId) {
  const state = getCopyState(userId);

  // Stop polling if running
  if (state.intervals.has(leaderId)) {
    clearInterval(state.intervals.get(leaderId));
    state.intervals.delete(leaderId);
  }

  const idx = state.leaders.findIndex(l => l.id === leaderId);
  if (idx === -1) return false;
  state.leaders.splice(idx, 1);
  return true;
}

function updateLeader(userId, leaderId, updates) {
  const state = getCopyState(userId);
  const leader = state.leaders.find(l => l.id === leaderId);
  if (!leader) return null;

  if (updates.name !== undefined) leader.name = updates.name;
  if (updates.scaleFactor !== undefined) leader.scaleFactor = Math.max(0.01, Math.min(10, updates.scaleFactor));
  if (updates.maxBetCents !== undefined) leader.maxBetCents = Math.max(50, Math.min(10000, updates.maxBetCents));
  if (updates.marketsFilter !== undefined) leader.marketsFilter = updates.marketsFilter;
  if (updates.enabled !== undefined) leader.enabled = updates.enabled;

  return leader;
}

function getLeaders(userId) {
  const state = getCopyState(userId);
  // Return sanitized leaders (no private keys exposed)
  return state.leaders.map(l => ({
    id: l.id,
    name: l.name,
    apiKeyId: l.apiKeyId ? l.apiKeyId.slice(0, 8) + '...' : null,
    scaleFactor: l.scaleFactor,
    maxBetCents: l.maxBetCents,
    marketsFilter: l.marketsFilter,
    enabled: l.enabled,
    addedAt: l.addedAt,
    lastPollAt: l.lastPollAt,
    lastFillId: l.lastFillId,
    stats: l.stats,
  }));
}

// ============================================
// FILL POLLING
// ============================================

async function pollLeaderFills(leader) {
  const leaderConfig = {
    apiKeyId: leader.apiKeyId,
    privateKey: leader.privateKey,
    isAuthenticated: true,
  };

  // Fetch recent fills. Use min_ts to only get fills after last seen
  let endpoint = '/portfolio/fills?limit=50';
  if (leader.lastFillTime) {
    // Add 1ms to avoid re-fetching the exact same fill
    const minTs = Math.floor(new Date(leader.lastFillTime).getTime() / 1000) + 1;
    endpoint += `&min_ts=${minTs}`;
  }

  const data = await kalshiRequest('GET', endpoint, null, leaderConfig);
  const fills = data.fills || [];

  if (fills.length === 0) {
    leader.lastPollAt = new Date().toISOString();
    return [];
  }

  // Filter out already-seen fills
  const newFills = leader.lastFillId
    ? fills.filter(f => f.fill_id !== leader.lastFillId && new Date(f.created_time) > new Date(leader.lastFillTime))
    : fills;

  // On first poll, just record the latest fill and don't copy (avoid copying entire history)
  if (!leader.lastFillId && fills.length > 0) {
    const latest = fills[0]; // Fills come newest first
    leader.lastFillId = latest.fill_id || latest.trade_id;
    leader.lastFillTime = latest.created_time;
    leader.lastPollAt = new Date().toISOString();
    return [];
  }

  // Update last seen
  if (newFills.length > 0) {
    const latest = newFills[0];
    leader.lastFillId = latest.fill_id || latest.trade_id;
    leader.lastFillTime = latest.created_time;
  }
  leader.lastPollAt = new Date().toISOString();

  return newFills;
}

// ============================================
// TRADE MIRRORING
// ============================================

async function mirrorFill(fill, leader, followerConfig) {
  const ticker = fill.ticker || fill.market_ticker;
  const side = fill.side;       // 'yes' or 'no'
  const action = fill.action;   // 'buy' or 'sell'
  const leaderCount = fill.count || 1;

  // Apply scale factor
  let copyCount = Math.max(1, Math.round(leaderCount * leader.scaleFactor));

  // Apply max bet cap
  const pricePerContract = side === 'yes' ? (fill.yes_price || 50) : (fill.no_price || 50);
  const totalCostCents = copyCount * pricePerContract;
  if (totalCostCents > leader.maxBetCents) {
    copyCount = Math.max(1, Math.floor(leader.maxBetCents / pricePerContract));
  }

  // Apply market filter
  if (leader.marketsFilter && leader.marketsFilter.length > 0) {
    const matchesFilter = leader.marketsFilter.some(prefix =>
      ticker.toUpperCase().startsWith(prefix.toUpperCase())
    );
    if (!matchesFilter) {
      return { status: 'skipped', reason: 'market_filter', ticker, fill };
    }
  }

  // Place the order on follower's account
  const orderBody = {
    ticker,
    action,
    side,
    type: 'market',
    count: copyCount,
  };

  try {
    const result = await kalshiRequest('POST', '/portfolio/orders', orderBody, followerConfig);
    return {
      status: 'copied',
      leaderFillId: fill.fill_id || fill.trade_id,
      leaderName: leader.name,
      ticker,
      side,
      action,
      leaderCount,
      copyCount,
      pricePerContract,
      orderId: result.order?.order_id,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: 'error',
      leaderFillId: fill.fill_id || fill.trade_id,
      leaderName: leader.name,
      ticker,
      side,
      action,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// ============================================
// COPY TRADING LOOP
// ============================================

async function runCopyTradingCycle(userId, followerConfig) {
  const state = getCopyState(userId);

  for (const leader of state.leaders) {
    if (!leader.enabled) continue;

    try {
      const newFills = await pollLeaderFills(leader);

      for (const fill of newFills) {
        const result = await mirrorFill(fill, leader, followerConfig);

        // Log activity
        state.activity.unshift(result);
        if (state.activity.length > 100) state.activity.length = 100;

        // Update stats
        if (result.status === 'copied') {
          leader.stats.totalCopied++;
          console.log(` COPY TRADE [${leader.name}]: ${result.action} ${result.copyCount}x ${result.side} ${result.ticker} (leader: ${result.leaderCount}x)`);
        } else if (result.status === 'skipped') {
          leader.stats.totalSkipped++;
          console.log(` COPY SKIP [${leader.name}]: ${result.reason} - ${result.ticker}`);
        } else if (result.status === 'error') {
          leader.stats.totalErrored++;
          console.error(` COPY ERROR [${leader.name}]: ${result.error} - ${result.ticker}`);
        }
      }
    } catch (err) {
      console.error(` COPY POLL ERROR [${leader.name}]: ${err.message}`);
      leader.stats.totalErrored++;
    }
  }
}

// ============================================
// START / STOP
// ============================================

function startCopyTrading(userId, followerConfig, intervalMs = 15000) {
  const state = getCopyState(userId);

  if (state.running) {
    return { success: false, error: 'Copy trading already running' };
  }

  state.running = true;

  // Run immediately, then on interval
  runCopyTradingCycle(userId, followerConfig).catch(err =>
    console.error(`Copy trading initial cycle error: ${err.message}`)
  );

  const intervalHandle = setInterval(() => {
    runCopyTradingCycle(userId, followerConfig).catch(err =>
      console.error(`Copy trading cycle error: ${err.message}`)
    );
  }, intervalMs);

  state.intervalHandle = intervalHandle;

  console.log(` Copy trading started for user ${userId} (${state.leaders.filter(l => l.enabled).length} leaders, ${intervalMs}ms interval)`);
  return { success: true };
}

function stopCopyTrading(userId) {
  const state = getCopyState(userId);

  if (!state.running) {
    return { success: false, error: 'Copy trading not running' };
  }

  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }

  state.running = false;

  console.log(` Copy trading stopped for user ${userId}`);
  return { success: true };
}

function getCopyTradingStatus(userId) {
  const state = getCopyState(userId);
  return {
    running: state.running,
    leaders: getLeaders(userId),
    recentActivity: state.activity.slice(0, 20),
    stats: {
      totalLeaders: state.leaders.length,
      activeLeaders: state.leaders.filter(l => l.enabled).length,
      totalCopied: state.leaders.reduce((sum, l) => sum + l.stats.totalCopied, 0),
      totalSkipped: state.leaders.reduce((sum, l) => sum + l.stats.totalSkipped, 0),
      totalErrored: state.leaders.reduce((sum, l) => sum + l.stats.totalErrored, 0),
    },
  };
}

// ============================================
// SERIALIZATION (for DB persistence)
// ============================================

function serializeCopyState(userId) {
  const state = getCopyState(userId);
  return {
    leaders: state.leaders.map(l => ({
      id: l.id,
      name: l.name,
      apiKeyId: l.apiKeyId,
      privateKey: l.privateKey,
      scaleFactor: l.scaleFactor,
      maxBetCents: l.maxBetCents,
      marketsFilter: l.marketsFilter,
      enabled: l.enabled,
      addedAt: l.addedAt,
      lastFillId: l.lastFillId,
      lastFillTime: l.lastFillTime,
      stats: l.stats,
    })),
    activity: state.activity.slice(0, 50),
  };
}

function loadCopyState(userId, saved) {
  if (!saved || !saved.leaders) return;
  const state = getCopyState(userId);
  state.leaders = saved.leaders.map(l => ({
    ...l,
    isAuthenticated: true,
    lastPollAt: null,
  }));
  state.activity = saved.activity || [];
}

// ============================================
// EXPORTS
// ============================================

export {
  addLeader,
  removeLeader,
  updateLeader,
  getLeaders,
  startCopyTrading,
  stopCopyTrading,
  getCopyTradingStatus,
  runCopyTradingCycle,
  serializeCopyState,
  loadCopyState,
};
