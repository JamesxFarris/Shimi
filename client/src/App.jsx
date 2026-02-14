import { useState, useEffect, useCallback, useRef, memo } from 'react'
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
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`)
      }
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

      {/* Locked overlay - shows all filter reasons */}
      {isLocked && !isWaiting && (
        <div className="locked-overlay">
          <div className="smoke-effect"></div>
          <div className="locked-icon">🔒</div>
          <div className="locked-reasons">
            {(opp.filterReasons && opp.filterReasons.length > 0 ? opp.filterReasons : [opp.filterReason || 'NO EDGE']).map((r, i) => (
              <div key={i} className="locked-reason-item">{r}</div>
            ))}
          </div>
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
          <span className="stat-value">{opp.edge >= 0 ? '+' : ''}{formatPercent(opp.edge || 0)}</span>
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
  const rawProfitCents = bet.profit || 0
  // Guard: if lost but profit=0 (bad price data), show -totalCost as the loss
  const profitCents = (bet.outcome === 'lost' && rawProfitCents === 0) ? -totalCostCents : rawProfitCents

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
  const tabRef = useRef('dashboard') // Ref to avoid stale closure in intervals
  const [opportunities, setOpportunities] = useState([])
  const [prices, setPrices] = useState({})
  const [priceLastUpdated, setPriceLastUpdated] = useState(null)
  const [balance, setBalance] = useState(null) // null = loading
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [balanceRefreshing, setBalanceRefreshing] = useState(false)
  const [betHistory, setBetHistory] = useState([])
  const betHistoryRef = useRef([]) // Ref to avoid stale closure in intervals
  const [betStats, setBetStats] = useState({ totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
  const [newBetsCount, setNewBetsCount] = useState(0)
  const [lastSeenBetId, setLastSeenBetId] = useState(null) // Track by ID, not count
  const lastSeenBetIdRef = useRef(null) // Ref to avoid stale closure in intervals
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
  const placingBetRef = useRef(false)
  const [tickerTime, setTickerTime] = useState(Date.now())

  // Keep refs in sync with state for use in callbacks with [] deps
  useEffect(() => { tabRef.current = tab }, [tab])
  useEffect(() => { lastSeenBetIdRef.current = lastSeenBetId }, [lastSeenBetId])

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
    currentDollars: '0.00'
  })
  const [riskSettings, setRiskSettings] = useState({
    maxPerTokenPerCycle: 500
  })
  // Profile system removed - Kalshi credentials tied directly to user account
  const [quoteIndex, setQuoteIndex] = useState(Math.floor(Math.random() * tradingQuotes.length))
  const [scaleInSettings, setScaleInSettings] = useState({
    enabled: true,
    minProbabilityIncrease: 15,
    maxBetsPerMarket: 3,
    minTimeBetweenBets: 60000
  })
  const [settingsSavedSection, setSettingsSavedSection] = useState(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  // Model monitoring state
  const [selectivityRules, setSelectivityRules] = useState({ minEdgeAfterFees: 5, minSignalStrength: 70, minEmpiricalWinRate: 62 })
  const [marketFilter, setMarketFilter] = useState('all') // 'all', 'crypto', 'index'
  const [marketStats, setMarketStats] = useState({ totalAnalyzed: 0, recommended: 0, filteredNoEdge: 0, filteredLowProb: 0 })
  // Performance tracking
  const [performance, setPerformance] = useState(null)

  // Copy trading state
  const [copyStatus, setCopyStatus] = useState({ running: false, leaders: [], recentActivity: [], stats: { totalLeaders: 0, activeLeaders: 0, totalCopied: 0 } })
  const [copyLeaderForm, setCopyLeaderForm] = useState({ name: '', apiKeyId: '', privateKey: '', scaleFactor: 1.0, maxBetCents: 500 })
  const [copyLoading, setCopyLoading] = useState(false)
  const [copyError, setCopyError] = useState(null)
  const [showAddLeader, setShowAddLeader] = useState(false)

  const fetchCopyStatus = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/copy-trading/status`)
      if (res.ok) {
        const data = await res.json()
        if (data.success) setCopyStatus(data)
      }
    } catch {}
  }, [])

  // Poll copy trading status when on that tab
  useEffect(() => {
    if (tab !== 'copytrade') return
    fetchCopyStatus()
    fetchPolyStatus()
    const interval = setInterval(() => { fetchCopyStatus(); fetchPolyStatus() }, 5000)
    return () => clearInterval(interval)
  }, [tab, fetchCopyStatus])

  // Polymarket copy trading state
  const [polyStatus, setPolyStatus] = useState({ running: false, wallets: [], recentActivity: [], stats: { totalWallets: 0, activeWallets: 0, totalCopied: 0 } })
  const [polyWalletForm, setPolyWalletForm] = useState({ name: '', walletAddress: '', scaleFactor: 1.0, maxBetCents: 500 })
  const [polyLoading, setPolyLoading] = useState(false)
  const [polyError, setPolyError] = useState(null)
  const [showAddPolyWallet, setShowAddPolyWallet] = useState(false)

  const fetchPolyStatus = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/poly-trading/status`)
      if (res.ok) {
        const data = await res.json()
        if (data.success) setPolyStatus(data)
      }
    } catch {}
  }, [])

  // Fetch prices directly (faster updates)
  // Fetch opportunities (now uses unified endpoint for all market types)
  // Always fetch ALL markets to show cards even without edge
  // IMPORTANT: Don't clear cards when API returns empty - keep last known markets visible
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/opportunities/all?showAll=true`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      if (data.success) {
        // Only update opportunities if we got actual markets back
        // This prevents cards from disappearing between 15-min cycles
        const newOpps = data.opportunities || []
        if (newOpps.length > 0) {
          setOpportunities(newOpps)
        } else {
          // API returned empty - mark existing as stale/expired (if any exist)
          setOpportunities(prev => prev.length > 0 ? prev.map(opp => ({
            ...opp,
            isRecommended: false,
            filterReason: 'Market expired - waiting for next cycle',
            isStale: true
          })) : prev)
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
  }, []) // No dependencies - uses functional updates for state

  // Fetch portfolio
  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/portfolio`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      if (data.success) {
        setBalance(data.balance || 0)
        const newHistory = data.betHistory || []
        setBetHistory(newHistory)
        betHistoryRef.current = newHistory // Keep ref in sync
        setBetStats(data.stats || { totalBets: 0, wins: 0, losses: 0, winRate: '0', totalProfit: 0 })
        setIsAuthenticated(!data.simulated)
        // Update risk/exposure if returned
        if (data.risk) {
          setRisk(data.risk)
        }
        // Track new bets for notification badge using bet IDs
        // Only show badge for NEW bets placed AFTER initial load
        // Using refs to avoid stale closures since this callback has [] deps
        if (newHistory.length > 0) {
          const latestBetId = newHistory[0]?.id
          if (lastSeenBetIdRef.current === null) {
            // First load - initialize to current latest (no badge)
            setLastSeenBetId(latestBetId)
          } else if (latestBetId !== lastSeenBetIdRef.current && tabRef.current !== 'history') {
            // New bet detected - count how many are new
            const lastSeenIndex = newHistory.findIndex(b => b.id === lastSeenBetIdRef.current)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

  // Fetch performance data
  const fetchPerformance = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/performance`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setIsAuthenticated(data.isAuthenticated)
    } catch (err) {
      console.error('Auth check failed:', err)
    }
  }, [])

  // Initial load - runs once
  useEffect(() => {
    // Fetch everything on initial load
    fetchOpportunities()
    fetchPortfolio()
    fetchPerformance()  // Fetch performance stats on load
    fetchAutoBetStatus()  // Get current auto-bet state
    fetchRiskSettings()     // Get saved risk settings
    fetchScaleInSettings()  // Get saved scale-in settings
    fetchModelMonitoring()  // Get prospective data, selectivity rules
    checkAuth()

    // Track whether fast polling is active to avoid double-fetching opportunities
    let fastPollingActive = false

    // Merged data polling: opportunities + portfolio every 10 seconds (was 2 separate intervals)
    const dataInterval = setInterval(() => {
      if (!fastPollingActive) {
        fetchOpportunities()
      }
      fetchPortfolio()
    }, 10000)

    // Faster exposure updates: poll every 3 seconds when there are pending bets
    const fastExposureInterval = setInterval(() => {
      const hasPendingBets = betHistoryRef.current.some(b => b.outcome !== 'won' && b.outcome !== 'lost')
      fastPollingActive = hasPendingBets
      if (hasPendingBets) {
        fetchOpportunities()
      }
    }, 3000)

    // Refresh performance stats every 60 seconds
    const perfInterval = setInterval(fetchPerformance, 60000)

    // Update ticker time display every second
    const tickerTimeInterval = setInterval(() => {
      setTickerTime(Date.now())
    }, 1000)

    return () => {
      clearInterval(dataInterval)
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
  }, [autoBetEnabled]) // Note: fetchScanStatus has [] deps, safe to exclude

  // Rotate trading quotes every 30 seconds
  useEffect(() => {
    const quoteInterval = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % tradingQuotes.length)
    }, 30000)
    return () => clearInterval(quoteInterval)
  }, [])

  // Place a bet
  const placeBet = async (opp, qty = 1) => {
    if (placingBetRef.current) return // Prevent double-clicks (synchronous ref check)
    placingBetRef.current = true

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
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Server error: ${res.status}`)
      }

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

    placingBetRef.current = false
    setPlacingBet(null)
    setTimeout(() => setBetStatus(null), 5000)
  }

  // Auto-bet
  const placeAutoBet = async () => {
    if (placingBetRef.current) return // Prevent double-clicks (synchronous ref check)
    placingBetRef.current = true

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
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Server error: ${res.status}`)
      }

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

    placingBetRef.current = false
    setPlacingBet(null)
    setTimeout(() => setBetStatus(null), 5000)
  }

  // Fetch auto-bet status from server (for initial load / refresh)
  const fetchAutoBetStatus = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/auto-bet/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success) {
        setAutoBetEnabled(data.autoBetEnabled)
      }
    } catch (err) {
      console.error('Error fetching auto-bet status:', err)
    }
  }


  // Fetch model monitoring data (selectivity rules)
  const fetchModelMonitoring = async () => {
    try {
      const selectivityRes = await authFetch(`${API_BASE}/api/model/selectivity`)
      if (selectivityRes.ok) {
        const data = await selectivityRes.json()
        if (data.success && data.selectivityRules) {
          setSelectivityRules(data.selectivityRules)
        }
      }
    } catch (err) {
      console.error('Error fetching model monitoring data:', err)
    }
  }

  // Update selectivity rules (min edge threshold)
  const updateSelectivityRules = async (field, value) => {
    const prev = selectivityRules
    const newRules = { ...selectivityRules, [field]: value }
    setSelectivityRules(newRules)
    try {
      const res = await authFetch(`${API_BASE}/api/model/selectivity`, {
        method: 'POST',
        body: JSON.stringify({ [field]: value })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success && data.selectivityRules) {
        setSelectivityRules(data.selectivityRules)
        setSettingsSavedSection('selectivity')
        setTimeout(() => setSettingsSavedSection(null), 3000)
      }
    } catch (err) {
      console.error('Error updating selectivity rules:', err)
      setSelectivityRules(prev)
    }
  }

  // Toggle continuous auto-betting
  const toggleAutoBet = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/crypto/auto-bet/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !autoBetEnabled, intervalSeconds: 10 })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success && data.riskLimits) {
        setRiskSettings(data.riskLimits)
      }
    } catch (err) {
      console.error('Error fetching risk settings:', err)
    }
  }

  // Fetch scale-in settings from server
  const fetchScaleInSettings = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/settings/scale-in`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success && data.scaleIn) {
        setScaleInSettings(data.scaleIn)
      }
    } catch (err) {
      console.error('Error fetching scale-in settings:', err)
    }
  }

  // Update local risk settings state (doesn't save until Save clicked)
  const updateRiskSettings = (field, value) => {
    setSettingsSavedSection(null)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success) {
        setRiskSettings(data.riskLimits)
        // Refresh opportunities to update exposure bar
        await fetchOpportunities()
        setSettingsSavedSection('risk')
        setTimeout(() => setSettingsSavedSection(null), 3000)
      }
    } catch (err) {
      console.error('Error saving risk settings:', err)
    } finally {
      setSettingsSaving(false)
    }
  }

  // Update local scale-in settings state
  const updateScaleInSettings = (field, value) => {
    setSettingsSavedSection(null)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.success) {
        setScaleInSettings(data.scaleIn)
        setSettingsSavedSection('scaleIn')
        setTimeout(() => setSettingsSavedSection(null), 3000)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
  const winningBets = betHistory.filter(b => b.outcome === 'won').length
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
          <button className={`nav-item ${tab === 'copytrade' ? 'active' : ''}`} onClick={() => { setTab('copytrade'); fetchCopyStatus(); }}>
            <span className="nav-icon">⇄</span>
            <span className="nav-text">Copy Trade</span>
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
              <span className="risk-label">Positions</span>
              <span className="risk-value">{risk.positionCount || 0}</span>
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
              {tab === 'copytrade' && 'Copy Trading'}
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

        {/* Error Banner */}
        {error && (
          <div className="status-banner error" onClick={() => setError(null)}>
            <span className="status-icon">✕</span>
            <span className="status-message">{error}</span>
            <button className="status-close">×</button>
          </div>
        )}

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
                </div>
                <div className="risk-tokens">
                  {['BTC', 'ETH', 'SOL', 'XRP'].map(token => {
                    const cycleSpend = (risk.rollingSpendByToken?.[token] || 0);
                    const cycleLimit = risk.rollingTokenCap || (riskSettings.maxPerTokenPerCycle || 500);
                    const atLimit = cycleSpend >= cycleLimit * 0.9;
                    return (
                      <div className="risk-token" key={token}>
                        <span className="risk-token-name">{token}</span>
                        <span className={`risk-token-value ${atLimit ? 'at-limit' : ''}`}>
                          ${(cycleSpend / 100).toFixed(2)} / ${(cycleLimit / 100).toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                  <div className="risk-token">
                    <span className="risk-token-name">Positions</span>
                    <span className="risk-token-value">{risk.positionCount || 0}</span>
                  </div>
                </div>
                {(() => {
                  const totalSpend = risk.totalCycleSpend || 0;
                  const totalLimit = risk.maxTotalPerCycle || (riskSettings.maxTotalPerCycle || 1500);
                  const pct = totalLimit > 0 ? Math.min(100, (totalSpend / totalLimit) * 100) : 0;
                  const isWarning = pct >= 70;
                  const isDanger = pct >= 90;
                  return (
                    <div className="cycle-budget-bar">
                      <div className="cycle-budget-labels">
                        <span className="cycle-budget-title">Cycle Budget</span>
                        <span className={`cycle-budget-value ${isDanger ? 'danger' : isWarning ? 'warning' : ''}`}>
                          ${(totalSpend / 100).toFixed(2)} / ${(totalLimit / 100).toFixed(2)}
                        </span>
                      </div>
                      <div className="cycle-budget-track">
                        <div
                          className={`cycle-budget-fill ${isDanger ? 'danger' : isWarning ? 'warning' : ''}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}
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

                    {/* Per-Token P/L Breakdown */}
                    {performance.byToken && Object.keys(performance.byToken).length > 0 && (
                      <div className="history-stats token-breakdown">
                        {Object.entries(performance.byToken).map(([token, data]) => (
                          <div key={token} className={`stat-summary ${data.profit >= 0 ? 'positive' : 'negative'}`}>
                            <span className="stat-label">{token}</span>
                            <span className="stat-value">
                              {data.profit >= 0 ? '+' : ''}${(data.profit / 100).toFixed(2)}
                            </span>
                            <span className="stat-sublabel">{data.wins}W / {data.losses}L</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Recent Activity Section */}
                <div className="recent-history-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 className="section-subtitle">Recent Activity (Last 20)</h3>
                    {betHistory.length > 0 && (
                      <button
                        className="disconnect-btn"
                        style={{ fontSize: '12px', padding: '4px 12px' }}
                        onClick={async () => {
                          if (!window.confirm('Clear all bet history cards? This cannot be undone.')) return
                          try {
                            const res = await authFetch(`${API_BASE}/api/history`, { method: 'DELETE' })
                            const data = await res.json()
                            if (data.success) {
                              setBetHistory([])
                              betHistoryRef.current = []
                              fetchPerformance()
                            }
                          } catch (err) {
                            console.error('Failed to clear history:', err)
                          }
                        }}
                      >
                        Clear History
                      </button>
                    )}
                  </div>
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


          {/* Copy Trading Tab */}
          {tab === 'copytrade' && (
            <div className="settings-page">
              <div className="settings-grid">
                {/* Copy Trading Status */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">Copy Trading</h3>
                  <p className="settings-description">
                    Mirror trades from high-performing Kalshi accounts. Add a leader's read-only API key to automatically copy their positions.
                  </p>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '12px' }}>
                    <button
                      className={`auto-bet-btn ${copyStatus.running ? 'active' : ''}`}
                      onClick={async () => {
                        setCopyLoading(true)
                        setCopyError(null)
                        try {
                          const res = await authFetch(`${API_BASE}/api/copy-trading/toggle`, {
                            method: 'POST',
                            body: JSON.stringify({ enabled: !copyStatus.running })
                          })
                          const data = await res.json()
                          if (!data.success) setCopyError(data.error)
                          else fetchCopyStatus()
                        } catch (err) { setCopyError('Connection failed') }
                        finally { setCopyLoading(false) }
                      }}
                      disabled={copyLoading || copyStatus.stats.activeLeaders === 0}
                    >
                      {copyLoading ? 'Working...' : copyStatus.running ? 'Stop Copying' : 'Start Copying'}
                    </button>
                    <span className={`connection-status ${copyStatus.running ? 'connected' : 'simulated'}`} style={{ padding: '4px 8px' }}>
                      <span className="status-dot"></span>
                      <span>{copyStatus.running ? 'Copying Active' : 'Stopped'}</span>
                    </span>
                  </div>
                  {copyError && <div className="auth-error" style={{ marginTop: '8px' }}>{copyError}</div>}

                  {/* Aggregate Stats */}
                  <div className="settings-list" style={{ marginTop: '16px' }}>
                    <div className="settings-item">
                      <span className="settings-label">Leaders</span>
                      <span className="settings-value">{copyStatus.stats.activeLeaders} / {copyStatus.stats.totalLeaders}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Trades Copied</span>
                      <span className="settings-value">{copyStatus.stats.totalCopied}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Skipped</span>
                      <span className="settings-value">{copyStatus.stats.totalSkipped || 0}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Errors</span>
                      <span className="settings-value">{copyStatus.stats.totalErrored || 0}</span>
                    </div>
                  </div>
                </div>

                {/* Leader Accounts */}
                <div className="settings-card wide">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 className="settings-card-title" style={{ margin: 0 }}>Leader Accounts</h3>
                    <button className="connect-btn" onClick={() => setShowAddLeader(true)}>
                      + Add Leader
                    </button>
                  </div>

                  {copyStatus.leaders.length === 0 ? (
                    <div className="connect-prompt" style={{ marginTop: '16px' }}>
                      <p>No leader accounts configured. Add a Kalshi account to start copying trades.</p>
                    </div>
                  ) : (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {copyStatus.leaders.map(leader => (
                        <div key={leader.id} className="settings-card" style={{ margin: 0, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <strong>{leader.name}</strong>
                              <span style={{ marginLeft: '8px', opacity: 0.5, fontSize: '12px' }}>{leader.apiKeyId}</span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <span className={`connection-status ${leader.enabled ? 'connected' : 'simulated'}`} style={{ padding: '2px 6px', fontSize: '11px' }}>
                                <span className="status-dot"></span>
                                <span>{leader.enabled ? 'Active' : 'Paused'}</span>
                              </span>
                              <button
                                className="disconnect-btn"
                                style={{ padding: '4px 8px', fontSize: '11px' }}
                                onClick={async () => {
                                  const res = await authFetch(`${API_BASE}/api/copy-trading/leaders/${leader.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !leader.enabled }) })
                                  if (res.ok) fetchCopyStatus()
                                }}
                              >
                                {leader.enabled ? 'Pause' : 'Resume'}
                              </button>
                              <button
                                className="disconnect-btn"
                                style={{ padding: '4px 8px', fontSize: '11px', color: '#ff4444' }}
                                onClick={async () => {
                                  if (!confirm(`Remove leader "${leader.name}"?`)) return
                                  const res = await authFetch(`${API_BASE}/api/copy-trading/leaders/${leader.id}`, { method: 'DELETE' })
                                  if (res.ok) fetchCopyStatus()
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          <div className="settings-list" style={{ marginTop: '8px' }}>
                            <div className="settings-item">
                              <span className="settings-label">Scale Factor</span>
                              <span className="settings-value">{leader.scaleFactor}x</span>
                            </div>
                            <div className="settings-item">
                              <span className="settings-label">Max Bet</span>
                              <span className="settings-value">${(leader.maxBetCents / 100).toFixed(2)}</span>
                            </div>
                            <div className="settings-item">
                              <span className="settings-label">Trades Copied</span>
                              <span className="settings-value">{leader.stats.totalCopied}</span>
                            </div>
                            <div className="settings-item">
                              <span className="settings-label">Last Poll</span>
                              <span className="settings-value">{leader.lastPollAt ? new Date(leader.lastPollAt).toLocaleTimeString() : 'Never'}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent Copy Activity */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">Recent Activity</h3>
                  {copyStatus.recentActivity.length === 0 ? (
                    <p className="settings-description">No copy trading activity yet. Start copying to see trades here.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px', maxHeight: '400px', overflowY: 'auto' }}>
                      {copyStatus.recentActivity.map((item, i) => (
                        <div key={i} style={{
                          padding: '8px 12px',
                          borderRadius: '6px',
                          background: item.status === 'copied' ? 'rgba(0,255,136,0.08)' : item.status === 'error' ? 'rgba(255,68,68,0.08)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${item.status === 'copied' ? 'rgba(0,255,136,0.2)' : item.status === 'error' ? 'rgba(255,68,68,0.2)' : 'rgba(255,255,255,0.1)'}`,
                          fontSize: '13px'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>
                              <strong style={{ color: item.status === 'copied' ? '#00ff88' : item.status === 'error' ? '#ff4444' : '#ffaa00' }}>
                                {item.status === 'copied' ? 'COPIED' : item.status === 'error' ? 'ERROR' : 'SKIPPED'}
                              </strong>
                              {' '}{item.action} {item.copyCount || '?'}x {item.side?.toUpperCase()} {item.ticker}
                            </span>
                            <span style={{ opacity: 0.5 }}>{item.leaderName}</span>
                          </div>
                          {item.error && <div style={{ color: '#ff4444', fontSize: '11px', marginTop: '4px' }}>{item.error}</div>}
                          {item.timestamp && <div style={{ opacity: 0.4, fontSize: '11px', marginTop: '2px' }}>{new Date(item.timestamp).toLocaleString()}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Polymarket Cross-Platform Copy Trading */}
                <div className="settings-card wide" style={{ borderLeft: '3px solid #8b5cf6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h3 className="settings-card-title" style={{ margin: 0 }}>Polymarket → Kalshi Copy</h3>
                      <p className="settings-description" style={{ margin: '4px 0 0' }}>
                        Track any public Polymarket wallet and mirror their crypto bets on Kalshi. No keys needed -- all Polymarket data is on-chain.
                      </p>
                    </div>
                    <button className="connect-btn" onClick={() => setShowAddPolyWallet(true)}>
                      + Add Wallet
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '12px' }}>
                    <button
                      className={`auto-bet-btn ${polyStatus.running ? 'active' : ''}`}
                      onClick={async () => {
                        setPolyLoading(true)
                        setPolyError(null)
                        try {
                          const res = await authFetch(`${API_BASE}/api/poly-trading/toggle`, {
                            method: 'POST',
                            body: JSON.stringify({ enabled: !polyStatus.running })
                          })
                          const data = await res.json()
                          if (!data.success) setPolyError(data.error)
                          else fetchPolyStatus()
                        } catch (err) { setPolyError('Connection failed') }
                        finally { setPolyLoading(false) }
                      }}
                      disabled={polyLoading || polyStatus.stats.activeWallets === 0}
                    >
                      {polyLoading ? 'Working...' : polyStatus.running ? 'Stop Tracking' : 'Start Tracking'}
                    </button>
                    <span className={`connection-status ${polyStatus.running ? 'connected' : 'simulated'}`} style={{ padding: '4px 8px' }}>
                      <span className="status-dot"></span>
                      <span>{polyStatus.running ? 'Tracking Active' : 'Stopped'}</span>
                    </span>
                  </div>
                  {polyError && <div className="auth-error" style={{ marginTop: '8px' }}>{polyError}</div>}

                  {/* Poly Stats */}
                  <div className="settings-list" style={{ marginTop: '12px' }}>
                    <div className="settings-item">
                      <span className="settings-label">Wallets Tracked</span>
                      <span className="settings-value">{polyStatus.stats.activeWallets} / {polyStatus.stats.totalWallets}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Trades Copied</span>
                      <span className="settings-value" style={{ color: '#00ff88' }}>{polyStatus.stats.totalCopied}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">No Kalshi Match</span>
                      <span className="settings-value">{polyStatus.stats.totalNoMatch || 0}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Errors</span>
                      <span className="settings-value">{polyStatus.stats.totalErrored || 0}</span>
                    </div>
                  </div>

                  {/* Tracked wallets */}
                  {polyStatus.wallets.length > 0 && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {polyStatus.wallets.map(w => (
                        <div key={w.id} style={{
                          padding: '10px 14px',
                          borderRadius: '8px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border)',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <strong>{w.name}</strong>
                              <span style={{ marginLeft: '8px', opacity: 0.4, fontSize: '11px', fontFamily: 'monospace' }}>
                                {w.walletAddress.slice(0, 6)}...{w.walletAddress.slice(-4)}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button className="disconnect-btn" style={{ padding: '3px 7px', fontSize: '11px' }}
                                onClick={async () => {
                                  const res = await authFetch(`${API_BASE}/api/poly-trading/wallets/${w.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !w.enabled }) })
                                  if (res.ok) fetchPolyStatus()
                                }}
                              >{w.enabled ? 'Pause' : 'Resume'}</button>
                              <button className="disconnect-btn" style={{ padding: '3px 7px', fontSize: '11px', color: '#ff4444' }}
                                onClick={async () => {
                                  if (!confirm(`Remove "${w.name}"?`)) return
                                  const res = await authFetch(`${API_BASE}/api/poly-trading/wallets/${w.id}`, { method: 'DELETE' })
                                  if (res.ok) fetchPolyStatus()
                                }}
                              >Remove</button>
                            </div>
                          </div>
                          <div className="settings-list" style={{ marginTop: '6px' }}>
                            <div className="settings-item">
                              <span className="settings-label">Scale</span>
                              <span className="settings-value">{w.scaleFactor}x</span>
                            </div>
                            <div className="settings-item">
                              <span className="settings-label">Max Bet</span>
                              <span className="settings-value">${(w.maxBetCents / 100).toFixed(2)}</span>
                            </div>
                            <div className="settings-item">
                              <span className="settings-label">Copied</span>
                              <span className="settings-value">{w.stats.totalCopied}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Polymarket Activity Feed */}
                {polyStatus.recentActivity.length > 0 && (
                  <div className="settings-card wide">
                    <h3 className="settings-card-title">Polymarket Copy Activity</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                      {polyStatus.recentActivity.map((item, i) => (
                        <div key={i} style={{
                          padding: '8px 12px',
                          borderRadius: '6px',
                          background: item.status === 'copied' ? 'rgba(139,92,246,0.1)' : item.status === 'error' ? 'rgba(255,68,68,0.08)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${item.status === 'copied' ? 'rgba(139,92,246,0.3)' : item.status === 'error' ? 'rgba(255,68,68,0.2)' : 'rgba(255,255,255,0.1)'}`,
                          fontSize: '13px'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>
                              <strong style={{ color: item.status === 'copied' ? '#8b5cf6' : item.status === 'error' ? '#ff4444' : item.status === 'no_match' ? '#ff8800' : '#888' }}>
                                {item.status === 'copied' ? 'COPIED' : item.status === 'error' ? 'ERROR' : item.status === 'no_match' ? 'NO MATCH' : 'SKIPPED'}
                              </strong>
                              {item.status === 'copied' && <> {item.copyCount}x {item.kalshiSide?.toUpperCase()} {item.kalshiTicker}</>}
                              {item.status !== 'copied' && <> {item.polyTitle?.slice(0, 50)}</>}
                            </span>
                            <span style={{ opacity: 0.5, fontSize: '11px' }}>{item.walletName}</span>
                          </div>
                          {item.status === 'copied' && (
                            <div style={{ opacity: 0.5, fontSize: '11px', marginTop: '2px' }}>
                              from: {item.polyTitle?.slice(0, 60)} ({item.polyOutcome}) · ${item.polyUsdcSize}
                            </div>
                          )}
                          {item.error && <div style={{ color: '#ff4444', fontSize: '11px', marginTop: '2px' }}>{item.error}</div>}
                          {item.reason && item.status === 'no_match' && <div style={{ opacity: 0.4, fontSize: '11px', marginTop: '2px' }}>{item.reason}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* How Copy Trading Works */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">How Copy Trading Works</h3>
                  <div className="how-it-works">
                    <div className="how-step">
                      <div className="step-number">1</div>
                      <div className="step-content">
                        <h4>Add a Leader</h4>
                        <p>Enter the Kalshi API credentials of the account you want to copy. Read-only API keys work.</p>
                      </div>
                    </div>
                    <div className="how-step">
                      <div className="step-number">2</div>
                      <div className="step-content">
                        <h4>Configure Scale</h4>
                        <p>Set a scale factor (e.g. 0.5x = half size) and max bet cap to control your risk.</p>
                      </div>
                    </div>
                    <div className="how-step">
                      <div className="step-number">3</div>
                      <div className="step-content">
                        <h4>Start Copying</h4>
                        <p>The engine polls the leader's trades every 15 seconds and mirrors new positions on your account.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Add Leader Modal */}
          {showAddLeader && (
            <div className="modal-overlay" onClick={() => setShowAddLeader(false)}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>Add Leader Account</h2>
                  <button className="modal-close" onClick={() => setShowAddLeader(false)}>x</button>
                </div>
                <p className="modal-description">Enter the Kalshi API credentials of the account you want to copy trade. Read-only scope is sufficient.</p>

                {copyError && <div className="auth-error">{copyError}</div>}

                <form onSubmit={async (e) => {
                  e.preventDefault()
                  setCopyLoading(true)
                  setCopyError(null)
                  try {
                    const res = await authFetch(`${API_BASE}/api/copy-trading/leaders`, {
                      method: 'POST',
                      body: JSON.stringify(copyLeaderForm)
                    })
                    const data = await res.json()
                    if (data.success) {
                      setShowAddLeader(false)
                      setCopyLeaderForm({ name: '', apiKeyId: '', privateKey: '', scaleFactor: 1.0, maxBetCents: 500 })
                      fetchCopyStatus()
                    } else {
                      setCopyError(data.error)
                    }
                  } catch { setCopyError('Connection failed') }
                  finally { setCopyLoading(false) }
                }}>
                  <div className="form-group">
                    <label>Name (optional)</label>
                    <input
                      type="text"
                      value={copyLeaderForm.name}
                      onChange={e => setCopyLeaderForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Top Crypto Trader"
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group">
                    <label>Leader's API Key ID</label>
                    <input
                      type="text"
                      value={copyLeaderForm.apiKeyId}
                      onChange={e => setCopyLeaderForm(f => ({ ...f, apiKeyId: e.target.value }))}
                      placeholder="API key ID from the leader's account"
                      required
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group">
                    <label>Leader's Private Key (PEM)</label>
                    <textarea
                      value={copyLeaderForm.privateKey}
                      onChange={e => setCopyLeaderForm(f => ({ ...f, privateKey: e.target.value }))}
                      placeholder="-----BEGIN PRIVATE KEY-----..."
                      rows={5}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Scale Factor ({copyLeaderForm.scaleFactor}x)</label>
                    <input
                      type="range"
                      min="0.1"
                      max="5"
                      step="0.1"
                      value={copyLeaderForm.scaleFactor}
                      onChange={e => setCopyLeaderForm(f => ({ ...f, scaleFactor: parseFloat(e.target.value) }))}
                    />
                    <span style={{ fontSize: '12px', opacity: 0.6 }}>
                      Leader bets 10 contracts, you bet {Math.round(10 * copyLeaderForm.scaleFactor)} contracts
                    </span>
                  </div>
                  <div className="form-group">
                    <label>Max Bet Per Copy (${(copyLeaderForm.maxBetCents / 100).toFixed(2)})</label>
                    <input
                      type="range"
                      min="50"
                      max="5000"
                      step="50"
                      value={copyLeaderForm.maxBetCents}
                      onChange={e => setCopyLeaderForm(f => ({ ...f, maxBetCents: parseInt(e.target.value) }))}
                    />
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={() => setShowAddLeader(false)}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={copyLoading}>
                      {copyLoading ? 'Validating...' : 'Add Leader'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Add Polymarket Wallet Modal */}
          {showAddPolyWallet && (
            <div className="modal-overlay" onClick={() => setShowAddPolyWallet(false)}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>Track Polymarket Wallet</h2>
                  <button className="modal-close" onClick={() => setShowAddPolyWallet(false)}>x</button>
                </div>
                <p className="modal-description">
                  Paste any Polymarket wallet address. Their trades are public on-chain -- no API keys needed.
                  Find wallet addresses from polymarket.com profiles.
                </p>

                {polyError && <div className="auth-error">{polyError}</div>}

                <form onSubmit={async (e) => {
                  e.preventDefault()
                  setPolyLoading(true)
                  setPolyError(null)
                  try {
                    const res = await authFetch(`${API_BASE}/api/poly-trading/wallets`, {
                      method: 'POST',
                      body: JSON.stringify(polyWalletForm)
                    })
                    const data = await res.json()
                    if (data.success) {
                      setShowAddPolyWallet(false)
                      setPolyWalletForm({ name: '', walletAddress: '', scaleFactor: 1.0, maxBetCents: 500 })
                      fetchPolyStatus()
                    } else {
                      setPolyError(data.error)
                    }
                  } catch { setPolyError('Connection failed') }
                  finally { setPolyLoading(false) }
                }}>
                  <div className="form-group">
                    <label>Name (optional)</label>
                    <input
                      type="text"
                      value={polyWalletForm.name}
                      onChange={e => setPolyWalletForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. 0x8dxd / daverific"
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group">
                    <label>Wallet Address</label>
                    <input
                      type="text"
                      value={polyWalletForm.walletAddress}
                      onChange={e => setPolyWalletForm(f => ({ ...f, walletAddress: e.target.value }))}
                      placeholder="0x63ce342161250d705dc0b16df89036c8e5f9ba9a"
                      required
                      autoComplete="off"
                      style={{ fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>
                  <div className="form-group">
                    <label>Scale Factor ({polyWalletForm.scaleFactor}x)</label>
                    <input
                      type="range"
                      min="0.01"
                      max="2"
                      step="0.01"
                      value={polyWalletForm.scaleFactor}
                      onChange={e => setPolyWalletForm(f => ({ ...f, scaleFactor: parseFloat(e.target.value) }))}
                    />
                    <span style={{ fontSize: '12px', opacity: 0.6 }}>
                      This trader bets big -- 0.01x-0.1x recommended to start small
                    </span>
                  </div>
                  <div className="form-group">
                    <label>Max Bet Per Copy (${(polyWalletForm.maxBetCents / 100).toFixed(2)})</label>
                    <input
                      type="range"
                      min="50"
                      max="5000"
                      step="50"
                      value={polyWalletForm.maxBetCents}
                      onChange={e => setPolyWalletForm(f => ({ ...f, maxBetCents: parseInt(e.target.value) }))}
                    />
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={() => setShowAddPolyWallet(false)}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={polyLoading}>
                      {polyLoading ? 'Verifying wallet...' : 'Track Wallet'}
                    </button>
                  </div>
                </form>
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
                      <span className="settings-label">Per Token / Cycle</span>
                      <span className="settings-value">${((riskSettings.maxPerTokenPerCycle || 500) / 100).toFixed(2)}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Total Cycle Budget</span>
                      <span className="settings-value">${((riskSettings.maxTotalPerCycle || 1500) / 100).toFixed(2)}</span>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">Min Edge</span>
                      <span className="settings-value">{selectivityRules.minEdgeAfterFees || 5}%</span>
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
                        label="Per token / cycle"
                        value={Math.round((riskSettings.maxPerTokenPerCycle || 500) / 100)}
                        onChange={(v) => updateRiskSettings('maxPerTokenPerCycle', v * 100)}
                        min={2}
                        max={50}
                      />
                      <DollarStepper
                        label="Total cycle budget"
                        value={Math.round((riskSettings.maxTotalPerCycle || 1500) / 100)}
                        onChange={(v) => updateRiskSettings('maxTotalPerCycle', v * 100)}
                        min={2}
                        max={100}
                      />
                    </div>
                  </div>
                  <button className={`save-settings-btn ${settingsSavedSection === 'risk' ? 'saved' : ''}`} onClick={saveRiskSettings}>
                    {settingsSavedSection === 'risk' ? '✓ Saved' : 'Save Risk Settings'}
                  </button>
                </div>

                {/* Scale-In Settings - hidden from UI, logic still active server-side */}


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

                {/* Model Monitoring */}
                <div className="settings-card wide">
                  <h3 className="settings-card-title">Model Monitoring</h3>
                  <p className="settings-description">Monitor model performance and adjust betting thresholds</p>

                  {/* Selectivity Rules */}
                  <div className="model-section" style={{ marginBottom: '20px' }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#ccc' }}>Betting Thresholds</h4>
                    <div className="threshold-controls-grid">
                      <div className="threshold-control">
                        <label style={{ fontSize: '12px', color: '#888' }}>Min Edge After Fees</label>
                        <div className="threshold-controls">
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minEdgeAfterFees', Math.max(1, selectivityRules.minEdgeAfterFees - 1))}>-</button>
                          <span className="threshold-value">{selectivityRules.minEdgeAfterFees}%</span>
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minEdgeAfterFees', Math.min(20, selectivityRules.minEdgeAfterFees + 1))}>+</button>
                        </div>
                        <span style={{ fontSize: '10px', color: '#666' }}>Recommended: 5-8%</span>
                      </div>
                      <div className="threshold-control">
                        <label style={{ fontSize: '12px', color: '#888' }}>Min Win Rate</label>
                        <div className="threshold-controls">
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minEmpiricalWinRate', Math.max(50, selectivityRules.minEmpiricalWinRate - 2))}>-</button>
                          <span className="threshold-value">{selectivityRules.minEmpiricalWinRate}%</span>
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minEmpiricalWinRate', Math.min(90, selectivityRules.minEmpiricalWinRate + 2))}>+</button>
                        </div>
                        <span style={{ fontSize: '10px', color: '#666' }}>Recommended: 62%</span>
                      </div>
                      <div className="threshold-control">
                        <label style={{ fontSize: '12px', color: '#888' }}>Min Signal Strength</label>
                        <div className="threshold-controls">
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minSignalStrength', Math.max(50, selectivityRules.minSignalStrength - 5))}>-</button>
                          <span className="threshold-value">{selectivityRules.minSignalStrength}</span>
                          <button className="threshold-btn" onClick={() => updateSelectivityRules('minSignalStrength', Math.min(95, selectivityRules.minSignalStrength + 5))}>+</button>
                        </div>
                        <span style={{ fontSize: '10px', color: '#666' }}>Recommended: 70</span>
                      </div>
                    </div>
                  </div>

                  <button onClick={fetchModelMonitoring} style={{ marginTop: '16px', padding: '8px 16px', background: '#2a2a3e', border: 'none', borderRadius: '6px', color: '#ccc', cursor: 'pointer' }}>
                    Refresh Data
                  </button>
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
            <span className="mobile-exposure-label">Positions</span>
            <span className="mobile-exposure-value">
              {risk.positionCount || 0}
            </span>
          </div>
        </div>

        {/* Mobile Nav */}
        <nav className="mobile-nav">
          <button className={`mobile-nav-item ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
            <span>📊</span>
            <span>Home</span>
          </button>
          <button className={`mobile-nav-item ${tab === 'history' ? 'active' : ''}`} onClick={() => { setTab('history'); fetchPerformance(); setNewBetsCount(0); setLastSeenBetId(betHistory[0]?.id); }}>
            <span>📈</span>
            <span>History</span>
            {newBetsCount > 0 && <span className="nav-badge mobile">{newBetsCount}</span>}
          </button>
          <button className={`mobile-nav-item ${tab === 'copytrade' ? 'active' : ''}`} onClick={() => { setTab('copytrade'); fetchCopyStatus(); }}>
            <span>⇄</span>
            <span>Copy</span>
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
