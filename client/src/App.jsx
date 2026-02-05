import { useState, useEffect, useCallback, memo } from 'react'
import './index.css'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:3001'

// ============================================
// AUTHENTICATION
// ============================================

// Get stored auth token from localStorage
const getStoredToken = () => localStorage.getItem('shimi_auth_token') || ''
const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem('shimi_user') || 'null')
  } catch {
    return null
  }
}

// Make authenticated API calls
const authFetch = async (url, options = {}) => {
  const token = getStoredToken()
  const headers = {
    ...options.headers,
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(url, { ...options, headers })
}

// Login/Register Screen Component
const LoginScreen = ({ onLogin }) => {
  const [mode, setMode] = useState('login') // 'login' or 'register'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match')
      setLoading(false)
      return
    }

    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login'
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()

      if (data.success) {
        localStorage.setItem('shimi_auth_token', data.token)
        localStorage.setItem('shimi_user', JSON.stringify(data.user))
        onLogin(data.user)
      } else {
        setError(data.error || 'Authentication failed')
      }
    } catch (err) {
      setError('Connection failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">SHIMI</h1>
        <p className="login-subtitle">Neural Trading System</p>

        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError('') }}
          >
            Login
          </button>
          <button
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => { setMode('register'); setError('') }}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="login-input"
            autoFocus
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="login-input"
            required
            minLength={6}
          />
          {mode === 'register' && (
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm Password"
              className="login-input"
              required
              minLength={6}
            />
          )}
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-button" disabled={loading}>
            {loading ? 'Please wait...' : (mode === 'register' ? 'Create Account' : 'Login')}
          </button>
        </form>
      </div>
    </div>
  )
}

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

