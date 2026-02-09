// KALSHI API
// Authenticated REST API requests to Kalshi with rate limiting and signing

import fetch from 'node-fetch';
import crypto from 'crypto';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Kalshi API rate limiter sliding window, max 8 requests/second
const kalshiRateLimiter = {
  timestamps: [],
  maxPerSecond: 8,
  async wait() {
    const now = Date.now();
    // Remove timestamps older than 1 second
    this.timestamps = this.timestamps.filter(t => now - t < 1000);
    if (this.timestamps.length >= this.maxPerSecond) {
      // Wait until the oldest request in the window expires
      const waitMs = 1000 - (now - this.timestamps[0]) + 10;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      // Clean up again after waiting
      const afterWait = Date.now();
      this.timestamps = this.timestamps.filter(t => afterWait - t < 1000);
    }
    this.timestamps.push(Date.now());
  }
};

// Sign request with specific config
function signRequestWithConfig(method, path, timestamp, cfg) {
  // Strip query parameters from path (Kalshi expects signature without query params)
  const pathWithoutQuery = path.split('?')[0];
  const message = timestamp + method + pathWithoutQuery;
  try {
    const privateKeyObj = crypto.createPrivateKey({
      key: cfg.privateKey,
      format: 'pem',
      type: 'pkcs8'
    });
    const signature = crypto.sign('RSA-SHA256', Buffer.from(message), {
      key: privateKeyObj,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    });
    return signature.toString('base64');
  } catch (err) {
    throw new Error(`Failed to sign request: ${err.message}`);
  }
}

// User-aware Kalshi API request - uses provided config or falls back to default
async function kalshiRequest(method, endpoint, body = null, userConfig = null) {
  // Rate limit all Kalshi API calls
  await kalshiRateLimiter.wait();
  const cfg = userConfig || kalshiRequest._defaultConfig;
  const timestamp = Date.now().toString();
  const path = `/trade-api/v2${endpoint}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Shimi/1.0'
  };

  if (cfg?.isAuthenticated && cfg.apiKeyId && cfg.privateKey) {
    const signature = signRequestWithConfig(method, path, timestamp, cfg);
    headers['KALSHI-ACCESS-KEY'] = cfg.apiKeyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signature;
  }

  // Add timeout to prevent hanging on slow Kalshi responses
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const options = { method, headers, signal: controller.signal };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${KALSHI_API_BASE}${endpoint}`, options);
    clearTimeout(timeoutId);

    if (response.status === 429) {
      // Rate limited wait and retry once
      clearTimeout(timeoutId);
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      console.warn(` Kalshi 429 rate limited on ${endpoint}, retrying in ${retryAfter}s`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      await kalshiRateLimiter.wait();
      return kalshiRequest(method, endpoint, body, userConfig);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
    }

    return response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Kalshi API timeout after 10s: ${endpoint}`);
    }
    throw err;
  }
}

// Allow setting default config (called from index.js during init)
kalshiRequest._defaultConfig = null;
function setDefaultConfig(config) {
  kalshiRequest._defaultConfig = config;
}

export {
  KALSHI_API_BASE,
  kalshiRequest,
  signRequestWithConfig,
  setDefaultConfig
};
