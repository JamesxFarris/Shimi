import { useState, useEffect, useCallback } from 'react'

const API_BASE = '/api'

function App() {
  const [markets, setMarkets] = useState([])
  const [quickBets, setQuickBets] = useState(null)
  const [optimalBets, setOptimalBets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [activeTab, setActiveTab] = useState('trading')

  // Auth & Portfolio
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [portfolio, setPortfolio] = useState({ balance: 10, positions: [], betHistory: [] })
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [apiKeyId, setApiKeyId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [authError, setAuthError] = useState('')

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

  // Filters
  const [sortBy, setSortBy] = useState('edge')
  const [sortOrder, setSortOrder] = useState('desc')
  const [minProbability, setMinProbability] = useState(50)
  const [minProfit, setMinProfit] = useState(10)
  const [maxTimeDays, setMaxTimeDays] = useState(3)
  const [search, setSearch] = useState('')

  // Fetch functions
  const fetchAuthStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/status`)
      const data = await response.json()
      setIsAuthenticated(data.isAuthenticated)
    } catch (err) {
      console.error('Auth status error:', err)
    }
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/settings`)
      const data = await response.json()
      if (data.success) {
        setSettings(data.settings)
        setMaxTimeDays(data.settings.maxTimeDays)
      }
    } catch (err) {
      console.error('Settings error:', err)
    }
  }, [])

  const fetchPortfolio = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/portfolio`)
      const data = await response.json()
      if (data.success) {
        setPortfolio({
          balance: data.balance,
          portfolioValue: data.portfolioValue,
          positions: data.positions || [],
          betHistory: data.betHistory || [],
          simulated: data.simulated
        })
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
      const data = await response.json()

      if (data.success) {
        setMarkets(data.markets)
        setLastUpdate(new Date())
        setError(null)
      } else {
        setError(data.error)
      }
    } catch (err) {
      setError(err.message)
    }
  }, [sortBy, sortOrder, minProbability, minProfit, maxTimeDays, search])

  const fetchQuickBets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/quick-bets?maxTimeDays=${maxTimeDays}`)
      const data = await response.json()

      if (data.success) {
        setQuickBets(data.quickBets)
      }
    } catch (err) {
      console.error('Quick bets error:', err)
    }
  }, [maxTimeDays])

  const fetchOptimalBets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/optimal-bets?maxTimeDays=${maxTimeDays}`)
      const data = await response.json()

      if (data.success) {
        setOptimalBets(data.bets)
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

  // Refetch when filters change
  useEffect(() => {
    fetchMarkets()
    fetchQuickBets()
    fetchOptimalBets()
  }, [fetchMarkets, fetchQuickBets, fetchOptimalBets])

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 15000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Configure API
  const handleConfigureApi = async (e) => {
    e.preventDefault()
    setAuthError('')

    try {
      const response = await fetch(`${API_BASE}/auth/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyId, privateKey })
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
        setAuthError(data.error)
      }
    } catch (err) {
      setAuthError(err.message)
    }
  }

  // Update settings
  const handleUpdateSettings = async (newSettings) => {
    try {
      const response = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      })
      const data = await response.json()
      if (data.success) {
        setSettings(data.settings)
      }
    } catch (err) {
      console.error('Update settings error:', err)
    }
  }

  // Place bet
  const handlePlaceBet = async (ticker, side, amount) => {
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
  }

  // Auto-bet
  const handleAutoBet = async (dryRun = false) => {
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
  }

  // Toggle auto-betting
  const handleToggleAutoBet = async (enabled) => {
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
  }

  const formatCurrency = (value) => `$${value.toFixed(2)}`
  const formatPercent = (value) => `${value.toFixed(1)}%`

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

  // Trading Card Component
  const TradingCard = ({ market, showKelly = true }) => (
    <div className="market-card trading">
      <div className="market-header">
        <span className={`bet-direction ${market.bestBet.toLowerCase()}`}>
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
          onClick={() => handlePlaceBet(market.ticker, market.bestBet, market.recommendedBet / 100 || 1)}
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

  // Portfolio Panel
  const PortfolioPanel = () => (
    <div className="portfolio-panel">
      <div className="portfolio-header">
        <h2>Portfolio</h2>
        {portfolio.simulated && <span className="sim-badge">SIMULATED</span>}
      </div>

      <div className="balance-display">
        <span className="balance-label">Balance</span>
        <span className="balance-amount">{formatCurrency(portfolio.balance)}</span>
      </div>

      {!isAuthenticated && (
        <button className="connect-btn" onClick={() => setShowAuthModal(true)}>
          Connect Kalshi Account
        </button>
      )}

      <div className="portfolio-section">
        <h3>Quick Settings</h3>
        <div className="setting-row">
          <label>Max Time (days)</label>
          <input
            type="number"
            min="1"
            max="30"
            value={maxTimeDays}
            onChange={(e) => {
              setMaxTimeDays(Number(e.target.value))
              handleUpdateSettings({ maxTimeDays: Number(e.target.value) })
            }}
          />
        </div>
        <div className="setting-row">
          <label>Min Win %</label>
          <input
            type="number"
            min="50"
            max="95"
            value={settings.minProbability}
            onChange={(e) => handleUpdateSettings({ minProbability: Number(e.target.value) })}
          />
        </div>
        <div className="setting-row">
          <label>Min Edge %</label>
          <input
            type="number"
            min="0"
            max="50"
            value={settings.minEdge}
            onChange={(e) => handleUpdateSettings({ minEdge: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="portfolio-section">
        <h3>Auto-Betting</h3>
        <button
          className={`auto-bet-toggle ${settings.autoBetEnabled ? 'active' : ''}`}
          onClick={() => handleToggleAutoBet(!settings.autoBetEnabled)}
        >
          {settings.autoBetEnabled ? 'STOP AUTO-BET' : 'START AUTO-BET'}
        </button>
        <button
          className="auto-bet-once"
          onClick={() => handleAutoBet(false)}
        >
          Place Best Bet Now
        </button>
      </div>

      {portfolio.betHistory.length > 0 && (
        <div className="portfolio-section">
          <h3>Recent Bets</h3>
          <div className="bet-history">
            {portfolio.betHistory.slice(0, 5).map(bet => (
              <div key={bet.id} className="bet-history-item">
                <div className="bet-info">
                  <span className={`bet-side ${bet.side}`}>{bet.side.toUpperCase()}</span>
                  <span className="bet-ticker">{bet.ticker}</span>
                </div>
                <div className="bet-details">
                  <span>{formatCurrency(bet.totalCost / 100)}</span>
                  <span className={`bet-status ${bet.status}`}>{bet.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  // Auth Modal
  const AuthModal = () => (
    <div className="modal-overlay" onClick={() => setShowAuthModal(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Connect Kalshi Account</h2>
        <p className="modal-desc">
          Enter your Kalshi API credentials to enable real trading.
          Generate keys at <a href="https://kalshi.com/account/api-keys" target="_blank" rel="noopener noreferrer">kalshi.com/account/api-keys</a>
        </p>

        {authError && <div className="auth-error">{authError}</div>}

        <form onSubmit={handleConfigureApi}>
          <div className="form-group">
            <label>API Key ID</label>
            <input
              type="text"
              value={apiKeyId}
              onChange={e => setApiKeyId(e.target.value)}
              placeholder="Enter your API Key ID"
              required
            />
          </div>
          <div className="form-group">
            <label>Private Key (RSA)</label>
            <textarea
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
              rows={6}
              required
            />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setShowAuthModal(false)}>Cancel</button>
            <button type="submit" className="primary">Connect</button>
          </div>
        </form>
      </div>
    </div>
  )

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
              Updated: {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <button onClick={fetchData} className="refresh-btn" disabled={loading}>
            {loading ? '...' : '↻'}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">Error: {error}</div>}

      <div className="main-layout">
        <PortfolioPanel />

        <div className="content">
          <nav className="tabs">
            <button
              className={`tab ${activeTab === 'trading' ? 'active' : ''}`}
              onClick={() => setActiveTab('trading')}
            >
              OPTIMAL BETS
            </button>
            <button
              className={`tab ${activeTab === 'quick' ? 'active' : ''}`}
              onClick={() => setActiveTab('quick')}
            >
              QUICK PICKS
            </button>
            <button
              className={`tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              ALL MARKETS
            </button>
          </nav>

          {activeTab === 'trading' && (
            <main className="main">
              <div className="trading-header">
                <h2>Kelly Criterion Picks</h2>
                <p className="trading-desc">
                  Mathematically optimal bets based on edge and probability.
                  Markets closing within {maxTimeDays} day{maxTimeDays !== 1 ? 's' : ''}.
                </p>
              </div>

              {optimalBets.length > 0 ? (
                <div className="trading-grid">
                  {optimalBets.map(market => (
                    <TradingCard key={market.ticker} market={market} />
                  ))}
                </div>
              ) : (
                <div className="no-results">
                  No optimal bets found matching your criteria.
                  Try adjusting min probability or edge settings.
                </div>
              )}
            </main>
          )}

          {activeTab === 'quick' && quickBets && (
            <main className="main">
              {quickBets.kellyPicks?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">
                    <span className="section-icon">📊</span>
                    KELLY PICKS
                  </h2>
                  <div className="quick-grid">
                    {quickBets.kellyPicks.map(market => (
                      <TradingCard key={market.ticker} market={market} />
                    ))}
                  </div>
                </div>
              )}

              {quickBets.closingSoon?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">
                    <span className="section-icon">⏰</span>
                    CLOSING SOON
                  </h2>
                  <div className="quick-grid">
                    {quickBets.closingSoon.map(market => (
                      <TradingCard key={market.ticker} market={market} showKelly={false} />
                    ))}
                  </div>
                </div>
              )}

              {quickBets.safeishBets?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">
                    <span className="section-icon">🛡️</span>
                    SAFE-ISH BETS
                  </h2>
                  <div className="quick-grid">
                    {quickBets.safeishBets.map(market => (
                      <TradingCard key={market.ticker} market={market} showKelly={false} />
                    ))}
                  </div>
                </div>
              )}

              {quickBets.valueBets?.length > 0 && (
                <div className="quick-section">
                  <h2 className="section-title">
                    <span className="section-icon">💎</span>
                    VALUE PLAYS
                  </h2>
                  <div className="quick-grid">
                    {quickBets.valueBets.map(market => (
                      <TradingCard key={market.ticker} market={market} showKelly={false} />
                    ))}
                  </div>
                </div>
              )}
            </main>
          )}

          {activeTab === 'all' && (
            <main className="main">
              <div className="filters">
                <div className="filter-row">
                  <div className="filter-group">
                    <label>Search</label>
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search markets..."
                      className="filter-input"
                    />
                  </div>

                  <div className="filter-group">
                    <label>Sort By</label>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="filter-select"
                    >
                      <option value="edge">Edge</option>
                      <option value="bestProbability">Win Probability</option>
                      <option value="bestProfitPotential">Profit Potential</option>
                      <option value="timeRemaining">Time Remaining</option>
                      <option value="recommendedBet">Kelly Bet Size</option>
                    </select>
                  </div>

                  <div className="filter-group">
                    <label>Order</label>
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value)}
                      className="filter-select"
                    >
                      <option value="desc">High to Low</option>
                      <option value="asc">Low to High</option>
                    </select>
                  </div>
                </div>

                <div className="filter-row">
                  <div className="filter-group">
                    <label>Min Win Chance: {minProbability}%</label>
                    <input
                      type="range"
                      min="0"
                      max="95"
                      value={minProbability}
                      onChange={(e) => setMinProbability(Number(e.target.value))}
                      className="filter-range"
                    />
                  </div>

                  <div className="filter-group">
                    <label>Min Profit: {minProfit}%</label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={minProfit}
                      onChange={(e) => setMinProfit(Number(e.target.value))}
                      className="filter-range"
                    />
                  </div>

                  <div className="filter-group">
                    <label>Max Days</label>
                    <input
                      type="number"
                      min="1"
                      max="30"
                      value={maxTimeDays}
                      onChange={(e) => setMaxTimeDays(Number(e.target.value))}
                      className="filter-input small"
                    />
                  </div>
                </div>
              </div>

              <div className="results-count">
                Showing {markets.length} opportunities
              </div>

              <div className="markets-grid">
                {markets.map(market => (
                  <TradingCard key={market.ticker} market={market} />
                ))}
              </div>

              {markets.length === 0 && !loading && (
                <div className="no-results">
                  No markets match your filters. Try adjusting them.
                </div>
              )}
            </main>
          )}
        </div>
      </div>

      <footer className="footer">
        <p>SHIMI - Kelly Criterion Betting Engine. Gamble responsibly. 🎲</p>
      </footer>

      {showAuthModal && <AuthModal />}
    </div>
  )
}

export default App
