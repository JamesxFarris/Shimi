/**
 * Kalshi WebSocket Manager
 * Provides real-time market data via WebSocket connection
 * Falls back to REST polling if WebSocket is unavailable
 */

import crypto from 'crypto';
import WebSocket from 'ws';

// WebSocket endpoint
const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';

/**
 * KalshiWebSocket - Manages real-time WebSocket connection to Kalshi
 * Subscribes to ticker and orderbook channels for faster data updates
 */
export class KalshiWebSocket {
  constructor(options = {}) {
    this.apiKeyId = options.apiKeyId || null;
    this.privateKey = options.privateKey || null;
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelayMs = options.reconnectDelayMs || 5000;
    this.heartbeatInterval = null;
    this.subscriptions = new Set();
    this.authFailed = false;

    // Callbacks
    this.onTickerUpdate = options.onTickerUpdate || (() => {});
    this.onOrderbookUpdate = options.onOrderbookUpdate || (() => {});
    this.onConnectionChange = options.onConnectionChange || (() => {});
    this.onError = options.onError || console.error;

    // Data caches - updated in real-time
    this.tickerCache = new Map(); // ticker -> market data
    this.orderbookCache = new Map(); // ticker -> orderbook data

    // Track last update times for fallback decisions
    this.lastTickerUpdate = 0;
    this.lastOrderbookUpdate = 0;
  }

  /**
   * Update credentials (when user authenticates)
   */
  setCredentials(apiKeyId, privateKey) {
    this.apiKeyId = apiKeyId;
    this.privateKey = privateKey;
    this.authFailed = false;
    this.reconnectAttempts = 0;

    // Disconnect and reconnect with new credentials
    if (this.ws) {
      this.stopHeartbeat();
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.isAuthenticated = false;
    }

    if (apiKeyId && privateKey) {
      console.log('[WS] New credentials received, reconnecting...');
      this.connect().catch(err => {
        console.log('[WS] Reconnection with new credentials failed:', err.message);
      });
    }
  }

