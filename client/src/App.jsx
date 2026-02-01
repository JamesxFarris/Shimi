import { useState, useEffect, useCallback, memo } from 'react'
import './index.css'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:3001'

// All tracked tokens with their colors and icons
const TOKEN_CONFIG = {
  BTC: { color: '#f7931a', name: 'Bitcoin', icon: '₿' },
  ETH: { color: '#627eea', name: 'Ethereum', icon: 'Ξ' },
  SOL: { color: '#14f195', name: 'Solana', icon: '◎' },
  XRP: { color: '#23292f', name: 'XRP', icon: '✕' },
  DOGE: { color: '#c2a633', name: 'Dogecoin', icon: 'Ð' },
  ADA: { color: '#0033ad', name: 'Cardano', icon: '₳' },
  AVAX: { color: '#e84142', name: 'Avalanche', icon: 'A' },
  LINK: { color: '#2a5ada', name: 'Chainlink', icon: '⬡' },
  MATIC: { color: '#8247e5', name: 'Polygon', icon: 'Ⓜ' },
  DOT: { color: '#e6007a', name: 'Polkadot', icon: '●' },
  SHIB: { color: '#ffa409', name: 'Shiba', icon: '🐕' },
  LTC: { color: '#345d9d', name: 'Litecoin', icon: 'Ł' },
  UNI: { color: '#ff007a', name: 'Uniswap', icon: '🦄' },
  ATOM: { color: '#2e3148', name: 'Cosmos', icon: '⚛' },
  APT: { color: '#4cd8af', name: 'Aptos', icon: 'A' }
}

// Format helpers
const formatCurrency = (val) => `$${parseFloat(val || 0).toFixed(2)}`
const formatPercent = (val) => `${parseFloat(val || 0).toFixed(1)}%`

