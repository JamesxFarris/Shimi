// WALLET ANALYZER
// Analyzes a Polymarket wallet's trading history to detect profit strategies.
//
// Key patterns detected:
//   1. Both-sides arbitrage: Buying YES and NO on same market when combined cost < $1
//   2. Market making: Providing liquidity on both sides to capture spread
//   3. Scalping: Quick entries/exits to capture small price movements
//   4. Event clustering: Timing trades around specific market conditions
//
// Usage:
//   const analysis = await analyzeWallet('0x...', { depth: 100 });

import fetch from 'node-fetch';

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// ============================================
// DATA FETCHING
// ============================================

async function fetchActivity(walletAddress, limit = 100, offset = 0) {
  const url = `${POLYMARKET_DATA_API}/activity?user=${walletAddress}&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Shimi/1.0' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Polymarket activity API error ${res.status}`);
  return res.json();
}

async function fetchPositions(walletAddress, limit = 100) {
  const url = `${POLYMARKET_DATA_API}/positions?user=${walletAddress}&sizeThreshold=0&limit=${limit}&sortBy=CURRENT&sortDirection=DESC`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Shimi/1.0' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Polymarket positions API error ${res.status}`);
  return res.json();
}

async function fetchProfile(walletAddress) {
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

// Fetch all activity pages up to a max depth
async function fetchAllActivity(walletAddress, maxTrades = 500) {
  const allTrades = [];
  let offset = 0;
  const pageSize = 100;

  while (allTrades.length < maxTrades) {
    const batch = await fetchActivity(walletAddress, pageSize, offset);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allTrades.push(...batch);
    if (batch.length < pageSize) break; // No more pages
    offset += pageSize;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  return allTrades.slice(0, maxTrades);
}

// ============================================
// TRADE GROUPING
// ============================================

// Group trades by market (conditionId or slug) to detect both-sides patterns
function groupByMarket(trades) {
  const markets = new Map(); // conditionId -> { trades, meta }

  for (const trade of trades) {
    const key = trade.conditionId || trade.slug || trade.title;
    if (!key) continue;

    if (!markets.has(key)) {
      markets.set(key, {
        conditionId: trade.conditionId,
        slug: trade.slug,
        title: trade.title,
        trades: [],
        buyYes: [],
        buyNo: [],
        sellYes: [],
        sellNo: [],
      });
    }

    const group = markets.get(key);
    group.trades.push(trade);

    const side = trade.side; // 'BUY' or 'SELL'
    const outcome = (trade.outcome || '').toLowerCase();

    if (side === 'BUY' && (outcome === 'yes' || outcome === 'up')) {
      group.buyYes.push(trade);
    } else if (side === 'BUY' && (outcome === 'no' || outcome === 'down')) {
      group.buyNo.push(trade);
    } else if (side === 'SELL' && (outcome === 'yes' || outcome === 'up')) {
      group.sellYes.push(trade);
    } else if (side === 'SELL' && (outcome === 'no' || outcome === 'down')) {
      group.sellNo.push(trade);
    }
  }

  return markets;
}

// Group trades by event (parent event that contains multiple markets)
function groupByEvent(trades) {
  const events = new Map(); // eventSlug -> trades[]

  for (const trade of trades) {
    // Use groupItemTitle or extract event from slug
    const eventKey = trade.groupItemTitle || trade.eventSlug || extractEventFromSlug(trade.slug);
    if (!eventKey) continue;

    if (!events.has(eventKey)) {
      events.set(eventKey, []);
    }
    events.get(eventKey).push(trade);
  }

  return events;
}

function extractEventFromSlug(slug) {
  if (!slug) return null;
  // Remove timestamp/specific parts to get the event base
  // e.g., "btc-updown-15m-2026-02-14-1500" -> "btc-updown-15m"
  const parts = slug.split('-');
  // Keep first 3-4 parts as the event identifier
  return parts.slice(0, Math.min(4, parts.length)).join('-');
}

// ============================================
// PATTERN DETECTION
// ============================================

// Detect both-sides arbitrage: buying YES + NO on same market
function detectBothSidesArbitrage(marketGroups) {
  const arbitrageTrades = [];

  for (const [key, group] of marketGroups) {
    if (group.buyYes.length > 0 && group.buyNo.length > 0) {
      // This market has buys on BOTH sides
      const yesAvgPrice = avgPrice(group.buyYes);
      const noAvgPrice = avgPrice(group.buyNo);
      const combinedCost = yesAvgPrice + noAvgPrice;
      const yesSize = totalSize(group.buyYes);
      const noSize = totalSize(group.buyNo);

      // If combined cost < $1.00, it's a guaranteed arbitrage
      const isArb = combinedCost < 1.0;
      const spread = 1.0 - combinedCost;
      const minContracts = Math.min(yesSize, noSize);
      const guaranteedProfit = isArb ? spread * minContracts : 0;

      arbitrageTrades.push({
        market: group.title || key,
        slug: group.slug,
        conditionId: group.conditionId,
        yesAvgPrice: round(yesAvgPrice, 4),
        noAvgPrice: round(noAvgPrice, 4),
        combinedCost: round(combinedCost, 4),
        yesContracts: round(yesSize, 2),
        noContracts: round(noSize, 2),
        isArbitrage: isArb,
        spread: round(spread, 4),
        guaranteedProfit: round(guaranteedProfit, 2),
        yesTradeCount: group.buyYes.length,
        noTradeCount: group.buyNo.length,
        yesTimestamps: group.buyYes.map(t => t.timestamp),
        noTimestamps: group.buyNo.map(t => t.timestamp),
        timeBetweenSides: calcTimeBetweenSides(group.buyYes, group.buyNo),
      });
    }
  }

  // Sort by profit potential
  arbitrageTrades.sort((a, b) => b.guaranteedProfit - a.guaranteedProfit);
  return arbitrageTrades;
}

// Detect scalping: quick buy then sell on same side
function detectScalping(marketGroups) {
  const scalps = [];

  for (const [key, group] of marketGroups) {
    // Check YES side: buy then sell
    if (group.buyYes.length > 0 && group.sellYes.length > 0) {
      const buyAvg = avgPrice(group.buyYes);
      const sellAvg = avgPrice(group.sellYes);
      const profitPerContract = sellAvg - buyAvg;
      if (profitPerContract > 0) {
        scalps.push({
          market: group.title || key,
          side: 'YES',
          buyAvg: round(buyAvg, 4),
          sellAvg: round(sellAvg, 4),
          profitPerContract: round(profitPerContract, 4),
          buyCount: group.buyYes.length,
          sellCount: group.sellYes.length,
          contracts: Math.min(totalSize(group.buyYes), totalSize(group.sellYes)),
        });
      }
    }

    // Check NO side: buy then sell
    if (group.buyNo.length > 0 && group.sellNo.length > 0) {
      const buyAvg = avgPrice(group.buyNo);
      const sellAvg = avgPrice(group.sellNo);
      const profitPerContract = sellAvg - buyAvg;
      if (profitPerContract > 0) {
        scalps.push({
          market: group.title || key,
          side: 'NO',
          buyAvg: round(buyAvg, 4),
          sellAvg: round(sellAvg, 4),
          profitPerContract: round(profitPerContract, 4),
          buyCount: group.buyNo.length,
          sellCount: group.sellNo.length,
          contracts: Math.min(totalSize(group.buyNo), totalSize(group.sellNo)),
        });
      }
    }
  }

  scalps.sort((a, b) => b.profitPerContract * b.contracts - a.profitPerContract * a.contracts);
  return scalps;
}

// Detect timing patterns: when does the wallet trade?
function detectTimingPatterns(trades) {
  const hourCounts = new Array(24).fill(0);
  const dayCounts = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const minuteBeforeExpiry = []; // how many minutes before market close do they trade

  for (const trade of trades) {
    const ts = Number(trade.timestamp);
    if (!ts) continue;
    const date = new Date(ts * 1000);
    hourCounts[date.getUTCHours()]++;
    dayCounts[dayNames[date.getUTCDay()]]++;
  }

  // Find peak hours
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Calculate trade frequency
  const timestamps = trades.map(t => Number(t.timestamp)).filter(Boolean).sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  const avgIntervalSec = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const medianIntervalSec = intervals.length > 0 ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : 0;

  return {
    hourDistribution: hourCounts,
    dayDistribution: dayCounts,
    peakHours,
    tradesPerDay: round(trades.length / Math.max(1, getDateSpanDays(timestamps)), 1),
    avgTimeBetweenTrades: formatDuration(avgIntervalSec),
    medianTimeBetweenTrades: formatDuration(medianIntervalSec),
    avgIntervalSeconds: round(avgIntervalSec, 0),
    medianIntervalSeconds: round(medianIntervalSec, 0),
    isBot: medianIntervalSec > 0 && medianIntervalSec < 120, // trades faster than 2 min apart = likely bot
  };
}

// Detect position sizing patterns
function detectSizingPatterns(trades) {
  const buyTrades = trades.filter(t => t.side === 'BUY' && t.type === 'TRADE');
  const sizes = buyTrades.map(t => parseFloat(t.usdcSize || t.size || 0)).filter(s => s > 0);

  if (sizes.length === 0) return { count: 0 };

  sizes.sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = total / sizes.length;
  const median = sizes[Math.floor(sizes.length / 2)];
  const max = sizes[sizes.length - 1];
  const min = sizes[0];

  // Check if sizing is uniform (bot-like) vs varied (human-like)
  const stdDev = Math.sqrt(sizes.reduce((sum, s) => sum + (s - avg) ** 2, 0) / sizes.length);
  const coeffOfVariation = avg > 0 ? stdDev / avg : 0;
  const isUniformSizing = coeffOfVariation < 0.15; // Less than 15% variation = very uniform

  // Detect common bet sizes (e.g. always $10.00 or always $5.00)
  const sizeBuckets = {};
  for (const s of sizes) {
    const rounded = Math.round(s * 100) / 100;
    sizeBuckets[rounded] = (sizeBuckets[rounded] || 0) + 1;
  }
  const topSizes = Object.entries(sizeBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([size, count]) => ({ size: parseFloat(size), count, pct: round(count / sizes.length * 100, 1) }));

  return {
    count: sizes.length,
    totalVolume: round(total, 2),
    avgSize: round(avg, 2),
    medianSize: round(median, 2),
    minSize: round(min, 2),
    maxSize: round(max, 2),
    stdDev: round(stdDev, 2),
    coeffOfVariation: round(coeffOfVariation, 3),
    isUniformSizing,
    topSizes,
  };
}

// Detect market type preferences
function detectMarketPreferences(trades) {
  const typeMap = {};
  const assetMap = {};
  const timeframeMap = {};

  for (const trade of trades) {
    const title = (trade.title || '').toLowerCase();
    const slug = (trade.slug || '').toLowerCase();

    // Detect crypto assets
    for (const [keyword, symbol] of [
      ['bitcoin', 'BTC'], ['btc', 'BTC'], ['ethereum', 'ETH'], ['eth', 'ETH'],
      ['solana', 'SOL'], ['sol', 'SOL'], ['xrp', 'XRP'], ['dogecoin', 'DOGE'],
    ]) {
      if (title.includes(keyword) || slug.includes(keyword)) {
        assetMap[symbol] = (assetMap[symbol] || 0) + 1;
        break;
      }
    }

    // Detect timeframes
    if (title.includes('15 min') || slug.includes('15m')) {
      timeframeMap['15m'] = (timeframeMap['15m'] || 0) + 1;
    } else if (title.includes('1 hour') || slug.includes('1h')) {
      timeframeMap['1h'] = (timeframeMap['1h'] || 0) + 1;
    } else if (title.includes('daily') || slug.includes('daily')) {
      timeframeMap['daily'] = (timeframeMap['daily'] || 0) + 1;
    }

    // Detect market type
    if (title.includes('up or down') || slug.includes('updown')) {
      typeMap['updown'] = (typeMap['updown'] || 0) + 1;
    } else if (title.includes('above') || title.includes('below')) {
      typeMap['strike'] = (typeMap['strike'] || 0) + 1;
    } else {
      typeMap['other'] = (typeMap['other'] || 0) + 1;
    }
  }

  return {
    assets: Object.entries(assetMap).sort((a, b) => b[1] - a[1]).map(([asset, count]) => ({ asset, count })),
    timeframes: Object.entries(timeframeMap).sort((a, b) => b[1] - a[1]).map(([tf, count]) => ({ timeframe: tf, count })),
    marketTypes: Object.entries(typeMap).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
  };
}

// ============================================
// P&L ESTIMATION
// ============================================

function estimatePnL(trades, positions) {
  // From trades: calculate total bought, total sold, fees
  let totalBought = 0;   // USDC spent buying
  let totalSold = 0;     // USDC received selling
  let totalFees = 0;
  let tradeCount = 0;

  for (const trade of trades) {
    if (trade.type !== 'TRADE') continue;
    const size = parseFloat(trade.usdcSize || trade.size || 0);
    const fee = parseFloat(trade.fee || 0);
    tradeCount++;
    totalFees += fee;

    if (trade.side === 'BUY') {
      totalBought += size;
    } else if (trade.side === 'SELL') {
      totalSold += size;
    }
  }

  // From positions: calculate unrealized P&L (current value of holdings)
  let unrealizedValue = 0;
  let positionCount = 0;
  if (Array.isArray(positions)) {
    for (const pos of positions) {
      const currentValue = parseFloat(pos.currentValue || pos.value || 0);
      const initialValue = parseFloat(pos.initialValue || pos.cost || 0);
      unrealizedValue += currentValue;
      positionCount++;
    }
  }

  const realizedPnl = totalSold - totalBought - totalFees;
  const estimatedTotalPnl = realizedPnl + unrealizedValue;

  return {
    totalBought: round(totalBought, 2),
    totalSold: round(totalSold, 2),
    totalFees: round(totalFees, 2),
    realizedPnl: round(realizedPnl, 2),
    unrealizedValue: round(unrealizedValue, 2),
    estimatedTotalPnl: round(estimatedTotalPnl, 2),
    tradeCount,
    positionCount,
    roi: totalBought > 0 ? round((estimatedTotalPnl / totalBought) * 100, 2) : 0,
    avgPnlPerTrade: tradeCount > 0 ? round(realizedPnl / tradeCount, 4) : 0,
  };
}

// ============================================
// STRATEGY CLASSIFICATION
// ============================================

function classifyStrategy(arbitrageTrades, scalps, timing, sizing, preferences, pnl) {
  const strategies = [];
  const confidence = {};

  // 1. Both-sides / Arbitrage
  const arbCount = arbitrageTrades.filter(a => a.isArbitrage).length;
  const bothSidesCount = arbitrageTrades.length;
  if (arbCount > 0) {
    strategies.push('ARBITRAGE');
    confidence['ARBITRAGE'] = Math.min(100, arbCount * 20);
  }
  if (bothSidesCount > arbCount) {
    strategies.push('BOTH_SIDES_HEDGE');
    confidence['BOTH_SIDES_HEDGE'] = Math.min(100, (bothSidesCount - arbCount) * 15);
  }

  // 2. Scalping
  if (scalps.length > 3) {
    strategies.push('SCALPING');
    confidence['SCALPING'] = Math.min(100, scalps.length * 10);
  }

  // 3. Bot detection
  if (timing.isBot || sizing.isUniformSizing) {
    strategies.push('AUTOMATED_BOT');
    confidence['AUTOMATED_BOT'] = timing.isBot && sizing.isUniformSizing ? 95
      : timing.isBot ? 80
      : 60;
  }

  // 4. High frequency
  if (timing.avgIntervalSeconds > 0 && timing.avgIntervalSeconds < 300) {
    strategies.push('HIGH_FREQUENCY');
    confidence['HIGH_FREQUENCY'] = Math.min(100, Math.round(300 / timing.avgIntervalSeconds * 20));
  }

  // 5. Market making (both sides + high frequency + spread capture)
  if (bothSidesCount > 2 && timing.avgIntervalSeconds < 600) {
    strategies.push('MARKET_MAKING');
    confidence['MARKET_MAKING'] = Math.min(100, bothSidesCount * 15 + (600 - timing.avgIntervalSeconds) / 6);
  }

  // 6. Directional if mostly one-sided
  const totalTrades = sizing.count || 0;
  if (bothSidesCount < totalTrades * 0.1 && totalTrades > 10) {
    strategies.push('DIRECTIONAL');
    confidence['DIRECTIONAL'] = Math.min(100, Math.round((1 - bothSidesCount / totalTrades) * 100));
  }

  // Sort by confidence
  strategies.sort((a, b) => (confidence[b] || 0) - (confidence[a] || 0));

  return {
    primaryStrategy: strategies[0] || 'UNKNOWN',
    strategies,
    confidence,
    summary: generateStrategySummary(strategies, confidence, arbitrageTrades, scalps, timing, sizing, pnl),
  };
}

function generateStrategySummary(strategies, confidence, arbitrageTrades, scalps, timing, sizing, pnl) {
  const lines = [];

  if (strategies.includes('ARBITRAGE')) {
    const arbTrades = arbitrageTrades.filter(a => a.isArbitrage);
    const totalArbProfit = arbTrades.reduce((s, a) => s + a.guaranteedProfit, 0);
    lines.push(`ARBITRAGE: ${arbTrades.length} arb opportunities detected. Buys YES + NO on same market when combined cost < $1.00. Guaranteed profit: ~$${round(totalArbProfit, 2)}.`);
  }

  if (strategies.includes('BOTH_SIDES_HEDGE')) {
    const hedges = arbitrageTrades.filter(a => !a.isArbitrage);
    lines.push(`HEDGING: ${hedges.length} markets with both-sides positions. Not pure arb (combined cost >= $1.00), but reduces risk by hedging.`);
  }

  if (strategies.includes('MARKET_MAKING')) {
    lines.push(`MARKET MAKING: Provides liquidity on both sides of markets, capturing the bid-ask spread. Trades frequently (avg ${timing.avgTimeBetweenTrades} between trades).`);
  }

  if (strategies.includes('SCALPING')) {
    const totalScalpProfit = scalps.reduce((s, sc) => s + sc.profitPerContract * sc.contracts, 0);
    lines.push(`SCALPING: ${scalps.length} profitable round-trips detected. Buys low, sells high on same side. Est. scalp profit: ~$${round(totalScalpProfit, 2)}.`);
  }

  if (strategies.includes('AUTOMATED_BOT')) {
    const reasons = [];
    if (timing.isBot) reasons.push(`trades every ${timing.medianTimeBetweenTrades}`);
    if (sizing.isUniformSizing) reasons.push(`uniform bet sizing ($${sizing.medianSize} median, ${round(sizing.coeffOfVariation * 100, 1)}% variation)`);
    lines.push(`BOT: Likely automated. ${reasons.join(', ')}.`);
  }

  if (strategies.includes('HIGH_FREQUENCY')) {
    lines.push(`HIGH FREQUENCY: ${timing.tradesPerDay} trades/day, avg interval ${timing.avgTimeBetweenTrades}.`);
  }

  if (strategies.includes('DIRECTIONAL')) {
    lines.push(`DIRECTIONAL: Mostly one-sided bets - taking a view on market outcome rather than hedging.`);
  }

  if (pnl.tradeCount > 0) {
    lines.push(`P&L: $${pnl.realizedPnl >= 0 ? '+' : ''}${pnl.realizedPnl} realized from ${pnl.tradeCount} trades (${pnl.roi >= 0 ? '+' : ''}${pnl.roi}% ROI). Avg $${pnl.avgPnlPerTrade}/trade.`);
  }

  return lines.join('\n');
}

// ============================================
// MAIN ANALYSIS FUNCTION
// ============================================

async function analyzeWallet(walletAddress, options = {}) {
  const {
    depth = 200,         // Max trades to fetch
    includePositions = true,
  } = options;

  const addr = walletAddress.trim().toLowerCase();

  // Fetch data in parallel
  const [trades, positions, profile] = await Promise.all([
    fetchAllActivity(addr, depth),
    includePositions ? fetchPositions(addr, 100).catch(() => []) : Promise.resolve([]),
    fetchProfile(addr),
  ]);

  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      success: false,
      error: 'No trading activity found for this wallet',
      walletAddress: addr,
    };
  }

  // Group and analyze
  const marketGroups = groupByMarket(trades);
  const onlyTrades = trades.filter(t => t.type === 'TRADE');

  const arbitrageTrades = detectBothSidesArbitrage(marketGroups);
  const scalps = detectScalping(marketGroups);
  const timing = detectTimingPatterns(onlyTrades);
  const sizing = detectSizingPatterns(trades);
  const preferences = detectMarketPreferences(trades);
  const pnl = estimatePnL(trades, positions);
  const strategy = classifyStrategy(arbitrageTrades, scalps, timing, sizing, preferences, pnl);

  return {
    success: true,
    walletAddress: addr,
    profileName: profile?.name || profile?.username || null,
    profilePnl: profile?.pnl || null,
    profileVolume: profile?.volume || null,
    analyzedAt: new Date().toISOString(),
    tradesAnalyzed: trades.length,
    marketsTraded: marketGroups.size,

    strategy,
    pnl,
    arbitrage: {
      bothSidesMarkets: arbitrageTrades.length,
      pureArbitrageMarkets: arbitrageTrades.filter(a => a.isArbitrage).length,
      hedgedMarkets: arbitrageTrades.filter(a => !a.isArbitrage).length,
      totalGuaranteedProfit: round(arbitrageTrades.filter(a => a.isArbitrage).reduce((s, a) => s + a.guaranteedProfit, 0), 2),
      details: arbitrageTrades.slice(0, 20), // Top 20 by profit
    },
    scalping: {
      profitableRoundTrips: scalps.length,
      totalScalpProfit: round(scalps.reduce((s, sc) => s + sc.profitPerContract * sc.contracts, 0), 2),
      details: scalps.slice(0, 20),
    },
    timing,
    sizing,
    preferences,

    // Raw data for frontend
    recentTrades: onlyTrades.slice(0, 50).map(t => ({
      title: t.title,
      slug: t.slug,
      side: t.side,
      outcome: t.outcome,
      size: t.usdcSize || t.size,
      price: t.price,
      timestamp: t.timestamp,
      transactionHash: t.transactionHash,
    })),
    currentPositions: Array.isArray(positions) ? positions.slice(0, 30).map(p => ({
      title: p.title,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      currentValue: p.currentValue || p.value,
      initialValue: p.initialValue || p.cost,
      pnl: p.pnl || p.curPnl,
    })) : [],
  };
}

