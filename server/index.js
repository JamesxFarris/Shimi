import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.use(cors());
app.use(express.json());

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// ============================================
// CONFIGURATION
// ============================================

let config = {
  apiKeyId: null,
  privateKey: null,
  isAuthenticated: false,
  bankroll: 1000, // cents ($10.00)
  maxBetPercent: 15,
  minBetAmount: 100, // $1 fixed bets
  fixedBetAmount: 100, // Always bet $1
  minEdge: 5, // 5% minimum - model has uncertainty, need buffer
  autoBetEnabled: false
};

let betHistory = [];
let portfolio = { balance: 0, positions: [] };

// ============================================
// AUTO-LOAD CREDENTIALS FROM ENVIRONMENT
// ============================================
// Set these in Render dashboard under Environment Variables:
//   KALSHI_API_KEY_ID = your API key ID
//   KALSHI_PRIVATE_KEY = your private key (replace newlines with \n)
//
// For the private key, you can either:
//   1. Replace actual newlines with literal \n characters
//   2. Or base64 encode it and set KALSHI_PRIVATE_KEY_BASE64 instead

async function loadCredentialsFromEnv() {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  let privateKey = process.env.KALSHI_PRIVATE_KEY;

  // Support base64-encoded private key (easier to paste in Render)
  if (!privateKey && process.env.KALSHI_PRIVATE_KEY_BASE64) {
    try {
      privateKey = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    } catch (e) {
      console.error('Failed to decode KALSHI_PRIVATE_KEY_BASE64:', e.message);
    }
  }

  // Handle escaped newlines (common when pasting in env var UIs)
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (apiKeyId && privateKey) {
    console.log('🔑 Found Kalshi credentials in environment variables');
    config.apiKeyId = apiKeyId.trim();
    config.privateKey = privateKey.trim();
    config.isAuthenticated = true;

    // Verify credentials by fetching balance
    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;
      console.log(`✅ Kalshi authenticated! Balance: $${(portfolio.balance / 100).toFixed(2)}`);
    } catch (error) {
      console.error('❌ Kalshi credentials invalid:', error.message);
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;
    }
  } else {
    console.log('ℹ️ No Kalshi credentials in environment. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_BASE64) in Render dashboard.');
  }
}

// Track markets we've already bet on to avoid duplicate bets
// Key: ticker, Value: { timestamp, side }
const recentBets = new Map();

// Edge requirements - lower for "obvious" high-probability bets
// Strategy: Safe growth from $10 → $100 by taking high-probability bets
const AUTO_BET_MIN_EDGE = 3;      // 3% edge for auto (lower for safe bets)
const MANUAL_BET_MIN_EDGE = 2;    // 2% edge for manual
const OBVIOUS_BET_MIN_EDGE = 1;   // 1% edge OK if probability is >90% (free money)

// ============================================
// NEWS & SENTIMENT MONITORING CONFIGURATION
// ============================================

const NEWS_CONFIG = {
  checkIntervalMs: 60000,   // Check RSS feeds every 60 seconds
  urgencyThreshold: 10,     // Score needed to trigger alert
  newsBoostMultiplier: 1.5, // How much to boost bets with aligned news
  enableAutoTrade: true,    // Auto-trade on high-confidence news
  maxNewsAge: 15 * 60 * 1000 // Only consider news from last 15 min
};

// RSS Feed URLs (all free, no API keys needed)
const RSS_FEEDS = {
  coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  cointelegraph: 'https://cointelegraph.com/rss',
  cnbc_markets: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
  marketwatch: 'https://feeds.marketwatch.com/marketwatch/topstories/'
};

// Market-moving keywords for urgency detection
const URGENT_KEYWORDS = {
  crypto: {
    bullish: [
      'etf approved', 'sec approval', 'sec approves', 'institutional adoption',
      'partnership announced', 'upgrade complete', 'halving', 'bullish',
      'all-time high', 'ath', 'mass adoption', 'major investment',
      'blackrock', 'fidelity', 'spot etf', 'regulatory clarity'
    ],
    bearish: [
      'hack', 'hacked', 'exploit', 'exploited', 'sec lawsuit', 'sec sues',
      'ban', 'banned', 'exchange collapse', 'rug pull', 'vulnerability',
      'security breach', 'stolen', 'fraud', 'ponzi', 'investigation',
      'regulatory crackdown', 'delisting', 'insolvency', 'bankruptcy'
    ]
  },
  index: {
    bullish: [
      'rate cut', 'fed cuts', 'better than expected', 'beat estimates',
      'beats expectations', 'strong jobs', 'employment surge', 'gdp growth',
      'inflation falls', 'inflation drops', 'dovish', 'stimulus',
      'economic recovery', 'consumer confidence'
    ],
    bearish: [
      'rate hike', 'fed hikes', 'recession', 'missed estimates',
      'misses expectations', 'layoffs', 'bank failure', 'banking crisis',
      'inflation rises', 'inflation surges', 'hawkish', 'default',
      'debt ceiling', 'unemployment rises', 'economic downturn'
    ]
  }
};

// News storage
let newsCache = [];
let seenArticles = new Set(); // Track seen articles by URL
let recentAlerts = []; // Recent urgent news alerts
let redditSentiment = { data: null, lastFetch: 0, ttl: 5 * 60 * 1000 }; // 5 min cache

// ============================================
// RSS FEED PARSING & NEWS FETCHING
// ============================================

