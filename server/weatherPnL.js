// WEATHER P&L TRACKER
// Records every weather bet placed, checks Kalshi for settlements, tracks profit/loss.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BETS_FILE = path.join(__dirname, 'weather_bets.json');

function calcFee(pricePerContract) {
  return Math.min(0.02, Math.ceil(1.75 * pricePerContract * (1 - pricePerContract) * 100) / 100);
}

function loadBets() {
  try {
    if (fs.existsSync(BETS_FILE)) return JSON.parse(fs.readFileSync(BETS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveBets(bets) {
  fs.writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2));
}

// Call this immediately after a Kalshi order is filled.
export function recordWeatherBet({ ticker, city, targetDate, threshold, betSide, contracts, pricePerContract, modelProb, edge, userId }) {
  const bets = loadBets();
  const fee = calcFee(pricePerContract);
  bets.push({
    id: `${ticker}-${Date.now()}`,
    placedAt: new Date().toISOString(),
    ticker,
    city,
    targetDate,
    threshold,
    betSide,
    contracts,
    pricePerContract: parseFloat(pricePerContract.toFixed(4)),
    feePerContract: parseFloat(fee.toFixed(4)),
    totalCost: parseFloat((contracts * pricePerContract).toFixed(2)),
    modelProb: parseFloat(modelProb.toFixed(4)),
    edge: parseFloat(edge.toFixed(4)),
    userId: userId || 'default',
    status: 'pending',   // pending | won | lost
    settledAt: null,
    result: null,        // 'yes' | 'no' (what Kalshi settled to)
    profit: null,        // net $ including fees
  });
  saveBets(bets);
  console.log(`[WEATHER P&L] Recorded bet: ${betSide} ${contracts}x ${ticker} @ ${(pricePerContract * 100).toFixed(0)}c | model: ${(modelProb * 100).toFixed(1)}% | edge: ${(edge * 100).toFixed(1)}%`);
}

// Run periodically to check if any pending bets have settled.
// kalshiReq and userConfig are needed to call the Kalshi REST API.
export async function checkWeatherSettlements(kalshiReq, userConfig) {
  const bets = loadBets();
  const pending = bets.filter(b => b.status === 'pending');
  if (pending.length === 0) return;

  let changed = false;

  for (const bet of pending) {
    try {
      const resp = await kalshiReq('GET', `/markets/${bet.ticker}`, null, userConfig);
      const market = resp?.market;
      if (!market || market.status !== 'finalized') continue;

      const result = market.result; // 'yes' or 'no'
      if (!result) continue;

      const won = bet.betSide.toLowerCase() === result;
      const fee = bet.feePerContract ?? calcFee(bet.pricePerContract);

      bet.status = won ? 'won' : 'lost';
      bet.settledAt = new Date().toISOString();
      bet.result = result;
      // Win: receive $1/contract minus purchase price minus fee
      // Loss: lose total cost
      bet.profit = won
        ? parseFloat(((1 - bet.pricePerContract - fee) * bet.contracts).toFixed(2))
        : parseFloat((-bet.totalCost).toFixed(2));

      changed = true;
      const emoji = won ? '✓ WON' : '✗ LOST';
      console.log(
        `[WEATHER P&L] ${emoji} $${Math.abs(bet.profit).toFixed(2)}` +
        ` | ${bet.betSide} on ${bet.city} ${bet.threshold}°F @ ${(bet.pricePerContract * 100).toFixed(0)}c` +
        ` | model was ${(bet.modelProb * 100).toFixed(1)}%, settled ${result.toUpperCase()}`
      );
    } catch {
      // silently skip — market may not be finalized yet
    }
  }

  if (changed) saveBets(bets);
}

// Returns a summary suitable for the API response.
export function getWeatherPnLSummary(userId = null) {
  let bets = loadBets();
  if (userId) bets = bets.filter(b => b.userId === userId || b.userId === 'default');

  const settled = bets.filter(b => b.status !== 'pending');
  const won = settled.filter(b => b.status === 'won');
  const lost = settled.filter(b => b.status === 'lost');
  const pending = bets.filter(b => b.status === 'pending');

  const totalProfit = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const totalWagered = settled.reduce((s, b) => s + (b.totalCost ?? 0), 0);
  const avgEdge = bets.length > 0
    ? bets.reduce((s, b) => s + (b.edge ?? 0), 0) / bets.length
    : 0;

  return {
    totalBets: bets.length,
    pending: pending.length,
    won: won.length,
    lost: lost.length,
    winRate: settled.length > 0 ? parseFloat((won.length / settled.length * 100).toFixed(1)) : null,
    totalProfit: parseFloat(totalProfit.toFixed(2)),
    totalWagered: parseFloat(totalWagered.toFixed(2)),
    roi: totalWagered > 0 ? parseFloat((totalProfit / totalWagered * 100).toFixed(1)) : null,
    avgEdgePct: parseFloat((avgEdge * 100).toFixed(1)),
    recentBets: bets.slice(-20).reverse(),
  };
}
