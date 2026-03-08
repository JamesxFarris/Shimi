# Quant Simulation Techniques for Prediction Markets
## Research from @gemchange_ltd tweet (March 2026)

Source: https://x.com/i/status/2027744530124951831

The tweet shares a deep-dive guide titled **"How to Simulate Like a Quant Desk — Every Model, Every Formula, Runnable Code"** covering 8 quantitative simulation techniques for prediction markets. Below is a breakdown of each technique and how it maps to concrete improvements for Shimi.

---

## 1. Monte Carlo Simulation + Brier Score Calibration

### What It Is
Instead of relying on single-point probability estimates, run thousands of simulated price paths to estimate the probability of BTC/ETH/SOL ending above or below a strike in 15 minutes. Score your probability estimates with the **Brier Score** (mean squared error between predicted probability and actual 0/1 outcome).

### What Shimi Does Today
- **Empirical lookup tables** map distance-from-strike to a static win rate (e.g., 0.3% distance → 78% favored win rate)
- Volatility regime multipliers adjust these up/down
- A `calibrationError` field exists in `learned_params.json` but is currently always `0`

### What We Could Improve

**A. Monte Carlo Price Path Simulation**
We already have the ingredients: current price, 15-min volatility (`statistics.js:calculateVolatility`), and momentum. Instead of a static table lookup, simulate N=1000 GBM (Geometric Brownian Motion) price paths:

```javascript
function monteCarloWinProb(currentPrice, strike, timeMinutes, volatility, momentum, N = 1000) {
  const dt = timeMinutes / 15; // fraction of 15-min window
  const drift = momentum * dt;  // incorporate current trend
  const sigma = volatility * Math.sqrt(dt);
  let winsAbove = 0;
  for (let i = 0; i < N; i++) {
    const z = normalRandom(); // standard normal
    const simPrice = currentPrice * Math.exp(drift + sigma * z);
    if (simPrice > strike) winsAbove++;
  }
  return winsAbove / N;
}
```

**Benefit**: Dynamically adapts to current volatility and momentum instead of relying on historical averages. More accurate when conditions differ from training data.

