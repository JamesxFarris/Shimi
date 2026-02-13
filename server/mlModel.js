// ML MODEL - Gradient Boosted Decision Trees (GBDT)
// Pure JS implementation — no external dependencies
// Replaces logistic regression with ensemble of shallow decision trees
// Handles non-linear feature interactions and regime changes natively
// Walk-forward validation prevents overfitting

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ML_MODEL_FILE = path.join(__dirname, 'ml_model.json');

// Expanded feature set: original 19 + 4 new cross-token/vol features
const ML_FEATURE_NAMES = [
  'distance', 'distanceSquared', 'timeRemaining', 'timeUrgency',
  'momentum1m', 'momentum5m', 'volatility', 'volToDistance',
  'marketImpliedProb', 'priceDeviation', 'spread',
  'tokenBTC', 'tokenETH', 'tokenSOL',
  'hourMorning', 'hourAfternoon', 'hourEvening', 'hourNight',
  'sideYes',
  // New features (v3)
  'btcMomentum1m',      // BTC momentum as leading indicator for alts
  'volOfVol',           // Volatility of volatility (regime stability)
  'orderImbalance',     // Buy/sell pressure ratio from orderbook
  // New features (v3.1) — aggTrade + funding
  'buyPressure1m',      // Binance aggTrade buy/sell pressure 1-min window [-1, 1]
  'buyPressure5m',      // Binance aggTrade buy/sell pressure 5-min window [-1, 1]
  'fundingRate',        // Binance perpetual funding rate (scaled ×1000)
];

let mlModel = {
  version: 3,
  modelType: 'gbdt',
  trainedOn: 0,
  lastUpdated: null,
  trees: [],            // Array of decision trees
  learningRate: 0.1,    // Shrinkage factor per tree
  basePrediction: 0,    // Initial prediction (log-odds of base rate)
  featureImportance: {},
  performance: {
    accuracy: 0,
    trainAccuracy: 0,
    valAccuracy: 0,
    logLoss: Infinity,
    confusionMatrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
    walkForwardScores: [] // Per-fold validation scores
  },
  // Backward compat: keep these so old code paths don't crash
  weights: {},
  bias: 0,
  featureStats: {},
};

// Load existing ML model
try {
  if (fs.existsSync(ML_MODEL_FILE)) {
    const data = JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'));
    if (data.version >= 2) {
      mlModel = { ...mlModel, ...data };
      console.log(` Loaded ML model v${mlModel.version} (${mlModel.modelType || 'logistic'}): ${mlModel.trainedOn} samples, accuracy ${(mlModel.performance?.accuracy * 100).toFixed(1)}%`);
    } else {
      console.log(` Skipping old ML model v${data.version}, will retrain`);
    }
  }
} catch (err) {
  console.error('Error loading ML model:', err.message);
}

function saveMLModel() {
  try {
    fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(mlModel, null, 2));
  } catch (err) {
    console.error('Error saving ML model:', err.message);
  }
}