  /**
   * Sign a message for authentication
   */
  signMessage(timestamp, method, path) {
    if (!this.privateKey) return null;

    const message = timestamp + method + path;
    try {
      const privateKeyObj = crypto.createPrivateKey({
        key: this.privateKey,
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
      this.onError('WebSocket signature error:', err.message);
      return null;
    }
  }

  /**
   * Connect to WebSocket
   */
  async connect() {
    if (this.ws && this.isConnected) {
      console.log('[WS] Already connected');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        console.log('[WS] Connecting to Kalshi WebSocket...');

        // Build headers for authentication
        const timestamp = Date.now().toString();
        const path = '/trade-api/ws/v2';
        const headers = {
          'User-Agent': 'Shimi/1.0'
        };

        // Add auth headers if credentials available
        if (this.apiKeyId && this.privateKey) {
          const signature = this.signMessage(timestamp, 'GET', path);
          if (signature) {
            headers['KALSHI-ACCESS-KEY'] = this.apiKeyId;
            headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
            headers['KALSHI-ACCESS-SIGNATURE'] = signature;
          }
        }

        this.ws = new WebSocket(KALSHI_WS_URL, { headers });

        this.ws.on('open', () => {
          console.log('[WS] Connected to Kalshi WebSocket');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.onConnectionChange(true);

          // Start heartbeat
          this.startHeartbeat();

          // Re-subscribe to any previous subscriptions
          this.resubscribe();

          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          this.onError('[WS] WebSocket error:', error.message);
          // Track auth failures -- retrying won't help without new credentials
          if (error.message?.includes('401')) {
            this.authFailed = true;
          }
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[WS] Connection closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.isAuthenticated = false;
          this.onConnectionChange(false);
          this.stopHeartbeat();

          // Don't reconnect on auth failure -- wait for setCredentials
          if (this.authFailed) {
            console.log('[WS] Auth failed (401). Waiting for valid credentials before reconnecting.');
            return;
          }

          // Attempt reconnection
          this.scheduleReconnect();
        });

      } catch (error) {
        this.onError('[WS] Connection error:', error.message);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      // Handle different message types
      switch (message.type) {
        case 'subscribed':
          console.log(`[WS] Subscribed to: ${message.msg?.channel || 'unknown'}`);
          break;

        case 'ticker':
        case 'ticker_v2':
          this.handleTickerUpdate(message);
          break;

        case 'orderbook_delta':
        case 'orderbook_snapshot':
          this.handleOrderbookUpdate(message);
          break;

        case 'trade':
          this.handleTradeUpdate(message);
          break;

        case 'error':
          this.onError('[WS] Server error:', message.msg);
          break;

        case 'pong':
          // Heartbeat response - connection is alive
          break;

        default:
          // Log unknown message types for debugging
          if (message.type) {
            console.log(`[WS] Unknown message type: ${message.type}`);
          }
      }
    } catch (error) {
      this.onError('[WS] Message parse error:', error.message);
    }
  }

  /**
   * Handle ticker updates - market price changes
   */
  handleTickerUpdate(message) {
    const data = message.msg || message;
    const ticker = data.ticker || data.market_ticker;

    if (!ticker) return;

    const update = {
      ticker,
      yesAsk: data.yes_ask,
      yesBid: data.yes_bid,
      noAsk: data.no_ask,
      noBid: data.no_bid,
      lastPrice: data.last_price,
      volume: data.volume,
      openInterest: data.open_interest,
      timestamp: Date.now()
    };

    this.tickerCache.set(ticker, update);
    this.lastTickerUpdate = Date.now();

    // Notify callback
    this.onTickerUpdate(ticker, update);
  }

  /**
   * Handle orderbook updates - bid/ask depth changes
   */
  handleOrderbookUpdate(message) {
    const data = message.msg || message;
    const ticker = data.ticker || data.market_ticker;

    if (!ticker) return;

    // Kalshi WS sends: { yes: [[price, qty], ...], no: [[price, qty], ...] }
    // Binary market: yes = YES bids, no = NO bids (sorted highest-first)
    const yesBids = data.yes || [];
    const noBids = data.no || [];

    const update = {
      ticker,
      yesOrders: yesBids,
      noOrders: noBids,
      timestamp: Date.now()
    };

    // Derived prices (binary market reciprocal: NO bid at X = YES ask at 100-X)
    update.bestYesBid = this.getBestPrice(yesBids);
    update.bestYesAsk = noBids.length > 0 ? (100 - this.getEntryPrice(noBids[0])) : null;
    update.bestNoBid = this.getBestPrice(noBids);
    update.bestNoAsk = yesBids.length > 0 ? (100 - this.getEntryPrice(yesBids[0])) : null;

    // Calculate spreads
    update.yesSpread = update.bestYesAsk && update.bestYesBid
      ? update.bestYesAsk - update.bestYesBid
      : null;
    update.noSpread = update.bestNoAsk && update.bestNoBid
      ? update.bestNoAsk - update.bestNoBid
      : null;

    // Calculate liquidity at best prices
    update.yesLiquidityAtBest = this.getLiquidityAtBest(yesBids);
    update.noLiquidityAtBest = this.getLiquidityAtBest(noBids);

    // Calculate total depth
    update.yesTotalDepth = this.getTotalDepth(yesBids);
    update.noTotalDepth = this.getTotalDepth(noBids);

    this.orderbookCache.set(ticker, update);
    this.lastOrderbookUpdate = Date.now();

    // Notify callback
    this.onOrderbookUpdate(ticker, update);
  }

  /**
   * Handle trade updates
   */
  handleTradeUpdate(message) {
    const data = message.msg || message;
    // Trade data can be used for additional signals
    // For now, just update the ticker cache with last trade price
    const ticker = data.ticker || data.market_ticker;
    if (ticker && this.tickerCache.has(ticker)) {
      const cached = this.tickerCache.get(ticker);
      cached.lastPrice = data.price;
      cached.lastTradeVolume = data.count;
      cached.timestamp = Date.now();
    }
  }

  /**
   * Get best bid or ask price from orders
   */
  /**
   * Extract price from an order entry (handles both [price, qty] tuples and {price} objects)
   */
  getEntryPrice(entry) {
    if (Array.isArray(entry)) return entry[0] || 0;
    return entry?.price || 0;
  }

  /**
   * Extract quantity from an order entry (handles both [price, qty] tuples and {count/quantity} objects)
   */
  getEntryQty(entry) {
    if (Array.isArray(entry)) return entry[1] || 0;
    return entry?.count || entry?.quantity || 0;
  }

  getBestPrice(orders, side) {
    if (!orders || !Array.isArray(orders) || orders.length === 0) return null;

    // Kalshi sends bids sorted highest-first; just return first entry's price
    return this.getEntryPrice(orders[0]);
  }

  /**
   * Get liquidity (number of contracts) at best price
   */
  getLiquidityAtBest(orders) {
    if (!orders || !Array.isArray(orders) || orders.length === 0) return 0;

    const bestPrice = this.getEntryPrice(orders[0]);
    if (!bestPrice) return 0;

    // Sum all contracts at the best price
    return orders
      .filter(o => this.getEntryPrice(o) === bestPrice)
      .reduce((sum, o) => sum + this.getEntryQty(o), 0);
  }

  /**
   * Get total depth (all contracts on one side)
   */
  getTotalDepth(orders) {
    if (!orders || !Array.isArray(orders)) return 0;
    return orders.reduce((sum, o) => sum + this.getEntryQty(o), 0);
  }

  /**
   * Subscribe to market tickers
   */
  subscribeTickers(tickers) {
    if (!Array.isArray(tickers)) tickers = [tickers];

    for (const ticker of tickers) {
      this.subscriptions.add({ type: 'ticker', ticker });

      if (this.isConnected && this.ws) {
        this.ws.send(JSON.stringify({
          id: Date.now(),
          cmd: 'subscribe',
          params: {
            channels: ['ticker_v2'],
            market_tickers: [ticker]
          }
        }));
      }
    }
  }

  /**
   * Subscribe to orderbook updates
   */
  subscribeOrderbooks(tickers) {
    if (!Array.isArray(tickers)) tickers = [tickers];

    for (const ticker of tickers) {
      this.subscriptions.add({ type: 'orderbook', ticker });

      if (this.isConnected && this.ws) {
        this.ws.send(JSON.stringify({
          id: Date.now(),
          cmd: 'subscribe',
          params: {
            channels: ['orderbook_delta'],
            market_tickers: [ticker]
          }
        }));
      }
    }
  }

  /**
   * Unsubscribe from market
   */
  unsubscribe(ticker) {
    this.subscriptions.forEach(sub => {
      if (sub.ticker === ticker) {
        this.subscriptions.delete(sub);
      }
    });

    if (this.isConnected && this.ws) {
      this.ws.send(JSON.stringify({
        id: Date.now(),
        cmd: 'unsubscribe',
        params: {
          channels: ['ticker_v2', 'orderbook_delta'],
          market_tickers: [ticker]
        }
      }));
    }
  }

  /**
   * Re-subscribe to all previous subscriptions after reconnect
   */
  resubscribe() {
    const tickers = new Set();
    const orderbookTickers = new Set();

    for (const sub of this.subscriptions) {
      if (sub.type === 'ticker') {
        tickers.add(sub.ticker);
      } else if (sub.type === 'orderbook') {
        orderbookTickers.add(sub.ticker);
      }
    }

    if (tickers.size > 0) {
      this.subscribeTickers([...tickers]);
    }
    if (orderbookTickers.size > 0) {
      this.subscribeOrderbooks([...orderbookTickers]);
    }
  }

  /**
   * Get cached ticker data (for instant access)
   */
  getTicker(ticker) {
    return this.tickerCache.get(ticker);
  }

  /**
   * Get cached orderbook data
   */
  getOrderbook(ticker) {
    return this.orderbookCache.get(ticker);
  }

  /**
   * Check if WebSocket data is stale (for fallback decisions)
   */
  isDataStale(maxAgeMs = 30000) {
    const now = Date.now();
    return (now - this.lastTickerUpdate) > maxAgeMs;
  }

  /**
   * Start heartbeat to keep connection alive
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        this.ws.send(JSON.stringify({ id: Date.now(), cmd: 'ping' }));
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WS] Max reconnection attempts reached. Falling back to REST.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.min(this.reconnectAttempts, 5);

    console.log(`[WS] Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(err => {
        console.log('[WS] Reconnection failed:', err.message);
      });
    }, delay);
  }

  /**
   * Disconnect and cleanup
   */
  disconnect() {
    this.stopHeartbeat();
    this.subscriptions.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isAuthenticated = false;
    console.log('[WS] Disconnected from Kalshi WebSocket');
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      authenticated: this.isAuthenticated,
      subscriptions: this.subscriptions.size,
      tickersCached: this.tickerCache.size,
      orderbooksCached: this.orderbookCache.size,
      lastTickerUpdate: this.lastTickerUpdate,
      lastOrderbookUpdate: this.lastOrderbookUpdate,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Export singleton instance for easy use
let instance = null;

export function getKalshiWebSocket(options = {}) {
  if (!instance) {
    instance = new KalshiWebSocket(options);
  }
  return instance;
}

export default KalshiWebSocket;
