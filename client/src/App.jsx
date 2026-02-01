import { useState, useEffect, useCallback, memo } from 'react'
import './index.css'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:3001'

// Token colors
const TOKEN_COLORS = {
  BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195', XRP: '#23292f',
  DOGE: '#c2a633', ADA: '#0033ad', AVAX: '#e84142', LINK: '#2a5ada',
  MATIC: '#8247e5', DOT: '#e6007a', SHIB: '#ffa409', LTC: '#345d9d',
  UNI: '#ff007a', ATOM: '#2e3148', APT: '#4cd8af'
}

// Format helpers
const formatCurrency = (val) => `$${parseFloat(val || 0).toFixed(2)}`
const formatPercent = (val) => `${parseFloat(val || 0).toFixed(1)}%`
const formatPrice = (val) => {
  if (!val) return '$0'
  if (val >= 1000) return `$${(val/1000).toFixed(1)}k`
  return `$${val.toFixed(0)}`
}

// Opportunity Card
const OpportunityCard = memo(({ opp, onBet }) => (
  <div className="opp-card">
    <div className="opp-header">
      <span
        className="crypto-badge"
        style={{ background: `${TOKEN_COLORS[opp.cryptoType] || '#888'}30`, color: TOKEN_COLORS[opp.cryptoType] || '#888' }}
      >
        {opp.cryptoType}
      </span>
      <span className="time-badge">{opp.timeRemainingFormatted}</span>
    </div>

    <div className="opp-title">{opp.title}</div>

    <div className="opp-prices">
      <div className="price-row">
        <span className="label">Current:</span>
        <span className="value">{formatPrice(opp.currentPrice)}</span>
      </div>
      <div className="price-row">
        <span className="label">Strike:</span>
        <span className="value">{formatPrice(opp.strikePrice)}</span>
      </div>
      <div className="price-row">
        <span className="label">Direction:</span>
        <span className="value">{opp.direction?.toUpperCase()}</span>
      </div>
    </div>

    <div className="opp-stats">
      <div className="stat">
        <span className="stat-label">Our Prob</span>
        <span className="stat-value">{formatPercent(opp.ourProbability)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Market</span>
        <span className="stat-value dim">{formatPercent(opp.marketImpliedProb)}</span>
      </div>
      <div className="stat edge-stat">
        <span className="stat-label">Edge</span>
        <span className="stat-value edge">+{formatPercent(opp.edge)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Profit</span>
        <span className="stat-value">{formatPercent(opp.profitPotential)}</span>
      </div>
    </div>

    <div className="opp-recommendation">
      <span className={`bet-side ${opp.betSide?.toLowerCase()}`}>
        BET {opp.betSide}
      </span>
      <span className="bet-amount">@ {formatCurrency(opp.betPrice)}</span>
    </div>

    <button className="bet-button" onClick={() => onBet(opp)}>
      BET {formatCurrency((opp.recommendedBet || 100) / 100)}
    </button>
  </div>
))

// History Item
const HistoryItem = memo(({ bet }) => (
  <div className="history-item">
    <div className="history-main">
      <span className={`history-side ${bet.side}`}>{bet.side?.toUpperCase()}</span>
      <span className="history-title">{bet.title}</span>
    </div>
    <div className="history-details">
      <span className="history-amount">{formatCurrency(bet.totalCost / 100)}</span>
      {bet.edge && <span className="history-edge">+{formatPercent(bet.edge)} edge</span>}
      <span className={`history-status ${bet.status}`}>{bet.status}</span>
    </div>
  </div>
))

function App() {
  const [tab, setTab] = useState('bets')
  const [opportunities, setOpportunities] = useState([])
  const [prices, setPrices] = useState({ BTC: 0, ETH: 0 })
  const [balance, setBalance] = useState(10)
  const [betHistory, setBetHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [autoBetEnabled, setAutoBetEnabled] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [authForm, setAuthForm] = useState({ apiKeyId: '', privateKey: '' })
  const [authError, setAuthError] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)

  // Fetch opportunities
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/opportunities`)
      const data = await res.json()

      if (data.success) {
        setOpportunities(data.opportunities || [])
        setPrices(data.prices || { BTC: 0, ETH: 0 })
        setError(null)
      }
    } catch (err) {
      setError('Failed to fetch opportunities')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch portfolio
  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/portfolio`)
      const data = await res.json()

      if (data.success) {
        setBalance(data.balance || 10)
        setBetHistory(data.betHistory || [])
        setIsAuthenticated(!data.simulated)
      }
    } catch (err) {
      console.error('Portfolio fetch error:', err)
    }
  }, [])

  // Check auth status
  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/status`)
      const data = await res.json()
      setIsAuthenticated(data.isAuthenticated)
    } catch (err) {}
  }, [])

  // Initial load
  useEffect(() => {
    fetchOpportunities()
    fetchPortfolio()
    checkAuth()

    // Refresh every 15 seconds
    const interval = setInterval(() => {
      fetchOpportunities()
      fetchPortfolio()
    }, 15000)

    return () => clearInterval(interval)
  }, [fetchOpportunities, fetchPortfolio, checkAuth])

  // Place a bet
  const placeBet = async (opp) => {
    try {
      const res = await fetch(`${API_BASE}/api/bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: opp.ticker,
          side: opp.betSide,
          amount: (opp.recommendedBet || 100) / 100
        })
      })
      const data = await res.json()

      if (data.success) {
        setBalance(data.newBalance)
        fetchPortfolio()
        fetchOpportunities()
      } else {
        alert(data.error || 'Bet failed')
      }
    } catch (err) {
      alert('Error placing bet')
    }
  }

  // Auto-bet
  const placeAutoBet = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/auto-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      const data = await res.json()

      if (data.success && data.bet) {
        setBalance(data.newBalance)
        fetchPortfolio()
        fetchOpportunities()
      } else if (data.message) {
        alert(data.message)
      }
    } catch (err) {
      alert('Error in auto-bet')
    }
  }

  // Toggle continuous auto-betting
  const toggleAutoBet = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/auto-bet/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !autoBetEnabled,
          intervalSeconds: 60
        })
      })
      const data = await res.json()

      if (data.success) {
        setAutoBetEnabled(data.enabled)
      }
    } catch (err) {
      alert('Error toggling auto-bet')
    }
  }

  // Auth handlers
  const handleAuth = async (e) => {
    e.preventDefault()
    setAuthLoading(true)
    setAuthError(null)

    try {
      const res = await fetch(`${API_BASE}/api/auth/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      })
      const data = await res.json()

      if (data.success) {
        setIsAuthenticated(true)
        setBalance(data.balance)
        setShowAuth(false)
        setAuthForm({ apiKeyId: '', privateKey: '' })
      } else {
        setAuthError(data.error)
      }
    } catch (err) {
      setAuthError('Connection failed')
    } finally {
      setAuthLoading(false)
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1 className="logo">SHIMI</h1>
          <span className="subtitle">Crypto Bot</span>
        </div>
        <div className="header-right">
          <div className="balance-badge">
            {!isAuthenticated && <span className="sim-tag">SIM</span>}
            <span className="balance-amount">{formatCurrency(balance)}</span>
          </div>
        </div>
      </header>

      {/* Live Prices - Scrollable */}
      <div className="price-ticker">
        <div className="ticker-scroll">
          {Object.entries(prices).filter(([_, p]) => p > 0).slice(0, 8).map(([token, price]) => (
            <div
              key={token}
              className="ticker-item"
              style={{ '--token-color': TOKEN_COLORS[token] || '#888' }}
            >
              <span className="ticker-label">{token}</span>
              <span className="ticker-price">{formatPrice(price)}</span>
            </div>
          ))}
        </div>
        <div className="ticker-status">
          <span className={`status-dot ${loading ? '' : 'live'}`}></span>
          {Object.keys(prices).length}
        </div>
      </div>

      {/* Tabs */}
      <nav className="tabs">
        <button
          className={`tab ${tab === 'bets' ? 'active' : ''}`}
          onClick={() => setTab('bets')}
        >
          OPPORTUNITIES
        </button>
        <button
          className={`tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
        >
          HISTORY
        </button>
        <button
          className={`tab ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          SETTINGS
        </button>
      </nav>

      {/* Error Banner */}
      {error && (
        <div className="error-banner" onClick={fetchOpportunities}>
          {error}
          <span className="retry">Tap to retry</span>
        </div>
      )}

      {/* Main Content */}
      <main className="main">
        {/* Bets Tab */}
        {tab === 'bets' && (
          <div className="bets-view">
            {/* Auto-bet controls */}
            <div className="auto-controls">
              <button
                className="auto-bet-now"
                onClick={placeAutoBet}
                disabled={opportunities.length === 0}
              >
                PLACE BEST BET NOW
              </button>
              <button
                className={`auto-toggle ${autoBetEnabled ? 'active' : ''}`}
                onClick={toggleAutoBet}
              >
                {autoBetEnabled ? 'STOP AUTO' : 'AUTO 1m'}
              </button>
            </div>

            {/* Loading */}
            {loading && (
              <div className="loading">
                <div className="spinner"></div>
                <p>Scanning crypto markets...</p>
              </div>
            )}

            {/* No opportunities */}
            {!loading && opportunities.length === 0 && (
              <div className="empty-state">
                <p>No opportunities with edge found</p>
                <span className="hint">
                  Waiting for markets where our probability differs from Kalshi's price...
                </span>
              </div>
            )}

            {/* Opportunities */}
            {!loading && opportunities.length > 0 && (
              <div className="opps-grid">
                {opportunities.map(opp => (
                  <OpportunityCard
                    key={opp.ticker}
                    opp={opp}
                    onBet={placeBet}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* History Tab */}
        {tab === 'history' && (
          <div className="history-view">
            <h2>Bet History</h2>
            {betHistory.length === 0 ? (
              <div className="empty-state">
                <p>No bets yet</p>
                <span className="hint">Place your first bet to see history</span>
              </div>
            ) : (
              <div className="history-list">
                {betHistory.map(bet => (
                  <HistoryItem key={bet.id} bet={bet} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings Tab */}
        {tab === 'settings' && (
          <div className="settings-view">
            <div className="settings-section">
              <h2>Account</h2>
              {isAuthenticated ? (
                <div className="connected-section">
                  <p className="connected-status">Connected to Kalshi</p>
                  <p>Real money betting enabled</p>
                </div>
              ) : (
                <div className="connect-section">
                  <p>Connect your Kalshi account to place real bets</p>
                  <button className="connect-btn" onClick={() => setShowAuth(true)}>
                    Connect Kalshi API
                  </button>
                </div>
              )}
            </div>

            <div className="settings-section">
              <h2>How It Works</h2>
              <p className="how-it-works">
                Shimi tracks live BTC and ETH prices from Binance every 10 seconds,
                calculates 15-minute volatility, and estimates the actual probability
                of hitting Kalshi's strike prices.
              </p>
              <p className="how-it-works">
                When our calculated probability differs from Kalshi's market price,
                that's <strong>edge</strong>. We only bet when edge exceeds 5%.
              </p>
            </div>

            <div className="settings-section">
              <h2>Current Settings</h2>
              <div className="settings-info">
                <div className="setting-item">
                  <span>Bankroll</span>
                  <span>{formatCurrency(balance)}</span>
                </div>
                <div className="setting-item">
                  <span>Min Edge Required</span>
                  <span>5%</span>
                </div>
                <div className="setting-item">
                  <span>Auto-bet Status</span>
                  <span>{autoBetEnabled ? 'Running (1m)' : 'Stopped'}</span>
                </div>
                <div className="setting-item">
                  <span>Mode</span>
                  <span>{isAuthenticated ? 'Real Money' : 'Simulation'}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        <button className="refresh-btn" onClick={() => {
          setLoading(true)
          fetchOpportunities()
        }}>
          Refresh
        </button>
      </footer>

      {/* Auth Modal */}
      {showAuth && (
        <div className="modal-overlay" onClick={() => setShowAuth(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Connect Kalshi</h2>
            <p>Enter your API credentials from kalshi.com/account/api</p>

            {authError && <div className="auth-error">{authError}</div>}

            <form onSubmit={handleAuth}>
              <div className="form-group">
                <label>API Key ID</label>
                <input
                  type="text"
                  value={authForm.apiKeyId}
                  onChange={e => setAuthForm(f => ({ ...f, apiKeyId: e.target.value }))}
                  placeholder="Your API key ID"
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label>Private Key (PEM format)</label>
                <textarea
                  value={authForm.privateKey}
                  onChange={e => setAuthForm(f => ({ ...f, privateKey: e.target.value }))}
                  placeholder="-----BEGIN PRIVATE KEY-----..."
                  rows={6}
                />
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowAuth(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={authLoading}>
                  {authLoading ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