// Sigmoid function
function sigmoid(z) {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

// ============================================
// FEATURE EXTRACTION
// ============================================

/**
 * Extract features from a market opportunity for ML prediction
 * @param {object} params - Market params + optional cross-token data
 * @returns {object} Feature vector keyed by feature name
 */
function extractMLFeatures(params) {
  const {
    absDistance = 0, timeRemaining = 15, token = 'BTC', side = 'YES',
    momentum1m = 0, momentum5m = 0, volatility = 0.02,
    marketImpliedProb = 50, spread = 0,
    // New params (optional — gracefully default)
    btcMomentum1m = 0,     // BTC's 1-min momentum (for alt predictions)
    volOfVol = 0,          // Volatility of recent volatility readings
    orderImbalance = 0,    // (bidSize - askSize) / (bidSize + askSize) from orderbook
    // v3.1 params
    buyPressure1m = 0,     // Binance aggTrade buy pressure 1m [-1, 1]
    buyPressure5m = 0,     // Binance aggTrade buy pressure 5m [-1, 1]
    fundingRate = 0,       // Binance perp funding rate (raw, e.g. 0.0001)
  } = params;

  const hour = new Date().getUTCHours();

  return {
    distance: absDistance,
    distanceSquared: absDistance * absDistance,
    timeRemaining: timeRemaining,
    timeUrgency: timeRemaining > 0 ? 1 / timeRemaining : 1,
    momentum1m,
    momentum5m,
    volatility: volatility * 100,
    volToDistance: absDistance > 0 ? (volatility * 100) / absDistance : 0,
    marketImpliedProb: marketImpliedProb / 100,
    priceDeviation: (marketImpliedProb - 50) / 50,
    spread,
    tokenBTC: token === 'BTC' ? 1 : 0,
    tokenETH: token === 'ETH' ? 1 : 0,
    tokenSOL: token === 'SOL' ? 1 : 0,
    hourMorning: (hour >= 6 && hour < 12) ? 1 : 0,
    hourAfternoon: (hour >= 12 && hour < 18) ? 1 : 0,
    hourEvening: (hour >= 18 && hour < 24) ? 1 : 0,
    hourNight: (hour >= 0 && hour < 6) ? 1 : 0,
    sideYes: side?.toUpperCase() === 'YES' ? 1 : 0,
    // New features
    btcMomentum1m: token === 'BTC' ? 0 : btcMomentum1m, // Only for alts (BTC leading indicator)
    volOfVol,
    orderImbalance,
    // v3.1 features
    buyPressure1m,
    buyPressure5m,
    fundingRate: fundingRate * 1000, // Scale up for tree splits (0.0001 → 0.1)
  };
}

/**
 * Normalize features using z-score — kept for backward compat with v2 logistic models
 */
function normalizeFeatures(features, stats) {
  const normalized = {};
  for (const [name, value] of Object.entries(features)) {
    const s = stats[name];
    if (s && s.std > 0) {
      normalized[name] = (value - s.mean) / s.std;
    } else {
      normalized[name] = value;
    }
  }
  return normalized;
}

// ============================================
// GRADIENT BOOSTED DECISION TREE IMPLEMENTATION
// ============================================

/**
 * A single decision tree node (binary split)
 * Trees are stored as plain objects for JSON serialization
 */
function createLeafNode(value) {
  return { leaf: true, value };
}

function createSplitNode(feature, threshold, left, right) {
  return { leaf: false, feature, threshold, left, right };
}

/**
 * Predict from a single tree
 */
function treePredictOne(tree, features) {
  if (tree.leaf) return tree.value;
  const val = features[tree.feature] ?? 0;
  return val <= tree.threshold
    ? treePredictOne(tree.left, features)
    : treePredictOne(tree.right, features);
}

/**
 * Find the best split for a set of data points
 * Uses gradient/hessian formulation for binary classification (log-loss)
 */
function findBestSplit(indices, gradients, hessians, allFeatures, featureNames, minSamplesLeaf, lambda) {
  let bestGain = 0;
  let bestFeature = null;
  let bestThreshold = null;
  let bestLeftIdx = null;
  let bestRightIdx = null;

  const totalGrad = indices.reduce((s, i) => s + gradients[i], 0);
  const totalHess = indices.reduce((s, i) => s + hessians[i], 0);

  for (const feat of featureNames) {
    // Get unique sorted values for this feature
    const vals = indices.map(i => ({ idx: i, val: allFeatures[i][feat] ?? 0 }));
    vals.sort((a, b) => a.val - b.val);

    let leftGrad = 0, leftHess = 0;

    for (let j = 0; j < vals.length - 1; j++) {
      leftGrad += gradients[vals[j].idx];
      leftHess += hessians[vals[j].idx];

      // Skip if same value as next (no split point here)
      if (vals[j].val === vals[j + 1].val) continue;

      const rightGrad = totalGrad - leftGrad;
      const rightHess = totalHess - leftHess;

      // Min samples check
      if (j + 1 < minSamplesLeaf || vals.length - j - 1 < minSamplesLeaf) continue;

      // Gain = 0.5 * [G_L^2/(H_L+λ) + G_R^2/(H_R+λ) - (G_L+G_R)^2/(H_L+H_R+λ)]
      const gain = 0.5 * (
        (leftGrad * leftGrad) / (leftHess + lambda) +
        (rightGrad * rightGrad) / (rightHess + lambda) -
        (totalGrad * totalGrad) / (totalHess + lambda)
      );

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = feat;
        bestThreshold = (vals[j].val + vals[j + 1].val) / 2;
        bestLeftIdx = vals.slice(0, j + 1).map(v => v.idx);
        bestRightIdx = vals.slice(j + 1).map(v => v.idx);
      }
    }
  }

  return { gain: bestGain, feature: bestFeature, threshold: bestThreshold, leftIdx: bestLeftIdx, rightIdx: bestRightIdx };
}

