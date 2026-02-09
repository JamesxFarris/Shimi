// ML MODEL - Logistic Regression
// Proper ML model trained on settlement data
// Blends with empirical tables at max 30% weight

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ML_MODEL_FILE = path.join(__dirname, 'ml_model.json');
const ML_FEATURE_NAMES = [
  'distance', 'distanceSquared', 'timeRemaining', 'timeUrgency',
  'momentum1m', 'momentum5m', 'volatility', 'volToDistance',
  'marketImpliedProb', 'priceDeviation', 'spread',
  'tokenBTC', 'tokenETH', 'tokenSOL',
  'hourMorning', 'hourAfternoon', 'hourEvening', 'hourNight',
  'sideYes'
];

let mlModel = {
  version: 2,
  trainedOn: 0,
  lastUpdated: null,
  weights: {},
  bias: 0,
  featureStats: {}, // { featureName: { mean, std } } for z-score normalization
  learningRate: 0.01,
  regularization: 0.001, // L2 regularization strength
  performance: {
    accuracy: 0,
    trainAccuracy: 0,
    valAccuracy: 0,
    logLoss: Infinity,
    confusionMatrix: { tp: 0, fp: 0, tn: 0, fn: 0 }
  }
};

// Initialize weights to zero
for (const name of ML_FEATURE_NAMES) {
  mlModel.weights[name] = 0;
}