async function fetchRssFeed(url, source) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`RSS fetch failed for ${source}: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const result = await parseStringPromise(xml, { explicitArray: false });

    // Handle different RSS formats
    let items = [];
    if (result.rss && result.rss.channel && result.rss.channel.item) {
      items = Array.isArray(result.rss.channel.item)
        ? result.rss.channel.item
        : [result.rss.channel.item];
    } else if (result.feed && result.feed.entry) {
      // Atom format
      items = Array.isArray(result.feed.entry)
        ? result.feed.entry
        : [result.feed.entry];
    }

    return items.map(item => ({
      source,
      title: item.title || item.title?._ || '',
      link: item.link?.href || item.link || '',
      pubDate: new Date(item.pubDate || item.published || item.updated || Date.now()),
      description: item.description || item.summary || '',
      raw: item
    })).filter(item => item.title && item.link);

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`RSS timeout for ${source}`);
    } else {
      console.log(`RSS error for ${source}: ${error.message}`);
    }
    return [];
  }
}

async function fetchAllNews() {
  const now = Date.now();
  const allArticles = [];

  // Fetch from all RSS feeds in parallel
  const feedPromises = Object.entries(RSS_FEEDS).map(async ([source, url]) => {
    const articles = await fetchRssFeed(url, source);
    return articles;
  });

  const results = await Promise.all(feedPromises);
  results.forEach(articles => allArticles.push(...articles));

  // Process and dedupe articles
  const newArticles = [];
  for (const article of allArticles) {
    // Skip if we've seen this article
    if (seenArticles.has(article.link)) continue;

    // Skip if article is too old
    const articleAge = now - article.pubDate.getTime();
    if (articleAge > 24 * 60 * 60 * 1000) continue; // Skip articles > 24h old

    // Score the article for urgency
    const urgency = scoreNewsUrgency(article.title, article.description);
    article.urgency = urgency;

    // Mark as seen
    seenArticles.add(article.link);
    newArticles.push(article);

    // Check if this is urgent news
    if (urgency.isUrgent) {
      handleUrgentNews(article);
    }
  }

  // Add new articles to cache (most recent first)
  newsCache = [...newArticles, ...newsCache]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, 100); // Keep last 100 articles

  // Clean up old seen articles (keep last 500)
  if (seenArticles.size > 500) {
    const articlesToKeep = [...seenArticles].slice(-500);
    seenArticles = new Set(articlesToKeep);
  }

  console.log(`📰 News update: ${newArticles.length} new articles | Cache: ${newsCache.length}`);
  return newArticles;
}

// Score news for urgency and direction
function scoreNewsUrgency(headline, body = '') {
  const text = (headline + ' ' + body).toLowerCase();
  let score = 0;
  let direction = 'neutral';
  let matchedKeywords = [];
  let assetType = null;

  // Check crypto keywords
  for (const keyword of URGENT_KEYWORDS.crypto.bullish) {
    if (text.includes(keyword)) {
      score += 10;
      direction = 'bullish';
      matchedKeywords.push(keyword);
      assetType = 'crypto';
    }
  }
  for (const keyword of URGENT_KEYWORDS.crypto.bearish) {
    if (text.includes(keyword)) {
      score += 10;
      direction = direction === 'bullish' ? 'mixed' : 'bearish';
      matchedKeywords.push(keyword);
      assetType = 'crypto';
    }
  }

  // Check index keywords
  for (const keyword of URGENT_KEYWORDS.index.bullish) {
    if (text.includes(keyword)) {
      score += 8;
      direction = direction === 'bearish' ? 'mixed' : 'bullish';
      matchedKeywords.push(keyword);
      assetType = assetType || 'index';
    }
  }
  for (const keyword of URGENT_KEYWORDS.index.bearish) {
    if (text.includes(keyword)) {
      score += 8;
      direction = direction === 'bullish' ? 'mixed' : 'bearish';
      matchedKeywords.push(keyword);
      assetType = assetType || 'index';
    }
  }

  // Detect which tokens are mentioned
  const mentionedTokens = [];
  for (const token of Object.keys(TRACKED_TOKENS)) {
    if (text.includes(token.toLowerCase()) ||
        text.includes(TRACKED_TOKENS[token].name.toLowerCase())) {
      mentionedTokens.push(token);
    }
  }

  // S&P 500 mentions
  if (text.includes('s&p') || text.includes('sp500') || text.includes('s&p 500') ||
      text.includes('stock market') || text.includes('wall street')) {
    assetType = 'index';
    mentionedTokens.push('SPX');
  }

  return {
    score,
    direction,
    isUrgent: score >= NEWS_CONFIG.urgencyThreshold,
    matchedKeywords,
    mentionedTokens,
    assetType
  };
}

// Handle urgent news - log alert and potentially trigger auto-bet
async function handleUrgentNews(article) {
  const alert = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    headline: article.title,
    source: article.source,
    link: article.link,
    direction: article.urgency.direction,
    score: article.urgency.score,
    keywords: article.urgency.matchedKeywords,
    tokens: article.urgency.mentionedTokens,
    assetType: article.urgency.assetType,
    acted: false
  };

  console.log(`\n🚨 URGENT NEWS ALERT 🚨`);
  console.log(`   ${article.title}`);
  console.log(`   Direction: ${alert.direction.toUpperCase()} | Score: ${alert.score}`);
  console.log(`   Keywords: ${alert.keywords.join(', ')}`);
  console.log(`   Tokens: ${alert.tokens.join(', ') || 'General market'}`);

  // Add to recent alerts
  recentAlerts.unshift(alert);
  recentAlerts = recentAlerts.slice(0, 20); // Keep last 20 alerts

  // If auto-trade is enabled and news is actionable, boost next bet
  if (NEWS_CONFIG.enableAutoTrade && alert.direction !== 'mixed' && alert.direction !== 'neutral') {
    // The news boost will be applied in the analysis functions
    console.log(`   ✅ News boost will be applied to matching markets`);
  }

  return alert;
}

// Get recent news for API
function getRecentNews(limit = 20, maxAgeMs = NEWS_CONFIG.maxNewsAge) {
  const now = Date.now();
  return newsCache
    .filter(article => now - article.pubDate.getTime() < maxAgeMs)
    .slice(0, limit);
}

// ============================================
// REDDIT SENTIMENT (ApeWisdom API)
// ============================================

async function getRedditSentiment() {
  const now = Date.now();

  // Return cached data if still valid
  if (redditSentiment.data && (now - redditSentiment.lastFetch) < redditSentiment.ttl) {
    return redditSentiment.data;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://apewisdom.io/api/v1.0/filter/all-crypto/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`ApeWisdom API error: ${res.status}`);
      return redditSentiment.data || [];
    }

    const data = await res.json();

    // Transform results
    const results = (data.results || []).slice(0, 30).map(item => ({
      ticker: item.ticker?.toUpperCase() || '',
      name: item.name || item.ticker || '',
      mentions: item.mentions || 0,
      upvotes: item.upvotes || 0,
      rank: item.rank || 0,
      mentionsChange24h: item.mentions_24h_ago ? item.mentions - item.mentions_24h_ago : 0
    }));

    redditSentiment.data = results;
    redditSentiment.lastFetch = now;

    console.log(`📊 Reddit sentiment updated: ${results.length} trending tickers`);
    return results;

  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('ApeWisdom timeout');
    } else {
      console.log(`ApeWisdom error: ${error.message}`);
    }
    return redditSentiment.data || [];
  }
}

// Calculate overall market sentiment from news and reddit
function calculateOverallSentiment(news, reddit) {
  let bullishSignals = 0;
  let bearishSignals = 0;

  // Count news sentiment
  for (const article of news) {
    if (article.urgency?.direction === 'bullish') bullishSignals++;
    if (article.urgency?.direction === 'bearish') bearishSignals++;
  }

  // Reddit momentum (high mentions + positive change = bullish)
  const topReddit = reddit.slice(0, 10);
  const avgMentionChange = topReddit.reduce((sum, t) => sum + (t.mentionsChange24h || 0), 0) / topReddit.length;
  if (avgMentionChange > 50) bullishSignals += 2;
  if (avgMentionChange < -50) bearishSignals += 2;

  // Calculate overall sentiment (-100 to +100)
  const total = bullishSignals + bearishSignals;
  if (total === 0) return { score: 0, label: 'Neutral', description: 'No strong signals' };

  const score = Math.round(((bullishSignals - bearishSignals) / total) * 100);

  let label, description;
  if (score > 50) {
    label = 'Very Bullish';
    description = 'Strong positive sentiment across news and social';
  } else if (score > 20) {
    label = 'Bullish';
    description = 'Moderately positive market sentiment';
  } else if (score > -20) {
    label = 'Neutral';
    description = 'Mixed or no strong signals';
  } else if (score > -50) {
    label = 'Bearish';
    description = 'Moderately negative market sentiment';
  } else {
    label = 'Very Bearish';
    description = 'Strong negative sentiment - caution advised';
  }

  return { score, label, description, bullishSignals, bearishSignals };
}

// Get news boost for a specific token/asset
function getNewsBoost(assetType, token) {
  const now = Date.now();
  const recentNews = newsCache.filter(a =>
    now - a.pubDate.getTime() < NEWS_CONFIG.maxNewsAge &&
    a.urgency?.isUrgent
  );

  let boost = 0;
  let direction = null;

  for (const article of recentNews) {
    // Check if this news is relevant to the asset
    const isRelevant = article.urgency.mentionedTokens.includes(token) ||
      (assetType === 'crypto' && article.urgency.assetType === 'crypto') ||
      (assetType === 'index' && article.urgency.assetType === 'index');

    if (isRelevant && article.urgency.direction !== 'mixed' && article.urgency.direction !== 'neutral') {
      const newsAge = now - article.pubDate.getTime();
      const ageFactor = 1 - (newsAge / NEWS_CONFIG.maxNewsAge); // Newer = stronger
      const newsBoost = (article.urgency.score / 10) * ageFactor * NEWS_CONFIG.newsBoostMultiplier;

      if (direction === null || direction === article.urgency.direction) {
        direction = article.urgency.direction;
        boost += newsBoost;
      } else {
        // Conflicting news - reduce boost
        boost *= 0.5;
      }
    }
  }

  return { boost: Math.min(boost, 15), direction }; // Cap at 15% boost
}

// Start news monitoring (every 60 seconds)
let newsInterval = setInterval(fetchAllNews, NEWS_CONFIG.checkIntervalMs);
fetchAllNews(); // Initial fetch

// ============================================
// CRYPTO PRICE TRACKING - EXPANDED TOKENS
// ============================================

// All tokens we track - with price ranges for strike detection
const TRACKED_TOKENS = {
  BTC: { name: 'Bitcoin', minPrice: 10000, maxPrice: 500000 },
  ETH: { name: 'Ethereum', minPrice: 100, maxPrice: 20000 },
  SOL: { name: 'Solana', minPrice: 1, maxPrice: 1000 },
  XRP: { name: 'XRP', minPrice: 0.1, maxPrice: 100 },
  DOGE: { name: 'Dogecoin', minPrice: 0.01, maxPrice: 10 },
  ADA: { name: 'Cardano', minPrice: 0.1, maxPrice: 50 },
  AVAX: { name: 'Avalanche', minPrice: 1, maxPrice: 500 },
  LINK: { name: 'Chainlink', minPrice: 1, maxPrice: 200 },
  MATIC: { name: 'Polygon', minPrice: 0.1, maxPrice: 50 },
  DOT: { name: 'Polkadot', minPrice: 1, maxPrice: 200 },
  SHIB: { name: 'Shiba Inu', minPrice: 0.000001, maxPrice: 0.001 },
  LTC: { name: 'Litecoin', minPrice: 10, maxPrice: 1000 },
  UNI: { name: 'Uniswap', minPrice: 1, maxPrice: 100 },
  ATOM: { name: 'Cosmos', minPrice: 1, maxPrice: 100 },
  APT: { name: 'Aptos', minPrice: 1, maxPrice: 100 }
};

// Price data storage
const cryptoPrices = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  cryptoPrices[token] = { price: 0, timestamp: 0, history: [], volatility: 0.02 };
});

// CoinGecko ID mapping
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin',
  ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink', MATIC: 'matic-network',
  DOT: 'polkadot', SHIB: 'shiba-inu', LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos', APT: 'aptos'
};

// Fetch all prices from CoinGecko (works globally, no restrictions)
async function fetchCryptoPrices() {
  try {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const data = await res.json();

    if (data.error) {
      console.error('CoinGecko error:', data.error);
      return null;
    }

    const now = Date.now();

    // Update each tracked token
    for (const [token, geckoId] of Object.entries(COINGECKO_IDS)) {
      const priceData = data[geckoId];
      if (priceData && priceData.usd > 0) {
        const price = priceData.usd;
        cryptoPrices[token].price = price;
        cryptoPrices[token].timestamp = now;

        // Keep 60 price points for volatility calculation
        cryptoPrices[token].history.push({ price, time: now });
        if (cryptoPrices[token].history.length > 60) {
          cryptoPrices[token].history.shift();
        }

        // Keep extended history for statistical analysis (2 hours)
        if (!priceHistoryExtended[token]) priceHistoryExtended[token] = [];
        priceHistoryExtended[token].push({ price, time: now });
        // Keep last 2 hours (720 points at 10-second intervals)
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        priceHistoryExtended[token] = priceHistoryExtended[token].filter(p => p.time > twoHoursAgo);

        // Calculate volatility
        cryptoPrices[token].volatility = calculateVolatility(cryptoPrices[token].history, token);
      }
    }

    return cryptoPrices;
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return null;
  }
}

// ============================================
// STATISTICAL ANALYSIS ENGINE
// ============================================

// Store extended price history for analysis (last 2 hours)
const priceHistoryExtended = {};
Object.keys(TRACKED_TOKENS).forEach(token => {
  priceHistoryExtended[token] = [];
});

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

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = sumY / n;

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

// ============================================
// TIME-OF-DAY FACTORS (S&P 500)
// ============================================

// S&P 500 has documented intraday patterns
function getTimeOfDayFactor() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // Market hours: 9:30 AM - 4:00 PM ET (14:30 - 21:00 UTC)
  const marketOpen = 14.5; // 14:30 UTC
  const marketClose = 21;  // 21:00 UTC
  const currentTime = hour + minute / 60;

  // Check if market is open
  const isMarketOpen = currentTime >= marketOpen && currentTime < marketClose;
  if (!isMarketOpen) {
    return { factor: 1.0, period: 'closed', description: 'Market closed' };
  }

  const hoursUntilClose = marketClose - currentTime;
  const hoursFromOpen = currentTime - marketOpen;

  // Opening 30 minutes: High volatility, mean-reverting
  if (hoursFromOpen < 0.5) {
    return {
      factor: 1.3,
      period: 'opening',
      description: 'Opening volatility - mean reversion common'
    };
  }

  // Last 15 minutes: End-of-day positioning, volatile
  if (hoursUntilClose < 0.25) {
    return {
      factor: 1.5,
      period: 'closing',
      description: 'Final 15min - increased volatility'
    };
  }

  // Power hour (3pm-4pm ET = last hour)
  if (hoursUntilClose < 1) {
    return {
      factor: 1.2,
      period: 'power_hour',
      description: 'Power hour - higher volume/volatility'
    };
  }

  // First hour after open (9:30-10:30 ET)
  if (hoursFromOpen < 1) {
    return {
      factor: 1.15,
      period: 'early',
      description: 'Early trading - settling volatility'
    };
  }

  // Midday stability (10am-2pm ET)
  if (hoursUntilClose > 2.5 && hoursFromOpen > 1) {
    return {
      factor: 1.0,
      period: 'midday',
      description: 'Midday stability - lower volatility'
    };
  }

  return { factor: 1.0, period: 'normal', description: 'Normal trading' };
}

// Analyze historical price crossings
// Given current price and a target, how often does price cross that target in X minutes?
function analyzeHistoricalCrossings(history, currentPrice, targetPrice, windowMinutes = 15) {
  if (history.length < 30) {
    return { crossingProb: 0.5, sampleSize: 0, reliable: false };
  }

  const windowMs = windowMinutes * 60 * 1000;
  let crossings = 0;
  let totalWindows = 0;

  // Look at historical windows
  for (let i = 0; i < history.length - 10; i++) {
    const startPrice = history[i].price;
    const startTime = history[i].time;

    // Find prices within the window
    const windowPrices = history.filter(p =>
      p.time > startTime && p.time <= startTime + windowMs
    );

    if (windowPrices.length < 3) continue;
    totalWindows++;

    // Did price cross the equivalent target?
    // Scale target relative to start price
    const relativeTarget = targetPrice / currentPrice;
    const scaledTarget = startPrice * relativeTarget;

    const didCross = windowPrices.some(p => {
      if (currentPrice > targetPrice) {
        // Currently above target - did it drop below?
        return p.price < scaledTarget;
      } else {
        // Currently below target - did it rise above?
        return p.price > scaledTarget;
      }
    });

    if (didCross) crossings++;
  }

  const crossingProb = totalWindows > 0 ? crossings / totalWindows : 0.5;

  return {
    crossingProb,
    sampleSize: totalWindows,
    reliable: totalWindows >= 10
  };
}

// Main statistical prediction function
// Returns probability that price will be above/below target at expiry
function predictOutcome(token, currentPrice, targetPrice, expiryMinutes = 15) {
  const history = cryptoPrices[token]?.history || [];
  const extHistory = priceHistoryExtended[token] || [];

  // Combine histories for analysis
  const allHistory = [...extHistory, ...history].sort((a, b) => a.time - b.time);

  // 1. Calculate volatility-based probability (baseline)
  const volatility = cryptoPrices[token]?.volatility || 0.025;

  // KEY INSIGHT: Scale volatility by time remaining
  // Less time = less chance for price to move = current position more likely to hold
  // sqrt(time) scaling because volatility scales with sqrt of time
  const timeScaleFactor = Math.sqrt(expiryMinutes / 15);  // 1.0 at 15min, 0.58 at 5min, 0.41 at 2.5min
  const adjustedVolatility = volatility * timeScaleFactor;

  const pctFromTarget = (currentPrice - targetPrice) / targetPrice;
  // How many "adjusted standard deviations" away is the current price?
  const zScore = pctFromTarget / adjustedVolatility;

  // Base probability from normal distribution
  // Higher z-score = more likely to stay on current side
  let probAbove = normalCDF(zScore);
  let probBelow = 1 - probAbove;

  // 2. TIME DECAY BOOST
  // If price has moved significantly AND little time remains, boost confidence
  // E.g., price 2% above strike with only 3 minutes left = very likely to stay above
  const timeRemainingRatio = expiryMinutes / 15;  // 1.0 at start, 0.2 at 3min left
  const priceDistanceRatio = Math.abs(pctFromTarget) / adjustedVolatility;

  if (priceDistanceRatio > 0.5 && timeRemainingRatio < 0.5) {
    // Price has moved AND time is running out
    // Boost the probability of staying on current side
    const timeDecayBoost = (1 - timeRemainingRatio) * 0.15;  // Up to +15% at expiry

    if (currentPrice > targetPrice) {
      probAbove = Math.min(0.95, probAbove + timeDecayBoost);
      probBelow = 1 - probAbove;
    } else {
      probBelow = Math.min(0.95, probBelow + timeDecayBoost);
      probAbove = 1 - probBelow;
    }
  }

  // 3. Adjust for momentum
  const momentum = calculateMomentum(allHistory, 5);

  // Momentum adjustment: if trending in a direction, boost that side
  let momentumAdjustment = 0;
  if (momentum.strength === 'strong') {
    momentumAdjustment = momentum.trend > 0 ? 0.10 : -0.10;  // ±10%
  } else if (momentum.strength === 'moderate') {
    momentumAdjustment = momentum.trend > 0 ? 0.05 : -0.05;  // ±5%
  }

  probAbove = Math.max(0.05, Math.min(0.95, probAbove + momentumAdjustment));
  probBelow = 1 - probAbove;

  // 4. Check historical crossing data
  const crossingAnalysis = analyzeHistoricalCrossings(allHistory, currentPrice, targetPrice, expiryMinutes);

  if (crossingAnalysis.reliable) {
    // Blend with historical data (weight: 30% historical, 70% model)
    const historicalProbCross = crossingAnalysis.crossingProb;

    if (currentPrice > targetPrice) {
      const blendedProbBelow = 0.3 * historicalProbCross + 0.7 * probBelow;
      probBelow = blendedProbBelow;
      probAbove = 1 - probBelow;
    } else {
      const blendedProbAbove = 0.3 * historicalProbCross + 0.7 * probAbove;
      probAbove = blendedProbAbove;
      probBelow = 1 - probAbove;
    }
  }

  // 5. Calculate confidence based on data quality AND time remaining
  // More confident when: more data, strong momentum, less time remaining
  const timeConfidenceBoost = (1 - timeRemainingRatio) * 0.2;  // Up to +20% confidence near expiry
  const confidence = Math.min(0.95,
    0.4 +  // Base confidence
    (allHistory.length / 200) * 0.2 +  // Data quality
    (momentum.strength === 'strong' ? 0.15 : momentum.strength === 'moderate' ? 0.08 : 0) +
    timeConfidenceBoost
  );

  return {
    probAbove,
    probBelow,
    momentum,
    volatility,
    adjustedVolatility,
    zScore,
    confidence,
    timeRemaining: expiryMinutes,
    dataPoints: allHistory.length,
    analysis: {
      method: crossingAnalysis.reliable ? 'historical+model' : 'model',
      momentumDirection: momentum.direction,
      momentumStrength: momentum.strength,
      timeDecayApplied: priceDistanceRatio > 0.5 && timeRemainingRatio < 0.5
    }
  };
}

// Calculate probability using log-normal distribution
function calculateProbability(currentPrice, targetPrice, volatility) {
  const sigma = volatility;
  const logRatio = Math.log(targetPrice / currentPrice);
  const d = logRatio / sigma;

  // Probability price will be BELOW target
  const probBelow = normalCDF(d);
  const probAbove = 1 - probBelow;

  return { probAbove, probBelow };
}

// Calculate how many standard deviations the current price is from strike
// This helps identify "obvious" mispricings
function calculateZScore(currentPrice, strikePrice, volatility) {
  const pctDiff = (currentPrice - strikePrice) / strikePrice;
  return pctDiff / volatility;  // How many std devs away
}

// Simple probability estimate based on distance from strike
// More robust than complex volatility model for short timeframes
function simpleEdgeCheck(currentPrice, strikePrice, marketPrice, side, volatility) {
  const pctFromStrike = (currentPrice - strikePrice) / strikePrice * 100;
  const zScore = calculateZScore(currentPrice, strikePrice, volatility);

  // For "above/up" markets: YES wins if price ends >= strike
  // If current price is ABOVE strike, YES is more likely
  // If current price is BELOW strike, NO is more likely

  let result = {
    pctFromStrike,
    zScore,
    isObviousBet: false,
    obviousSide: null,
    obviousEdge: 0
  };

  // "Obvious" bet: price is far from strike (2+ std devs)
  // These are potential "free money" situations
  if (Math.abs(zScore) >= 1.5) {
    if (zScore > 0) {
      // Price is well ABOVE strike - YES (above) is very likely
      // If YES is cheap (< 85¢), there's edge
      result.isObviousBet = true;
      result.obviousSide = 'YES';
      // Estimate: if 1.5+ std devs above, ~93% chance it stays above
      const estimatedProb = normalCDF(zScore);  // Prob of staying above
      result.obviousEdge = (estimatedProb - marketPrice) * 100;
    } else {
      // Price is well BELOW strike - NO (below) is very likely
      // If NO is cheap (< 85¢), there's edge
      result.isObviousBet = true;
      result.obviousSide = 'NO';
      const estimatedProb = normalCDF(-zScore);  // Prob of staying below
      result.obviousEdge = (estimatedProb - (1 - marketPrice)) * 100;
    }
  }

  return result;
}

// Standard normal CDF
function normalCDF(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  return 0.5 * (1.0 + sign * y);
}

// Start price tracking (every 10 seconds)
let priceInterval = setInterval(fetchCryptoPrices, 10000);
fetchCryptoPrices();

// ============================================
// S&P 500 INDEX PRICE TRACKING
// ============================================

const indexPrices = {
  SPX: { price: 0, timestamp: 0, history: [], volatility: 0.01 }
};

// Extended history for S&P 500
const indexHistoryExtended = { SPX: [] };

async function fetchIndexPrice() {
  try {
    // Yahoo Finance API (free, no key needed)
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();

    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const price = result.meta.regularMarketPrice;
      const now = Date.now();

      if (price && price > 0) {
        indexPrices.SPX.price = price;
        indexPrices.SPX.timestamp = now;

        // Keep 60 price points for volatility calculation
        indexPrices.SPX.history.push({ price, time: now });
        if (indexPrices.SPX.history.length > 60) {
          indexPrices.SPX.history.shift();
        }

        // Extended history (2 hours)
        indexHistoryExtended.SPX.push({ price, time: now });
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        indexHistoryExtended.SPX = indexHistoryExtended.SPX.filter(p => p.time > twoHoursAgo);

        // Calculate volatility (S&P is much less volatile than crypto)
        indexPrices.SPX.volatility = calculateIndexVolatility(indexPrices.SPX.history);

        console.log(`📈 S&P 500: $${price.toFixed(2)} | Vol: ${(indexPrices.SPX.volatility * 100).toFixed(2)}%`);
      }
    }
  } catch (error) {
    console.error('Error fetching S&P 500 price:', error.message);
  }
}

function calculateIndexVolatility(history) {
  // Default S&P 500 15-minute volatility (much lower than crypto)
  if (history.length < 10) return 0.005; // 0.5% default

  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const logReturn = Math.log(history[i].price / history[i-1].price);
    returns.push(logReturn);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Scale to 15-minute equivalent
  const avgInterval = (history[history.length - 1].time - history[0].time) / (history.length - 1);
  const intervalsIn15Min = (15 * 60 * 1000) / avgInterval;
  const vol15min = stdDev * Math.sqrt(intervalsIn15Min);

  // Clamp to reasonable range for S&P (0.1% to 3%)
  return Math.max(0.001, Math.min(0.03, vol15min));
}

// Start S&P 500 price tracking (every 15 seconds - don't spam Yahoo)
let indexPriceInterval = setInterval(fetchIndexPrice, 15000);
fetchIndexPrice();

// ============================================
// RISK MANAGEMENT
// ============================================

const MAX_TOTAL_RISK_CENTS = 500; // $5.00 max TOTAL at risk across ALL positions

function getCurrentRiskFromPortfolio() {
  // Sum up the cost of all active (unsettled) positions
  let totalRisk = 0;
  if (portfolio.positions && Array.isArray(portfolio.positions)) {
    for (const pos of portfolio.positions) {
      // Each position's risk is contracts * price paid
      const contracts = Math.abs(pos.position || 0);
      const avgPrice = pos.average_price || 50; // cents
      totalRisk += contracts * avgPrice;
    }
  }
  return totalRisk;
}

function canPlaceBet(betCostCents) {
  const currentRisk = getCurrentRiskFromPortfolio();
  return (currentRisk + betCostCents) <= MAX_TOTAL_RISK_CENTS;
}

function getRemainingRiskBudget() {
  const currentRisk = getCurrentRiskFromPortfolio();
  return Math.max(0, MAX_TOTAL_RISK_CENTS - currentRisk);
}

// ============================================
// KALSHI API
// ============================================

function signRequest(method, path, timestamp) {
  if (!config.privateKey) throw new Error('Private key not configured');

  try {
    const pathWithoutQuery = path.split('?')[0];
    const message = `${timestamp}${method}${pathWithoutQuery}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    return sign.sign({
      key: config.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, 'base64');
  } catch (err) {
    throw new Error('Failed to sign request: ' + err.message);
  }
}

