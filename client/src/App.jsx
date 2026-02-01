import { useState, useEffect, useCallback } from 'react'

const API_BASE = '/api'

function App() {
  const [markets, setMarkets] = useState([])
  const [quickBets, setQuickBets] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [activeTab, setActiveTab] = useState('quick')

  // Filters
  const [sortBy, setSortBy] = useState('bestDegenScore')
  const [sortOrder, setSortOrder] = useState('desc')
  const [minProbability, setMinProbability] = useState(50)
  const [minProfit, setMinProfit] = useState(10)
  const [maxTimeHours, setMaxTimeHours] = useState('')
  const [search, setSearch] = useState('')

  const fetchMarkets = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        sortBy,
        sortOrder,
        minProbability: minProbability.toString(),
        minProfit: minProfit.toString(),
        ...(maxTimeHours && { maxTimeHours }),
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
  }, [sortBy, sortOrder, minProbability, minProfit, maxTimeHours, search])

  const fetchQuickBets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/quick-bets`)
      const data = await response.json()

      if (data.success) {
        setQuickBets(data.quickBets)
        setLastUpdate(new Date())
        setError(null)
      } else {
        setError(data.error)
      }
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchMarkets(), fetchQuickBets()])
    setLoading(false)
  }, [fetchMarkets, fetchQuickBets])

  // Initial fetch
  useEffect(() => {
    fetchData()
  }, [])

  // Refetch when filters change
  useEffect(() => {
    fetchMarkets()
  }, [fetchMarkets])

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 15000)
    return () => clearInterval(interval)
  }, [fetchData])

  const formatCurrency = (value) => {
    return `$${value.toFixed(2)}`
  }

  const formatPercent = (value) => {
    return `${value.toFixed(1)}%`
  }

  const getProbabilityColor = (prob) => {
    if (prob >= 80) return 'prob-high'
    if (prob >= 65) return 'prob-medium'
    return 'prob-low'
  }

  const getProfitColor = (profit) => {
    if (profit >= 50) return 'profit-high'
    if (profit >= 25) return 'profit-medium'
    return 'profit-low'
  }

  const MarketCard = ({ market, compact = false }) => (
    <div className={`market-card ${compact ? 'compact' : ''}`}>
      <div className="market-header">
        <span className={`bet-direction ${market.bestBet.toLowerCase()}`}>
          {market.bestBet}
        </span>
        <span className="market-ticker">{market.ticker}</span>
      </div>
      <h3 className="market-title">{market.title}</h3>
      {market.subtitle && <p className="market-subtitle">{market.subtitle}</p>}

      <div className="market-stats">
        <div className="stat">
          <span className="stat-label">Win Chance</span>
          <span className={`stat-value ${getProbabilityColor(market.bestProbability)}`}>
            {formatPercent(market.bestProbability)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Profit</span>
          <span className={`stat-value ${getProfitColor(market.bestProfitPotential)}`}>
            +{formatPercent(market.bestProfitPotential)}
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

      <div className="market-score">
        <span className="score-label">DEGEN SCORE</span>
        <span className="score-value">{market.bestDegenScore.toFixed(1)}</span>
      </div>

      <a
        href={`https://kalshi.com/markets/${market.eventTicker}`}
        target="_blank"
        rel="noopener noreferrer"
        className="bet-button"
      >
        PLACE BET
      </a>
    </div>
  )

  const QuickBetsSection = ({ title, bets, icon }) => {
    if (!bets || bets.length === 0) return null

    return (
      <div className="quick-section">
        <h2 className="section-title">
          <span className="section-icon">{icon}</span>
          {title}
        </h2>
        <div className="quick-grid">
          {bets.map(market => (
            <MarketCard key={market.ticker} market={market} compact />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1 className="logo">
            <span className="logo-icon">🎰</span>
            SHIMI
          </h1>
          <p className="tagline">Kalshi Betting Optimizer</p>
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

      {error && (
        <div className="error-banner">
          Error: {error}
        </div>
      )}

      <nav className="tabs">
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

      {activeTab === 'quick' && quickBets && (
        <main className="main">
          <QuickBetsSection
            title="SAFE-ISH BETS"
            bets={quickBets.safeishBets}
            icon="🛡️"
          />
          <QuickBetsSection
            title="VALUE PLAYS"
            bets={quickBets.valueBets}
            icon="💎"
          />
          <QuickBetsSection
            title="CLOSING SOON"
            bets={quickBets.closingSoon}
            icon="⏰"
          />
          <QuickBetsSection
            title="MOONSHOTS"
            bets={quickBets.moonshots}
            icon="🚀"
          />
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
                  <option value="bestDegenScore">Degen Score</option>
                  <option value="bestProbability">Win Probability</option>
                  <option value="bestProfitPotential">Profit Potential</option>
                  <option value="timeRemaining">Time Remaining</option>
                  <option value="volume">Volume</option>
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
                <label>Max Time (hours)</label>
                <input
                  type="number"
                  value={maxTimeHours}
                  onChange={(e) => setMaxTimeHours(e.target.value)}
                  placeholder="Any"
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
              <MarketCard key={market.ticker} market={market} />
            ))}
          </div>

          {markets.length === 0 && !loading && (
            <div className="no-results">
              No markets match your filters. Try adjusting them.
            </div>
          )}
        </main>
      )}

      <footer className="footer">
        <p>SHIMI - For entertainment purposes. Gamble responsibly. 🎲</p>
      </footer>
    </div>
  )
}

export default App
