// STATISTICAL ANALYSIS ENGINE
// Pure math functions for probability estimation, volatility, and momentum

// Standard normal CDF
function normalCDF(x) {
  // Handle edge cases
  if (isNaN(x) || !isFinite(x)) return 0.5;
  if (x > 8) return 0.9999;
  if (x < -8) return 0.0001;

  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  const result = 0.5 * (1.0 + sign * y);
  return isNaN(result) ? 0.5 : Math.max(0.0001, Math.min(0.9999, result));
}

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

  // Calculate log returns (guard against zero/negative prices that produce NaN/Infinity)
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i].price <= 0 || history[i-1].price <= 0) continue;
    const logReturn = Math.log(history[i].price / history[i-1].price);
    if (!isFinite(logReturn)) continue;
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

  const denominator = n * sumX2 - sumX * sumX;
  const avgPrice = sumY / n;
  if (denominator === 0 || avgPrice === 0) {
    return { trend: 0, strength: 'weak', direction: 'neutral' };
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;

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
      m1: 0, m5: 0, m15: 0, m60: 0,
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

  const price1minAgo = findPriceAt(1);
  const price5minAgo = findPriceAt(5);
  const price15minAgo = findPriceAt(15);
  const price60minAgo = findPriceAt(60);

  // Calculate returns
  const m1 = price1minAgo ? ((latest - price1minAgo) / price1minAgo) * 100 : 0;
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
    m1: parseFloat(m1.toFixed(2)),
    m5: parseFloat(m5.toFixed(2)),
    m15: parseFloat(m15.toFixed(2)),
    m60: parseFloat(m60.toFixed(2)),
    aligned,
    strength: parseFloat(strength.toFixed(2)),
    direction
  };
}

// ============================================
// MONTE CARLO PRICE SIMULATION
// ============================================
// Geometric Brownian Motion with antithetic variates for variance reduction
// Replaces static empirical lookup tables with dynamic, condition-aware probabilities