async function kalshiRequest(method, endpoint, body = null) {
  const timestamp = Date.now().toString();
  const path = `/trade-api/v2${endpoint}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Shimi/1.0'
  };

  if (config.isAuthenticated && config.apiKeyId && config.privateKey) {
    const signature = signRequest(method, path, timestamp);
    headers['KALSHI-ACCESS-KEY'] = config.apiKeyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signature;
  }

  const options = { method, headers };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${KALSHI_API_BASE}${endpoint}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ============================================
// MARKET ANALYSIS
// ============================================

let marketCache = { data: null, lastFetch: 0, ttl: 15000 };

async function fetchCryptoMarkets() {
  const now = Date.now();

  if (marketCache.data && (now - marketCache.lastFetch) < marketCache.ttl) {
    return marketCache.data;
  }

  try {
    // Fetch crypto markets directly by series ticker instead of filtering 1000+ markets
    // This ensures we get the 15-minute crypto markets that would otherwise be buried
    const cryptoSeries = [
      // 15-minute markets (short term, high frequency)
      'KXBTC15M',   // Bitcoin 15-minute up/down
      'KXETH15M',   // Ethereum 15-minute up/down
      'KXSOL15M',   // Solana 15-minute up/down

      // Daily above/below markets
      'KXBTCD',     // Bitcoin above/below
      'KXETHD',     // Ethereum above/below
      'KXSOLD',     // Solana above/below
      'KXXRPD',     // XRP above/below
      'KXDOGED',    // Doge above/below
      'KXLTCD',     // Litecoin above/below
      'KXLINKD',    // Chainlink above/below
      'KXAVAXD',    // Avalanche above/below
      'KXDOTD',     // Polkadot above/below
      'KXSHIBAD',   // Shiba above/below

      // Range/min/max markets (look for mispricings)
      'KXBTCMAXD',  // BTC max daily
      'KXBTC',      // Bitcoin range
      'KXETH',      // Ethereum range
      'KXSOL',      // Solana range
      'KXXRP',      // XRP range

      // Monthly directional
      'KXBTCMAXM',  // BTC max monthly
      'KXETHMAXM',  // ETH max monthly
      'KXSOLMAXM',  // SOL max monthly
    ];

    const allMarkets = [];

    // Fetch each crypto series in parallel
    const fetches = cryptoSeries.map(async (series) => {
      try {
        const data = await kalshiRequest('GET', `/markets?limit=100&status=open&series_ticker=${series}`);
        return data.markets || [];
      } catch (e) {
        console.log(`No markets for ${series}`);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    results.forEach(markets => allMarkets.push(...markets));

    // Also try the general crypto filter as backup
    try {
      const data = await kalshiRequest('GET', '/markets?limit=1000&status=open');
      const markets = data.markets || [];

      markets.forEach(m => {
        const ticker = (m.ticker || '').toUpperCase();
        const title = (m.title || '').toUpperCase();

        // Check if already added
        if (allMarkets.some(existing => existing.ticker === m.ticker)) return;

        // Check if it's a crypto market
        let isCrypto = false;
        for (const [token, cfg] of Object.entries(TRACKED_TOKENS)) {
          if (ticker.includes(token) || title.includes(token) || title.includes(cfg.name.toUpperCase())) {
            isCrypto = true;
            break;
          }
        }

        if (isCrypto) allMarkets.push(m);
      });
    } catch (e) {
      console.log('Backup market fetch failed:', e.message);
    }

    // Filter for short-term markets (within 4 hours, more than 30 seconds remaining)
    const cryptoMarkets = allMarkets.filter(m => {
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      const isShortTerm = timeRemaining && timeRemaining > 30000 && timeRemaining < 4 * 60 * 60 * 1000;
      return isShortTerm;
    });

    console.log(`📊 Fetched ${allMarkets.length} crypto markets, ${cryptoMarkets.length} short-term`);

    marketCache.data = cryptoMarkets;
    marketCache.lastFetch = now;

    return cryptoMarkets;
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
}

// ============================================
// S&P 500 INDEX MARKET FETCHING
// ============================================

const indexMarketCache = { data: null, lastFetch: 0, ttl: 30000 };

async function fetchIndexMarkets() {
  const now = Date.now();

  if (indexMarketCache.data && (now - indexMarketCache.lastFetch) < indexMarketCache.ttl) {
    return indexMarketCache.data;
  }

  try {
    // S&P 500 market series on Kalshi
    const indexSeries = [
      'KXINX',      // S&P 500 daily range
      'KXINXU',     // S&P 500 above/below
      'KXINXD',     // S&P 500 daily direction
    ];

    const allMarkets = [];

    // Fetch each index series in parallel
    const fetches = indexSeries.map(async (series) => {
      try {
        const data = await kalshiRequest('GET', `/markets?limit=100&status=open&series_ticker=${series}`);
        return data.markets || [];
      } catch (e) {
        console.log(`No markets for ${series}`);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    results.forEach(markets => allMarkets.push(...markets));

    // Filter for markets closing within reasonable time (today)
    const indexMarkets = allMarkets.filter(m => {
      const closeTime = m.close_time ? new Date(m.close_time).getTime() : null;
      const timeRemaining = closeTime ? closeTime - now : null;
      // S&P markets settle at end of day, so allow up to 8 hours
      const isValidTime = timeRemaining && timeRemaining > 60000 && timeRemaining < 8 * 60 * 60 * 1000;
      return isValidTime;
    });

    console.log(`📊 Fetched ${allMarkets.length} index markets, ${indexMarkets.length} valid`);

    indexMarketCache.data = indexMarkets;
    indexMarketCache.lastFetch = now;

    return indexMarkets;
  } catch (error) {
    console.error('Error fetching index markets:', error.message);
    return [];
  }
}

// Parse S&P 500 market data
function parseIndexMarket(market) {
  const ticker = (market.ticker || '').toUpperCase();
  const title = (market.title || '').toLowerCase();

  // Extract strike price from title
  // Example titles: "S&P 500 above 6,000?", "S&P 500 to close between 5,950 and 6,000?"
  let strikePrice = null;
  const priceMatches = title.match(/[\d,]+(?:\.\d+)?/g);
  if (priceMatches) {
    for (const match of priceMatches) {
      const price = parseFloat(match.replace(/,/g, ''));
      // S&P 500 range: 3000-8000
      if (price >= 3000 && price <= 8000) {
        strikePrice = price;
        break;
      }
    }
  }

  // Determine market type
  let marketType = null;
  if (title.includes('above') || title.includes('higher') || title.includes('or more') || title.includes('at least')) {
    marketType = 'above';
  } else if (title.includes('below') || title.includes('lower') || title.includes('or less') || title.includes('under')) {
    marketType = 'below';
  } else if (title.includes('between')) {
    marketType = 'between';
  }

  // Time remaining
  const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
  const timeRemaining = closeTime ? closeTime - Date.now() : null;
  const timeRemainingMinutes = timeRemaining ? timeRemaining / (60 * 1000) : null;

  // Prices (Kalshi returns in cents)
  const yesAsk = (parseFloat(market.yes_ask) || 0) / 100;
  const noAsk = (parseFloat(market.no_ask) || 0) / 100;

  return {
    ticker: market.ticker,
    title: market.title,
    assetType: 'SPX',
    strikePrice,
    marketType,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk,
    noAsk,
    volume: parseInt(market.volume) || 0
  };
}

// Analyze S&P 500 market for betting opportunity
function analyzeIndexMarket(parsed) {
  if (!parsed.strikePrice || !parsed.marketType || parsed.marketType === 'between') {
    return null;
  }

  const priceData = indexPrices.SPX;
  if (!priceData || !priceData.price) {
    return null;
  }

  const currentPrice = priceData.price;
  const volatility = priceData.volatility;
  const timeMinutes = parsed.timeRemainingMinutes || 60;

  // Calculate how far price is from strike
  const pctFromStrike = ((currentPrice - parsed.strikePrice) / parsed.strikePrice) * 100;

  // Get time-of-day factor for S&P 500
  const timeOfDay = getTimeOfDayFactor();

  // Adjust volatility based on time of day
  const adjustedVolatility = volatility * timeOfDay.factor;

  // Simple probability model for S&P 500
  // Use z-score based on volatility
  const timeHours = timeMinutes / 60;
  const expectedMove = currentPrice * adjustedVolatility * Math.sqrt(timeHours / 4); // 4-hour normalized vol
  const zScore = (parsed.strikePrice - currentPrice) / expectedMove;

  // Convert z-score to probability using normal CDF
  const probBelow = normalCDF(zScore);
  const probAbove = 1 - probBelow;

  // Calculate multi-timeframe momentum
  const allHistory = [...(indexHistoryExtended.SPX || []), ...(priceData.history || [])];
  const momentum = calculateMomentumMultiTimeframe(allHistory);

  // Determine win probabilities based on market type
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = probAbove;
    probNoWins = probBelow;
  } else {
    probYesWins = probBelow;
    probNoWins = probAbove;
  }

  // Adjust for momentum
  if (momentum.aligned) {
    const momentumBoost = parseFloat(momentum.strength) / 100 * 0.5; // Up to 5% boost
    if (momentum.direction === 'bullish') {
      probYesWins = Math.min(0.95, probYesWins + momentumBoost);
      probNoWins = Math.max(0.05, probNoWins - momentumBoost);
    } else if (momentum.direction === 'bearish') {
      probNoWins = Math.min(0.95, probNoWins + momentumBoost);
      probYesWins = Math.max(0.05, probYesWins - momentumBoost);
    }
  }

  // Market implied probabilities
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge
  let yesEdge = (probYesWins - marketProbYes) * 100;
  let noEdge = (probNoWins - marketProbNo) * 100;

  // Find best bet (highest win probability with positive edge)
  let bestBet = null;
  const yesValid = parsed.yesAsk > 0 && parsed.yesAsk < 0.98 && yesEdge > 0.5;
  const noValid = parsed.noAsk > 0 && parsed.noAsk < 0.98 && noEdge > 0.5;

  if (yesValid && noValid) {
    if (probYesWins >= probNoWins) {
      bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
    } else {
      bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
    }
  } else if (yesValid) {
    bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
  } else if (noValid) {
    bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
  }

  if (!bestBet) return null;

  const isHighProb = bestBet.prob >= 0.60;
  const isSafeBet = bestBet.prob >= 0.70;

  const priceCents = Math.round(bestBet.price * 100);
  const contractsFor1Dollar = Math.floor(100 / priceCents);
  const totalCostCents = contractsFor1Dollar * priceCents;
  const profitIfWinCents = contractsFor1Dollar * 100 - totalCostCents;

  // Build reason string
  const momentumDesc = momentum.direction === 'bullish' ? '📈' : momentum.direction === 'bearish' ? '📉' : '➡️';

  return {
    ...parsed,
    marketCategory: 'index',
    assetType: 'SPX',
    assetName: 'S&P 500',
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    adjustedVolatility: (adjustedVolatility * 100).toFixed(2) + '%',
    pctFromStrike: pctFromStrike.toFixed(2),
    zScore: zScore.toFixed(2),
    winProbability: (bestBet.prob * 100).toFixed(1),
    edge: bestBet.edge,
    betSide: bestBet.side,
    betPrice: bestBet.price,
    betPriceCents: priceCents,
    contractsFor1Dollar,
    profitIfWin: profitIfWinCents,
    betReason: `${momentumDesc} S&P ${pctFromStrike > 0 ? 'above' : 'below'} by ${Math.abs(pctFromStrike).toFixed(1)}%`,
    isObviousBet: isSafeBet,
    isHighProb,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining),
    // Enhanced data
    momentum: momentum.direction,
    momentumStrength: momentum.aligned ? 'strong' : 'weak',
    momentumData: momentum,
    timeOfDay: timeOfDay,
    confidence: (isSafeBet ? 85 : isHighProb ? 70 : 55) + '%',
    dataPoints: allHistory.length
  };
}

// Parse market to extract token, strike price, and determine both sides
function parseMarket(market) {
  const ticker = (market.ticker || '').toUpperCase();
  const title = (market.title || '').toLowerCase();

  // Find which token this market is for
  let cryptoType = null;
  for (const [token, cfg] of Object.entries(TRACKED_TOKENS)) {
    if (ticker.includes(token) || title.includes(token.toLowerCase()) || title.includes(cfg.name.toLowerCase())) {
      cryptoType = token;
      break;
    }
  }

  // Extract strike price - check floor_strike first (for 15-minute markets), then title
  let strikePrice = null;
  if (market.floor_strike && typeof market.floor_strike === 'number') {
    strikePrice = market.floor_strike;
  } else {
    const priceMatches = title.match(/\$?([\d,]+(?:\.\d+)?)/g);
    if (priceMatches && cryptoType) {
      const cfg = TRACKED_TOKENS[cryptoType];
      for (const match of priceMatches) {
        const price = parseFloat(match.replace(/[$,]/g, ''));
        if (price >= cfg.minPrice && price <= cfg.maxPrice) {
          strikePrice = price;
          break;
        }
      }
    }
  }

  // Determine market type (above/below/between)
  // 15-minute markets use "up" (YES = price goes up = above starting price)
  let marketType = null;
  if (title.includes('above') || title.includes('>=') || title.includes('higher') ||
      title.includes('or more') || title.includes('over') || title.includes(' up')) {
    marketType = 'above'; // YES = price above strike
  } else if (title.includes('below') || title.includes('<=') || title.includes('lower') ||
             title.includes('or less') || title.includes('under') || title.includes(' down')) {
    marketType = 'below'; // YES = price below strike
  } else if (title.includes('between')) {
    marketType = 'between';
  }

  // Time remaining
  const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
  const timeRemaining = closeTime ? closeTime - Date.now() : null;
  const timeRemainingMinutes = timeRemaining ? timeRemaining / (60 * 1000) : null;

  // Kalshi API returns prices in cents (0-100), convert to probability (0-1)
  // e.g., yes_ask: 4 means $0.04 = 4% probability
  const yesAsk = (parseFloat(market.yes_ask) || 0) / 100;
  const noAsk = (parseFloat(market.no_ask) || 0) / 100;
  const yesBid = (parseFloat(market.yes_bid) || 0) / 100;
  const noBid = (parseFloat(market.no_bid) || 0) / 100;

  return {
    ticker: market.ticker,
    title: market.title,
    cryptoType,
    strikePrice,
    marketType,
    closeTime: market.close_time,
    timeRemaining,
    timeRemainingMinutes,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    volume: parseInt(market.volume) || 0
  };
}

// Analyze market and find the SAFEST side to bet (highest win probability)
function analyzeCryptoMarket(parsed) {
  if (!parsed.cryptoType || !parsed.strikePrice || !parsed.marketType || parsed.marketType === 'between') {
    return null;
  }

  const priceData = cryptoPrices[parsed.cryptoType];
  if (!priceData || !priceData.price) {
    return null;
  }

  const currentPrice = priceData.price;
  const volatility = priceData.volatility;
  const timeMinutes = parsed.timeRemainingMinutes || 15;

  // Calculate how far price is from strike
  const pctFromStrike = ((currentPrice - parsed.strikePrice) / parsed.strikePrice) * 100;

  // USE STATISTICAL PREDICTION ENGINE
  // This analyzes historical data, momentum, and volatility
  const prediction = predictOutcome(
    parsed.cryptoType,
    currentPrice,
    parsed.strikePrice,
    timeMinutes
  );

  // For "above/up" markets: YES wins if price >= strike at expiry
  // For "below/down" markets: YES wins if price < strike at expiry
  let probYesWins, probNoWins;
  if (parsed.marketType === 'above') {
    probYesWins = prediction.probAbove;
    probNoWins = prediction.probBelow;
  } else {
    probYesWins = prediction.probBelow;
    probNoWins = prediction.probAbove;
  }

  // Market implied probabilities from ask prices
  const marketProbYes = parsed.yesAsk;
  const marketProbNo = parsed.noAsk;

  // Calculate edge for BOTH sides
  const yesEdge = (probYesWins - marketProbYes) * 100;
  const noEdge = (probNoWins - marketProbNo) * 100;

  // Build analysis description
  const momentumDesc = prediction.momentum.direction === 'up' ? '📈 UP' :
                       prediction.momentum.direction === 'down' ? '📉 DOWN' : '➡️ flat';
  const timeDesc = prediction.analysis.timeDecayApplied ? '⏰ time decay' : '';

  // ============================================
  // SAFETY-FIRST BET SELECTION
  // ============================================
  // Strategy: Pick the side with HIGHEST WIN PROBABILITY
  // Only requirement: must have SOME positive edge (>0.5%)
  // We don't care about profit size - we want SAFE wins

  let bestBet = null;

  // Evaluate YES side
  const yesValid = parsed.yesAsk > 0 && parsed.yesAsk < 0.98 && yesEdge > 0.5;
  // Evaluate NO side
  const noValid = parsed.noAsk > 0 && parsed.noAsk < 0.98 && noEdge > 0.5;

  // Pick the side with HIGHER WIN PROBABILITY (safest bet)
  if (yesValid && noValid) {
    // Both sides have positive edge - pick the one with higher probability
    if (probYesWins >= probNoWins) {
      bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
    } else {
      bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
    }
  } else if (yesValid) {
    bestBet = { side: 'YES', edge: yesEdge, prob: probYesWins, price: parsed.yesAsk };
  } else if (noValid) {
    bestBet = { side: 'NO', edge: noEdge, prob: probNoWins, price: parsed.noAsk };
  }

  // No valid bet found
  if (!bestBet) {
    return null;
  }

  // Determine if this is a "safe" bet (high confidence)
  const isHighProb = bestBet.prob >= 0.60;
  const isSafeBet = bestBet.prob >= 0.70;

  // Build reason string
  const probPct = (bestBet.prob * 100).toFixed(0);
  const betReason = `${momentumDesc} ${timeDesc} | ${probPct}% win prob`;

  // Calculate profit for $1 worth of contracts
  // E.g., if price is 50¢, we buy 2 contracts. If we win, each pays $1, so profit = 2×$1 - $1 = $1 (100¢)
  const priceCents = Math.round(bestBet.price * 100);
  const contractsFor1Dollar = Math.floor(100 / priceCents);
  const totalCostCents = contractsFor1Dollar * priceCents;
  const payoutIfWinCents = contractsFor1Dollar * 100; // Each contract pays $1
  const profitIfWinCents = payoutIfWinCents - totalCostCents;

  // Expected profit accounting for probability
  const expectedProfit = (bestBet.prob * profitIfWinCents - (1 - bestBet.prob) * totalCostCents);
  const profitPotential = (profitIfWinCents / totalCostCents) * 100;

  // Fixed bet amount ($1) for sustainable growth
  const recommendedBet = 100; // Always $1

  return {
    ...parsed,
    currentPrice,
    volatility: (volatility * 100).toFixed(2) + '%',
    pctFromStrike: pctFromStrike.toFixed(2),
    zScore: prediction.zScore.toFixed(2),
    probYesWins: probYesWins * 100,
    probNoWins: probNoWins * 100,
    ourProbability: bestBet.prob * 100,
    winProbability: (bestBet.prob * 100).toFixed(1),
    marketImpliedProb: bestBet.price * 100,
    yesEdge,
    noEdge,
    edge: bestBet.edge,
    betSide: bestBet.side,
    betPrice: bestBet.price,
    betPriceCents: priceCents,
    contractsFor1Dollar,
    betReason,
    profitIfWin: profitIfWinCents, // Total profit in cents for $1 bet
    expectedProfit: expectedProfit.toFixed(1),
    profitPotential,
    recommendedBet,
    isObviousBet: isSafeBet,
    isHighProb,
    // Statistical analysis info
    momentum: prediction.momentum.direction,
    momentumStrength: prediction.momentum.strength,
    confidence: (prediction.confidence * 100).toFixed(0) + '%',
    dataPoints: prediction.dataPoints,
    analysisMethod: prediction.analysis.method,
    timeRemainingFormatted: formatTimeRemaining(parsed.timeRemaining)
  };
}

function formatTimeRemaining(ms) {
  if (!ms || ms < 0) return 'Expired';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ============================================
// API ENDPOINTS
// ============================================

// Get current prices for all tokens
app.get('/api/crypto/prices', (req, res) => {
  const prices = {};
  for (const [token, data] of Object.entries(cryptoPrices)) {
    if (data.price > 0) {
      prices[token] = {
        price: data.price,
        volatility: (data.volatility * 100).toFixed(2) + '%',
        lastUpdate: data.timestamp,
        dataPoints: data.history.length
      };
    }
  }

  res.json({
    success: true,
    prices,
    trackedTokens: Object.keys(TRACKED_TOKENS),
    timestamp: Date.now()
  });
});

// Get betting opportunities
app.get('/api/crypto/opportunities', async (req, res) => {
  try {
    const markets = await fetchCryptoMarkets();

    const opportunities = markets
      .map(m => analyzeCryptoMarket(parseMarket(m)))
      .filter(m => {
        if (m === null) return false;
        if (m.edge < 0.5) return false; // Need 0.5% edge minimum
        // Only show opportunities where win probability is at least 50%
        // This prevents showing bets on sides that are more likely to lose
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 50) return false;
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    // Get simplified price object for display
    const priceDisplay = {};
    for (const token of Object.keys(cryptoPrices)) {
      if (cryptoPrices[token].price > 0) {
        priceDisplay[token] = cryptoPrices[token].price;
      }
    }

    res.json({
      success: true,
      count: opportunities.length,
      minEdge: config.minEdge,
      prices: priceDisplay,
      opportunities
    });
  } catch (error) {
    console.error('Error getting opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get ALL opportunities (crypto + index) - unified endpoint
app.get('/api/opportunities/all', async (req, res) => {
  try {
    // Fetch both market types in parallel
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      })
      .filter(m => m !== null && m.edge >= 0.5 && parseFloat(m.winProbability) >= 50);

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)))
      .filter(m => m !== null && m.edge >= 0.5 && parseFloat(m.winProbability) >= 50);

    // Combine and sort by win probability
    const allOpportunities = [...cryptoOpps, ...indexOpps]
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    // Refresh positions before calculating risk
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    // Get current risk info
    const currentRisk = getCurrentRiskFromPortfolio();
    const remainingBudget = getRemainingRiskBudget();

    // Price display
    const priceDisplay = {
      crypto: {},
      index: { SPX: indexPrices.SPX.price }
    };
    for (const token of Object.keys(cryptoPrices)) {
      if (cryptoPrices[token].price > 0) {
        priceDisplay.crypto[token] = cryptoPrices[token].price;
      }
    }

    res.json({
      success: true,
      count: allOpportunities.length,
      cryptoCount: cryptoOpps.length,
      indexCount: indexOpps.length,
      prices: priceDisplay,
      risk: {
        current: currentRisk,
        max: MAX_TOTAL_RISK_CENTS,
        remaining: remainingBudget,
        currentDollars: (currentRisk / 100).toFixed(2),
        maxDollars: (MAX_TOTAL_RISK_CENTS / 100).toFixed(2),
        remainingDollars: (remainingBudget / 100).toFixed(2)
      },
      opportunities: allOpportunities
    });
  } catch (error) {
    console.error('Error getting all opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current risk exposure
app.get('/api/risk', async (req, res) => {
  try {
    // Refresh portfolio if authenticated
    if (config.isAuthenticated) {
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions:', e.message);
      }
    }

    const currentRisk = getCurrentRiskFromPortfolio();
    const remainingBudget = getRemainingRiskBudget();

    res.json({
      success: true,
      risk: {
        current: currentRisk,
        max: MAX_TOTAL_RISK_CENTS,
        remaining: remainingBudget,
        currentDollars: (currentRisk / 100).toFixed(2),
        maxDollars: (MAX_TOTAL_RISK_CENTS / 100).toFixed(2),
        remainingDollars: (remainingBudget / 100).toFixed(2),
        positionCount: portfolio.positions?.length || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SENTIMENT & NEWS API ENDPOINTS
// ============================================

// Get overall market sentiment
app.get('/api/sentiment', async (req, res) => {
  try {
    const [news, reddit] = await Promise.all([
      Promise.resolve(getRecentNews(20)),
      getRedditSentiment()
    ]);

    const overall = calculateOverallSentiment(news, reddit);

    res.json({
      success: true,
      timestamp: Date.now(),
      overall,
      news: news.map(a => ({
        title: a.title,
        source: a.source,
        link: a.link,
        pubDate: a.pubDate,
        urgency: a.urgency
      })),
      reddit: reddit.slice(0, 20),
      alerts: recentAlerts.slice(0, 10),
      config: {
        newsInterval: NEWS_CONFIG.checkIntervalMs,
        urgencyThreshold: NEWS_CONFIG.urgencyThreshold,
        maxNewsAge: NEWS_CONFIG.maxNewsAge
      }
    });
  } catch (error) {
    console.error('Sentiment API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent news articles
app.get('/api/news/latest', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const maxAgeMinutes = parseInt(req.query.maxAge) || 60;

  const news = getRecentNews(limit, maxAgeMinutes * 60 * 1000);

  res.json({
    success: true,
    count: news.length,
    news: news.map(a => ({
      title: a.title,
      source: a.source,
      link: a.link,
      pubDate: a.pubDate,
      urgency: a.urgency,
      age: Math.round((Date.now() - a.pubDate.getTime()) / 60000) + ' min ago'
    }))
  });
});

// Get recent alerts
app.get('/api/news/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  res.json({
    success: true,
    count: recentAlerts.length,
    alerts: recentAlerts.slice(0, limit)
  });
});

// Manually trigger news check
app.post('/api/news/check', async (req, res) => {
  try {
    const newArticles = await fetchAllNews();

    res.json({
      success: true,
      newArticles: newArticles.length,
      totalCached: newsCache.length,
      alerts: recentAlerts.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Reddit sentiment data
app.get('/api/reddit/sentiment', async (req, res) => {
  try {
    const reddit = await getRedditSentiment();

    res.json({
      success: true,
      count: reddit.length,
      tickers: reddit
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Place a bet
app.post('/api/bet', async (req, res) => {
  try {
    const { ticker, side, expectedPrice } = req.body;

    if (!ticker || !side) {
      return res.status(400).json({ success: false, error: 'ticker and side required' });
    }

    // Force fresh market data by clearing cache
    marketCache.lastFetch = 0;
    indexMarketCache.lastFetch = 0;

    // Search both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);

    let market = cryptoMarkets.find(m => m.ticker === ticker);
    let marketType = 'crypto';

    if (!market) {
      market = indexMarkets.find(m => m.ticker === ticker);
      marketType = 'index';
    }

    if (!market) {
      return res.status(404).json({ success: false, error: `Market ${ticker} not found or has expired` });
    }

    // Check if market is still open
    const closeTime = market.close_time ? new Date(market.close_time).getTime() : null;
    if (closeTime && closeTime < Date.now()) {
      return res.status(400).json({ success: false, error: 'Market has closed' });
    }

    // Kalshi API returns prices in cents already (e.g., yes_ask: 4 means 4 cents)
    let priceCents = side.toLowerCase() === 'yes'
      ? parseFloat(market.yes_ask) || 0
      : parseFloat(market.no_ask) || 0;

    console.log(`Bet attempt: ${ticker} | side=${side} | yes_ask=${market.yes_ask} | no_ask=${market.no_ask} | priceCents=${priceCents} | expectedPrice=${expectedPrice}`);

    // If we have an expected price from the UI and the fetched price is 0 or very different, use expected
    if (expectedPrice && expectedPrice > 0) {
      if (priceCents <= 0) {
        console.log(`Using expected price ${expectedPrice} since market price is 0`);
        priceCents = expectedPrice;
      } else if (Math.abs(priceCents - expectedPrice) > 10) {
        // Price changed by more than 10 cents - warn but proceed with current price
        console.log(`Price changed: expected ${expectedPrice}, got ${priceCents}`);
      }
    }

    if (!priceCents || priceCents <= 0) {
      return res.status(400).json({
        success: false,
        error: `No liquidity for ${side.toUpperCase()} side (price=0). Try the other side or wait.`,
        debug: { yes_ask: market.yes_ask, no_ask: market.no_ask, ticker }
      });
    }

    // Calculate bet size (up to $1, but respect risk limit)
    const remainingBudget = getRemainingRiskBudget();
    const TARGET_BET_CENTS = Math.min(100, remainingBudget); // $1.00 max, but respect risk cap

    if (TARGET_BET_CENTS < priceCents) {
      return res.status(400).json({
        success: false,
        error: `Risk limit reached. Only $${(remainingBudget/100).toFixed(2)} remaining of $${(MAX_TOTAL_RISK_CENTS/100).toFixed(2)} max.`
      });
    }

    const count = Math.floor(TARGET_BET_CENTS / priceCents);

    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: `Contract price too high (${priceCents}¢). Max price: 99¢`
      });
    }

    const totalCost = count * priceCents;
    console.log(`Bet: ${ticker} | ${side} | price=${priceCents}¢ | count=${count} | total=${totalCost}¢`);

    const betRecord = {
      id: Date.now().toString(),
      ticker,
      title: market.title,
      side: side.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet - use limit order slightly above ask to ensure fill
    // Add 2 cent buffer to improve fill rate
    const fillPrice = Math.min(priceCents + 2, 99);

    const orderRequest = {
      ticker,
      action: 'buy',
      side: side.toLowerCase(),
      type: 'limit',
      count
    };

    // Add the appropriate price field based on side
    if (side.toLowerCase() === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }

    console.log(`Placing order (ask: ${priceCents}¢, bid: ${fillPrice}¢):`, JSON.stringify(orderRequest));

    try {
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
      console.log('Order response:', JSON.stringify(orderResponse));

      const order = orderResponse.order;
      if (!order) {
        return res.status(400).json({ success: false, error: 'No order in response' });
      }

      // Check if order was filled
      const status = order.status;
      const filledCount = order.filled_count || 0;

      if (status === 'canceled' || filledCount === 0) {
        return res.status(400).json({
          success: false,
          error: `Order not filled. Status: ${status}. No liquidity at current price.`
        });
      }

      // Update bet record with actual fill info
      betRecord.status = status === 'filled' ? 'filled' : 'partial';
      betRecord.orderId = order.order_id;
      betRecord.filledCount = filledCount;
      betRecord.avgPrice = order.average_fill_price || priceCents;
      betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
      betHistory.unshift(betRecord);

      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      // Refresh positions for risk tracking
      try {
        const posData = await kalshiRequest('GET', '/portfolio/positions?status=open');
        portfolio.positions = posData.positions || [];
      } catch (e) {
        console.log('Could not refresh positions after bet:', e.message);
      }

      const currentRisk = getCurrentRiskFromPortfolio();

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        newBalance: portfolio.balance / 100,
        risk: {
          current: currentRisk,
          max: MAX_TOTAL_RISK_CENTS,
          remaining: getRemainingRiskBudget(),
          currentDollars: (currentRisk / 100).toFixed(2),
          maxDollars: (MAX_TOTAL_RISK_CENTS / 100).toFixed(2)
        }
      });
    } catch (orderError) {
      console.error('Kalshi order error:', orderError.message);
      res.status(400).json({ success: false, error: `Kalshi: ${orderError.message}` });
    }

  } catch (error) {
    console.error('Error placing bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto-bet on best opportunity (Place Best Bet button) - now supports all markets
app.post('/api/crypto/auto-bet', async (req, res) => {
  try {
    // Fetch both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);
    const now = Date.now();

    // Clean up old bets from tracking (older than 30 min)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      });

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)));

    // Combine and filter
    const opportunities = [...cryptoOpps, ...indexOpps]
      .filter(m => {
        if (m === null) return false;
        // Skip if we already bet on this exact market
        if (recentBets.has(m.ticker)) return false;
        // REQUIRE 60%+ WIN PROBABILITY for auto-betting
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 60) return false;
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    const totalScanned = cryptoMarkets.length + indexMarkets.length;

    if (opportunities.length === 0) {
      return res.json({
        success: true,
        message: 'No opportunities with 60%+ win probability found. Waiting...',
        bet: null,
        scanned: totalScanned
      });
    }

    // Check risk limit
    const remainingBudget = getRemainingRiskBudget();
    if (remainingBudget < 10) { // Less than 10 cents remaining
      return res.json({
        success: true,
        message: `Risk limit reached ($${(MAX_TOTAL_RISK_CENTS/100).toFixed(2)} max). Wait for positions to settle.`,
        bet: null,
        risk: {
          current: getCurrentRiskFromPortfolio(),
          max: MAX_TOTAL_RISK_CENTS,
          remaining: remainingBudget
        }
      });
    }

    const best = opportunities[0];
    const category = best.marketCategory || 'crypto';
    console.log(`Auto-bet found [${category}]: ${best.title} | Win prob: ${best.winProbability}% | Side: ${best.betSide}`);

    // Cap bet at remaining risk budget or $1, whichever is less
    const MAX_BET_CENTS = Math.min(100, remainingBudget);

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      return res.json({ success: true, message: 'Bet size too small for risk budget', bet: null });
    }

    // Ensure we don't exceed budget
    const totalCost = count * priceCents;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      marketCategory: category,
      assetType: best.assetType || best.cryptoType,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      edge: best.edge,
      winProbability: best.winProbability,
      currentPrice: best.currentPrice,
      strikePrice: best.strikePrice,
      timestamp: new Date().toISOString(),
      status: 'pending',
      auto: true
    };

    // Mark this market as bet on
    recentBets.set(best.ticker, { timestamp: now, side: best.betSide });

    if (!config.isAuthenticated) {
      betRecord.status = 'simulated';
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;

      return res.json({
        success: true,
        simulated: true,
        bet: betRecord,
        opportunity: best,
        newBalance: config.bankroll / 100
      });
    }

    // Real bet - use limit order slightly above ask to ensure fill
    const fillPrice = Math.min(priceCents + 2, 99);

    const orderRequest = {
      ticker: best.ticker,
      action: 'buy',
      side: best.betSide.toLowerCase(),
      type: 'limit',
      count
    };

    // Add the appropriate price field based on side
    if (best.betSide.toLowerCase() === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }

    console.log(`Auto-bet placing order (ask: ${priceCents}¢, bid: ${fillPrice}¢):`, JSON.stringify(orderRequest));

    try {
      const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
      console.log('Auto-bet order response:', JSON.stringify(orderResponse));

      const order = orderResponse.order;
      if (!order) {
        return res.status(400).json({ success: false, error: 'No order in response' });
      }

      // Check if order was filled
      const status = order.status;
      const filledCount = order.filled_count || 0;

      if (status === 'canceled' || filledCount === 0) {
        // Remove from recent bets so we can try again
        recentBets.delete(best.ticker);
        return res.status(400).json({
          success: false,
          error: `Order not filled. Status: ${status}. No liquidity at current price.`
        });
      }

      // Update bet record with actual fill info
      betRecord.status = status === 'filled' ? 'filled' : 'partial';
      betRecord.orderId = order.order_id;
      betRecord.filledCount = filledCount;
      betRecord.avgPrice = order.average_fill_price || priceCents;
      betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
      betHistory.unshift(betRecord);

      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      res.json({
        success: true,
        filled: filledCount,
        requested: count,
        avgPrice: betRecord.avgPrice,
        bet: betRecord,
        opportunity: best,
        newBalance: portfolio.balance / 100
      });
    } catch (orderError) {
      console.error('Kalshi auto-bet order error:', orderError.message);
      // Remove from recent bets on error so we can try again
      recentBets.delete(best.ticker);
      res.status(400).json({ success: false, error: `Kalshi: ${orderError.message}` });
    }

  } catch (error) {
    console.error('Error in auto-bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle auto-betting
let autoBetInterval = null;

async function runAutoBet() {
  try {
    console.log('\n🤖 ========== AUTO-BET SCAN ==========');

    // Force fresh data
    marketCache.lastFetch = 0;
    indexMarketCache.lastFetch = 0;

    // Fetch both crypto and index markets
    const [cryptoMarkets, indexMarkets] = await Promise.all([
      fetchCryptoMarkets(),
      fetchIndexMarkets()
    ]);
    const now = Date.now();

    // Clean up old bets (remove bets older than 30 minutes)
    for (const [ticker, bet] of recentBets.entries()) {
      if (now - bet.timestamp > 30 * 60 * 1000) {
        recentBets.delete(ticker);
      }
    }

    console.log(`📊 Fetched: ${cryptoMarkets.length} crypto, ${indexMarkets.length} index markets`);
    console.log(`   Recent bets tracking: ${recentBets.size} markets`);

    // Analyze crypto opportunities
    const cryptoOpps = cryptoMarkets
      .map(m => {
        const analyzed = analyzeCryptoMarket(parseMarket(m));
        if (analyzed) analyzed.marketCategory = 'crypto';
        return analyzed;
      });

    // Analyze index opportunities
    const indexOpps = indexMarkets
      .map(m => analyzeIndexMarket(parseIndexMarket(m)));

    // Count before filtering
    const allOpps = [...cryptoOpps, ...indexOpps].filter(m => m !== null);
    const withEdge = allOpps.filter(m => m.edge > 0);
    const above50 = allOpps.filter(m => parseFloat(m.winProbability) >= 50);
    const above60 = allOpps.filter(m => parseFloat(m.winProbability) >= 60);

    console.log(`   Analyzed: ${allOpps.length} valid | ${withEdge.length} with edge | ${above50.length} >50% | ${above60.length} >60%`);

    // Combine and filter
    const opportunities = [...cryptoOpps, ...indexOpps]
      .filter(m => {
        if (m === null) return false;
        // Skip if we already bet on this exact market
        if (recentBets.has(m.ticker)) {
          return false;
        }
        // REQUIRE 60%+ WIN PROBABILITY for auto-betting
        const winProb = parseFloat(m.winProbability) || 0;
        if (winProb < 60) return false;
        // Also require positive edge
        if (m.edge < 0.5) return false;
        return true;
      })
      // SORT BY WIN PROBABILITY (safest bets first)
      .sort((a, b) => parseFloat(b.winProbability) - parseFloat(a.winProbability));

    const highConfCount = opportunities.filter(o => parseFloat(o.winProbability) >= 70).length;
    console.log(`   Final: ${opportunities.length} opportunities (${highConfCount} above 70%)`);

    if (opportunities.length === 0) {
      console.log('⏳ No valid opportunities - waiting for next scan...');
      console.log('========================================\n');
      return;
    }

    // Check risk limit
    const remainingBudget = getRemainingRiskBudget();
    const currentRisk = getCurrentRiskFromPortfolio();
    console.log(`💰 Risk: $${(currentRisk/100).toFixed(2)} / $${(MAX_TOTAL_RISK_CENTS/100).toFixed(2)} | Remaining: $${(remainingBudget/100).toFixed(2)}`);

    if (remainingBudget < 10) {
      console.log('⚠️ Risk limit reached - waiting for positions to settle...');
      return;
    }

    const best = opportunities[0];
    const category = best.marketCategory || 'crypto';
    const assetName = best.assetName || best.cryptoType || 'Unknown';

    console.log(`\n💰 BEST OPPORTUNITY [${category.toUpperCase()}]:`);
    console.log(`   ${best.title}`);
    console.log(`   ${best.betReason}`);
    console.log(`   Side: ${best.betSide} @ ${(best.betPrice * 100).toFixed(0)}¢ | Win prob: ${best.winProbability}%`);
    console.log(`   Current: $${best.currentPrice?.toFixed(2) || 'N/A'} | Strike: $${best.strikePrice?.toFixed(2) || 'N/A'}`);
    console.log(`   Edge: +${best.edge.toFixed(1)}%`);
    console.log(`   ${best.isObviousBet ? '✅ HIGH CONFIDENCE' : '⚠️ Model-based'}`);

    // Cap bet at remaining risk budget or $1, whichever is less
    const MAX_BET_CENTS = Math.min(100, remainingBudget);

    const priceCents = Math.round(best.betPrice * 100);

    // Calculate contracts but cap total cost
    let count = Math.floor(MAX_BET_CENTS / priceCents);
    if (count < 1) {
      console.log('⚠️ Bet size too small for risk budget');
      return;
    }

    // Ensure we don't exceed budget
    const totalCost = count * priceCents;

    const betRecord = {
      id: Date.now().toString(),
      ticker: best.ticker,
      title: best.title,
      marketCategory: category,
      assetType: best.assetType || best.cryptoType,
      side: best.betSide.toLowerCase(),
      count,
      price: priceCents,
      totalCost,
      edge: best.edge,
      timestamp: new Date().toISOString(),
      status: config.isAuthenticated ? 'pending' : 'simulated',
      auto: true
    };

    // Mark this market as bet on BEFORE placing the bet
    recentBets.set(best.ticker, { timestamp: now, side: best.betSide });

    if (!config.isAuthenticated) {
      betRecord.orderId = 'SIM-' + Date.now();
      betHistory.unshift(betRecord);
      config.bankroll -= betRecord.totalCost;
      console.log(`\n🎰 SIMULATED BET PLACED:`);
      console.log(`   ${betRecord.side.toUpperCase()} on ${assetName}`);
      console.log(`   ${count} contracts @ ${priceCents}¢ = $${(betRecord.totalCost/100).toFixed(2)}`);
      console.log(`   Edge: +${best.edge.toFixed(1)}% | Win prob: ${best.winProbability}%`);
      console.log(`   New balance: $${(config.bankroll/100).toFixed(2)}`);
      console.log('========================================\n');
      return;
    }

    // Real bet - use limit order slightly above ask to ensure fill
    const fillPrice = Math.min(priceCents + 2, 99);

    console.log(`\n💸 PLACING REAL BET...`);
    const orderRequest = {
      ticker: best.ticker,
      action: 'buy',
      side: best.betSide.toLowerCase(),
      type: 'limit',
      count
    };

    // Add the appropriate price field based on side
    if (best.betSide.toLowerCase() === 'yes') {
      orderRequest.yes_price = fillPrice;
    } else {
      orderRequest.no_price = fillPrice;
    }
    console.log(`   Order (ask: ${priceCents}¢, bid: ${fillPrice}¢): ${JSON.stringify(orderRequest)}`);

    const orderResponse = await kalshiRequest('POST', '/portfolio/orders', orderRequest);
    console.log(`   Response: ${JSON.stringify(orderResponse)}`);

    const order = orderResponse.order;
    if (!order) {
      console.error('❌ No order in response');
      recentBets.delete(best.ticker);
      console.log('========================================\n');
      return;
    }

    // Check if order was filled
    const status = order.status;
    const filledCount = order.filled_count || 0;

    if (status === 'canceled' || filledCount === 0) {
      console.error(`❌ Order not filled. Status: ${status}. No liquidity.`);
      recentBets.delete(best.ticker);
      console.log('========================================\n');
      return;
    }

    // Update bet record with actual fill info
    betRecord.status = status === 'filled' ? 'filled' : 'partial';
    betRecord.orderId = order.order_id;
    betRecord.filledCount = filledCount;
    betRecord.avgPrice = order.average_fill_price || priceCents;
    betRecord.totalCost = filledCount * (order.average_fill_price || priceCents);
    betHistory.unshift(betRecord);

    const balanceData = await kalshiRequest('GET', '/portfolio/balance');
    config.bankroll = balanceData.balance || 0;

    console.log(`\n✅ REAL BET FILLED:`);
    console.log(`   ${betRecord.side.toUpperCase()} on ${best.cryptoType || best.assetType}`);
    console.log(`   ${filledCount} contracts @ ${betRecord.avgPrice}¢`);
    console.log(`   Edge: +${best.edge.toFixed(1)}% | New balance: $${(config.bankroll/100).toFixed(2)}`);
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Auto-bet error:', error.message);
    console.error('   Stack:', error.stack);
    console.log('========================================\n');
  }
}

app.post('/api/crypto/auto-bet/toggle', (req, res) => {
  const { enabled, intervalSeconds = 15 } = req.body; // Check every 15 seconds

  if (enabled && !config.autoBetEnabled) {
    config.autoBetEnabled = true;

    runAutoBet();
    autoBetInterval = setInterval(runAutoBet, intervalSeconds * 1000);

    res.json({
      success: true,
      message: `Auto-betting enabled (every ${intervalSeconds}s)`,
      enabled: true
    });
  } else if (!enabled && config.autoBetEnabled) {
    config.autoBetEnabled = false;
    if (autoBetInterval) {
      clearInterval(autoBetInterval);
      autoBetInterval = null;
    }

    res.json({ success: true, message: 'Auto-betting disabled', enabled: false });
  } else {
    res.json({
      success: true,
      message: `Auto-betting ${config.autoBetEnabled ? 'running' : 'stopped'}`,
      enabled: config.autoBetEnabled
    });
  }
});

// Auth endpoints
app.post('/api/auth/configure', async (req, res) => {
  try {
    const { apiKeyId, privateKey } = req.body;

    if (!apiKeyId || !privateKey) {
      return res.status(400).json({ success: false, error: 'apiKeyId and privateKey required' });
    }

    config.apiKeyId = apiKeyId.trim();
    config.privateKey = privateKey.trim();
    config.isAuthenticated = true;

    try {
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      res.json({
        success: true,
        message: 'Connected to Kalshi',
        balance: portfolio.balance / 100
      });
    } catch (authError) {
      config.apiKeyId = null;
      config.privateKey = null;
      config.isAuthenticated = false;
      res.status(401).json({ success: false, error: 'Invalid credentials: ' + authError.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    isAuthenticated: config.isAuthenticated,
    hasApiKey: !!config.apiKeyId
  });
});

app.get('/api/portfolio', async (req, res) => {
  try {
    // If authenticated, fetch real data from Kalshi
    if (config.isAuthenticated) {
      // Fetch balance
      const balanceData = await kalshiRequest('GET', '/portfolio/balance');
      portfolio.balance = balanceData.balance || 0;
      config.bankroll = portfolio.balance;

      // Fetch recent fills (completed trades) - last 20
      let realBetHistory = [];
      try {
        const fillsData = await kalshiRequest('GET', '/portfolio/fills?limit=20');
        const fills = fillsData.fills || [];

        // Transform fills into our bet history format
        realBetHistory = fills.map(fill => {
          const count = fill.count || 1;
          // Kalshi API can return price in different formats:
          // - As cents (0-100): e.g., 10 = 10 cents
          // - As decimal probability (0-1): e.g., 0.10 = 10 cents
          // We need to normalize to cents
          let priceCents = fill.price || 0;
          if (priceCents > 0 && priceCents <= 1) {
            // Price is a decimal probability, convert to cents
            priceCents = Math.round(priceCents * 100);
          }
          // Total cost = number of contracts × price per contract (in cents)
          const totalCost = count * priceCents;

          // Debug logging disabled for performance
          // console.log(`Fill: ${fill.ticker} | count=${count} | price=${fill.price} | priceCents=${priceCents} | totalCost=${totalCost}`);

          return {
            id: fill.trade_id || fill.fill_id || Date.now().toString(),
            ticker: fill.ticker,
            title: fill.ticker,
            side: fill.side,
            count,
            price: priceCents,
            totalCost,
            timestamp: fill.created_time || fill.ts || new Date().toISOString(),
            status: 'pending', // Will be updated below
            action: fill.action || 'buy',
            orderId: fill.order_id,
            outcome: null, // Will be 'won', 'lost', or null (pending)
            payout: 0,
            profit: 0
          };
        });

        // Get market data including settlement results - FETCH IN PARALLEL for speed
        const uniqueTickers = [...new Set(realBetHistory.map(b => b.ticker))].slice(0, 10);
        const marketData = {};

        // Fetch all market data in parallel
        const marketPromises = uniqueTickers.map(async (ticker) => {
          try {
            const data = await kalshiRequest('GET', `/markets/${ticker}`);
            if (data.market) {
              return {
                ticker,
                title: data.market.title || ticker,
                result: data.market.result,
                status: data.market.status,
                closeTime: data.market.close_time
              };
            }
          } catch (e) {
            return { ticker, title: ticker, result: null, status: 'unknown' };
          }
          return { ticker, title: ticker, result: null, status: 'unknown' };
        });

        const marketResults = await Promise.all(marketPromises);
        marketResults.forEach(m => {
          if (m) marketData[m.ticker] = m;
        });

        // Update bets with market data and calculate outcomes
        realBetHistory = realBetHistory.map(bet => {
          const market = marketData[bet.ticker] || {};
          const title = market.title || bet.ticker;
          const result = market.result; // 'yes' or 'no' if settled
          const marketStatus = market.status;

          let outcome = null;
          let status = 'open';
          let payout = 0;
          let profit = 0;

          // Only calculate outcomes for buy orders (not sells)
          const isBuy = bet.action?.toLowerCase() !== 'sell';

          if (result && isBuy) {
            // Market has settled - determine if we won
            const betSide = bet.side?.toLowerCase();
            const wonBet = (betSide === result);

            outcome = wonBet ? 'won' : 'lost';
            status = 'settled';

            if (wonBet) {
              // Won: payout is $1 per contract (100 cents)
              payout = bet.count * 100;
              profit = payout - bet.totalCost;
            } else {
              // Lost: lose the entire bet amount (totalCost)
              payout = 0;
              profit = -bet.totalCost;
            }

            // Debug logging disabled for performance
          } else if (marketStatus === 'closed') {
            status = 'closed';
          } else {
            status = 'open';
          }

          return {
            ...bet,
            title,
            status,
            outcome,
            payout,
            profit,
            marketResult: result,
            closeTime: market.closeTime
          };
        });

      } catch (fillError) {
        console.error('Error fetching fills:', fillError.message);
        realBetHistory = betHistory.slice(0, 20);
      }

      // Merge with in-memory history
      const combinedHistory = [...realBetHistory];
      betHistory.forEach(memBet => {
        if (!combinedHistory.some(b => b.orderId === memBet.orderId || b.id === memBet.id)) {
          combinedHistory.push(memBet);
        }
      });

      // Sort by timestamp descending
      combinedHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate totals
      const settled = combinedHistory.filter(b => b.outcome);
      const totalProfit = settled.reduce((sum, b) => sum + (b.profit || 0), 0);
      const wins = settled.filter(b => b.outcome === 'won').length;
      const losses = settled.filter(b => b.outcome === 'lost').length;

      res.json({
        success: true,
        simulated: false,
        balance: portfolio.balance / 100,
        betHistory: combinedHistory.slice(0, 20),
        stats: {
          totalBets: settled.length,
          wins,
          losses,
          winRate: settled.length > 0 ? ((wins / settled.length) * 100).toFixed(1) : '0',
          totalProfit: totalProfit / 100 // in dollars
        }
      });
    } else {
      // Return simulated data
      res.json({
        success: true,
        simulated: true,
        balance: config.bankroll / 100,
        betHistory: betHistory.slice(0, 20),
        stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 }
      });
    }
  } catch (error) {
    console.error('Portfolio error:', error.message);
    res.json({
      success: true,
      simulated: !config.isAuthenticated,
      balance: config.bankroll / 100,
      betHistory: betHistory.slice(0, 20),
      stats: { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 },
      error: error.message
    });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      minEdge: config.minEdge,
      maxBetPercent: config.maxBetPercent,
      autoBetEnabled: config.autoBetEnabled
    }
  });
});

app.post('/api/settings', (req, res) => {
  const { bankroll, minEdge, maxBetPercent } = req.body;

  if (bankroll !== undefined) config.bankroll = Math.round(bankroll * 100);
  if (minEdge !== undefined) config.minEdge = minEdge;
  if (maxBetPercent !== undefined) config.maxBetPercent = maxBetPercent;

  res.json({
    success: true,
    settings: {
      bankroll: config.bankroll / 100,
      minEdge: config.minEdge,
      maxBetPercent: config.maxBetPercent
    }
  });
});

app.get('/api/health', (req, res) => {
  const activePrices = Object.entries(cryptoPrices)
    .filter(([_, d]) => d.price > 0)
    .map(([t, d]) => `${t}: $${d.price.toFixed(2)}`);

  res.json({
    status: 'ok',
    trackedTokens: Object.keys(TRACKED_TOKENS).length,
    activePrices: activePrices.length,
    autoBetEnabled: config.autoBetEnabled,
    authenticated: config.isAuthenticated
  });
});

// Serve static frontend
const clientDistPath = path.join(__dirname, '../client/dist');
try {
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
  }
} catch (err) {}

app.get('*', (req, res) => {
  try {
    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend not built');
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🎰 Shimi Crypto Bot running on port ${PORT}`);
  console.log(`📊 Tracking ${Object.keys(TRACKED_TOKENS).length} tokens: ${Object.keys(TRACKED_TOKENS).join(', ')}`);
  console.log(`💰 Min edge: ${config.minEdge}% | Max bet: ${config.maxBetPercent}%`);

  // Auto-load Kalshi credentials from environment
  await loadCredentialsFromEnv();
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
});