/**
 * Build a single decision tree (depth-limited)
 */
function buildTree(indices, gradients, hessians, allFeatures, featureNames, depth, maxDepth, minSamplesLeaf, lambda) {
  // Leaf value = -sum(gradients) / (sum(hessians) + lambda)
  const sumGrad = indices.reduce((s, i) => s + gradients[i], 0);
  const sumHess = indices.reduce((s, i) => s + hessians[i], 0);
  const leafValue = -sumGrad / (sumHess + lambda);

  if (depth >= maxDepth || indices.length < minSamplesLeaf * 2) {
    return createLeafNode(leafValue);
  }

  const split = findBestSplit(indices, gradients, hessians, allFeatures, featureNames, minSamplesLeaf, lambda);

  if (!split.feature || split.gain <= 0) {
    return createLeafNode(leafValue);
  }

  const left = buildTree(split.leftIdx, gradients, hessians, allFeatures, featureNames, depth + 1, maxDepth, minSamplesLeaf, lambda);
  const right = buildTree(split.rightIdx, gradients, hessians, allFeatures, featureNames, depth + 1, maxDepth, minSamplesLeaf, lambda);

  return createSplitNode(split.feature, split.threshold, left, right);
}

/**
 * Count feature usage across all trees (for importance)
 */
function countFeatureUsage(tree, counts = {}) {
  if (tree.leaf) return counts;
  counts[tree.feature] = (counts[tree.feature] || 0) + 1;
  countFeatureUsage(tree.left, counts);
  countFeatureUsage(tree.right, counts);
  return counts;
}

// ============================================
// PREDICTION
// ============================================

/**
 * Predict win probability using GBDT ensemble (or fallback to logistic if v2 model loaded)
 */
function mlPredict(features) {
  if (!mlModel.trainedOn || mlModel.trainedOn < 200) return null;
  if (!mlModel.performance || mlModel.performance.accuracy < 0.55) return null;

  // GBDT prediction (v3)
  if (mlModel.modelType === 'gbdt' && mlModel.trees && mlModel.trees.length > 0) {
    let logOdds = mlModel.basePrediction || 0;
    const lr = mlModel.learningRate || 0.1;
    for (const tree of mlModel.trees) {
      logOdds += lr * treePredictOne(tree, features);
    }
    return sigmoid(logOdds);
  }

  // Fallback: logistic regression (v2 backward compat)
  if (mlModel.weights && mlModel.featureStats) {
    const normalized = normalizeFeatures(features, mlModel.featureStats);
    let z = mlModel.bias || 0;
    for (const [name, value] of Object.entries(normalized)) {
      z += (mlModel.weights[name] || 0) * value;
    }
    return sigmoid(z);
  }

  return null;
}

/**
 * Compute feature statistics (mean, std) for normalization — kept for backward compat
 */
