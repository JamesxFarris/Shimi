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

// Asset config (crypto only - S&P 500 disabled for now)
const ASSET_CONFIG = {
  ...TOKEN_CONFIG
}

// Opportunity Card - Larger stacked design
const OpportunityCard = memo(({ opp, onBet, isPlacing }) => {
  const assetType = opp.assetType || opp.cryptoType || 'Unknown'
  const config = ASSET_CONFIG[assetType] || { color: '#888', name: assetType, icon: '?' }
  const isIndex = opp.marketCategory === 'index'
  const notRecommended = opp.isRecommended === false
  const isLocked = opp.isLocked === true
  const isDegen = opp.isDegen === true
  const isSafe = opp.isSafe === true
  const pctFromStrike = parseFloat(opp.pctFromStrike) || 0

  return (
    <div className={`opp-card ${opp.isObviousBet ? 'safe-bet' : ''} ${isIndex ? 'index-market' : ''} ${notRecommended ? 'no-edge' : ''} ${isLocked ? 'locked' : ''} ${isDegen ? 'degen' : ''} ${isSafe ? 'safe' : ''}`}>
      {/* DEGEN badge */}
      {isDegen && !isLocked && (
        <div className="degen-badge">
          <span className="degen-icon">🎲</span>
          <span className="degen-text">DEGEN</span>
        </div>
      )}

      {/* SAFE badge */}
      {isSafe && !isLocked && (
        <div className="safe-badge">
          <span className="safe-icon">✓</span>
          <span className="safe-text">SAFE</span>
        </div>
      )}

      {/* Locked smoke overlay */}
      {isLocked && (
        <div className="locked-overlay">
          <div className="smoke-effect"></div>
          <div className="locked-icon">🔒</div>
          <div className="locked-text">WAITING FOR SIGNAL</div>
        </div>
      )}

      {/* Header: Token + Time */}
      <div className="opp-header">
        <div className="opp-token">
          <div className="token-icon" style={{ background: `${config.color}20`, color: config.color }}>
            {config.icon}
          </div>
          <div className="token-info">
            <span className="token-symbol">{assetType}</span>
            <span className="token-name">{config.name}</span>
          </div>
        </div>
        <div className="opp-meta">
          {opp.isObviousBet && !notRecommended && <span className="high-conf-dot" title="High Confidence"></span>}
          <span className="time-badge">{opp.timeRemainingFormatted || 'Scanning...'}</span>
        </div>
      </div>

      {/* Stacked Stats */}
      <div className="stacked-stats">
        {/* Win Probability - Most Important */}
        <div className="stat-row win-prob">
          <span className="stat-label">Win Probability</span>
          <span className="stat-value">{opp.winProbability || '--'}%</span>
        </div>

        {/* Edge */}
        <div className="stat-row edge">
          <span className="stat-label">Your Edge</span>
          <span className="stat-value">{opp.edge > 0 ? '+' : ''}{formatPercent(opp.edge || 0)}%</span>
        </div>

        {/* Price vs Strike */}
        <div className={`stat-row distance ${pctFromStrike >= 0 ? 'above' : 'below'}`}>
          <span className="stat-label">Distance from Strike</span>
          <span className="stat-value">{pctFromStrike >= 0 ? '+' : ''}{opp.pctFromStrike || '0.00'}%</span>
        </div>

        {/* Current → Strike */}
        <div className="stat-row prices">
          <span className="stat-label">Current Price</span>
          <span className="stat-value price-comparison">
            {formatPrice(opp.currentPrice, opp.cryptoType)}
          </span>
        </div>
      </div>

      {/* Action Button */}
      <button
        className={`bet-btn ${isPlacing ? 'loading' : ''} ${opp.betSide?.toLowerCase()} ${notRecommended ? 'disabled-no-edge' : ''}`}
        onClick={() => onBet(opp)}
        disabled={isPlacing || notRecommended || isLocked}
      >
        {isPlacing ? 'Placing...' : isLocked ? (opp.filterReason || 'No signal') : notRecommended ? `${opp.filterReason}` : `BET ${opp.betSide} @ ${opp.betPriceCents || Math.round(opp.betPrice * 100)}¢`}
      </button>
    </div>
  )
})

// Format countdown time
const formatCountdown = (ms) => {
  if (ms <= 0) return 'Settling...'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else {
    return `${seconds}s`
  }
}