**Priority: HIGH** — This replaces the weakest part of the system (static lookup tables that can't adapt to unusual market conditions).

**B. Brier Score Tracking**
Every time a bet settles, compute: `brierScore = (predictedProb - actualOutcome)^2` and track a rolling average. Use this to:
- Auto-adjust confidence: if Brier score is high (bad calibration), widen the min edge threshold
- Compare empirical vs Monte Carlo vs ML predictions to see which performs best
- Replace the unused `calibrationError` field with real data

**Priority: MEDIUM** — Cheap to implement, gives visibility into model quality over time.

---

## 2. Importance Sampling for Tail-Risk Contracts

### What It Is
When evaluating extreme contracts (e.g., "Will BTC drop 5% in 15 minutes?"), crude Monte Carlo is inefficient because the event is so rare that most simulated paths never trigger it. Importance sampling biases the simulation toward the tail region, then corrects with likelihood ratios.

### What Shimi Does Today
- Bets on contracts with 0.1-5% distance from strike
- Currently avoids very low-probability events (40c minimum price = 40% implied probability floor)
- No way to evaluate tail risk contracts

### What We Could Improve

**Low priority for Shimi's current strategy.** Shimi deliberately avoids tail-risk contracts (the 40c price floor and 5% max distance filters screen these out). However, if we ever expand to longer-duration markets or want to evaluate extreme scenarios for risk management:

```javascript
// Importance sampling: shift distribution toward tail event
function importanceSampleTailProb(currentPrice, strike, vol, N = 5000) {
  const targetMove = Math.log(strike / currentPrice);
  const shiftedMean = targetMove; // bias toward the strike
  let sumWeights = 0;
  let sumHits = 0;
  for (let i = 0; i < N; i++) {
    const z = normalRandom() + shiftedMean / vol; // shifted sampling
    const simPrice = currentPrice * Math.exp(vol * z);
    const weight = Math.exp(-shiftedMean * z / vol + shiftedMean**2 / (2 * vol**2));
    sumWeights += weight;
    if (simPrice > strike) sumHits += weight;
  }
  return sumHits / sumWeights;
}
```

**Priority: LOW** — Not needed unless strategy expands to tail-risk or longer-duration markets.

---

## 3. Sequential Monte Carlo (Particle Filters) for Real-Time Updates

### What It Is
Particle filters maintain a population of "particles" (probability estimates), and as new data arrives (each price tick), particles are reweighted and resampled. This gives you a continuously updating probability estimate that incorporates the latest information without re-running the full model.

### What Shimi Does Today
- Scans every 10 seconds and recalculates everything from scratch
- Position monitoring every 15 seconds, also from scratch
- No concept of "updating" a probability — each scan is independent

### What We Could Improve

**A. Particle Filter for Live Probability Tracking**
Instead of recalculating from scratch every 10s, maintain a particle cloud per active market:

```javascript
class ParticleFilter {
  constructor(N = 500) {
    this.particles = []; // Each: { price, weight }
    this.N = N;
  }

  initialize(currentPrice, strike, vol, timeMinutes) {
    // Spawn N particles as simulated future prices
    this.particles = Array.from({ length: this.N }, () => ({
      price: currentPrice * Math.exp(vol * Math.sqrt(timeMinutes/15) * normalRandom()),
      weight: 1 / this.N
    }));
  }

  update(newPrice, dt, vol) {
    // Propagate particles forward
    for (const p of this.particles) {
      p.price += (newPrice - p.price) * 0.3 + vol * Math.sqrt(dt) * normalRandom();
      // Reweight based on how close particle is to actual price trajectory
      const dist = Math.abs(p.price - newPrice) / newPrice;
      p.weight *= Math.exp(-dist * dist / (2 * vol * vol));
    }
    // Normalize weights
    const totalWeight = this.particles.reduce((s, p) => s + p.weight, 0);
    this.particles.forEach(p => p.weight /= totalWeight);
    // Resample if effective sample size drops
    this.resampleIfNeeded();
  }

  getWinProb(strike) {
    return this.particles
      .filter(p => p.price > strike)
      .reduce((s, p) => s + p.weight, 0);
  }
}
```

**Benefit**: Much faster per-tick updates (O(N) reweight vs full recalculation). Naturally tracks regime changes in real-time. Can detect probability shifts faster → earlier exits or entries.

**Priority: HIGH** — Directly improves the core scan loop speed and probability accuracy, especially for position management decisions.

**B. Use for Position Exit Decisions**
The particle filter's real-time probability estimate is perfect for the position management system. Instead of the current heuristic-based exit rules (stop-loss %, momentum direction, coin-flip detection), you get a single number: "what's the probability this position wins right now?" If it drops below 50%, exit. If it's 90%+, hold to settlement.

---

## 4. Variance Reduction (Antithetic Variates, Control Variates, Stratification)

### What It Is
Three techniques to get much more precise Monte Carlo estimates with the same number of simulations (100-500x efficiency gains):

- **Antithetic variates**: For each random draw z, also simulate -z. The two paths are negatively correlated, reducing variance
- **Control variates**: Use a known analytical solution (like Black-Scholes) as a baseline and only simulate the *difference* from it
- **Stratification**: Divide the probability space into equal bins and sample from each, ensuring even coverage

### What Shimi Does Today
- No Monte Carlo simulation at all, so no variance to reduce yet

### What We Could Improve

If we implement the Monte Carlo simulation from section 1, these techniques should be baked in from the start:

```javascript
function monteCarloWithVarianceReduction(price, strike, vol, timeMin, N = 500) {
  const dt = timeMin / 15;
  const sigma = vol * Math.sqrt(dt);
  let winsAbove = 0;

  // Antithetic variates: halve N, each iteration produces 2 paths
  for (let i = 0; i < N / 2; i++) {
    const z = normalRandom();
    const path1 = price * Math.exp(sigma * z);
    const path2 = price * Math.exp(sigma * (-z)); // antithetic
    if (path1 > strike) winsAbove++;
    if (path2 > strike) winsAbove++;
  }

  // Control variate correction using analytical Black-Scholes-style formula
  const analyticalProb = normalCDF((Math.log(price / strike)) / sigma);
  const mcProb = winsAbove / N;
  // Blend: MC estimate corrected toward analytical
  return mcProb + 0.5 * (analyticalProb - mcProb);
}
```

**Priority: MEDIUM** — Only matters after Monte Carlo is implemented. But essentially free accuracy improvement.

---

## 5. Copulas & Tail Dependence (Correlated Contracts)

### What It Is
When betting on multiple correlated assets (BTC, ETH, SOL), their joint distribution matters. Gaussian copulas underestimate tail dependence (the 2008 financial crisis lesson). Student-t or Clayton copulas capture the fact that crypto assets crash *together* more often than a normal distribution would predict.

### What Shimi Does Today
- Treats each token independently with separate per-token exposure caps
- Has `btcMomentum1m` as a cross-token feature (BTC leads alts) in the ML model
- Cross-token correlations noted in code: BTC-ETH 0.85, BTC-SOL 0.70
- Per-token exposure limits but no portfolio-level correlation adjustment

### What We Could Improve

**A. Correlation-Adjusted Portfolio Exposure**
The current risk system treats "$3 on BTC + $3 on ETH + $3 on SOL" as $9 total exposure. But if all three are highly correlated (which they are in crypto), the effective risk is much higher than 3 independent bets.

```javascript
function adjustedPortfolioRisk(positions) {
  const correlations = {
    'BTC-ETH': 0.85, 'BTC-SOL': 0.70, 'ETH-SOL': 0.75
  };

  // Sum of squared exposures + 2 * sum of cross-correlations
  let portfolioVar = 0;
  const tokens = Object.keys(positions);
  for (const t1 of tokens) {
    portfolioVar += positions[t1] ** 2;
    for (const t2 of tokens) {
      if (t1 < t2) {
        const corr = correlations[`${t1}-${t2}`] || correlations[`${t2}-${t1}`] || 0.5;
        portfolioVar += 2 * corr * positions[t1] * positions[t2];
      }
    }
  }
  return Math.sqrt(portfolioVar);
}
```

**Benefit**: Prevents over-concentration when all 3 crypto assets are likely to move together. The current $10 total cap might be too generous when all positions are correlated.

**Priority: MEDIUM-HIGH** — Crypto correlations spike during crashes (exactly when you need protection). This is a risk management improvement.

**B. Dynamic Correlation Tracking**
Instead of static correlation values, calculate rolling correlations from the price history buffers we already maintain. Correlations spike during selloffs — dynamically reducing exposure during these periods would prevent concentrated losses.

---

## 6. Agent-Based Modeling (Order Book Simulation)

### What It Is
Simulate heterogeneous traders interacting in an order book: momentum traders, market makers, noise traders. This models *how the orderbook will evolve*, not just where the price will go.

### What Shimi Does Today
- Reads Kalshi orderbook for spread and slippage estimation
- Has `orderImbalance` as an ML feature: `(bidSize - askSize) / (bidSize + askSize)`
- Buy pressure features from Binance aggTrades (1m, 5m, 15m, 30m windows)
- No simulation of how the Kalshi orderbook itself will change

### What We Could Improve

**A. Orderbook Depletion Modeling**
For maker orders, it matters whether the orderbook will still be there when our order might get filled. Simple model:

```javascript
function estimateFillProbability(orderbook, ourPrice, timeToExpiry) {
  // How much volume sits between current best and our price?
  const volumeAhead = orderbook.asks
    .filter(a => a.price <= ourPrice)
    .reduce((sum, a) => sum + a.quantity, 0);

  // Estimate arrival rate of market orders from historical data
  const avgMarketOrderRate = 5; // orders per minute (calibrate from data)
  const expectedVolume = avgMarketOrderRate * timeToExpiry;

  return Math.min(1, expectedVolume / Math.max(1, volumeAhead));
}
```

**Priority: LOW-MEDIUM** — Interesting for optimizing maker order placement, but Shimi's current markets are liquid enough that fill probability isn't usually an issue.

**B. Adverse Selection Detection**
If the orderbook is thinning on our side right before expiry, it may signal informed traders pulling liquidity. Worth monitoring as an exit signal.

---

## 7. Production Stack Architecture

### What It Is
The article describes a full production pipeline: data ingestion → feature engineering → simulation engine → risk management → execution → monitoring.

### What Shimi Does Today
- Monolithic `index.js` (10,900+ lines) handles everything
- Real-time via WebSocket + REST polling
- PostgreSQL for persistence

### What We Could Improve

**A. Separate Simulation Engine**
Move probability calculation into its own module (like `mlModel.js` but for Monte Carlo). This would let us:
- Run simulations in parallel (worker threads)
- A/B test different probability models
- Cache and share simulation results across endpoints

**B. Model Performance Dashboard**
Track Brier scores, calibration curves, and prediction accuracy over time. The `performanceTracking` structure in `learned_params.json` already has the skeleton for this.

**Priority: LOW** — Architecture improvement, not a strategy improvement. Only worth it if we're adding Monte Carlo and particle filters.

---

## 8. Brier Score — The Missing Calibration Metric

### What It Is
`BrierScore = (1/N) * Σ(predicted_prob - actual_outcome)²`

A perfectly calibrated model has Brier=0. A coin-flip model has Brier=0.25. Anything above 0.25 is worse than random.

### What Shimi Does Today
- Tracks accuracy (binary right/wrong) and log loss in the ML model
- `calibrationError` field exists but is always 0
- No Brier score calculation

### What We Could Improve

```javascript
function updateBrierScore(predictedProb, actualOutcome) {
  // predictedProb: 0-1 (our estimated win probability)
  // actualOutcome: 0 or 1 (did the favored side win?)
  const brierContrib = (predictedProb - actualOutcome) ** 2;

  // Track rolling Brier score (last 100 bets)
  learnedParams.performanceTracking.brierScores =
    learnedParams.performanceTracking.brierScores || [];
  learnedParams.performanceTracking.brierScores.push(brierContrib);

  // Keep last 100
  if (learnedParams.performanceTracking.brierScores.length > 100) {
    learnedParams.performanceTracking.brierScores.shift();
  }

  const avgBrier = learnedParams.performanceTracking.brierScores
    .reduce((a, b) => a + b, 0) / learnedParams.performanceTracking.brierScores.length;

  learnedParams.performanceTracking.calibrationError = avgBrier;

  // If Brier > 0.20, our calibration is poor — tighten selectivity
  if (avgBrier > 0.20) {
    console.warn(`⚠ Brier score ${avgBrier.toFixed(3)} > 0.20 — model may be miscalibrated`);
  }

  return avgBrier;
}
```

**Priority: HIGH** — Trivial to implement and gives you the single most important metric for whether your probability estimates are any good.

---

## Summary: Prioritized Improvements

| # | Technique | Priority | Effort | Impact |
|---|-----------|----------|--------|--------|
| 1 | **Brier Score tracking** | HIGH | Low | Know if your probabilities are calibrated |
| 2 | **Monte Carlo price simulation** | HIGH | Medium | Dynamic probabilities that adapt to current conditions |
| 3 | **Particle filter for live tracking** | HIGH | Medium | Faster, smoother probability updates for position management |
| 4 | **Correlation-adjusted portfolio risk** | MED-HIGH | Low | Prevent concentrated losses when crypto crashes together |
| 5 | **Variance reduction in MC** | MEDIUM | Low | Free accuracy improvement once MC is implemented |
| 6 | **Dynamic correlation tracking** | MEDIUM | Low | Adapt risk limits to current market correlation regime |
| 7 | **Orderbook depletion modeling** | LOW-MED | Medium | Better maker order fill estimation |
| 8 | **Importance sampling** | LOW | Medium | Only if expanding to tail-risk contracts |
| 9 | **Agent-based orderbook sim** | LOW | High | Academic interest, overkill for 15-min crypto markets |
| 10 | **Architecture refactor** | LOW | High | Only if implementing multiple new simulation engines |

### Recommended Implementation Order
1. **Brier Score** — add to settlement handler, start collecting data immediately
2. **Monte Carlo + variance reduction** — replace static empirical tables with dynamic simulation
3. **Correlation-adjusted risk** — protect against correlated drawdowns
4. **Particle filter** — upgrade position management with real-time probability tracking