// Box-Muller transform for standard normal random variables
function normalRandom() {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Monte Carlo simulation of win probability using GBM with antithetic variates.
 * Simulates N price paths from current price to estimate P(price > strike) at expiry.
 *
 * @param {number} currentPrice - Current crypto price
 * @param {number} strikePrice - Market strike price
 * @param {number} timeMinutes - Minutes until settlement
 * @param {number} volatility - 15-minute realized volatility (as decimal, e.g. 0.02)
 * @param {number} momentumDrift - Per-minute drift from momentum (as decimal, e.g. 0.001)
 * @param {number} N - Number of simulations (default 1000, actual paths = N due to antithetic)
 * @returns {object} { winProb, simPaths, analyticalProb, confidence }
 */
function monteCarloWinProb(currentPrice, strikePrice, timeMinutes, volatility, momentumDrift = 0, N = 1000) {
  if (!currentPrice || !strikePrice || timeMinutes <= 0) {
    return { winProb: 0.5, simPaths: 0, analyticalProb: 0.5, confidence: 0 };
  }

  // Scale volatility to the remaining time window
  // volatility param is 15-min vol; scale to remaining time
  const dt = timeMinutes / 15;
  const sigma = volatility * Math.sqrt(dt);
  const drift = momentumDrift * timeMinutes; // total drift over remaining time

  // Guard against zero/tiny sigma (price not moving)
  if (sigma < 1e-8) {
    // No volatility: outcome is deterministic
    const deterministic = currentPrice * Math.exp(drift) > strikePrice ? 1 : 0;
    return { winProb: deterministic * 100, simPaths: 0, analyticalProb: deterministic * 100, confidence: 1 };
  }

  // Analytical (Black-Scholes style) probability for control variate
  // Jensen's inequality correction: -0.5*sigma^2 ensures E[S_T] = S_0*exp(drift)
  const halfSigmaSq = 0.5 * sigma * sigma;
  const d = (Math.log(currentPrice / strikePrice) + drift - halfSigmaSq) / sigma;
  const analyticalProb = normalCDF(d) * 100;

  // Monte Carlo with antithetic variates: each iteration produces 2 paths
  let aboveCount = 0;
  const halfN = Math.floor(N / 2);

  for (let i = 0; i < halfN; i++) {
    const z = normalRandom();

    // Path 1: regular GBM terminal price: S * exp((drift - 0.5*sigma^2) + sigma*Z)
    const simPrice1 = currentPrice * Math.exp(drift - halfSigmaSq + sigma * z);
    if (simPrice1 > strikePrice) aboveCount++;

    // Path 2: antithetic (use -z, negatively correlated → reduces variance)
    const simPrice2 = currentPrice * Math.exp(drift - halfSigmaSq + sigma * (-z));
    if (simPrice2 > strikePrice) aboveCount++;
  }

  const mcProb = (aboveCount / (halfN * 2)) * 100;

  // Control variate correction: blend MC toward analytical to further reduce variance
  // Weight: 40% correction toward analytical (conservative blend)
  const correctedProb = mcProb + 0.4 * (analyticalProb - mcProb);

  // Confidence: higher with more time data and moderate volatility
  // Low confidence when vol is extreme or time is very short
  const confidence = Math.min(1, Math.max(0.3,
    1 - Math.abs(volatility - 0.02) / 0.06 // peaks at 2% vol, drops at extremes
  ));

  return {
    winProb: Math.max(1, Math.min(99, correctedProb)),
    simPaths: halfN * 2,
    analyticalProb: Math.max(1, Math.min(99, analyticalProb)),
    confidence
  };
}

// ============================================
// BRIER SCORE CALIBRATION TRACKING
// ============================================
// Tracks prediction quality: BrierScore = mean((predicted - actual)^2)
// Perfect calibration = 0, coin flip = 0.25, worse than random > 0.25

/**
 * Compute Brier score contribution for a single prediction
 * @param {number} predictedProb - Our predicted win probability (0-100 scale)
 * @param {boolean} actualWin - Did the bet actually win?
 * @returns {number} Brier score contribution (0-1 scale, lower is better)
 */
function computeBrierContribution(predictedProb, actualWin) {
  const p = Math.max(0, Math.min(1, predictedProb / 100)); // normalize to 0-1
  const outcome = actualWin ? 1 : 0;
  return (p - outcome) ** 2;
}

/**
 * Update rolling Brier score tracker
 * @param {object} tracker - { scores: number[], avgBrier: number, count: number }
 * @param {number} predictedProb - Predicted win probability (0-100)
 * @param {boolean} actualWin - Did the bet win?
 * @param {number} maxWindow - Max scores to keep (default 100)
 * @returns {object} Updated tracker with new avgBrier
 */
function updateBrierTracker(tracker, predictedProb, actualWin, maxWindow = 100) {
  if (!tracker.scores) tracker.scores = [];

  const contribution = computeBrierContribution(predictedProb, actualWin);
  tracker.scores.push(contribution);

  // Keep rolling window
  if (tracker.scores.length > maxWindow) {
    tracker.scores = tracker.scores.slice(-maxWindow);
  }

  tracker.count = (tracker.count || 0) + 1;
  tracker.avgBrier = tracker.scores.reduce((a, b) => a + b, 0) / tracker.scores.length;
  tracker.lastUpdated = new Date().toISOString();

  return tracker;
}

// ============================================
// CORRELATION-ADJUSTED PORTFOLIO RISK
// ============================================
// Crypto assets are highly correlated (BTC-ETH: 0.85, BTC-SOL: 0.70).
// Independent risk limits understate true portfolio risk during crashes.

// Default correlations (can be overridden with dynamic calculations)
const DEFAULT_CRYPTO_CORRELATIONS = {
  'BTC-ETH': 0.85, 'BTC-SOL': 0.70, 'BTC-XRP': 0.65,
  'ETH-SOL': 0.75, 'ETH-XRP': 0.60,
  'SOL-XRP': 0.55
};

/**
 * Calculate correlation-adjusted portfolio risk.
 * Measures how much cross-token correlation increases effective risk vs independent exposures.
 * Uses exposure-weighted correlation to compute effective portfolio risk.
 *
 * Formula: Var(P) = Σ(wi²) + 2*Σ(wi*wj*ρij), then sqrt for risk
 * This gives "correlation-adjusted exposure" in the same units as input (cents).
 *
 * @param {object} exposureByToken - { BTC: 300, ETH: 200, SOL: 150 } (cents)
 * @param {object} correlations - Optional custom correlation overrides
 * @returns {object} { independentRisk, correlatedRisk, diversificationRatio, riskMultiplier }
 */
function calculateCorrelatedPortfolioRisk(exposureByToken, correlations = null) {
  const corr = correlations || DEFAULT_CRYPTO_CORRELATIONS;
  const tokens = Object.keys(exposureByToken).filter(t => exposureByToken[t] > 0);

  if (tokens.length <= 1) {
    const totalExposure = tokens.reduce((sum, t) => sum + exposureByToken[t], 0);
    return {
      independentRisk: totalExposure,
      correlatedRisk: totalExposure,
      diversificationRatio: 1,
      riskMultiplier: 1
    };
  }

  // Sum of individual exposures (naive risk, assumes independence)
  const independentRisk = tokens.reduce((sum, t) => sum + exposureByToken[t], 0);

  // Correlation-weighted portfolio variance: Σ(wi²) + 2*Σ(wi*wj*ρij)
  // This measures effective exposure given cross-asset correlations
  let portfolioVariance = 0;
  for (const t1 of tokens) {
    portfolioVariance += exposureByToken[t1] ** 2;
    for (const t2 of tokens) {
      if (t1 >= t2) continue; // avoid double counting
      const pairKey = [t1, t2].sort().join('-');
      const rho = corr[pairKey] ?? 0.5; // default 0.5 if unknown pair
      portfolioVariance += 2 * rho * exposureByToken[t1] * exposureByToken[t2];
    }
  }

  const correlatedRisk = Math.sqrt(portfolioVariance);

  // Diversification ratio: how much does correlation increase risk vs independent
  // 1.0 = fully independent, higher = more correlated risk
  const diversificationRatio = correlatedRisk / Math.max(1, independentRisk);

  // Risk multiplier: use this to scale down max total exposure
  // If all 3 tokens are highly correlated, effective risk is ~1.3-1.5x the naive sum
  const riskMultiplier = Math.max(1, diversificationRatio);

  return {
    independentRisk,
    correlatedRisk: Math.round(correlatedRisk),
    diversificationRatio: parseFloat(diversificationRatio.toFixed(3)),
    riskMultiplier: parseFloat(riskMultiplier.toFixed(3))
  };
}

/**
 * Calculate dynamic correlations from recent price history.
 * Updates correlation estimates based on actual price movements.
 *
 * @param {object} priceHistories - { BTC: [{price, time}], ETH: [...], ... }
 * @param {number} windowMinutes - Lookback window (default 60 minutes)
 * @returns {object} Updated correlation map
 */
function calculateDynamicCorrelations(priceHistories, windowMinutes = 60) {
  const correlations = { ...DEFAULT_CRYPTO_CORRELATIONS };
  const tokens = Object.keys(priceHistories);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const t1 = tokens[i], t2 = tokens[j];
      const h1 = priceHistories[t1]?.filter(p => p.time > cutoff) || [];
      const h2 = priceHistories[t2]?.filter(p => p.time > cutoff) || [];

      if (h1.length < 20 || h2.length < 20) continue;

      // Align timestamps: find closest h2 price at BOTH h1[k] and h1[k-1] timestamps
      // This ensures returns cover matching time intervals (fixes misaligned return bug)
      const returns1 = [], returns2 = [];
      const findClosest = (arr, targetTime) => {
        let bestIdx = -1, bestDist = Infinity;
        for (let m = 0; m < arr.length; m++) {
          const dist = Math.abs(arr[m].time - targetTime);
          if (dist < bestDist) { bestDist = dist; bestIdx = m; }
        }
        return { idx: bestIdx, dist: bestDist };
      };

      for (let k = 1; k < h1.length; k++) {
        const match1 = findClosest(h2, h1[k].time);
        const match0 = findClosest(h2, h1[k - 1].time);
        // Both timestamps must have close matches (within 30s)
        if (match1.dist > 30000 || match0.dist > 30000) continue;
        if (match1.idx === match0.idx) continue; // same h2 entry for both → no return to compute
        if (h1[k].price <= 0 || h1[k - 1].price <= 0) continue;
        if (h2[match1.idx].price <= 0 || h2[match0.idx].price <= 0) continue;

        const r1 = Math.log(h1[k].price / h1[k - 1].price);
        const r2 = Math.log(h2[match1.idx].price / h2[match0.idx].price);
        if (!isFinite(r1) || !isFinite(r2)) continue;
        returns1.push(r1);
        returns2.push(r2);
      }

      if (returns1.length < 10) continue;

      // Pearson correlation
      const n = returns1.length;
      const mean1 = returns1.reduce((a, b) => a + b, 0) / n;
      const mean2 = returns2.reduce((a, b) => a + b, 0) / n;
      let cov = 0, var1 = 0, var2 = 0;
      for (let k = 0; k < n; k++) {
        const d1 = returns1[k] - mean1;
        const d2 = returns2[k] - mean2;
        cov += d1 * d2;
        var1 += d1 * d1;
        var2 += d2 * d2;
      }
      const denom = Math.sqrt(var1 * var2);
      if (denom > 0) {
        const rho = Math.max(-1, Math.min(1, cov / denom));
        const pairKey = [t1, t2].sort().join('-');
        // Exponential smoothing: 70% new + 30% old (adapt quickly to regime changes)
        const oldCorr = correlations[pairKey] ?? 0.5;
        correlations[pairKey] = parseFloat((0.7 * rho + 0.3 * oldCorr).toFixed(3));
      }
    }
  }

  return correlations;
}

export {
  normalCDF,
  calculateVolatility,
  calculateMomentum,
  calculateMomentumMultiTimeframe,
  normalRandom,
  monteCarloWinProb,
  computeBrierContribution,
  updateBrierTracker,
  calculateCorrelatedPortfolioRisk,
  calculateDynamicCorrelations,
  DEFAULT_CRYPTO_CORRELATIONS
};