// History Item - Shows bet with clear win/loss and profit/loss
const HistoryItem = ({ bet, currentTime }) => {
  const totalCostCents = bet.totalCost || (bet.count * bet.price) || 0
  const profitCents = bet.profit || 0

  // Determine outcome display
  const hasOutcome = bet.outcome === 'won' || bet.outcome === 'lost'
  const isWin = bet.outcome === 'won'

  // Calculate payout for wins (cost + profit)
  const payoutCents = isWin ? totalCostCents + profitCents : 0

  // Calculate time remaining for pending bets
  const closeTime = bet.closeTime ? new Date(bet.closeTime).getTime() : null
  const timeRemaining = closeTime ? closeTime - currentTime : null

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
            {timeRemaining !== null ? (
              <span className={`result-countdown ${timeRemaining < 60000 ? 'urgent' : ''}`}>
                {formatCountdown(timeRemaining)}
              </span>
            ) : (
              <span className="result-amount">Awaiting result</span>
            )}
          </>
        )}
      </div>

      {/* Bet Details */}
      <div className="bet-details">
        <div className="bet-market">
          <span className="bet-title">
            {bet.title}
            {bet.isScaleIn && <span className="scale-in-badge">Scale #{bet.scaleInNumber}</span>}
          </span>
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
}

// Stats Card
const StatsCard = ({ title, value, icon, color }) => (
  <div className="stats-card" style={{ '--card-color': color }}>
    <div className="stats-card-icon">{icon}</div>
    <div className="stats-card-content">
      <span className="stats-card-value">{value}</span>
      <span className="stats-card-title">{title}</span>
    </div>
  </div>
)