// Opportunity Card - Larger stacked design with Mortal Kombat style
const OpportunityCard = memo(({ opp, onBet, isPlacing }) => {
  const [qty, setQty] = useState(1)
  const assetType = opp.assetType || opp.cryptoType || 'Unknown'
  const config = ASSET_CONFIG[assetType] || { color: '#888', name: assetType, icon: '?' }
  const isIndex = opp.marketCategory === 'index'
  const notRecommended = opp.isRecommended === false
  const isLocked = opp.isLocked === true
  const isSafe = opp.isSafe === true
  const isStale = opp.isStale === true
  const isPlaceholder = opp.isPlaceholder === true
  const hasActiveMarket = opp.hasActiveMarket !== false
  const pctFromStrike = parseFloat(opp.pctFromStrike) || 0

  // Determine card state for styling
  const isActionable = hasActiveMarket && opp.isRecommended && !isLocked && !isStale
  const isWaiting = isPlaceholder || !hasActiveMarket

  return (
    <div className={`opp-card ${opp.isObviousBet ? 'safe-bet' : ''} ${isIndex ? 'index-market' : ''} ${notRecommended && !isPlaceholder ? 'no-edge' : ''} ${isLocked ? 'locked' : ''} ${isSafe ? 'safe' : ''} ${isStale ? 'stale' : ''} ${isPlacing ? 'placing' : ''} ${isPlaceholder ? 'placeholder' : ''} ${isActionable ? 'actionable' : ''}`}>
      {/* Loading overlay when placing bet */}
      {isPlacing && (
        <div className="placing-overlay">
          <div className="placing-spinner"></div>
          <span className="placing-text">Placing bet...</span>
        </div>
      )}

      {/* ACTIONABLE badge - ready to bet */}
      {isActionable && !isLocked && (
        <div className="safe-badge actionable-badge">
          <span className="safe-icon">⚡</span>
          <span className="safe-text">READY</span>
        </div>
      )}

      {/* SAFE badge for auto-bet eligible */}
      {isSafe && !isActionable && !isLocked && (
        <div className="safe-badge">
          <span className="safe-icon">✓</span>
          <span className="safe-text">AUTO</span>
        </div>
      )}

      {/* Waiting/Placeholder overlay */}
      {isWaiting && (
        <div className="waiting-overlay">
          <div className="waiting-pulse"></div>
          <div className="waiting-icon">⏳</div>
          <div className="waiting-text">WAITING FOR MARKET</div>
        </div>
      )}

      {/* Locked overlay - shows filter reason */}
      {isLocked && !isWaiting && (
        <div className="locked-overlay">
          <div className="smoke-effect"></div>
          <div className="locked-icon">🔒</div>
          <div className="locked-text">{opp.filterReason || 'NO EDGE'}</div>
        </div>
      )}

      {/* NO EDGE badge for non-recommended markets */}
      {notRecommended && !isLocked && !isWaiting && (
        <div className="no-edge-badge">
          <span className="no-edge-icon">⊘</span>
          <span className="no-edge-text">{opp.filterReason || 'NO EDGE'}</span>
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
          {opp.marketTimeframe === 'hourly' && <span className="timeframe-badge hourly">1H</span>}
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
        <div className={`stat-row edge ${opp.edge >= 0 ? 'positive' : 'negative'}`}>
          <span className="stat-label">Your Edge</span>
          <span className="stat-value">{opp.edge >= 0 ? '+' : ''}{formatPercent(opp.edge || 0)}%</span>
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
      <div className="bet-action-row">
        <button
          className={`bet-btn ${isPlacing ? 'loading' : ''} ${opp.betSide?.toLowerCase()} ${notRecommended && !isWaiting ? 'disabled-no-edge' : ''} ${isWaiting ? 'waiting' : ''} ${isActionable ? 'actionable' : ''}`}
          onClick={() => onBet(opp, qty)}
          disabled={isPlacing || notRecommended || isLocked || isWaiting}
        >
          {isPlacing ? 'Placing...' :
           isWaiting ? '⏳ Waiting for market...' :
           isLocked ? (opp.filterReason || 'No signal') :
           notRecommended ? `${opp.filterReason}` :
           `BET ${opp.betSide} @ ${opp.betPriceCents || Math.round(opp.betPrice * 100)}¢`}
        </button>
      </div>
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

// Trading quotes for rotation in history sidebar
const tradingQuotes = [
  { text: "The market can stay irrational longer than you can stay solvent.", author: "John Maynard Keynes" },
  { text: "Be fearful when others are greedy, greedy when others are fearful.", author: "Warren Buffett" },
  { text: "The trend is your friend until the end when it bends.", author: "Ed Seykota" },
  { text: "Cut your losses short and let your winners run.", author: "Jesse Livermore" },
  { text: "Risk comes from not knowing what you're doing.", author: "Warren Buffett" },
  { text: "In trading, the impossible happens about twice a year.", author: "Henri M. Simoes" },
  { text: "Markets are never wrong, opinions often are.", author: "Jesse Livermore" },
  { text: "The goal isn't to be right, it's to make money.", author: "Mark Minervini" },
  { text: "It's not whether you're right or wrong, but how much you make when right.", author: "George Soros" },
  { text: "The best trade is the one you don't make.", author: "Anonymous" },
]

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
          {hasOutcome ? (
            <div className="bet-info-item">
              <span className="bet-info-label">{isWin ? 'Payout' : 'Lost'}</span>
              <span className={`bet-info-value ${isWin ? 'positive' : 'negative'}`}>
                {isWin ? formatCurrency(payoutCents / 100) : formatCurrency(totalCostCents / 100)}
              </span>
            </div>
          ) : (
            <>
              <div className="bet-info-item">
                <span className="bet-info-label">Payout if Right</span>
                <span className="bet-info-value potential-payout">{formatCurrency((bet.count || 1) * 1)}</span>
              </div>
              {bet.currentMarketPrice && (
                <div className="bet-info-item">
                  <span className="bet-info-label">Now</span>
                  <span className={`bet-info-value ${bet.profitIfSellNow >= 0 ? 'positive' : 'negative'}`}>
                    {bet.currentMarketPrice}¢ ({bet.profitIfSellNow >= 0 ? '+' : ''}{formatCurrency(bet.profitIfSellNow / 100)})
                  </span>
                </div>
              )}
            </>
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
  // Auth state
  const [needsLogin, setNeedsLogin] = useState(null) // null = checking, true = show login, false = logged in
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [currentUser, setCurrentUser] = useState(getStoredUser())

  const [tab, setTab] = useState('dashboard')
  const [opportunities, setOpportunities] = useState([])
  const [prices, setPrices] = useState({})
  const [prevPrices, setPrevPrices] = useState({})
  const [priceLastUpdated, setPriceLastUpdated] = useState(null)
  const [balance, setBalance] = useState(null) // null = loading
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [balanceRefreshing, setBalanceRefreshing] = useState(false)
  const [betHistory, setBetHistory] = useState([])
  const [betStats, setBetStats] = useState({ totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
  const [newBetsCount, setNewBetsCount] = useState(0)
  const [lastSeenBetId, setLastSeenBetId] = useState(null) // Track by ID, not count
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

  // Check if authentication is required on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const token = getStoredToken()
        if (!token) {
          // No token stored, require login
          setNeedsLogin(true)
          setCheckingAuth(false)
          return
        }

        // Verify token is still valid
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })

        if (res.ok) {
          const data = await res.json()
          setCurrentUser(data.user)
          setNeedsLogin(false)
        } else {
          // Token invalid, clear and require login
          localStorage.removeItem('shimi_auth_token')
          localStorage.removeItem('shimi_user')
          setCurrentUser(null)
          setNeedsLogin(true)
        }
      } catch (err) {
        // If server is down, check if we have stored credentials
        const token = getStoredToken()
        setNeedsLogin(!token)
      } finally {
        setCheckingAuth(false)
      }
    }
    checkAuth()
  }, [])
  // New: Risk tracking and market filtering
  const [risk, setRisk] = useState({
    current: 0,
    max: 1500,
    remaining: 1500,
    currentDollars: '0.00',
    maxDollars: '15.00'
  })
  const [portfolioWorth, setPortfolioWorth] = useState({
    balance: 0,
    positionValue: '0.00',
    portfolioWorth: '0.00',
    projectedMax: '0.00',
    positionCount: 0
  })
  const [riskSettings, setRiskSettings] = useState({
    maxPerBet: 500,
    maxPerToken: 500,
    maxTotal: 1500
  })
  // Profile system removed - Kalshi credentials tied directly to user account
  const [quoteIndex, setQuoteIndex] = useState(Math.floor(Math.random() * tradingQuotes.length))
  const [scaleInSettings, setScaleInSettings] = useState({
    enabled: true,
    minProbabilityIncrease: 15,
    maxBetsPerMarket: 3,
    minTimeBetweenBets: 60000
  })
  const [takeProfitSettings, setTakeProfitSettings] = useState({
    enabled: true,
    autoExecute: true,
    minProfitPercent: 10,
    logOnly: false
  })
  // Limit order settings for automatic stop-loss and take-profit via Kalshi
  const [limitOrderSettings, setLimitOrderSettings] = useState({
    stopLoss: { enabled: true, threshold: -40 },
    takeProfit: { enabled: false, threshold: 25 }
  })
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [marketFilter, setMarketFilter] = useState('all') // 'all', 'crypto', 'index'
  const [marketStats, setMarketStats] = useState({ totalAnalyzed: 0, recommended: 0, filteredNoEdge: 0, filteredLowProb: 0 })
  // Performance tracking
  const [performance, setPerformance] = useState(null)

  // Fetch prices directly (faster updates)
  const fetchPrices = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/crypto/prices`)
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
  // Always fetch ALL markets to show cards even without edge
  // IMPORTANT: Don't clear cards when API returns empty - keep last known markets visible
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/opportunities/all?showAll=true`)
      const data = await res.json()

      if (data.success) {
        // Only update opportunities if we got actual markets back
        // This prevents cards from disappearing between 15-min cycles
        const newOpps = data.opportunities || []
        if (newOpps.length > 0) {
          setOpportunities(newOpps)
        } else if (opportunities.length > 0) {
          // API returned empty but we have existing - mark them as stale/expired
          setOpportunities(prev => prev.map(opp => ({
            ...opp,
            isRecommended: false,
            filterReason: 'Market expired - waiting for next cycle',
            isStale: true
          })))
        }
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
  }, [opportunities.length])

  // Fetch portfolio
  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/portfolio`)
      const data = await res.json()

      if (data.success) {
        setBalance(data.balance || 0)
        const newHistory = data.betHistory || []
        setBetHistory(newHistory)
        setBetStats(data.stats || { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
        setIsAuthenticated(!data.simulated)
        // Track new bets for notification badge using bet IDs
        // Only show badge for NEW bets placed AFTER initial load
        if (newHistory.length > 0) {
          const latestBetId = newHistory[0]?.id
          if (lastSeenBetId === null) {
            // First load - initialize to current latest (no badge)
            setLastSeenBetId(latestBetId)
          } else if (latestBetId !== lastSeenBetId && tab !== 'history') {
            // New bet detected - count how many are new
            const lastSeenIndex = newHistory.findIndex(b => b.id === lastSeenBetId)
            if (lastSeenIndex > 0) {
              setNewBetsCount(lastSeenIndex)
            } else if (lastSeenIndex === -1) {
              // Last seen bet no longer in history, show badge for latest
              setNewBetsCount(1)
            }
          }
        }
      }
    } catch (err) {
      console.error('Portfolio fetch error:', err)
    } finally {
      setBalanceLoading(false)
    }
  }, [])

  // Quick balance refresh (doesn't fetch full portfolio)
  const refreshBalance = useCallback(async () => {
    setBalanceRefreshing(true)
    try {
      const res = await authFetch(`${API_BASE}/api/balance/refresh`)
      const data = await res.json()
      if (data.success) {
        setBalance(data.balance)
      }
    } catch (err) {
      console.error('Balance refresh error:', err)
    } finally {
      setBalanceRefreshing(false)
    }
  }, [])

  // Fetch portfolio worth (projected value based on current market prices)
  const fetchPortfolioWorth = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/portfolio/worth`)
      const data = await res.json()
      if (data.success) {
        setPortfolioWorth(data)
      }
    } catch (err) {
      console.error('Portfolio worth fetch error:', err)
    }
  }, [])

  // Fetch performance data
  const fetchPerformance = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/performance`)
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
      const res = await authFetch(`${API_BASE}/api/auto-bet/status`)
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
    fetchPerformance()  // Fetch performance stats on load
    fetchAutoBetStatus()  // Get current auto-bet state
    fetchTakeProfitSettings()  // Get take-profit settings
    fetchLimitOrderSettings()  // Get limit order settings (stop-loss/take-profit via Kalshi)
    fetchRiskSettings()     // Get saved risk settings
    checkAuth()

    // Refresh opportunities every 10 seconds (includes prices and risk/exposure)
    const oppInterval = setInterval(fetchOpportunities, 10000)

    // Refresh portfolio every 10 seconds (faster balance updates)
    const portfolioInterval = setInterval(fetchPortfolio, 10000)

    // Faster exposure updates: poll every 3 seconds when there are pending bets
    const fastExposureInterval = setInterval(() => {
      const hasPendingBets = betHistory.some(b => b.outcome !== 'won' && b.outcome !== 'lost')
      if (hasPendingBets) {
        fetchOpportunities() // This updates exposure/risk
      }
    }, 3000)

    // Refresh performance stats every 60 seconds
    const perfInterval = setInterval(fetchPerformance, 60000)

    // Update ticker time display every second
    const tickerTimeInterval = setInterval(() => {
      setTickerTime(Date.now())
    }, 1000)

    return () => {
      clearInterval(oppInterval)
      clearInterval(portfolioInterval)
      clearInterval(perfInterval)
      clearInterval(tickerTimeInterval)
      clearInterval(fastExposureInterval)
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

  // Rotate trading quotes every 30 seconds
  useEffect(() => {
    const quoteInterval = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % tradingQuotes.length)
    }, 30000)
    return () => clearInterval(quoteInterval)
  }, [])

  // Place a bet
  const placeBet = async (opp, qty = 1) => {
    if (placingBet) return // Prevent double-clicks

    setPlacingBet(opp.ticker)
    setBetStatus(null)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

      const res = await authFetch(`${API_BASE}/api/bet`, {
        method: 'POST',
        body: JSON.stringify({
          ticker: opp.ticker,
          side: opp.betSide,
          expectedPrice: opp.betPriceCents || Math.round(opp.betPrice * 100),
          count: qty
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      const data = await res.json()

      if (data.success) {
        if (data.newBalance) setBalance(data.newBalance)
        // Update risk if returned
        if (data.risk) {
          setRisk(data.risk)
        }
        // Increment new bets badge if not on history tab
        if (tab !== 'history') {
          setNewBetsCount(prev => prev + 1)
        }
        const priceInfo = data.avgPrice ? ` @ ${data.avgPrice}¢` : ''
        const fillInfo = data.filled ? ` (${data.filled} contract${data.filled > 1 ? 's' : ''})` : ''

        // Handle resting orders (placed but waiting for fill)
        if (data.resting) {
          setBetStatus({
            type: 'success',
            message: `⏳ Order placed on ${opp.cryptoType || opp.assetType} - waiting for fill`
          })
        } else {
          setBetStatus({
            type: 'success',
            message: `✓ Bought ${opp.betSide.toUpperCase()}${priceInfo}${fillInfo} on ${opp.cryptoType || opp.assetType}${data.simulated ? ' (simulated)' : ''}`
          })
        }
        // Refresh opportunities after placing a bet
        fetchOpportunities()
        // Also refresh portfolio to see the bet
        fetchPortfolio()
      } else {
        setBetStatus({ type: 'error', message: data.error || 'Bet failed - try refreshing' })
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setBetStatus({ type: 'error', message: 'Request timed out - check History to see if bet went through' })
      } else {
        console.error('Bet error:', err)
        setBetStatus({ type: 'error', message: err.message || 'Network error - check History to verify' })
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

      const res = await authFetch(`${API_BASE}/api/crypto/auto-bet`, {
        method: 'POST',
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

  // Fetch auto-bet status from server (for initial load / refresh)
  const fetchAutoBetStatus = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/auto-bet/status`)
      const data = await res.json()
      if (data.success) {
        setAutoBetEnabled(data.autoBetEnabled)
      }
    } catch (err) {
      console.error('Error fetching auto-bet status:', err)
    }
  }


  // Fetch take-profit settings
  const fetchTakeProfitSettings = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/take-profit/settings`)
      const data = await res.json()
      if (data.success && data.settings) {
        setTakeProfitSettings(data.settings)
      }
    } catch (err) {
      console.error('Error fetching take-profit settings:', err)
    }
  }

  // Fetch limit order settings (stop-loss and take-profit via Kalshi)
  const fetchLimitOrderSettings = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/limit-order-settings`)
      const data = await res.json()
      if (data.success && data.limitOrderSettings) {
        setLimitOrderSettings(data.limitOrderSettings)
      }
    } catch (err) {
      console.error('Error fetching limit order settings:', err)
    }
  }

  // Update limit order settings
  const updateLimitOrderSettings = async (newSettings) => {
    setLimitOrderSettings(newSettings)
    try {
      const res = await authFetch(`${API_BASE}/api/limit-order-settings`, {
        method: 'POST',
        body: JSON.stringify(newSettings)
      })
      const data = await res.json()
      if (data.success && data.limitOrderSettings) {
        setLimitOrderSettings(data.limitOrderSettings)
        setSettingsSaved(true)
        setTimeout(() => setSettingsSaved(false), 3000)
      }
    } catch (err) {
      console.error('Error saving limit order settings:', err)
    }
  }

  // Toggle take-profit
  const toggleTakeProfit = async () => {
    const newEnabled = !takeProfitSettings.enabled
    setTakeProfitSettings(prev => ({ ...prev, enabled: newEnabled }))
    try {
      const res = await authFetch(`${API_BASE}/api/take-profit/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled: newEnabled })
      })
      const data = await res.json()
      if (data.success && data.settings) {
        setTakeProfitSettings(data.settings)
      }
    } catch (err) {
      console.error('Error toggling take-profit:', err)
    }
  }

  // Toggle continuous auto-betting
  const toggleAutoBet = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/crypto/auto-bet/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !autoBetEnabled, intervalSeconds: 10 })
      })
      const data = await res.json()
      if (data.success) setAutoBetEnabled(data.autoBetEnabled)
    } catch (err) {
      alert('Error toggling auto-bet')
    }
  }

  // Fetch risk settings from server
  const fetchRiskSettings = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/settings/risk`)
      const data = await res.json()
      if (data.success && data.riskLimits) {
        setRiskSettings(data.riskLimits)
        const totalMax = data.riskLimits.maxTotal || 1500
        setRisk(prev => ({
          ...prev,
          max: totalMax,
          maxDollars: (totalMax / 100).toFixed(2)
        }))
      }
    } catch (err) {
      console.error('Error fetching risk settings:', err)
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
    setSettingsSaving(true)
    try {
      const res = await authFetch(`${API_BASE}/api/settings/risk`, {
        method: 'POST',
        body: JSON.stringify(riskSettings)
      })
      const data = await res.json()
      if (data.success) {
        const totalMax = data.riskLimits.maxTotal || 1500
        setRisk(prev => ({
          ...prev,
          max: totalMax,
          maxDollars: (totalMax / 100).toFixed(2)
        }))
        setRiskSettings(data.riskLimits)
        // Refresh opportunities to update exposure bar
        await fetchOpportunities()
        setSettingsSaved(true)
        setTimeout(() => setSettingsSaved(false), 3000)
      }
    } catch (err) {
      console.error('Error saving risk settings:', err)
    } finally {
      setSettingsSaving(false)
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
      const res = await authFetch(`${API_BASE}/api/settings/scale-in`, {
        method: 'POST',
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
      const res = await authFetch(`${API_BASE}/api/auth/configure`, {
        method: 'POST',
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

  // Disconnect from Kalshi
  const handleDisconnect = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/auth/disconnect`, {
        method: 'POST'
      })
      const data = await res.json()
      if (data.success) {
        setIsAuthenticated(false)
        setBalance(25) // Reset to default simulated balance
      }
    } catch (err) {
      console.error('Disconnect failed:', err)
    }
  }

  // Log out of account
  const handleLogout = () => {
    localStorage.removeItem('shimi_auth_token')
    localStorage.removeItem('shimi_user')
    setCurrentUser(null)
    setNeedsLogin(true)
    setIsAuthenticated(false)
    setBalance(25)
  }

  // Calculate stats
  const totalBets = betHistory.length
  const winningBets = betHistory.filter(b => b.status === 'won').length
  const totalWagered = betHistory.reduce((sum, b) => sum + (b.totalCost || 0), 0) / 100
  const avgEdge = opportunities.length > 0
    ? opportunities.reduce((sum, o) => sum + (o.edge || 0), 0) / opportunities.length
    : 0

  // Show loading while checking auth
  if (checkingAuth) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1 className="login-title">🎰 Shimi</h1>
          <p className="login-subtitle">Connecting...</p>
        </div>
      </div>
    )
  }

  // Show login screen if authentication required
  if (needsLogin) {
    return <LoginScreen onLogin={(user) => {
      setCurrentUser(user)
      setNeedsLogin(false)
    }} />
  }

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
          <button className={`nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => {
            setTab('history');
            fetchPerformance();
            setNewBetsCount(0);
            setLastSeenBetId(betHistory[0]?.id);
          }}>
            <span className="nav-icon">◰</span>
            <span className="nav-text">History</span>
            {newBetsCount > 0 && <span className="nav-badge">{newBetsCount}</span>}
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
          <a
            href="https://kalshi.com/portfolio"
            target="_blank"
            rel="noopener noreferrer"
            className="kalshi-link-btn"
          >
            Open Kalshi ↗
          </a>
          <div className="balance-display">
            <div className="balance-header">
              <span className="balance-label">
                {balanceLoading ? 'Loading...' : isAuthenticated ? 'Live Balance' : 'Simulated'}
              </span>
              <button
                className={`balance-refresh-btn ${balanceRefreshing ? 'refreshing' : ''}`}
                onClick={refreshBalance}
                disabled={balanceRefreshing || balanceLoading}
                title="Refresh balance"
              >
                ↻
              </button>
            </div>
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
          {currentUser && (
            <div className="user-info-sidebar">
              <span className="user-email">{currentUser.email}</span>
              <button
                className="logout-btn"
                onClick={() => {
                  localStorage.removeItem('shimi_auth_token')
                  localStorage.removeItem('shimi_user')
                  setCurrentUser(null)
                  setNeedsLogin(true)
                }}
              >
                Logout
              </button>
            </div>
          )}
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
              <span className="cyber-divider">\\</span>
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
                  value={`${avgEdge >= 0 ? '+' : ''}${avgEdge.toFixed(1)}%`}
                  icon="◐"
                  color={avgEdge >= 0 ? "#00f0ff" : "#ff4466"}
                />
                <StatsCard
                  title="Active"
                  value={risk.positionCount || 0}
                  icon="▣"
                  color="#ff00aa"
                />
              </div>

              {/* Risk Card */}
              <div className="risk-card">
                <div className="risk-card-header">
                  <span className="risk-card-title">Risk Exposure</span>
                  <span className={`risk-card-status ${
                    (risk.current / risk.max) > 0.9 ? 'danger' :
                    (risk.current / risk.max) > 0.7 ? 'warning' : ''
                  }`}>
                    {(risk.current / risk.max) > 0.9 ? 'AT LIMIT' :
                     (risk.current / risk.max) > 0.7 ? 'HIGH' : 'SAFE'}
                  </span>
                </div>
                <div className="risk-exposure-bar">
                  <div className="risk-exposure-label">
                    <span>Current: ${risk.currentDollars || '0.00'}</span>
                    <span>Max: ${risk.maxDollars || '15.00'}</span>
                  </div>
                  <div className="risk-exposure-track">
                    <div
                      className={`risk-exposure-fill ${
                        (risk.current / risk.max) > 0.9 ? 'danger' :
                        (risk.current / risk.max) > 0.7 ? 'warning' : ''
                      }`}
                      style={{ width: `${Math.min(100, (risk.current / risk.max) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="risk-tokens">
                  <div className="risk-token">
                    <span className="risk-token-name">BTC</span>
                    <span className={`risk-token-value ${risk.byToken?.BTC >= (riskSettings.maxPerToken || 500) ? 'at-limit' : ''}`}>
                      ${((risk.byToken?.BTC || 0) / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="risk-token">
                    <span className="risk-token-name">ETH</span>
                    <span className={`risk-token-value ${risk.byToken?.ETH >= (riskSettings.maxPerToken || 500) ? 'at-limit' : ''}`}>
                      ${((risk.byToken?.ETH || 0) / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="risk-token">
                    <span className="risk-token-name">SOL</span>
                    <span className={`risk-token-value ${risk.byToken?.SOL >= (riskSettings.maxPerToken || 500) ? 'at-limit' : ''}`}>
                      ${((risk.byToken?.SOL || 0) / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="risk-token">
                    <span className="risk-token-name">Positions</span>
                    <span className="risk-token-value">{risk.positionCount || 0}</span>
                  </div>
                </div>
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
                {autoBetEnabled && scanStatus && (
                  <div className="scan-status">
                    <div className="scan-status-header">
                      <span className={`scan-status-indicator ${scanStatus.status}`}></span>
                      <span className="scan-status-label">
                        {scanStatus.status === 'scanning' ? 'Scanning...' :
                         scanStatus.status === 'bet_placed' ? '✅ Bet Placed' :
                         scanStatus.status === 'no_opportunities' ? '⏳ Waiting' :
                         scanStatus.status === 'risk_limit' ? '⚠️ Risk Limit' :
                         scanStatus.status === 'token_limit' ? '⚠️ Token Limit' :
                         scanStatus.status === 'bet_too_small' ? '⚠️ Budget Low' :
                         scanStatus.status === 'error' ? '❌ Error' :
                         scanStatus.status === 'idle' ? '💤 Idle' :
                         'Unknown'}
                      </span>
                    </div>
                    <div className="scan-status-details">
                      <span>Markets: {scanStatus.marketsScanned || 0}</span>
                      <span>With Edge: {scanStatus.marketsWithEdge || 0}</span>
                      <span>Qualifying: {scanStatus.opportunitiesFound || 0}</span>
                    </div>
                    <div className="scan-status-message">
                      {scanStatus.statusMessage}
                    </div>
                    {scanStatus.blockedReasons?.length > 0 && scanStatus.status !== 'bet_placed' && (
                      <div className="scan-blocked-reasons">
                        {scanStatus.blockedReasons.map((reason, i) => (
                          <span key={i} className="blocked-reason">{reason}</span>
                        ))}
                      </div>
                    )}
                    {scanStatus.lastBet && (
                      <div className="scan-last-bet">
                        <span className="last-bet-label">Last bet:</span>
                        <span className="last-bet-details">
                          {scanStatus.lastBet.contracts}x {scanStatus.lastBet.side} @ {scanStatus.lastBet.price}¢
                          {scanStatus.lastBet.simulated && ' (sim)'}
                        </span>
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

                {loading && opportunities.length === 0 ? (
                  <div className="loading-state">
                    <div className="spinner"></div>
                    <p>Scanning crypto markets...</p>
                  </div>
                ) : opportunities.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon">🔍</span>
                    <h3>Waiting for markets</h3>
                    <p>No active markets found - waiting for next 15-minute cycle...</p>
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
            <div className="history-page-wrapper">
              <div className="history-page">
                {/* Overall Bot Stats - from performance tracking */}
                {performance && performance.summary && (
                  <div className="overall-stats-banner">
                    <h3 className="stats-banner-title">All-Time Bot Stats {performance.summary.totalBets === 0 && '(No bets tracked yet)'}</h3>
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

              {/* Branding Sidebar */}
              <div className="history-sidebar">
                <div className="sidebar-brand">
                  <div className="sidebar-logo">
                    <span className="logo-text">//SHIMI</span>
                    <span className="logo-subtitle">Neural Trading System</span>
                  </div>
                  <div className="sidebar-divider"></div>
                </div>

                <div className="sidebar-status">
                  <div className="status-header">
                    <span className="status-dot"></span>
                    <span>SYSTEM STATUS</span>
                  </div>
                  <div className="status-grid">
                    <div className="status-item">
                      <span className="status-label">Engine</span>
                      <span className="status-value online">ONLINE</span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">Auto-Bet</span>
                      <span className={`status-value ${autoBetEnabled ? 'online' : 'offline'}`}>
                        {autoBetEnabled ? 'ACTIVE' : 'STANDBY'}
                      </span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">Strategy</span>
                      <span className="status-value">MOMENTUM</span>
                    </div>
                    <div className="status-item">
                      <span className="status-label">Sizing</span>
                      <span className="status-value">KELLY 50%</span>
                    </div>
                  </div>
                </div>

                <div className="sidebar-quote">
                  <div className="quote-marks">"</div>
                  <p className="quote-text">{tradingQuotes[quoteIndex].text}</p>
                  <span className="quote-author">— {tradingQuotes[quoteIndex].author}</span>
                </div>

                <div className="sidebar-decoration">
                  <div className="deco-line"></div>
                  <div className="deco-line"></div>
                  <div className="deco-line"></div>
                  <div className="deco-circuit">
                    <span>◇</span><span>◇</span><span>◇</span>
                  </div>
                </div>
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
                  <div className="account-info">
                    <div className="account-email">
                      <span className="account-label">Logged in as:</span>
                      <span className="account-value">{currentUser?.email || 'Unknown'}</span>
                    </div>
                    <button className="logout-btn" onClick={handleLogout}>
                      Log Out
                    </button>
                  </div>
                </div>

                {/* Kalshi Connection Section */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Kalshi Connection</h3>
                  <p className="settings-description">Your Kalshi API credentials are tied to your account</p>
                  {isAuthenticated ? (
                    <div className="connected-info">
                      <div className="connected-badge">
                        <span className="connected-dot"></span>
                        Connected to Kalshi
                      </div>
                      <p>Real money betting is enabled</p>
                      <button className="disconnect-btn" onClick={handleDisconnect}>
                        Disconnect
                      </button>
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
                        label="Max per token"
                        value={Math.round((riskSettings.maxPerToken || 500) / 100)}
                        onChange={(v) => updateRiskSettings('maxPerToken', v * 100)}
                        min={1}
                        max={50}
                      />
                      <h4 style={{ marginTop: '16px' }}>Total Exposure</h4>
                      <DollarStepper
                        label="Max Exposure"
                        value={Math.round((riskSettings.maxTotal || 1500) / 100)}
                        onChange={(v) => updateRiskSettings('maxTotal', v * 100)}
                        min={5}
                        max={100}
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

                {/* Limit Order Settings - Stop-Loss & Take-Profit via Kalshi */}
                <div className="settings-card">
                  <h3 className="settings-card-title">Auto Stop-Loss & Take-Profit</h3>
                  <p className="settings-description">
                    Automatic limit orders placed on Kalshi when you buy. Kalshi executes them for you.
                  </p>

                  {/* Stop-Loss Toggle + Threshold */}
                  <div className="limit-order-setting">
                    <div className="feature-toggle">
                      <div className="feature-info">
                        <span className="feature-icon">🛡️</span>
                        <div className="feature-text">
                          <span className="feature-name">Auto Stop-Loss</span>
                          <span className="feature-desc">Sell automatically if position drops below threshold</span>
                        </div>
                      </div>
                      <button
                        className={`toggle-btn ${limitOrderSettings.stopLoss?.enabled ? 'active' : ''}`}
                        onClick={() => updateLimitOrderSettings({
                          ...limitOrderSettings,
                          stopLoss: { ...limitOrderSettings.stopLoss, enabled: !limitOrderSettings.stopLoss?.enabled }
                        })}
                      >
                        {limitOrderSettings.stopLoss?.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    {limitOrderSettings.stopLoss?.enabled && (
                      <div className="threshold-input">
                        <label>Stop-Loss Threshold:</label>
                        <div className="threshold-controls">
                          <button
                            className="threshold-btn"
                            onClick={() => updateLimitOrderSettings({
                              ...limitOrderSettings,
                              stopLoss: { ...limitOrderSettings.stopLoss, threshold: Math.max(-90, (limitOrderSettings.stopLoss?.threshold || -40) - 5) }
                            })}
                          >−</button>
                          <span className="threshold-value">{limitOrderSettings.stopLoss?.threshold || -40}%</span>
                          <button
                            className="threshold-btn"
                            onClick={() => updateLimitOrderSettings({
                              ...limitOrderSettings,
                              stopLoss: { ...limitOrderSettings.stopLoss, threshold: Math.min(-5, (limitOrderSettings.stopLoss?.threshold || -40) + 5) }
                            })}
                          >+</button>
                        </div>
                        <span className="threshold-example">
                          Buy at 50¢ → Sell at {Math.round(50 * (1 + (limitOrderSettings.stopLoss?.threshold || -40) / 100))}¢
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Take-Profit Toggle + Threshold */}
                  <div className="limit-order-setting" style={{ marginTop: '16px' }}>
                    <div className="feature-toggle">
                      <div className="feature-info">
                        <span className="feature-icon">💎</span>
                        <div className="feature-text">
                          <span className="feature-name">Auto Take-Profit</span>
                          <span className="feature-desc">Sell automatically if position rises above threshold</span>
                        </div>
                      </div>
                      <button
                        className={`toggle-btn ${limitOrderSettings.takeProfit?.enabled ? 'active' : ''}`}
                        onClick={() => updateLimitOrderSettings({
                          ...limitOrderSettings,
                          takeProfit: { ...limitOrderSettings.takeProfit, enabled: !limitOrderSettings.takeProfit?.enabled }
                        })}
                      >
                        {limitOrderSettings.takeProfit?.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    {limitOrderSettings.takeProfit?.enabled && (
                      <div className="threshold-input">
                        <label>Take-Profit Threshold:</label>
                        <div className="threshold-controls">
                          <button
                            className="threshold-btn"
                            onClick={() => updateLimitOrderSettings({
                              ...limitOrderSettings,
                              takeProfit: { ...limitOrderSettings.takeProfit, threshold: Math.max(5, (limitOrderSettings.takeProfit?.threshold || 25) - 5) }
                            })}
                          >−</button>
                          <span className="threshold-value">+{limitOrderSettings.takeProfit?.threshold || 25}%</span>
                          <button
                            className="threshold-btn"
                            onClick={() => updateLimitOrderSettings({
                              ...limitOrderSettings,
                              takeProfit: { ...limitOrderSettings.takeProfit, threshold: Math.min(100, (limitOrderSettings.takeProfit?.threshold || 25) + 5) }
                            })}
                          >+</button>
                        </div>
                        <span className="threshold-example">
                          Buy at 50¢ → Sell at {Math.round(50 * (1 + (limitOrderSettings.takeProfit?.threshold || 25) / 100))}¢
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="limit-order-note" style={{ marginTop: '12px', fontSize: '12px', color: '#888' }}>
                    Limit orders are placed immediately when you buy. Kalshi executes them automatically.
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
          <button className={`mobile-nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); fetchPerformance(); setNewBetsCount(0); setLastSeenBetId(betHistory[0]?.id); }}>
            <span>📜</span>
            <span>History</span>
            {newBetsCount > 0 && <span className="nav-badge mobile">{newBetsCount}</span>}
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

      {/* Settings Saving Overlay */}
      {settingsSaving && (
        <div className="settings-saving-overlay">
          <div className="settings-saving-content">
            <div className="shimi-loader">
              <span className="shimi-text">//SHIMI</span>
            </div>
            <span className="saving-text">Syncing settings...</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