// Load existing ML model
try {
  if (fs.existsSync(ML_MODEL_FILE)) {
    const data = JSON.parse(fs.readFileSync(ML_MODEL_FILE, 'utf8'));
    if (data.version >= 2) {
      mlModel = data;
      console.log(` Loaded ML model: ${mlModel.trainedOn} samples, accuracy ${(mlModel.performance?.accuracy * 100).toFixed(1)}%`);
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

/**
 * Extract features from a market opportunity for ML prediction
 * @param {object} params - { absDistance, timeRemaining, token, side, momentum, volatility, marketImpliedProb, spread }
 * @returns {object} Feature vector keyed by feature name
 */
function extractMLFeatures(params) {
  const {
    absDistance = 0, timeRemaining = 15, token = 'BTC', side = 'YES',
    momentum1m = 0, momentum5m = 0, volatility = 0.02,
    marketImpliedProb = 50, spread = 0
  } = params;

  const hour = new Date().getUTCHours();

  return {
    distance: absDistance,
    distanceSquared: absDistance * absDistance,
    timeRemaining: timeRemaining,
    timeUrgency: timeRemaining > 0 ? 1 / timeRemaining : 1,
    momentum1m,
    momentum5m,
    volatility: volatility * 100, // convert to %
    volToDistance: absDistance > 0 ? (volatility * 100) / absDistance : 0,
    marketImpliedProb: marketImpliedProb / 100, // normalize to 0-1
    priceDeviation: (marketImpliedProb - 50) / 50, // how far from 50/50
    spread,
    tokenBTC: token === 'BTC' ? 1 : 0,
    tokenETH: token === 'ETH' ? 1 : 0,
    tokenSOL: token === 'SOL' ? 1 : 0,
    hourMorning: (hour >= 6 && hour < 12) ? 1 : 0, // 6am-12pm UTC
    hourAfternoon: (hour >= 12 && hour < 18) ? 1 : 0, // 12pm-6pm UTC
    hourEvening: (hour >= 18 && hour < 24) ? 1 : 0, // 6pm-12am UTC
    hourNight: (hour >= 0 && hour < 6) ? 1 : 0, // 12am-6am UTC
    sideYes: side?.toUpperCase() === 'YES' ? 1 : 0
  };
}

/**
 * Normalize features using z-score (mean=0, std=1)
 */
function normalizeFeatures(features, stats) {
  const normalized = {};
  for (const [name, value] of Object.entries(features)) {
    const s = stats[name];
    if (s && s.std > 0) {
      normalized[name] = (value - s.mean) / s.std;
    } else {
      normalized[name] = value; // No normalization if no stats
    }
  }
  return normalized;
}

/**
 * Predict win probability using logistic regression
 */
function mlPredict(features) {
  if (!mlModel.trainedOn || mlModel.trainedOn < 200) return null;
  if (!mlModel.performance || mlModel.performance.accuracy < 0.55) return null;

  const normalized = normalizeFeatures(features, mlModel.featureStats);
  let z = mlModel.bias || 0;
  for (const [name, value] of Object.entries(normalized)) {
    z += (mlModel.weights[name] || 0) * value;
  }
  return sigmoid(z);
}

/**
 * Compute feature statistics (mean, std) for normalization
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

/**
 * Train logistic regression model using gradient descent
 * @param {Array} dataPoints - Array of { features: {}, outcome: 0|1 }
 * @returns {object} Training results
 */
function trainMLModel(dataPoints) {
  if (dataPoints.length < 200) {
    console.log(` ML: Insufficient data (${dataPoints.length} < 200 required)`);
    return { success: false, reason: 'Insufficient data' };
  }

  console.log(` ML: Training on ${dataPoints.length} samples...`);

  // Shuffle data
  const shuffled = [...dataPoints].sort(() => Math.random() - 0.5);

  // 80/20 train/val split
  const splitIdx = Math.floor(shuffled.length * 0.8);
  const trainData = shuffled.slice(0, splitIdx);
  const valData = shuffled.slice(splitIdx);

  // Compute feature stats from training data only
  const featureStats = computeFeatureStats(trainData);

  // Initialize weights
  const weights = {};
  for (const name of ML_FEATURE_NAMES) {
    weights[name] = 0;
  }
  let bias = 0;

  const lr = 0.01;
  const lambda = 0.001; // L2 regularization
  const epochs = 100;
  const batchSize = Math.min(64, Math.floor(trainData.length / 4));

  let bestValAccuracy = 0;
  let bestWeights = { ...weights };
  let bestBias = bias;
  let epochsSinceImprovement = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Shuffle training data each epoch
    trainData.sort(() => Math.random() - 0.5);

    // Mini-batch gradient descent
    for (let i = 0; i < trainData.length; i += batchSize) {
      const batch = trainData.slice(i, i + batchSize);

      // Accumulate gradients
      const gradients = {};
      for (const name of ML_FEATURE_NAMES) {
        gradients[name] = 0;
      }
      let biasGrad = 0;

      for (const dp of batch) {
        const normalized = normalizeFeatures(dp.features, featureStats);
        let z = bias;
        for (const [name, value] of Object.entries(normalized)) {
          z += (weights[name] || 0) * value;
        }
        const pred = sigmoid(z);
        const error = pred - dp.outcome; // gradient of log-loss

        biasGrad += error;
        for (const [name, value] of Object.entries(normalized)) {
          gradients[name] = (gradients[name] || 0) + error * value;
        }
      }

      // Update weights with L2 regularization
      const scale = lr / batch.length;
      bias -= scale * biasGrad;
      for (const name of ML_FEATURE_NAMES) {
        weights[name] -= scale * (gradients[name] + lambda * weights[name]);
      }
    }

    // Evaluate on validation set every 10 epochs
    if ((epoch + 1) % 10 === 0) {
      let correct = 0;
      for (const dp of valData) {
        const normalized = normalizeFeatures(dp.features, featureStats);
        let z = bias;
        for (const [name, value] of Object.entries(normalized)) {
          z += (weights[name] || 0) * value;
        }
        const pred = sigmoid(z) >= 0.5 ? 1 : 0;
        if (pred === dp.outcome) correct++;
      }
      const valAcc = correct / valData.length;

      if (valAcc > bestValAccuracy) {
        bestValAccuracy = valAcc;
        bestWeights = { ...weights };
        bestBias = bias;
        epochsSinceImprovement = 0;
      } else {
        epochsSinceImprovement += 10;
      }

      // Early stopping
      if (epochsSinceImprovement >= 30) {
        console.log(` ML: Early stopping at epoch ${epoch + 1} (val accuracy: ${(bestValAccuracy * 100).toFixed(1)}%)`);
        break;
      }
    }
  }

  // Evaluate final model on both sets
  let trainCorrect = 0;
  const confusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };

  for (const dp of trainData) {
    const normalized = normalizeFeatures(dp.features, featureStats);
    let z = bestBias;
    for (const [name, value] of Object.entries(normalized)) {
      z += (bestWeights[name] || 0) * value;
    }
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === dp.outcome) trainCorrect++;
  }

  let valCorrect = 0;
  let logLossSum = 0;
  for (const dp of valData) {
    const normalized = normalizeFeatures(dp.features, featureStats);
    let z = bestBias;
    for (const [name, value] of Object.entries(normalized)) {
      z += (bestWeights[name] || 0) * value;
    }
    const pred = sigmoid(z);
    const predBinary = pred >= 0.5 ? 1 : 0;
    if (predBinary === dp.outcome) valCorrect++;

    // Log loss
    const clipped = Math.max(0.001, Math.min(0.999, pred));
    logLossSum -= dp.outcome * Math.log(clipped) + (1 - dp.outcome) * Math.log(1 - clipped);

    // Confusion matrix
    if (predBinary === 1 && dp.outcome === 1) confusionMatrix.tp++;
    else if (predBinary === 1 && dp.outcome === 0) confusionMatrix.fp++;
    else if (predBinary === 0 && dp.outcome === 0) confusionMatrix.tn++;
    else confusionMatrix.fn++;
  }

  const trainAccuracy = trainCorrect / trainData.length;
  const valAccuracy = valCorrect / valData.length;
  const logLoss = logLossSum / valData.length;

  // Update model
  mlModel = {
    version: 2,
    trainedOn: dataPoints.length,
    lastUpdated: new Date().toISOString(),
    weights: bestWeights,
    bias: bestBias,
    featureStats,
    learningRate: lr,
    regularization: lambda,
    performance: {
      accuracy: valAccuracy,
      trainAccuracy,
      valAccuracy,
      logLoss,
      confusionMatrix,
      trainSize: trainData.length,
      valSize: valData.length
    }
  };

  saveMLModel();

  console.log(` ML: Training complete!`);
  console.log(` Train accuracy: ${(trainAccuracy * 100).toFixed(1)}% | Val accuracy: ${(valAccuracy * 100).toFixed(1)}%`);
  console.log(` Log loss: ${logLoss.toFixed(4)}`);
  console.log(` Confusion matrix: TP=${confusionMatrix.tp} FP=${confusionMatrix.fp} TN=${confusionMatrix.tn} FN=${confusionMatrix.fn}`);

  // Log top features by absolute weight
  const sortedFeatures = Object.entries(bestWeights)
    .map(([name, weight]) => ({ name, weight, absWeight: Math.abs(weight) }))
    .sort((a, b) => b.absWeight - a.absWeight)
    .slice(0, 5);
  console.log(` Top features: ${sortedFeatures.map(f => `${f.name}=${f.weight.toFixed(3)}`).join(', ')}`);

  return {
    success: true,
    trainAccuracy,
    valAccuracy,
    logLoss,
    confusionMatrix,
    topFeatures: sortedFeatures
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

    // Skip samples without betting-time data using settlement price causes data leakage
    if (s.bettingTimePct === undefined) continue;

    // Calculate distance
    const absDistance = Math.abs(s.bettingTimePct);

    if (absDistance > 10) continue; // Skip outliers

    // Determine the favored side at betting time
    const wasAboveStrike = s.bettingTimePct > 0;

    const token = s.token;
    const side = wasAboveStrike ? 'YES' : 'NO'; // Favored side
    const yesWon = s.result === 'yes';
    const favoredWon = (wasAboveStrike && yesWon) || (!wasAboveStrike && !yesWon);

    // Extract time info from close time
    let hour = 12; // default
    let timeRemaining = 7.5; // default mid-point
    try {
      if (s.closeTime) {
        const closeDate = new Date(s.closeTime);
        hour = closeDate.getUTCHours();
      }
    } catch (e) {}

    const features = extractMLFeatures({
      absDistance,
      timeRemaining, // We don't know exact time remaining from settlements
      token,
      side,
      momentum1m: 0, // Not available from historical data
      momentum5m: 0,
      volatility: 0.02, // Default
      marketImpliedProb: 50 + absDistance * 5, // Rough estimate
      spread: 0
    });

    // Override hour features based on actual close time
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