// Format price with proper decimal places
const formatPrice = (val, token) => {
  if (!val) return '$0.00'
  const num = parseFloat(val)

  // Very small prices (SHIB, DOGE etc)
  if (num < 0.01) return `$${num.toFixed(6)}`
  if (num < 1) return `$${num.toFixed(4)}`
  if (num < 100) return `$${num.toFixed(2)}`
  if (num < 10000) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Large prices (BTC, ETH)
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Price Ticker Item - shows price with change indicator
const PriceTickerItem = memo(({ token, price, prevPrice }) => {
  const config = TOKEN_CONFIG[token] || { color: '#888', name: token, icon: '?' }

  // Determine price change direction
  const priceChange = prevPrice ? price - prevPrice : 0
  const changeClass = priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : ''

  return (
    <div className={`ticker-item ${changeClass}`} style={{ '--token-color': config.color }}>
      <div className="ticker-icon">{config.icon}</div>
      <div className="ticker-info">
        <span className="ticker-symbol">{token}</span>
        <span className={`ticker-price ${changeClass}`}>{formatPrice(price, token)}</span>
      </div>
      {changeClass && <span className="ticker-change-indicator">{priceChange > 0 ? '▲' : '▼'}</span>}
    </div>
  )
})

// Opportunity Card
const OpportunityCard = memo(({ opp, onBet, isPlacing }) => {
  const config = TOKEN_CONFIG[opp.cryptoType] || { color: '#888', name: opp.cryptoType, icon: '?' }

  return (
    <div className={`opp-card ${opp.isObviousBet ? 'safe-bet' : ''}`}>
      {/* Card Header */}
      <div className="opp-header">
        <div className="opp-token">
          <div className="token-icon" style={{ background: `${config.color}20`, color: config.color }}>
            {config.icon}
          </div>
          <div className="token-info">
            <span className="token-symbol">{opp.cryptoType}</span>
            <span className="token-name">{config.name}</span>
          </div>
        </div>
        <div className="opp-badges">
          {opp.isObviousBet && <span className="badge safe">HIGH CONF</span>}
          <span className="badge time">{opp.timeRemainingFormatted}</span>
        </div>
      </div>

      {/* Market Title */}
      <div className="opp-title">{opp.title}</div>

      {/* Price Comparison */}
      <div className="price-comparison">
        <div className="price-box current">
          <span className="price-label">Current</span>
          <span className="price-value">{formatPrice(opp.currentPrice, opp.cryptoType)}</span>
        </div>
        <div className="price-arrow">
          <span className={parseFloat(opp.pctFromStrike) >= 0 ? 'up' : 'down'}>
            {parseFloat(opp.pctFromStrike) >= 0 ? '↑' : '↓'}
          </span>
          <span className={`pct ${parseFloat(opp.pctFromStrike) >= 0 ? 'up' : 'down'}`}>
            {opp.pctFromStrike > 0 ? '+' : ''}{opp.pctFromStrike}%
          </span>
        </div>
        <div className="price-box strike">
          <span className="price-label">Strike</span>
          <span className="price-value">{formatPrice(opp.strikePrice, opp.cryptoType)}</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        <div className="stat-box">
          <span className="stat-label">Win Probability</span>
          <span className="stat-value highlight">{opp.winProbability}%</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Market Price</span>
          <span className="stat-value">{(opp.betPrice * 100).toFixed(0)}¢</span>
        </div>
        <div className="stat-box edge">
          <span className="stat-label">Your Edge</span>
          <span className="stat-value">+{formatPercent(opp.edge)}</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">Profit if Win</span>
          <span className="stat-value">{opp.profitIfWin}¢</span>
        </div>
      </div>

      {/* Analysis Bar */}
      <div className="analysis-bar">
        <div className="analysis-item">
          <span className={`momentum-icon ${opp.momentum}`}>
            {opp.momentum === 'up' ? '📈' : opp.momentum === 'down' ? '📉' : '➡️'}
          </span>
          <span className="analysis-text">{opp.momentumStrength}</span>
        </div>
        <div className="analysis-item">
          <span className="analysis-icon">🎯</span>
          <span className="analysis-text">{opp.confidence}</span>
        </div>
        <div className="analysis-item">
          <span className="analysis-icon">📊</span>
          <span className="analysis-text">{opp.dataPoints} points</span>
        </div>
      </div>

      {/* Recommendation */}
      <div className="recommendation">
        <div className={`rec-side ${opp.betSide?.toLowerCase()}`}>
          BET {opp.betSide}
        </div>
        <div className="rec-reason">{opp.betReason}</div>
      </div>

      {/* Action Button */}
      <button
        className={`bet-btn ${isPlacing ? 'loading' : ''} ${opp.betSide?.toLowerCase()}`}
        onClick={() => onBet(opp)}
        disabled={isPlacing}
      >
        {isPlacing ? (
          <span className="btn-loading">Placing bet...</span>
        ) : (
          <>
            <span className="btn-action">Buy {opp.contractsFor1Dollar || 1}× @ {opp.betPriceCents || Math.round(opp.betPrice * 100)}¢</span>
            <span className="btn-profit">Win +{opp.profitIfWin}¢</span>
          </>
        )}
      </button>
    </div>
  )
})

// History Item - Shows bet with clear win/loss and profit/loss
const HistoryItem = memo(({ bet }) => {
  const totalCostCents = bet.totalCost || (bet.count * bet.price) || 0
  const profitCents = bet.profit || 0

  // Determine outcome display
  const hasOutcome = bet.outcome === 'won' || bet.outcome === 'lost'
  const isWin = bet.outcome === 'won'

  // Calculate payout for wins (cost + profit)
  const payoutCents = isWin ? totalCostCents + profitCents : 0

  return (
    <div className={`history-card ${hasOutcome ? (isWin ? 'won' : 'lost') : 'pending'}`}>
      {/* Result Banner */}
      <div className={`result-banner ${hasOutcome ? (isWin ? 'won' : 'lost') : 'pending'}`}>
        {hasOutcome ? (
          <>
            <span className="result-icon">{isWin ? '✓' : '✗'}</span>
            <span className="result-text">{isWin ? 'WON' : 'LOST'}</span>
            <span className={`result-amount ${isWin ? 'positive' : 'negative'}`}>
              {isWin ? '+' : '-'}{formatCurrency(Math.abs(profitCents) / 100)}
            </span>
          </>
        ) : (
          <>
            <span className="result-icon">⏳</span>
            <span className="result-text">PENDING</span>
            <span className="result-amount">Awaiting result</span>
          </>
        )}
      </div>

      {/* Bet Details */}
      <div className="bet-details">
        <div className="bet-market">
          <span className="bet-title">{bet.title}</span>
          <span className="bet-time">{new Date(bet.timestamp).toLocaleString()}</span>
        </div>
        <div className="bet-info-row">
          <div className="bet-info-item">
            <span className="bet-info-label">Side</span>
            <span className={`side-badge ${bet.side}`}>{bet.side?.toUpperCase()}</span>
          </div>
          <div className="bet-info-item">
            <span className="bet-info-label">Price</span>
            <span className="bet-info-value">{bet.price || 0}¢</span>
          </div>
          <div className="bet-info-item">
            <span className="bet-info-label">Contracts</span>
            <span className="bet-info-value">{bet.count || 1}</span>
          </div>
          <div className="bet-info-item">
            <span className="bet-info-label">Total Cost</span>
            <span className="bet-info-value">{formatCurrency(totalCostCents / 100)}</span>
          </div>
          {hasOutcome && (
            <div className="bet-info-item">
              <span className="bet-info-label">{isWin ? 'Payout' : 'Lost'}</span>
              <span className={`bet-info-value ${isWin ? 'positive' : 'negative'}`}>
                {isWin ? formatCurrency(payoutCents / 100) : formatCurrency(totalCostCents / 100)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

// Stats Card
const StatsCard = ({ title, value, subtitle, icon, color }) => (
  <div className="stats-card" style={{ '--card-color': color }}>
    <div className="stats-card-icon">{icon}</div>
    <div className="stats-card-content">
      <span className="stats-card-value">{value}</span>
      <span className="stats-card-title">{title}</span>
      {subtitle && <span className="stats-card-subtitle">{subtitle}</span>}
    </div>
  </div>
)

function App() {
  const [tab, setTab] = useState('dashboard')
  const [opportunities, setOpportunities] = useState([])
  const [prices, setPrices] = useState({})
  const [prevPrices, setPrevPrices] = useState({})
  const [priceLastUpdated, setPriceLastUpdated] = useState(null)
  const [balance, setBalance] = useState(10)
  const [betHistory, setBetHistory] = useState([])
  const [betStats, setBetStats] = useState({ totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [autoBetEnabled, setAutoBetEnabled] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [authForm, setAuthForm] = useState({ apiKeyId: '', privateKey: '' })
  const [authError, setAuthError] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [betStatus, setBetStatus] = useState(null)
  const [placingBet, setPlacingBet] = useState(null)
  const [tickerTime, setTickerTime] = useState(Date.now())

  // Fetch prices directly (faster updates)
  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/prices`)
      const data = await res.json()

      if (data.success && data.prices) {
        // Extract just the price values
        const newPrices = {}
        for (const [token, info] of Object.entries(data.prices)) {
          newPrices[token] = info.price
        }

        // Store previous prices before updating
        setPrevPrices(prev => {
          const updated = { ...prev }
          for (const token of Object.keys(newPrices)) {
            if (prices[token] !== undefined) {
              updated[token] = prices[token]
            }
          }
          return updated
        })

        setPrices(newPrices)
        setPriceLastUpdated(Date.now())
      }
    } catch (err) {
      console.error('Price fetch error:', err)
    }
  }, [prices])

  // Fetch opportunities
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/opportunities`)
      const data = await res.json()

      if (data.success) {
        setOpportunities(data.opportunities || [])
        // Also update prices from opportunities as backup
        if (data.prices) {
          setPrices(prev => ({ ...prev, ...data.prices }))
          setPriceLastUpdated(Date.now())
        }
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
        setBetStats(data.stats || { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
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
    // Fetch everything on initial load
    fetchPrices()
    fetchOpportunities()
    fetchPortfolio()
    checkAuth()

    // Fetch prices every 3 seconds for live ticker updates
    const priceInterval = setInterval(() => {
      fetchPrices()
    }, 3000)

    // Refresh opportunities every 5 seconds
    const oppInterval = setInterval(() => {
      fetchOpportunities()
    }, 5000)

    // Refresh portfolio less frequently (every 30 seconds)
    const portfolioInterval = setInterval(() => {
      fetchPortfolio()
    }, 30000)

    // Update ticker time display every second
    const tickerTimeInterval = setInterval(() => {
      setTickerTime(Date.now())
    }, 1000)

    return () => {
      clearInterval(priceInterval)
      clearInterval(oppInterval)
      clearInterval(portfolioInterval)
      clearInterval(tickerTimeInterval)
    }
  }, [fetchPrices, fetchOpportunities, fetchPortfolio, checkAuth])

  // Place a bet
  const placeBet = async (opp) => {
    setPlacingBet(opp.ticker)
    setBetStatus(null)

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

      // Try to parse JSON response
      let data
      try {
        data = await res.json()
      } catch (parseErr) {
        setBetStatus({ type: 'error', message: `Server error (${res.status})` })
        return
      }

      if (data.success) {
        setBalance(data.newBalance)
        setBetStatus({
          type: 'success',
          message: `Bet placed: ${opp.betSide} on ${opp.cryptoType} @ ${(opp.betPrice * 100).toFixed(0)}¢${data.simulated ? ' (simulated)' : ''}`
        })
        fetchPortfolio()
        fetchOpportunities()
      } else {
        setBetStatus({ type: 'error', message: data.error || 'Bet failed' })
      }
    } catch (err) {
      console.error('Bet error:', err)
      setBetStatus({ type: 'error', message: `Network error: ${err.message}` })
    } finally {
      setPlacingBet(null)
      setTimeout(() => setBetStatus(null), 8000)
    }
  }

  // Auto-bet
  const placeAutoBet = async () => {
    setPlacingBet('auto')
    setBetStatus(null)

    try {
      const res = await fetch(`${API_BASE}/api/crypto/auto-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      // Try to parse JSON response
      let data
      try {
        data = await res.json()
      } catch (parseErr) {
        setBetStatus({ type: 'error', message: `Server error (${res.status})` })
        return
      }

      if (data.success && data.bet) {
        setBalance(data.newBalance)
        const bet = data.bet
        setBetStatus({
          type: 'success',
          message: `Bet placed: ${bet.side.toUpperCase()} on ${bet.cryptoType} @ ${bet.price}¢${data.simulated ? ' (simulated)' : ''}`
        })
        fetchPortfolio()
        fetchOpportunities()
      } else if (data.error) {
        setBetStatus({ type: 'error', message: data.error })
      } else if (data.message) {
        setBetStatus({ type: 'info', message: data.message })
      }
    } catch (err) {
      console.error('Auto-bet error:', err)
      setBetStatus({ type: 'error', message: `Network error: ${err.message}` })
    } finally {
      setPlacingBet(null)
      setTimeout(() => setBetStatus(null), 8000)
    }
  }

  // Toggle continuous auto-betting
  const toggleAutoBet = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/auto-bet/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoBetEnabled, intervalSeconds: 15 })
      })
      const data = await res.json()
      if (data.success) setAutoBetEnabled(data.enabled)
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

  // Calculate stats
  const totalBets = betHistory.length
  const winningBets = betHistory.filter(b => b.status === 'won').length
  const totalWagered = betHistory.reduce((sum, b) => sum + (b.totalCost || 0), 0) / 100
  const avgEdge = opportunities.length > 0
    ? opportunities.reduce((sum, o) => sum + (o.edge || 0), 0) / opportunities.length
    : 0

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="logo">SHIMI</h1>
          <span className="logo-subtitle">Crypto Prediction Bot</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
            <span className="nav-icon">📊</span>
            <span className="nav-text">Dashboard</span>
          </button>
          <button className={`nav-item ${tab === 'opportunities' ? 'active' : ''}`} onClick={() => setTab('opportunities')}>
            <span className="nav-icon">🎯</span>
            <span className="nav-text">Opportunities</span>
            {opportunities.length > 0 && <span className="nav-badge">{opportunities.length}</span>}
          </button>
          <button className={`nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            <span className="nav-icon">📜</span>
            <span className="nav-text">History</span>
          </button>
          <button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <span className="nav-icon">⚙️</span>
            <span className="nav-text">Settings</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="balance-display">
            <span className="balance-label">
              {isAuthenticated ? 'Live Balance' : 'Simulated'}
            </span>
            <span className="balance-value">{formatCurrency(balance)}</span>
          </div>
          <div className={`connection-status ${isAuthenticated ? 'connected' : 'simulated'}`}>
            <span className="status-dot"></span>
            <span>{isAuthenticated ? 'Connected to Kalshi' : 'Simulation Mode'}</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {/* Top Bar */}
        <header className="top-bar">
          <div className="top-bar-left">
            <h2 className="page-title">
              {tab === 'dashboard' && 'Dashboard'}
              {tab === 'opportunities' && 'Betting Opportunities'}
              {tab === 'history' && 'Bet History'}
              {tab === 'settings' && 'Settings'}
            </h2>
          </div>
          <div className="top-bar-right">
            <button className="refresh-btn" onClick={() => { setLoading(true); fetchOpportunities() }}>
              <span className="refresh-icon">↻</span>
              Refresh
            </button>
          </div>
        </header>

        {/* Price Ticker */}
        <div className="price-ticker-container">
          <div className="price-ticker">
            {Object.entries(prices)
              .filter(([_, p]) => p > 0)
              .sort(([a], [b]) => {
                const order = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'MATIC', 'DOT', 'SHIB', 'LTC', 'UNI', 'ATOM', 'APT']
                return order.indexOf(a) - order.indexOf(b)
              })
              .map(([token, price]) => (
                <PriceTickerItem
                  key={`${token}-${price}`}
                  token={token}
                  price={price}
                  prevPrice={prevPrices[token]}
                />
              ))}
          </div>
          <div className="ticker-fade-left"></div>
          <div className="ticker-fade-right"></div>
          <div className="ticker-status">
            <span className={`status-indicator ${priceLastUpdated ? 'live' : ''}`}></span>
            <span className="status-text">
              {Object.keys(prices).filter(k => prices[k] > 0).length} tokens
              {priceLastUpdated && ` • ${Math.floor((tickerTime - priceLastUpdated) / 1000)}s ago`}
            </span>
          </div>
        </div>

        {/* Status Banner */}
        {betStatus && (
          <div className={`status-banner ${betStatus.type}`} onClick={() => setBetStatus(null)}>
            <span className="status-icon">
              {betStatus.type === 'success' ? '✓' : betStatus.type === 'error' ? '✕' : 'ℹ'}
            </span>
            <span className="status-message">{betStatus.message}</span>
            <button className="status-close">×</button>
          </div>
        )}

        {/* Content Area */}
        <div className="content-area">
          {/* Dashboard Tab */}
          {tab === 'dashboard' && (
            <div className="dashboard">
              {/* Quick Stats */}
              <div className="stats-row">
                <StatsCard
                  title="Balance"
                  value={formatCurrency(balance)}
                  subtitle={isAuthenticated ? 'Live' : 'Simulated'}
                  icon="💰"
                  color="#00ff88"
                />
                <StatsCard
                  title="Opportunities"
                  value={opportunities.length}
                  subtitle="Markets with edge"
                  icon="🎯"
                  color="#a855f7"
                />
                <StatsCard
                  title="Avg Edge"
                  value={`+${avgEdge.toFixed(1)}%`}
                  subtitle="Current markets"
                  icon="📈"
                  color="#4da6ff"
                />
                <StatsCard
                  title="Total Bets"
                  value={totalBets}
                  subtitle={`$${totalWagered.toFixed(2)} wagered`}
                  icon="🎰"
                  color="#ffd700"
                />
              </div>

              {/* Quick Actions */}
              <div className="quick-actions">
                <h3 className="section-title">Quick Actions</h3>
                <div className="action-buttons">
                  <button
                    className={`action-btn primary ${placingBet === 'auto' ? 'loading' : ''}`}
                    onClick={placeAutoBet}
                    disabled={opportunities.length === 0 || placingBet}
                  >
                    <span className="action-icon">⚡</span>
                    <span className="action-text">
                      {placingBet === 'auto' ? 'Placing...' : 'Place Best Bet Now'}
                    </span>
                  </button>
                  <button
                    className={`action-btn ${autoBetEnabled ? 'danger' : 'secondary'}`}
                    onClick={toggleAutoBet}
                  >
                    <span className="action-icon">{autoBetEnabled ? '⏹' : '▶'}</span>
                    <span className="action-text">
                      {autoBetEnabled ? 'Stop Auto-Bet' : 'Start Auto-Bet (15s)'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Top Opportunities Preview */}
              <div className="top-opportunities">
                <div className="section-header">
                  <h3 className="section-title">Top Opportunities</h3>
                  <button className="view-all-btn" onClick={() => setTab('opportunities')}>
                    View All →
                  </button>
                </div>

                {loading && (
                  <div className="loading-state">
                    <div className="spinner"></div>
                    <p>Scanning crypto markets...</p>
                  </div>
                )}

                {!loading && opportunities.length === 0 && (
                  <div className="empty-state">
                    <span className="empty-icon">🔍</span>
                    <p>No opportunities with edge found</p>
                    <span className="empty-hint">Waiting for price mispricings...</span>
                  </div>
                )}

                {!loading && opportunities.length > 0 && (
                  <div className="opportunities-preview">
                    {opportunities.slice(0, 3).map(opp => (
                      <OpportunityCard
                        key={opp.ticker}
                        opp={opp}
                        onBet={placeBet}
                        isPlacing={placingBet === opp.ticker}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Opportunities Tab */}
          {tab === 'opportunities' && (
            <div className="opportunities-page">
              <div className="page-actions">
                <button
                  className={`action-btn primary ${placingBet === 'auto' ? 'loading' : ''}`}
                  onClick={placeAutoBet}
                  disabled={opportunities.length === 0 || placingBet}
                >
                  <span className="action-icon">⚡</span>
                  {placingBet === 'auto' ? 'Placing...' : 'Place Best Bet'}
                </button>
                <button
                  className={`action-btn ${autoBetEnabled ? 'danger' : 'secondary'}`}
                  onClick={toggleAutoBet}
                >
                  <span className="action-icon">{autoBetEnabled ? '⏹' : '▶'}</span>
                  {autoBetEnabled ? 'Stop Auto' : 'Auto 15s'}
                </button>
              </div>

              {loading && (
                <div className="loading-state">
                  <div className="spinner"></div>
                  <p>Scanning crypto markets...</p>
                </div>
              )}

              {!loading && opportunities.length === 0 && (
                <div className="empty-state large">
                  <span className="empty-icon">🔍</span>
                  <h3>No Opportunities Found</h3>
                  <p>Waiting for markets where our probability differs from Kalshi's price...</p>
                </div>
              )}

              {!loading && opportunities.length > 0 && (
                <div className="opportunities-grid">
                  {opportunities.map(opp => (
                    <OpportunityCard
                      key={opp.ticker}
                      opp={opp}
                      onBet={placeBet}
                      isPlacing={placingBet === opp.ticker}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* History Tab */}
          {tab === 'history' && (
            <div className="history-page">
              {/* Stats Summary */}
              {betStats.totalBets > 0 && (
                <div className="history-stats">
                  <div className={`stat-summary ${betStats.totalProfit >= 0 ? 'positive' : 'negative'}`}>
                    <span className="stat-label">Total P/L</span>
                    <span className="stat-value">
                      {betStats.totalProfit >= 0 ? '+' : ''}{formatCurrency(betStats.totalProfit)}
                    </span>
                  </div>
                  <div className="stat-summary">
                    <span className="stat-label">Win Rate</span>
                    <span className="stat-value">{betStats.winRate}%</span>
                  </div>
                  <div className="stat-summary wins">
                    <span className="stat-label">Wins</span>
                    <span className="stat-value">{betStats.wins}</span>
                  </div>
                  <div className="stat-summary losses">
                    <span className="stat-label">Losses</span>
                    <span className="stat-value">{betStats.losses}</span>
                  </div>
                </div>
              )}

              {betHistory.length === 0 ? (
                <div className="empty-state large">
                  <span className="empty-icon">📜</span>
                  <h3>No Bet History</h3>
                  <p>Place your first bet to see history here</p>
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
            <div className="settings-page">
              <div className="settings-grid">
                {/* Account Section */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Account</h3>
                  {isAuthenticated ? (
                    <div className="connected-info">
                      <div className="connected-badge">
                        <span className="connected-dot"></span>
                        Connected to Kalshi
                      </div>
                      <p>Real money betting is enabled</p>
                    </div>
                  ) : (
                    <div className="connect-prompt">
                      <p>Connect your Kalshi account to place real bets</p>
                      <button className="connect-btn" onClick={() => setShowAuth(true)}>
                        Connect Kalshi API
                      </button>
                    </div>
                  )}
                </div>

                {/* Current Settings */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Current Configuration</h3>
                  <div className="settings-list">
                    <div className="settings-item">
                      <span className="settings-label">Bankroll</span>
                      <span className="settings-value">{formatCurrency(balance)}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Bet Amount</span>
                      <span className="settings-value">$1.00 fixed</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Min Edge (High Conf)</span>
                      <span className="settings-value">0.5%</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Min Edge (Normal)</span>
                      <span className="settings-value">3%</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Auto-bet Status</span>
                      <span className={`settings-value ${autoBetEnabled ? 'active' : ''}`}>
                        {autoBetEnabled ? 'Running' : 'Stopped'}
                      </span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Mode</span>
                      <span className={`settings-value ${isAuthenticated ? 'live' : ''}`}>
                        {isAuthenticated ? 'Live' : 'Simulation'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* How It Works */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">How It Works</h3>
                  <div className="how-it-works">
                    <div className="step">
                      <span className="step-number">1</span>
                      <div className="step-content">
                        <h4>Track Prices</h4>
                        <p>We monitor 15 cryptocurrencies via CoinGecko every 10 seconds, tracking price movements and calculating volatility.</p>
                      </div>
                    </div>
                    <div className="step">
                      <span className="step-number">2</span>
                      <div className="step-content">
                        <h4>Analyze Markets</h4>
                        <p>We fetch Kalshi's 15-minute crypto markets and calculate the true probability of each outcome using our statistical model.</p>
                      </div>
                    </div>
                    <div className="step">
                      <span className="step-number">3</span>
                      <div className="step-content">
                        <h4>Find Edge</h4>
                        <p>When our calculated probability differs from Kalshi's price, that's your edge. We only show bets with positive expected value.</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Tracked Tokens */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">Tracked Cryptocurrencies</h3>
                  <div className="tokens-grid">
                    {Object.entries(TOKEN_CONFIG).map(([token, config]) => (
                      <div key={token} className="token-item" style={{ '--token-color': config.color }}>
                        <span className="token-icon">{config.icon}</span>
                        <span className="token-symbol">{token}</span>
                        <span className="token-name">{config.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="mobile-nav">
        <button className={`mobile-nav-item ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
          <span>📊</span>
          <span>Dashboard</span>
        </button>
        <button className={`mobile-nav-item ${tab === 'opportunities' ? 'active' : ''}`} onClick={() => setTab('opportunities')}>
          <span>🎯</span>
          <span>Bets</span>
        </button>
        <button className={`mobile-nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
          <span>📜</span>
          <span>History</span>
        </button>
        <button className={`mobile-nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          <span>⚙️</span>
          <span>Settings</span>
        </button>
      </nav>

      {/* Auth Modal */}
      {showAuth && (
        <div className="modal-overlay" onClick={() => setShowAuth(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Connect Kalshi</h2>
              <button className="modal-close" onClick={() => setShowAuth(false)}>×</button>
            </div>
            <p className="modal-description">Enter your API credentials from kalshi.com/account/api</p>

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
                <button type="button" className="btn-secondary" onClick={() => setShowAuth(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={authLoading}>
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