// Dollar Stepper - simple +/- buttons for $1 increments
const DollarStepper = ({ value, onChange, min = 1, max = 100, step = 1, label }) => (
  <div className="dollar-stepper">
    {label && <label className="stepper-label">{label}</label>}
    <div className="stepper-controls">
      <button
        className="stepper-btn minus"
        onClick={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
      >
        −
      </button>
      <span className="stepper-value">${value}</span>
      <button
        className="stepper-btn plus"
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
      >
        +
      </button>
    </div>
  </div>
)

function App() {
  const [tab, setTab] = useState('dashboard')
  const [opportunities, setOpportunities] = useState([])
  const [prices, setPrices] = useState({})
  const [prevPrices, setPrevPrices] = useState({})
  const [priceLastUpdated, setPriceLastUpdated] = useState(null)
  const [balance, setBalance] = useState(null) // null = loading
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [betHistory, setBetHistory] = useState([])
  const [betStats, setBetStats] = useState({ totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [autoBetEnabled, setAutoBetEnabled] = useState(false)
  const [scanStatus, setScanStatus] = useState(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [authForm, setAuthForm] = useState({ apiKeyId: '', privateKey: '' })
  const [authError, setAuthError] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [betStatus, setBetStatus] = useState(null)
  const [placingBet, setPlacingBet] = useState(null)
  const [tickerTime, setTickerTime] = useState(Date.now())
  // New: Risk tracking and market filtering
  const [risk, setRisk] = useState({
    current: 0,
    max: 1500,
    remaining: 1500,
    currentDollars: '0.00',
    maxDollars: '15.00'
  })
  const [riskSettings, setRiskSettings] = useState({
    maxPerBet: 500,
    maxTotal: 1500,
    maxPerToken: 500
  })
  const [scaleInSettings, setScaleInSettings] = useState({
    enabled: true,
    minProbabilityIncrease: 15,
    maxBetsPerMarket: 3,
    minTimeBetweenBets: 60000
  })
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [marketFilter, setMarketFilter] = useState('all') // 'all', 'crypto', 'index'
  const [marketStats, setMarketStats] = useState({ totalAnalyzed: 0, recommended: 0, filteredNoEdge: 0, filteredLowProb: 0 })
  // Performance tracking
  const [performance, setPerformance] = useState(null)

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

        // Store previous prices before updating (use functional update to avoid dependency)
        setPrices(currentPrices => {
          setPrevPrices(currentPrices)
          return newPrices
        })
        setPriceLastUpdated(Date.now())
      }
    } catch (err) {
      console.error('Price fetch error:', err)
    }
  }, []) // No dependencies - prevents infinite loop

  // Fetch opportunities (now uses unified endpoint for all market types)
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/opportunities/all`)
      const data = await res.json()

      if (data.success) {
        setOpportunities(data.opportunities || [])
        if (data.stats) setMarketStats(data.stats)
        // Update risk info
        if (data.risk) {
                    setRisk(data.risk)
        }
        // Also update prices from opportunities as backup (crypto only)
        if (data.prices?.crypto) {
          setPrices(prev => ({ ...prev, ...data.prices.crypto }))
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
        setBalance(data.balance || 0)
        setBetHistory(data.betHistory || [])
        setBetStats(data.stats || { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
        setIsAuthenticated(!data.simulated)
      }
    } catch (err) {
      console.error('Portfolio fetch error:', err)
    } finally {
      setBalanceLoading(false)
    }
  }, [])

  // Fetch performance data
  const fetchPerformance = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/performance`)
      const data = await res.json()
      if (data.success) {
        setPerformance(data)
      }
    } catch (err) {
      console.error('Performance fetch error:', err)
    }
  }, [])

  // Fetch scan status (for auto-bet diagnostics)
  const fetchScanStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/scan-status`)
      const data = await res.json()
      if (data.success) {
        setScanStatus(data)
      }
    } catch (err) {
      console.error('Scan status error:', err)
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


  // Initial load - runs once
  useEffect(() => {
    // Fetch everything on initial load
    fetchOpportunities()
    fetchPortfolio()
    checkAuth()

    // Refresh opportunities every 10 seconds (includes prices)
    const oppInterval = setInterval(fetchOpportunities, 10000)

    // Refresh portfolio every 30 seconds
    const portfolioInterval = setInterval(fetchPortfolio, 30000)

    // Update ticker time display every second
    const tickerTimeInterval = setInterval(() => {
      setTickerTime(Date.now())
    }, 1000)

    return () => {
      clearInterval(oppInterval)
      clearInterval(portfolioInterval)
      clearInterval(tickerTimeInterval)
    }
  }, []) // Empty dependency - only runs on mount

  // Poll scan status when auto-bet is enabled
  useEffect(() => {
    if (autoBetEnabled) {
      fetchScanStatus() // Fetch immediately
      const scanInterval = setInterval(fetchScanStatus, 5000) // Poll every 5 seconds
      return () => clearInterval(scanInterval)
    }
  }, [autoBetEnabled, fetchScanStatus])

  // Place a bet
  const placeBet = async (opp) => {
    if (placingBet) return // Prevent double-clicks

    setPlacingBet(opp.ticker)
    setBetStatus(null)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const res = await fetch(`${API_BASE}/api/bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: opp.ticker,
          side: opp.betSide,
          expectedPrice: opp.betPriceCents || Math.round(opp.betPrice * 100)
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      const data = await res.json()

      if (data.success) {
        setBalance(data.newBalance)
        // Update risk if returned
        if (data.risk) {
                    setRisk(data.risk)
        }
        setBetStatus({
          type: 'success',
          message: `Bet placed: ${opp.betSide} on ${opp.cryptoType || opp.assetType}${data.simulated ? ' (simulated)' : ''}`
        })
        // Refresh opportunities after placing a bet
        fetchOpportunities()
      } else {
        setBetStatus({ type: 'error', message: data.error || 'Bet failed - try refreshing' })
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setBetStatus({ type: 'error', message: 'Request timed out' })
      } else {
        setBetStatus({ type: 'error', message: err.message || 'Network error' })
      }
    }

    setPlacingBet(null)
    setTimeout(() => setBetStatus(null), 5000)
  }

  // Auto-bet
  const placeAutoBet = async () => {
    if (placingBet) return // Prevent double-clicks

    setPlacingBet('auto')
    setBetStatus(null)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const res = await fetch(`${API_BASE}/api/crypto/auto-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      const data = await res.json()

      if (data.success && data.bet) {
        setBalance(data.newBalance)
        // Update risk if returned
        if (data.risk) {
                    setRisk(data.risk)
        }
        setBetStatus({
          type: 'success',
          message: `Bet placed: ${data.bet.side.toUpperCase()} on ${data.bet.assetType || data.bet.cryptoType || 'market'}${data.simulated ? ' (simulated)' : ''}`
        })
        // Refresh opportunities after placing a bet
        fetchOpportunities()
      } else if (data.error) {
        setBetStatus({ type: 'error', message: data.error })
      } else if (data.message) {
        setBetStatus({ type: 'info', message: data.message })
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setBetStatus({ type: 'error', message: 'Request timed out' })
      } else {
        setBetStatus({ type: 'error', message: err.message || 'Network error' })
      }
    }

    setPlacingBet(null)
    setTimeout(() => setBetStatus(null), 5000)
  }

  // Toggle continuous auto-betting
  const toggleAutoBet = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/crypto/auto-bet/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoBetEnabled, intervalSeconds: 10 })
      })
      const data = await res.json()
      if (data.success) setAutoBetEnabled(data.enabled)
    } catch (err) {
      alert('Error toggling auto-bet')
    }
  }

  // Update local risk settings state (doesn't save until Save clicked)
  const updateRiskSettings = (field, value) => {
    setSettingsSaved(false)
    setRiskSettings(prev => ({
      ...prev,
      [field]: value
    }))
  }

  // Save risk settings to server
  const saveRiskSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/risk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(riskSettings)
      })
      const data = await res.json()
      if (data.success) {
        // Update local risk state with new limits
        setRisk(prev => ({
          ...prev,
          max: data.riskLimits.maxTotal,
          maxDollars: (data.riskLimits.maxTotal / 100).toFixed(2)
        }))
        setRiskSettings(data.riskLimits)
        setSettingsSaved(true)
        setTimeout(() => setSettingsSaved(false), 3000)
      }
    } catch (err) {
      console.error('Error saving risk settings:', err)
    }
  }

  // Update local scale-in settings state
  const updateScaleInSettings = (field, value) => {
    setSettingsSaved(false)
    setScaleInSettings(prev => ({
      ...prev,
      [field]: value
    }))
  }

  // Save scale-in settings to server
  const saveScaleInSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/scale-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scaleInSettings)
      })
      const data = await res.json()
      if (data.success) {
        setScaleInSettings(data.scaleIn)
        setSettingsSaved(true)
        setTimeout(() => setSettingsSaved(false), 3000)
      }
    } catch (err) {
      console.error('Error saving scale-in settings:', err)
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
          <h1 className={`logo ${balanceLoading ? 'loading' : ''}`}>SHIMI</h1>
          <span className="logo-subtitle">neural_trading_v2.0</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
            <span className="nav-icon">◈</span>
            <span className="nav-text">Dashboard</span>
          </button>
          <button className={`nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); fetchPerformance(); }}>
            <span className="nav-icon">◰</span>
            <span className="nav-text">History</span>
          </button>
          <button className={`nav-item ${tab === 'performance' ? 'active' : ''}`} onClick={() => { setTab('performance'); fetchPerformance(); }}>
            <span className="nav-icon">📈</span>
            <span className="nav-text">Performance</span>
          </button>
          <button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <span className="nav-icon">⚙</span>
            <span className="nav-text">Config</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="balance-display">
            <span className="balance-label">
              {balanceLoading ? 'Loading...' : isAuthenticated ? 'Live Balance' : 'Simulated'}
            </span>
            <span className={`balance-value ${balanceLoading ? 'loading' : ''}`}>
              {balanceLoading ? '---' : formatCurrency(balance)}
            </span>
          </div>
          <div className="risk-display-sidebar">
            <div className="risk-header">
              <span className="risk-label">Exposure</span>
              <span className="risk-value">${risk.currentDollars || '0.00'} / ${risk.maxDollars || '15.00'}</span>
            </div>
            <div className="risk-bar-small">
              <div
                className="risk-fill-small"
                style={{ width: `${Math.min(100, ((risk.current || 0) / (risk.max || 1500)) * 100)}%` }}
              ></div>
            </div>
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

        {/* Cyber Status Bar */}
        <div className="cyber-status-bar">
          <div className="cyber-scan-line"></div>
          <div className="cyber-grid"></div>
          <div className="cyber-status-content">
            <div className="cyber-left">
              <span className="cyber-bracket">[</span>
              <span className="cyber-label">SYS</span>
              <span className="cyber-value online">ONLINE</span>
              <span className="cyber-bracket">]</span>
            </div>
            <div className="cyber-center">
              <span className="cyber-divider">//</span>
              <span className="cyber-title">SHIMI NEURAL TRADING</span>
              <span className="cyber-divider">//</span>
            </div>
            <div className="cyber-right">
              <span className="cyber-bracket">[</span>
              <span className="cyber-label">FEED</span>
              <span className={`cyber-value ${priceLastUpdated ? 'live' : ''}`}>
                {Object.keys(prices).filter(k => prices[k] > 0).length > 0 ? 'LIVE' : 'SYNC'}
              </span>
              <span className="cyber-dot"></span>
              <span className="cyber-bracket">]</span>
            </div>
          </div>
        </div>

        {/* News Alert Banner - disabled, view in Sentiment tab instead */}

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
                  value={balanceLoading ? '---' : formatCurrency(balance)}
                  icon="◈"
                  color="#00ff88"
                />
                <StatsCard
                  title="Signals"
                  value={opportunities.length}
                  icon="⬡"
                  color="#bf00ff"
                />
                <StatsCard
                  title="Edge"
                  value={`+${avgEdge.toFixed(1)}%`}
                  icon="◐"
                  color="#00f0ff"
                />
                <StatsCard
                  title="Bets"
                  value={totalBets}
                  icon="▣"
                  color="#ff00aa"
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

                {/* Scan Status (visible when auto-bet is enabled) */}
                {autoBetEnabled && scanStatus?.lastScan && (
                  <div className="scan-status">
                    <div className="scan-status-header">
                      <span className="scan-status-indicator"></span>
                      Last Scan: {scanStatus.summary?.age || 'just now'}
                    </div>
                    <div className="scan-status-details">
                      <span>Markets: {scanStatus.lastScan.cryptoMarketsFound + scanStatus.lastScan.indexMarketsFound}</span>
                      <span>Qualifying: {scanStatus.lastScan.above60}</span>
                      <span className={`scan-result ${scanStatus.lastScan.betPlaced ? 'bet-placed' : scanStatus.lastScan.blockedReason || 'waiting'}`}>
                        {scanStatus.lastScan.betPlaced ? 'Bet Placed' :
                         scanStatus.lastScan.blockedReason === 'no_opportunities' ? 'Waiting' :
                         scanStatus.lastScan.blockedReason === 'risk_limit' ? 'Risk limit' :
                         scanStatus.lastScan.blockedReason === 'token_limit' ? 'Token limit' :
                         scanStatus.lastScan.blockedReason === 'error' ? 'Error' :
                         'Scanning...'}
                      </span>
                    </div>
                    {scanStatus.lastScan.bestOpportunity && !scanStatus.lastScan.betPlaced && (
                      <div className="scan-best-opp">
                        Best: {scanStatus.lastScan.bestOpportunity.title?.substring(0, 30)}...
                        ({scanStatus.lastScan.bestOpportunity.winProbability}%)
                        {scanStatus.lastScan.bestOpportunity.reason && (
                          <span className="blocked-reason"> - {scanStatus.lastScan.bestOpportunity.reason}</span>
                        )}
                      </div>
                    )}
                    {scanStatus.lastScan.betPlaced && scanStatus.lastScan.betDetails && (
                      <div className="scan-bet-placed">
                        {scanStatus.lastScan.betDetails.count > 1 ? (
                          <>Placed {scanStatus.lastScan.betDetails.count} bets | ${(scanStatus.lastScan.betDetails.totalAmount / 100).toFixed(2)} total</>
                        ) : scanStatus.lastScan.betDetails.bets?.[0] ? (
                          <>Placed: {scanStatus.lastScan.betDetails.bets[0].count}x {scanStatus.lastScan.betDetails.bets[0].side} @ {scanStatus.lastScan.betDetails.bets[0].price}¢</>
                        ) : (
                          <>Bet placed</>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Top Opportunities */}
              <div className="top-opportunities">
                <div className="section-header">
                  <h3 className="section-title">
                    Top Opportunities
                    {marketStats.totalAnalyzed > 0 && (
                      <span className="market-stats-inline">
                        ({marketStats.recommended} of {marketStats.totalAnalyzed} have edge)
                      </span>
                    )}
                  </h3>
                </div>

                {loading ? (
                  <div className="loading-state">
                    <div className="spinner"></div>
                    <p>Scanning crypto markets...</p>
                  </div>
                ) : opportunities.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon">🔍</span>
                    <h3>No opportunities with edge found</h3>
                    <p>
                      {marketStats.totalAnalyzed > 0
                        ? `Analyzed ${marketStats.totalAnalyzed} markets: ${marketStats.filteredNoEdge} have no edge (price too high)`
                        : 'Waiting for price mispricings...'}
                    </p>
                  </div>
                ) : (
                  <div className="opportunities-wrapper">
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
                    <div className="shimi-brand-side">
                      <div className="shimi-vertical">
                        <span className="shimi-slash">//</span>
                        <span className="shimi-text">SHIMI</span>
                      </div>
                      <div className="shimi-tagline">NEURAL TRADING</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}


          {/* History Tab */}
          {tab === 'history' && (
            <div className="history-page">
              {/* Overall Bot Stats - from performance tracking */}
              {performance && performance.summary.totalBets > 0 && (
                <div className="overall-stats-banner">
                  <h3 className="stats-banner-title">All-Time Bot Stats</h3>
                  <div className="history-stats">
                    <div className={`stat-summary ${parseFloat(performance.summary.totalProfitDollars) >= 0 ? 'positive' : 'negative'}`}>
                      <span className="stat-label">Total P/L</span>
                      <span className="stat-value">
                        {parseFloat(performance.summary.totalProfitDollars) >= 0 ? '+' : ''}${performance.summary.totalProfitDollars}
                      </span>
                    </div>
                    <div className="stat-summary">
                      <span className="stat-label">ROI</span>
                      <span className={`stat-value ${parseFloat(performance.summary.roi) >= 0 ? 'positive' : 'negative'}`}>
                        {performance.summary.roi}%
                      </span>
                    </div>
                    <div className="stat-summary">
                      <span className="stat-label">Win Rate</span>
                      <span className={`stat-value ${parseFloat(performance.summary.winRate) >= 50 ? 'positive' : 'negative'}`}>
                        {performance.summary.winRate}%
                      </span>
                    </div>
                    <div className="stat-summary">
                      <span className="stat-label">Total Bets</span>
                      <span className="stat-value">{performance.summary.totalBets}</span>
                    </div>
                  </div>
                  <div className="history-stats secondary">
                    <div className="stat-summary wins">
                      <span className="stat-label">Wins</span>
                      <span className="stat-value">{performance.summary.wins}</span>
                    </div>
                    <div className="stat-summary losses">
                      <span className="stat-label">Losses</span>
                      <span className="stat-value">{performance.summary.losses}</span>
                    </div>
                    <div className="stat-summary pending">
                      <span className="stat-label">Pending</span>
                      <span className="stat-value">{performance.summary.pendingBets}</span>
                    </div>
                    <div className="stat-summary">
                      <span className="stat-label">Wagered</span>
                      <span className="stat-value">${performance.summary.totalWageredDollars}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent Activity Section */}
              <div className="recent-history-section">
                <h3 className="section-subtitle">Recent Activity (Last 20)</h3>
                {betHistory.length === 0 ? (
                  <div className="empty-state large">
                    <span className="empty-icon">📜</span>
                    <h3>No Bet History</h3>
                    <p>Place your first bet to see history here</p>
                  </div>
                ) : (
                  <div className="history-list">
                    {betHistory.map(bet => (
                      <HistoryItem key={bet.id} bet={bet} currentTime={tickerTime} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}


          {/* Performance Tab */}
          {tab === 'performance' && (
            <div className="performance-page">
              <div className="performance-grid">
                {/* Summary Stats */}
                <div className="perf-card wide">
                  <h3 className="perf-card-title">Overall Performance</h3>
                  {performance ? (
                    <div className="perf-summary">
                      <div className="perf-stat-row">
                        <div className="perf-stat">
                          <span className="perf-stat-label">Total Bets</span>
                          <span className="perf-stat-value">{performance.summary.totalBets}</span>
                        </div>
                        <div className="perf-stat">
                          <span className="perf-stat-label">Win Rate</span>
                          <span className={`perf-stat-value ${parseFloat(performance.summary.winRate) >= 50 ? 'positive' : 'negative'}`}>
                            {performance.summary.winRate}%
                          </span>
                        </div>
                        <div className="perf-stat">
                          <span className="perf-stat-label">Total P&L</span>
                          <span className={`perf-stat-value ${parseFloat(performance.summary.totalProfitDollars) >= 0 ? 'positive' : 'negative'}`}>
                            ${performance.summary.totalProfitDollars}
                          </span>
                        </div>
                        <div className="perf-stat">
                          <span className="perf-stat-label">ROI</span>
                          <span className={`perf-stat-value ${parseFloat(performance.summary.roi) >= 0 ? 'positive' : 'negative'}`}>
                            {performance.summary.roi}%
                          </span>
                        </div>
                      </div>
                      <div className="perf-stat-row secondary">
                        <div className="perf-stat small">
                          <span className="perf-stat-label">Wins</span>
                          <span className="perf-stat-value positive">{performance.summary.wins}</span>
                        </div>
                        <div className="perf-stat small">
                          <span className="perf-stat-label">Losses</span>
                          <span className="perf-stat-value negative">{performance.summary.losses}</span>
                        </div>
                        <div className="perf-stat small">
                          <span className="perf-stat-label">Pending</span>
                          <span className="perf-stat-value">{performance.summary.pendingBets}</span>
                        </div>
                        <div className="perf-stat small">
                          <span className="perf-stat-label">Wagered</span>
                          <span className="perf-stat-value">${performance.summary.totalWageredDollars}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="loading-text">Loading performance data...</p>
                  )}
                </div>

                {/* Calibration - Predicted vs Actual */}
                <div className="perf-card calibration-card">
                  <h3 className="perf-card-title">Model Calibration</h3>

                  {/* Calibration Score */}
                  {performance?.calibrationScore && (
                    <div className={`calibration-score ${performance.calibrationScore.status}`}>
                      <div className="cal-score-main">
                        {performance.calibrationScore.score ? (
                          <>
                            <span className="cal-score-value">{performance.calibrationScore.score}</span>
                            <span className="cal-score-label">/ 100</span>
                          </>
                        ) : (
                          <span className="cal-score-na">N/A</span>
                        )}
                      </div>
                      <div className="cal-score-status">{performance.calibrationScore.message}</div>
                      {performance.calibrationScore.mae && (
                        <div className="cal-score-detail">
                          Mean error: {performance.calibrationScore.mae}% | {performance.calibrationScore.bucketsAnalyzed} buckets
                        </div>
                      )}
                    </div>
                  )}

                  {/* Calibration Table */}
                  {performance?.calibration && Object.keys(performance.calibration).length > 0 ? (
                    <div className="calibration-table">
                      <div className="calibration-header">
                        <span>Predicted</span>
                        <span>Actual</span>
                        <span>Diff</span>
                        <span>Bets</span>
                      </div>
                      {Object.entries(performance.calibration).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([bucket, data]) => (
                        <div key={bucket} className={`calibration-row ${data.bets >= 10 ? 'calibrated' : 'low-sample'}`}>
                          <span>{bucket}%</span>
                          <span className={data.actual >= data.predicted ? 'positive' : 'negative'}>
                            {data.actual.toFixed(1)}%
                          </span>
                          <span className={data.difference >= 0 ? 'positive' : 'negative'}>
                            {data.difference >= 0 ? '+' : ''}{data.difference.toFixed(1)}%
                          </span>
                          <span>{data.bets}{data.bets < 10 ? '*' : ''}</span>
                        </div>
                      ))}
                      <div className="calibration-note">
                        * Buckets with &lt;10 bets not used for calibration
                      </div>
                    </div>
                  ) : (
                    <p className="no-data">No calibration data yet. Place some bets!</p>
                  )}
                </div>

                {/* By Token */}
                <div className="perf-card">
                  <h3 className="perf-card-title">By Token</h3>
                  {performance?.byToken && Object.keys(performance.byToken).length > 0 ? (
                    <div className="token-perf-list">
                      {Object.entries(performance.byToken).map(([token, data]) => (
                        <div key={token} className="token-perf-row">
                          <span className="token-name">{token}</span>
                          <span className="token-stats">
                            {data.wins}W / {data.losses}L
                          </span>
                          <span className={`token-profit ${data.profit >= 0 ? 'positive' : 'negative'}`}>
                            ${(data.profit / 100).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="no-data">No token data yet</p>
                  )}
                </div>

                {/* By Market Type */}
                <div className="perf-card">
                  <h3 className="perf-card-title">By Market Type</h3>
                  {performance?.byMarketType && Object.keys(performance.byMarketType).length > 0 ? (
                    <div className="token-perf-list">
                      {Object.entries(performance.byMarketType).map(([type, data]) => (
                        <div key={type} className="token-perf-row">
                          <span className="token-name">{type.toUpperCase()}</span>
                          <span className="token-stats">
                            {data.wins}W / {data.losses}L
                          </span>
                          <span className={`token-profit ${data.profit >= 0 ? 'positive' : 'negative'}`}>
                            ${(data.profit / 100).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="no-data">No market type data yet</p>
                  )}
                </div>

                {/* Recent Bets */}
                <div className="perf-card wide">
                  <h3 className="perf-card-title">Recent Tracked Bets</h3>
                  {performance?.recentBets && performance.recentBets.length > 0 ? (
                    <div className="recent-bets-list">
                      {performance.recentBets.map((bet, i) => (
                        <div key={bet.id || i} className={`recent-bet-row ${bet.outcome}`}>
                          <div className="bet-main">
                            <span className={`bet-side ${bet.side}`}>{bet.side?.toUpperCase()}</span>
                            <span className="bet-token">{bet.token}</span>
                            <span className="bet-title">{bet.title?.slice(0, 40)}...</span>
                          </div>
                          <div className="bet-details">
                            <span className="bet-prob">Pred: {bet.predictedProb?.toFixed(0)}%</span>
                            <span className="bet-price">@ {bet.price}¢</span>
                            <span className={`bet-outcome ${bet.outcome}`}>
                              {bet.outcome === 'pending' ? '⏳' : bet.outcome === 'won' ? '✅' : '❌'}
                              {bet.outcome !== 'pending' && bet.actualProfit !== null && (
                                <span className={bet.actualProfit >= 0 ? 'positive' : 'negative'}>
                                  {bet.actualProfit >= 0 ? '+' : ''}{bet.actualProfit}¢
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="no-data">No bets tracked yet. Performance tracking starts now!</p>
                  )}
                </div>
              </div>
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
                      <span className="settings-label">Max per Bet</span>
                      <span className="settings-value">${((riskSettings.maxPerBet || 200) / 100).toFixed(2)}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Max Exposure</span>
                      <span className="settings-value">${((riskSettings.maxTotal || 1500) / 100).toFixed(2)}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Min Edge</span>
                      <span className="settings-value">5%</span>
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

                {/* Risk Settings */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Risk Limits</h3>
                  <div className="risk-settings">
                    <div className="risk-pool-settings">
                      <h4>Exposure Limits</h4>
                      <DollarStepper
                        label="Max per bet"
                        value={Math.round((riskSettings.maxPerBet || 200) / 100)}
                        onChange={(v) => updateRiskSettings('maxPerBet', v * 100)}
                        min={1}
                        max={10}
                      />
                      <DollarStepper
                        label="Max total exposure"
                        value={Math.round((riskSettings.maxTotal || 1500) / 100)}
                        onChange={(v) => updateRiskSettings('maxTotal', v * 100)}
                        min={1}
                        max={100}
                      />
                      <DollarStepper
                        label="Max per token"
                        value={Math.round((riskSettings.maxPerToken || 500) / 100)}
                        onChange={(v) => updateRiskSettings('maxPerToken', v * 100)}
                        min={1}
                        max={50}
                      />
                    </div>
                  </div>
                  <button className={`save-settings-btn ${settingsSaved ? 'saved' : ''}`} onClick={saveRiskSettings}>
                    {settingsSaved ? '✓ Saved' : 'Save Risk Settings'}
                  </button>
                </div>

                {/* Scale-In Settings */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Scale-In Strategy</h3>
                  <p className="settings-description">Add to positions when probability improves (Kelly-inspired scaling)</p>
                  <div className="scale-in-settings">
                    <div className="settings-input-group">
                      <label>Enabled</label>
                      <input
                        type="checkbox"
                        checked={scaleInSettings.enabled}
                        onChange={(e) => updateScaleInSettings('enabled', e.target.checked)}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label>Min probability increase (%)</label>
                      <input
                        type="number"
                        min="5"
                        max="50"
                        step="5"
                        value={scaleInSettings.minProbabilityIncrease}
                        onChange={(e) => updateScaleInSettings('minProbabilityIncrease', parseInt(e.target.value) || 15)}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label>Max bets per market</label>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        step="1"
                        value={scaleInSettings.maxBetsPerMarket}
                        onChange={(e) => updateScaleInSettings('maxBetsPerMarket', parseInt(e.target.value) || 3)}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label>Min time between bets (sec)</label>
                      <input
                        type="number"
                        min="30"
                        max="600"
                        step="30"
                        value={Math.round(scaleInSettings.minTimeBetweenBets / 1000)}
                        onChange={(e) => updateScaleInSettings('minTimeBetweenBets', (parseInt(e.target.value) || 60) * 1000)}
                      />
                    </div>
                  </div>
                  <button className={`save-settings-btn ${settingsSaved ? 'saved' : ''}`} onClick={saveScaleInSettings}>
                    {settingsSaved ? '✓ Saved' : 'Save Scale-In Settings'}
                  </button>
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

      {/* Mobile Bottom Bar - Exposure + Nav */}
      <div className="mobile-bottom-bar">
        {/* Mobile Exposure Bar */}
        <div className="mobile-exposure">
          <div className="mobile-exposure-left">
            <span className="mobile-balance">{formatCurrency(balance)}</span>
            <span className={`mobile-mode ${isAuthenticated ? 'live' : 'sim'}`}>
              {isAuthenticated ? 'LIVE' : 'SIM'}
            </span>
          </div>
          <div className="mobile-exposure-right">
            <span className="mobile-exposure-label">Exposure</span>
            <div className="mobile-exposure-bar">
              <div
                className="mobile-exposure-fill"
                style={{ width: `${Math.min(100, ((risk.current || 0) / (risk.max || 1500)) * 100)}%` }}
              ></div>
            </div>
            <span className="mobile-exposure-value">${risk.currentDollars || '0.00'}</span>
          </div>
        </div>

        {/* Mobile Nav */}
        <nav className="mobile-nav">
          <button className={`mobile-nav-item ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
            <span>📊</span>
            <span>Home</span>
          </button>
          <button className={`mobile-nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); fetchPerformance(); }}>
            <span>📜</span>
            <span>History</span>
          </button>
          <button className={`mobile-nav-item ${tab === 'performance' ? 'active' : ''}`} onClick={() => { setTab('performance'); fetchPerformance(); }}>
            <span>📈</span>
            <span>Stats</span>
          </button>
          <button className={`mobile-nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <span>⚙️</span>
            <span>Config</span>
          </button>
        </nav>
      </div>

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