function computeFeatureStats(dataPoints) {
  const stats = {};
  if (dataPoints.length === 0) return stats;

  for (const name of ML_FEATURE_NAMES) {
    const values = dataPoints.map(d => d.features[name] || 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    stats[name] = { mean, std: Math.sqrt(variance) || 1 };
  }
  return stats;
}

// ============================================
// TRAINING WITH WALK-FORWARD VALIDATION
// ============================================

/**
 * Evaluate a trained GBDT ensemble on a dataset
 */
function evaluateEnsemble(trees, basePrediction, lr, dataPoints) {
  let correct = 0;
  let logLossSum = 0;
  const cm = { tp: 0, fp: 0, tn: 0, fn: 0 };

  for (const dp of dataPoints) {
    let logOdds = basePrediction;
    for (const tree of trees) {
      logOdds += lr * treePredictOne(tree, dp.features);
    }
    const pred = sigmoid(logOdds);
    const predBinary = pred >= 0.5 ? 1 : 0;
    if (predBinary === dp.outcome) correct++;

    const clipped = Math.max(0.001, Math.min(0.999, pred));
    logLossSum -= dp.outcome * Math.log(clipped) + (1 - dp.outcome) * Math.log(1 - clipped);

    if (predBinary === 1 && dp.outcome === 1) cm.tp++;
    else if (predBinary === 1 && dp.outcome === 0) cm.fp++;
    else if (predBinary === 0 && dp.outcome === 0) cm.tn++;
    else cm.fn++;
  }

  return {
    accuracy: correct / dataPoints.length,
    logLoss: logLossSum / dataPoints.length,
    confusionMatrix: cm
  };
}

/**
 * Train a GBDT ensemble on a training set
 */
function trainGBDTOnData(trainData, featureNames, params = {}) {
  const {
    nTrees = 50,
    maxDepth = 4,         // Shallow trees — prevent overfitting on our small data
    minSamplesLeaf = 10,
    learningRate = 0.1,
    lambda = 1.0,         // L2 regularization on leaf weights
    subsampleRate = 0.8,  // Row subsampling per tree
  } = params;

  // Base prediction: log(p / (1-p)) where p = positive rate
  const posRate = trainData.filter(d => d.outcome === 1).length / trainData.length;
  const basePrediction = Math.log(Math.max(0.01, posRate) / Math.max(0.01, 1 - posRate));

  // Extract all features into array for fast access
  const allFeatures = trainData.map(d => d.features);
  const outcomes = trainData.map(d => d.outcome);
  const n = trainData.length;

  // Current predictions (log-odds space)
  const predictions = new Float64Array(n).fill(basePrediction);
  const trees = [];

  for (let t = 0; t < nTrees; t++) {
    // Compute gradients and hessians for log-loss
    const gradients = new Float64Array(n);
    const hessians = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const pred = sigmoid(predictions[i]);
      gradients[i] = pred - outcomes[i];         // First derivative of log-loss
      hessians[i] = pred * (1 - pred);           // Second derivative
    }

    // Row subsampling
    let indices;
    if (subsampleRate < 1.0) {
      const shuffled = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
      indices = shuffled.slice(0, Math.floor(n * subsampleRate));
    } else {
      indices = Array.from({ length: n }, (_, i) => i);
    }

    // Build tree
    const tree = buildTree(indices, gradients, hessians, allFeatures, featureNames, 0, maxDepth, minSamplesLeaf, lambda);
    trees.push(tree);

    // Update predictions
    for (let i = 0; i < n; i++) {
      predictions[i] += learningRate * treePredictOne(tree, allFeatures[i]);
    }
  }

  return { trees, basePrediction, learningRate };
}

/**
 * Train GBDT with walk-forward validation
 * Splits data chronologically into rolling windows, trains on each, validates on next
 * Only deploys the model if out-of-sample performance is adequate
 *
 * @param {Array} dataPoints - Array of { features: {}, outcome: 0|1 }
 * @returns {object} Training results
 */
