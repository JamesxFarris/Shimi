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

export {
  normalCDF,
  calculateVolatility,
  calculateMomentum,
  calculateMomentumMultiTimeframe
};
