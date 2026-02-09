// NEWS & SENTIMENT MONITORING
// RSS feed parsing, Reddit sentiment, and news urgency scoring

import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

// Configuration
const NEWS_CONFIG = {
  checkIntervalMs: 60000, // Check RSS feeds every 60 seconds
  urgencyThreshold: 10, // Score needed to trigger alert
  newsBoostMultiplier: 1.5, // How much to boost bets with aligned news
  enableAutoTrade: true, // Auto-trade on high-confidence news
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
let seenArticles = new Set();
let recentAlerts = [];
let redditSentiment = { data: null, lastFetch: 0, ttl: 5 * 60 * 1000 }; // 5 min cache

// TRACKED_TOKENS passed in via init()
let TRACKED_TOKENS = {};

function init(trackedTokens) {
  TRACKED_TOKENS = trackedTokens;
}

async function fetchRssFeed(url, source) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

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
    if (seenArticles.has(article.link)) continue;

    const articleAge = now - article.pubDate.getTime();
    if (articleAge > 24 * 60 * 60 * 1000) continue;

    const urgency = scoreNewsUrgency(article.title, article.description);
    article.urgency = urgency;

    seenArticles.add(article.link);
    newArticles.push(article);

    if (urgency.isUrgent) {
      handleUrgentNews(article);
    }
  }

  // Add new articles to cache (most recent first)
  newsCache = [...newArticles, ...newsCache]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, 100);

  // Clean up old seen articles (keep last 500)
  if (seenArticles.size > 500) {
    const articlesToKeep = [...seenArticles].slice(-500);
    seenArticles = new Set(articlesToKeep);
  }

  console.log(` News update: ${newArticles.length} new articles | Cache: ${newsCache.length}`);
  return newArticles;
}

// Score news for urgency and direction
function scoreNewsUrgency(headline, body = '') {
  const text = (headline + ' ' + body).toLowerCase();
  let score = 0;
  let direction = 'neutral';
  let matchedKeywords = [];
  let assetType = null;

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

  return {
    score,
    direction,
    isUrgent: score >= NEWS_CONFIG.urgencyThreshold,
    matchedKeywords,
    mentionedTokens,
    assetType
  };
}

// Handle urgent news - log alert
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

  recentAlerts.unshift(alert);
  recentAlerts = recentAlerts.slice(0, 20);

  return alert;
}

// Get recent news for API
function getRecentNews(limit = 20, maxAgeMs = NEWS_CONFIG.maxNewsAge) {
  const now = Date.now();
  return newsCache
    .filter(article => now - article.pubDate.getTime() < maxAgeMs)
    .slice(0, limit);
}

async function getRedditSentiment() {
  const now = Date.now();

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

    console.log(` Reddit sentiment updated: ${results.length} trending tickers`);
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

  for (const article of news) {
    if (article.urgency?.direction === 'bullish') bullishSignals++;
    if (article.urgency?.direction === 'bearish') bearishSignals++;
  }

  const topReddit = reddit.slice(0, 10);
  const avgMentionChange = topReddit.reduce((sum, t) => sum + (t.mentionsChange24h || 0), 0) / topReddit.length;
  if (avgMentionChange > 50) bullishSignals += 2;
  if (avgMentionChange < -50) bearishSignals += 2;

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
    const isRelevant = article.urgency.mentionedTokens.includes(token) ||
      (assetType === 'crypto' && article.urgency.assetType === 'crypto') ||
      (assetType === 'index' && article.urgency.assetType === 'index');

    if (isRelevant && article.urgency.direction !== 'mixed' && article.urgency.direction !== 'neutral') {
      const newsAge = now - article.pubDate.getTime();
      const ageFactor = 1 - (newsAge / NEWS_CONFIG.maxNewsAge);
      const newsBoost = (article.urgency.score / 10) * ageFactor * NEWS_CONFIG.newsBoostMultiplier;

      if (direction === null || direction === article.urgency.direction) {
        direction = article.urgency.direction;
        boost += newsBoost;
      } else {
        boost *= 0.5;
      }
    }
  }

  return { boost: Math.min(boost, 15), direction };
}

// Get the full news cache (for API endpoints)
function getNewsCache() {
  return newsCache;
}

// Get recent alerts (for API endpoints)
function getRecentAlerts() {
  return recentAlerts;
}

// Start/stop news monitoring
let newsInterval = null;

function startNewsMonitoring() {
  fetchAllNews(); // Initial fetch
  newsInterval = setInterval(fetchAllNews, NEWS_CONFIG.checkIntervalMs);
}

function stopNewsMonitoring() {
  if (newsInterval) {
    clearInterval(newsInterval);
    newsInterval = null;
  }
}

export {
  NEWS_CONFIG,
  init,
  fetchAllNews,
  scoreNewsUrgency,
  getRecentNews,
  getRedditSentiment,
  calculateOverallSentiment,
  getNewsBoost,
  getNewsCache,
  getRecentAlerts,
  startNewsMonitoring,
  stopNewsMonitoring
};