function trainMLModel(dataPoints) {
  if (dataPoints.length < 200) {
    console.log(` ML: Insufficient data (${dataPoints.length} < 200 required)`);
    return { success: false, reason: 'Insufficient data' };
  }

  console.log(` ML GBDT: Training on ${dataPoints.length} samples with walk-forward validation...`);

  // Active feature names: only include features that exist in data
  const sampleFeatures = dataPoints[0]?.features || {};
  const activeFeatures = ML_FEATURE_NAMES.filter(f => f in sampleFeatures);
  console.log(` ML: Using ${activeFeatures.length} features: ${activeFeatures.join(', ')}`);

  // Walk-forward validation: 3 folds
  // Split data into 4 chunks: train on 1-2-3, validate on 2-3-4
  const nFolds = 3;
  const foldSize = Math.floor(dataPoints.length / (nFolds + 1));
  const walkForwardScores = [];

  console.log(` ML: Walk-forward: ${nFolds} folds, ~${foldSize} samples each`);

  for (let fold = 0; fold < nFolds; fold++) {
    const trainEnd = (fold + 1) * foldSize;
    const valEnd = Math.min((fold + 2) * foldSize, dataPoints.length);
    const trainSlice = dataPoints.slice(0, trainEnd);
    const valSlice = dataPoints.slice(trainEnd, valEnd);

    if (trainSlice.length < 100 || valSlice.length < 30) continue;

    const { trees, basePrediction, learningRate: lr } = trainGBDTOnData(trainSlice, activeFeatures, {
      nTrees: 40,
      maxDepth: 4,
      minSamplesLeaf: Math.max(5, Math.floor(trainSlice.length * 0.02)),
      learningRate: 0.1,
      lambda: 1.0,
      subsampleRate: 0.8
    });

    const valResult = evaluateEnsemble(trees, basePrediction, lr, valSlice);
    walkForwardScores.push({
      fold,
      trainSize: trainSlice.length,
      valSize: valSlice.length,
      valAccuracy: valResult.accuracy,
      valLogLoss: valResult.logLoss
    });

    console.log(` Fold ${fold + 1}: train=${trainSlice.length} val=${valSlice.length} accuracy=${(valResult.accuracy * 100).toFixed(1)}% logLoss=${valResult.logLoss.toFixed(4)}`);
  }

  // Average walk-forward accuracy
  const avgWFAccuracy = walkForwardScores.length > 0
    ? walkForwardScores.reduce((s, f) => s + f.valAccuracy, 0) / walkForwardScores.length
    : 0;

  console.log(` ML: Walk-forward avg accuracy: ${(avgWFAccuracy * 100).toFixed(1)}%`);

  // Train final model on 80% of data, validate on last 20% (time-ordered, no shuffle)
  const splitIdx = Math.floor(dataPoints.length * 0.8);
  const trainData = dataPoints.slice(0, splitIdx);
  const valData = dataPoints.slice(splitIdx);

  const params = {
    nTrees: 50,
    maxDepth: 4,
    minSamplesLeaf: Math.max(5, Math.floor(trainData.length * 0.02)),
    learningRate: 0.1,
    lambda: 1.0,
    subsampleRate: 0.8
  };

  const { trees, basePrediction, learningRate: lr } = trainGBDTOnData(trainData, activeFeatures, params);

  // Evaluate on both sets
  const trainResult = evaluateEnsemble(trees, basePrediction, lr, trainData);
  const valResult = evaluateEnsemble(trees, basePrediction, lr, valData);

  // Compute feature importance
  const featureCounts = {};
  for (const tree of trees) {
    countFeatureUsage(tree, featureCounts);
  }
  const totalSplits = Object.values(featureCounts).reduce((s, v) => s + v, 0) || 1;
  const featureImportance = {};
  for (const [feat, count] of Object.entries(featureCounts)) {
    featureImportance[feat] = parseFloat((count / totalSplits).toFixed(4));
  }

  // Only deploy if walk-forward accuracy is reasonable
  const deployable = avgWFAccuracy >= 0.53; // Lower bar than 0.55 since GBDT is better calibrated

  if (!deployable) {
    console.log(` ML: Walk-forward accuracy ${(avgWFAccuracy * 100).toFixed(1)}% < 53% — model NOT deployed (keeping previous)`);
    return {
      success: false,
      reason: `Walk-forward accuracy too low: ${(avgWFAccuracy * 100).toFixed(1)}%`,
      trainAccuracy: trainResult.accuracy,
      valAccuracy: valResult.accuracy,
      walkForwardScores
    };
  }

  // Update model
  mlModel = {
    version: 3,
    modelType: 'gbdt',
    trainedOn: dataPoints.length,
    lastUpdated: new Date().toISOString(),
    trees,
    basePrediction,
    learningRate: lr,
    featureImportance,
    performance: {
      accuracy: valResult.accuracy,
      trainAccuracy: trainResult.accuracy,
      valAccuracy: valResult.accuracy,
      logLoss: valResult.logLoss,
      confusionMatrix: valResult.confusionMatrix,
      trainSize: trainData.length,
      valSize: valData.length,
      walkForwardScores,
      avgWalkForwardAccuracy: avgWFAccuracy
    },
    // Backward compat fields
    weights: {},
    bias: 0,
    featureStats: computeFeatureStats(trainData),
  };

  saveMLModel();

  console.log(` ML GBDT: Training complete!`);
  console.log(` ${trees.length} trees, max depth ${params.maxDepth}`);
  console.log(` Train accuracy: ${(trainResult.accuracy * 100).toFixed(1)}% | Val accuracy: ${(valResult.accuracy * 100).toFixed(1)}%`);
  console.log(` Walk-forward accuracy: ${(avgWFAccuracy * 100).toFixed(1)}%`);
  console.log(` Log loss: ${valResult.logLoss.toFixed(4)}`);
  console.log(` Confusion matrix: TP=${valResult.confusionMatrix.tp} FP=${valResult.confusionMatrix.fp} TN=${valResult.confusionMatrix.tn} FN=${valResult.confusionMatrix.fn}`);

  // Log top features
  const sortedFeatures = Object.entries(featureImportance)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);
  console.log(` Top features: ${sortedFeatures.map(([name, imp]) => `${name}=${(imp * 100).toFixed(1)}%`).join(', ')}`);

  return {
    success: true,
    trainAccuracy: trainResult.accuracy,
    valAccuracy: valResult.accuracy,
    logLoss: valResult.logLoss,
    confusionMatrix: valResult.confusionMatrix,
    topFeatures: sortedFeatures.map(([name, imp]) => ({ name, weight: imp, absWeight: imp })),
    walkForwardScores
  };
}

