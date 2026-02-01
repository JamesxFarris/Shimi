import { useState, useEffect, useCallback, memo } from 'react'

const API_BASE = '/api'

// Move components outside App to prevent re-creation on every render
const TradingCard = memo(({ market, showKelly = true, onPlaceBet }) => {
  const formatCurrency = (value) => `$${(value || 0).toFixed(2)}`
  const formatPercent = (value) => `${(value || 0).toFixed(1)}%`

  const getProbabilityColor = (prob) => {
    if (prob >= 80) return 'prob-high'
    if (prob >= 65) return 'prob-medium'
    return 'prob-low'
  }

  const getEdgeColor = (edge) => {
    if (edge >= 15) return 'edge-high'
    if (edge >= 8) return 'edge-medium'
    return 'edge-low'
  }

  return (
    <div className="market-card trading">
      <div className="market-header">
        <span className={`bet-direction ${market.bestBet?.toLowerCase()}`}>
          {market.bestBet}
        </span>
        <span className="market-ticker">{market.ticker}</span>
      </div>
      <h3 className="market-title">{market.title}</h3>

      <div className="market-stats">
        <div className="stat">
          <span className="stat-label">Win Chance</span>
          <span className={`stat-value ${getProbabilityColor(market.bestProbability)}`}>
            {formatPercent(market.bestProbability)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Edge</span>
          <span className={`stat-value ${getEdgeColor(market.edge)}`}>
            +{formatPercent(market.edge)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Cost</span>
          <span className="stat-value">{formatCurrency(market.bestAskPrice)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Closes</span>
          <span className="stat-value time">{market.timeRemainingFormatted}</span>
        </div>
      </div>

      {showKelly && market.recommendedBet > 0 && (
        <div className="kelly-recommendation">
          <span className="kelly-label">KELLY SAYS BET</span>
          <span className="kelly-amount">{formatCurrency(market.recommendedBet / 100)}</span>
        </div>
      )}

      <div className="card-actions">
        <button
          className="bet-button small"
          onClick={() => onPlaceBet(market.ticker, market.bestBet, market.recommendedBet / 100 || 1)}
        >
          BET {formatCurrency(market.recommendedBet / 100 || 1)}
        </button>
        <a
          href={`https://kalshi.com/markets/${market.eventTicker}`}
          target="_blank"
          rel="noopener noreferrer"
          className="view-button"
        >
          VIEW
        </a>
      </div>
    </div>
  )
})

function App() {
  const [markets, setMarkets] = useState([])
  const [quickBets, setQuickBets] = useState(null)
  const [optimalBets, setOptimalBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [activeTab, setActiveTab] = useState('trading')
  const [apiError, setApiError] = useState(null)

  // Auth & Portfolio
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [portfolio, setPortfolio] = useState({ balance: 10, positions: [], betHistory: [] })
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [apiKeyId, setApiKeyId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  // Settings
  const [settings, setSettings] = useState({
    bankroll: 10,
    maxBetPercent: 25,
    minBetAmount: 1,
    maxTimeDays: 3,
    minProbability: 60,
    minEdge: 5,
    autoBetEnabled: false
  })

  // Filters - use local state that doesn't trigger API calls immediately
  const [sortBy, setSortBy] = useState('edge')
  const [sortOrder, setSortOrder] = useState('desc')
  const [minProbability, setMinProbability] = useState(50)
  const [minProfit, setMinProfit] = useState(10)
  const [maxTimeDays, setMaxTimeDays] = useState(3)
  const [search, setSearch] = useState('')

  const formatCurrency = (value) => `$${(value || 0).toFixed(2)}`

  // Fetch functions with better error handling
  const fetchAuthStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/status`)
      if (response.ok) {
        const data = await response.json()
        setIsAuthenticated(data.isAuthenticated)
      }
    } catch (err) {
      console.error('Auth status error:', err)
    }
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/settings`)
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setSettings(data.settings)
        }
      }
    } catch (err) {
      console.error('Settings error:', err)
    }
  }, [])

  const fetchPortfolio = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/portfolio`)
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setPortfolio({
            balance: data.balance || 10,
            portfolioValue: data.portfolioValue,
            positions: data.positions || [],
            betHistory: data.betHistory || [],
            simulated: data.simulated
          })
        }
      }
    } catch (err) {
      console.error('Portfolio error:', err)
    }
  }, [])

  const fetchMarkets = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        sortBy,
        sortOrder,
        minProbability: minProbability.toString(),
        minProfit: minProfit.toString(),
        maxTimeDays: maxTimeDays.toString(),
        ...(search && { search })
      })

      const response = await fetch(`${API_BASE}/markets?${params}`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json()

      if (data.success) {
        setMarkets(data.markets || [])
        setLastUpdate(new Date())
        setApiError(null)
      } else {
        setApiError(data.error || 'Failed to load markets')
      }
    } catch (err) {
      console.error('Markets error:', err)
      setApiError('Failed to connect to Kalshi API. Retrying...')
    }
  }, [sortBy, sortOrder, minProbability, minProfit, maxTimeDays, search])

  const fetchQuickBets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/quick-bets?maxTimeDays=${maxTimeDays}`)
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setQuickBets(data.quickBets)
        }
      }
    } catch (err) {
      console.error('Quick bets error:', err)
    }
  }, [maxTimeDays])

  const fetchOptimalBets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/optimal-bets?maxTimeDays=${maxTimeDays}`)
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setOptimalBets(data.bets || [])
        }
      }
    } catch (err) {
      console.error('Optimal bets error:', err)
    }
  }, [maxTimeDays])

  const fetchData = useCallback(async () => {
    setLoading(true)
    await Promise.all([
      fetchMarkets(),
      fetchQuickBets(),
      fetchOptimalBets(),
      fetchPortfolio(),
      fetchSettings()
    ])
    setLoading(false)
  }, [fetchMarkets, fetchQuickBets, fetchOptimalBets, fetchPortfolio, fetchSettings])

  // Initial fetch
  useEffect(() => {
    fetchAuthStatus()
    fetchData()
  }, [])

  // Debounced refetch when filters change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchMarkets()
      fetchQuickBets()
      fetchOptimalBets()
    }, 500)
    return () => clearTimeout(timer)
  }, [sortBy, sortOrder, minProbability, minProfit, maxTimeDays, search])

  // Auto-refresh every 30 seconds (less aggressive for mobile)
  useEffect(() => {
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Configure API
  const handleConfigureApi = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setAuthError('')
    setAuthLoading(true)

    try {
      const response = await fetch(`${API_BASE}/auth/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyId: apiKeyId.trim(), privateKey: privateKey.trim() })
      })
      const data = await response.json()

      if (data.success) {
        setIsAuthenticated(true)
        setShowAuthModal(false)
        setApiKeyId('')
        setPrivateKey('')
        fetchPortfolio()
        fetchSettings()
      } else {
        setAuthError(data.error || 'Failed to authenticate')
      }
    } catch (err) {
      setAuthError('Connection error: ' + err.message)
    } finally {
      setAuthLoading(false)
    }
  }

  // Update settings with debounce
  const handleUpdateSettings = useCallback(async (newSettings) => {
    try {
      const response = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      })
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setSettings(data.settings)
        }
      }
    } catch (err) {
      console.error('Update settings error:', err)
    }
  }, [])

  // Place bet
  const handlePlaceBet = useCallback(async (ticker, side, amount) => {
    try {
      const response = await fetch(`${API_BASE}/bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, side, amount })
      })
      const data = await response.json()

      if (data.success) {
        fetchPortfolio()
        fetchData()
        return data
      } else {
        alert('Bet failed: ' + data.error)
        return null
      }
    } catch (err) {
      alert('Bet error: ' + err.message)
      return null
    }
  }, [fetchPortfolio, fetchData])

  // Auto-bet
  const handleAutoBet = useCallback(async (dryRun = false) => {
    try {
      const response = await fetch(`${API_BASE}/auto-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTimeDays, dryRun })
      })
      const data = await response.json()

      if (data.success) {
        if (dryRun) {
          return data.recommendation
        } else {
          fetchPortfolio()
          fetchData()
          return data.bet
        }
      }
      return null
    } catch (err) {
      console.error('Auto-bet error:', err)
      return null
    }
  }, [maxTimeDays, fetchPortfolio, fetchData])

  // Toggle auto-betting
  const handleToggleAutoBet = useCallback(async (enabled) => {
    try {
      const response = await fetch(`${API_BASE}/auto-bet/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalMinutes: 5 })
      })
      const data = await response.json()
      if (data.success) {
        setSettings(prev => ({ ...prev, autoBetEnabled: data.enabled }))
      }
    } catch (err) {
      console.error('Toggle auto-bet error:', err)
    }
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1 className="logo">
            <span className="logo-icon">🎰</span>
            SHIMI
          </h1>
          <p className="tagline">Kelly Criterion Betting Engine</p>
        </div>
        <div className="header-status">
          {lastUpdate && (
            <span className="last-update">
              {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <button onClick={fetchData} className="refresh-btn" disabled={loading}>
            {loading ? '...' : '↻'}
          </button>
        </div>
      </header>

      {(error || apiError) && (
        <div className="error-banner">
          {error || apiError}
        </div>
      )}

      <div className="main-layout">
        {/* Portfolio Panel */}
        <div className="portfolio-panel">
          <div className="portfolio-header">
            <h2>Portfolio</h2>
            {portfolio.simulated && <span className="sim-badge">SIM</span>}
          </div>

          <div className="balance-display">
            <span className="balance-label">Balance</span>
            <span className="balance-amount">{formatCurrency(portfolio.balance)}</span>
          </div>

          {!isAuthenticated && (
            <button className="connect-btn" onClick={() => setShowAuthModal(true)}>
              Connect Kalshi
            </button>
          )}

          <div className="portfolio-section">
            <h3>Settings</h3>
            <div className="setting-row">
              <label>Max Days</label>
              <input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                min="1"
                max="30"
                value={maxTimeDays}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 3
                  setMaxTimeDays(val)
                  handleUpdateSettings({ maxTimeDays: val })
                }}
              />
            </div>
            <div className="setting-row">
              <label>Min Win %</label>
              <input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                min="50"
                max="95"
                value={settings.minProbability}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 60
                  handleUpdateSettings({ minProbability: val })
                }}
              />
            </div>
            <div className="setting-row">
              <label>Min Edge %</label>
              <input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                min="0"
                max="50"
                value={settings.minEdge}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 5
                  handleUpdateSettings({ minEdge: val })
                }}
              />
            </div>
          </div>

          <div className="portfolio-section">
            <h3>Auto-Bet</h3>
            <button
              className={`auto-bet-toggle ${settings.autoBetEnabled ? 'active' : ''}`}
              onClick={() => handleToggleAutoBet(!settings.autoBetEnabled)}
            >
              {settings.autoBetEnabled ? 'STOP' : 'START'} AUTO
            </button>
            <button
              className="auto-bet-once"
              onClick={() => handleAutoBet(false)}
            >
              Bet Now
            </button>
          </div>

          {portfolio.betHistory.length > 0 && (
            <div className="portfolio-section">
              <h3>Recent</h3>
              <div className="bet-history">
                {portfolio.betHistory.slice(0, 3).map(bet => (
                  <div key={bet.id} className="bet-history-item">
                    <span className={`bet-side ${bet.side}`}>{bet.side?.toUpperCase()}</span>
                    <span className="bet-ticker">{bet.ticker}</span>
                    <span className={`bet-status ${bet.status}`}>{bet.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="content">
          <nav className="tabs">
            <button
              className={`tab ${activeTab === 'trading' ? 'active' : ''}`}
              onClick={() => setActiveTab('trading')}
            >
              OPTIMAL
            </button>
            <button
              className={`tab ${activeTab === 'quick' ? 'active' : ''}`}
              onClick={() => setActiveTab('quick')}
            >
              PICKS
            </button>
            <button
              className={`tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              ALL
            </button>
          </nav>

          {loading && markets.length === 0 && (
            <div className="loading-state">
              <p>Loading markets from Kalshi...</p>
            </div>
          )}

          {activeTab === 'trading' && (
            <main className="main">
              <div className="trading-header">
                <h2>Kelly Picks</h2>
                <p className="trading-desc">
                  Closing within {maxTimeDays} day{maxTimeDays !== 1 ? 's' : ''}
                </p>
              </div>

              {optimalBets.length > 0 ? (
                <div className="trading-grid">
                  {optimalBets.map(market => (
                    <TradingCard
                      key={market.ticker}
                      market={market}
                      onPlaceBet={handlePlaceBet}
                    />
                  ))}
                </div>
              ) : !loading ? (
                <div className="no-results">
                  No optimal bets found. Try lowering min edge or probability.
                </div>
              ) : null}
            </main>
          )}

          {activeTab === 'quick' && (
            <main className="main">
              {quickBets?.kellyPicks?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">📊 KELLY PICKS</h2>
                  <div className="quick-grid">
                    {quickBets.kellyPicks.map(market => (
                      <TradingCard
                        key={market.ticker}
                        market={market}
                        onPlaceBet={handlePlaceBet}
                      />
                    ))}
                  </div>
                </div>
              )}

              {quickBets?.closingSoon?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">⏰ CLOSING SOON</h2>
                  <div className="quick-grid">
                    {quickBets.closingSoon.map(market => (
                      <TradingCard
                        key={market.ticker}
                        market={market}
                        showKelly={false}
                        onPlaceBet={handlePlaceBet}
                      />
                    ))}
                  </div>
                </div>
              )}

              {quickBets?.safeishBets?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">🛡️ SAFE-ISH</h2>
                  <div className="quick-grid">
                    {quickBets.safeishBets.map(market => (
                      <TradingCard
                        key={market.ticker}
                        market={market}
                        showKelly={false}
                        onPlaceBet={handlePlaceBet}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!quickBets && !loading && (
                <div className="no-results">Loading picks...</div>
              )}
            </main>
          )}

          {activeTab === 'all' && (
            <main className="main">
              <div className="filters">
                <div className="filter-group">
                  <label>Search</label>
                  <input
                    type="text"
                    inputMode="search"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search..."
                    className="filter-input"
                  />
                </div>

                <div className="filter-row">
                  <div className="filter-group">
                    <label>Sort</label>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="filter-select"
                    >
                      <option value="edge">Edge</option>
                      <option value="bestProbability">Probability</option>
                      <option value="timeRemaining">Time</option>
                    </select>
                  </div>

                  <div className="filter-group">
                    <label>Min Win: {minProbability}%</label>
                    <input
                      type="range"
                      min="0"
                      max="95"
                      value={minProbability}
                      onChange={(e) => setMinProbability(Number(e.target.value))}
                      className="filter-range"
                    />
                  </div>
                </div>
              </div>

              <div className="results-count">
                {markets.length} markets
              </div>

              <div className="markets-grid">
                {markets.map(market => (
                  <TradingCard
                    key={market.ticker}
                    market={market}
                    onPlaceBet={handlePlaceBet}
                  />
                ))}
              </div>

              {markets.length === 0 && !loading && (
                <div className="no-results">
                  No markets found. Try different filters.
                </div>
              )}
            </main>
          )}
        </div>
      </div>

      <footer className="footer">
        <p>SHIMI - Gamble responsibly 🎲</p>
      </footer>

      {/* Auth Modal - Keep it simple and outside main render logic */}
      {showAuthModal && (
        <div className="modal-overlay" onClick={() => !authLoading && setShowAuthModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Connect Kalshi</h2>
            <p className="modal-desc">
              Get API keys from{' '}
              <a href="https://kalshi.com/account/api-keys" target="_blank" rel="noopener noreferrer">
                kalshi.com/account/api-keys
              </a>
            </p>

            {authError && <div className="auth-error">{authError}</div>}

            <form onSubmit={handleConfigureApi}>
              <div className="form-group">
                <label>API Key ID</label>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  value={apiKeyId}
                  onChange={e => setApiKeyId(e.target.value)}
                  placeholder="Your API Key ID"
                  disabled={authLoading}
                  required
                />
              </div>
              <div className="form-group">
                <label>Private Key (RSA PEM)</label>
                <textarea
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  value={privateKey}
                  onChange={e => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
                  rows={8}
                  disabled={authLoading}
                  required
                />
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => setShowAuthModal(false)}
                  disabled={authLoading}
                >
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