// ============================================
// HELPERS
// ============================================

function avgPrice(trades) {
  const prices = trades.map(t => parseFloat(t.price || 0)).filter(p => p > 0);
  if (prices.length === 0) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

function totalSize(trades) {
  return trades.reduce((sum, t) => sum + parseFloat(t.usdcSize || t.size || 0), 0);
}

function calcTimeBetweenSides(yesTrades, noTrades) {
  if (yesTrades.length === 0 || noTrades.length === 0) return null;
  const yesTs = yesTrades.map(t => Number(t.timestamp)).filter(Boolean);
  const noTs = noTrades.map(t => Number(t.timestamp)).filter(Boolean);
  if (yesTs.length === 0 || noTs.length === 0) return null;

  // Avg time between yes and no trades on same market
  const minYes = Math.min(...yesTs);
  const minNo = Math.min(...noTs);
  const diffSec = Math.abs(minYes - minNo);
  return { seconds: diffSec, formatted: formatDuration(diffSec) };
}

function getDateSpanDays(sortedTimestamps) {
  if (sortedTimestamps.length < 2) return 1;
  return Math.max(1, (sortedTimestamps[sortedTimestamps.length - 1] - sortedTimestamps[0]) / 86400);
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${round(seconds / 3600, 1)}h`;
  return `${round(seconds / 86400, 1)}d`;
}

function round(num, decimals) {
  return Math.round(num * 10 ** decimals) / 10 ** decimals;
}

// ============================================
// EXPORTS
// ============================================

export {
  analyzeWallet,
  fetchAllActivity,
  fetchPositions,
  fetchProfile,
  groupByMarket,
  detectBothSidesArbitrage,
  detectScalping,
  detectTimingPatterns,
  detectSizingPatterns,
  detectMarketPreferences,
  estimatePnL,
  classifyStrategy,
};