/**
 * Build training data from historical settlements
 * @param {Array} settlements - Settlement records from fetchBulkHistoricalData
 * @returns {Array} Training data points { features, outcome }
 */
function buildMLTrainingData(settlements) {
  const dataPoints = [];

  for (const s of settlements) {
    if (!s.token || !s.strikePrice || !s.result) continue;

    // Skip samples without betting-time data — using settlement price causes data leakage
    if (s.bettingTimePct === undefined) continue;

    const absDistance = Math.abs(s.bettingTimePct);
    if (absDistance > 10) continue;

    const wasAboveStrike = s.bettingTimePct > 0;
    const token = s.token;
    const side = wasAboveStrike ? 'YES' : 'NO';
    const yesWon = s.result === 'yes';
    const favoredWon = (wasAboveStrike && yesWon) || (!wasAboveStrike && !yesWon);

    let hour = 12;
    let timeRemaining = 7.5;
    try {
      if (s.closeTime) {
        const closeDate = new Date(s.closeTime);
        hour = closeDate.getUTCHours();
      }
    } catch (e) {}

    const features = extractMLFeatures({
      absDistance,
      timeRemaining,
      token,
      side,
      momentum1m: 0,
      momentum5m: 0,
      volatility: 0.02,
      marketImpliedProb: 50 + absDistance * 5,
      spread: 0,
      // New features default to 0 for historical data (not available)
      btcMomentum1m: 0,
      volOfVol: 0,
      orderImbalance: 0,
      buyPressure1m: 0,
      buyPressure5m: 0,
      fundingRate: 0,
    });

    features.hourMorning = (hour >= 6 && hour < 12) ? 1 : 0;
    features.hourAfternoon = (hour >= 12 && hour < 18) ? 1 : 0;
    features.hourEvening = (hour >= 18 && hour < 24) ? 1 : 0;
    features.hourNight = (hour >= 0 && hour < 6) ? 1 : 0;

    dataPoints.push({
      features,
      outcome: favoredWon ? 1 : 0
    });
  }

  return dataPoints;
}

/**
 * Get the current ML model state (for API endpoints)
 */
function getMLModel() {
  return mlModel;
}

export {
  ML_FEATURE_NAMES,
  sigmoid,
  extractMLFeatures,
  normalizeFeatures,
  mlPredict,
  computeFeatureStats,
  trainMLModel,
  buildMLTrainingData,
  saveMLModel,
  getMLModel
};
