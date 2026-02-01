import { useState, useEffect, useCallback, memo } from 'react'

const API_BASE = '/api'

// Risk level presets
const RISK_PRESETS = {
  low: { minProbability: 75, minProfit: 15, maxTimeDays: 7, label: 'LOW RISK', desc: '75%+ win, 15%+ profit' },
  medium: { minProbability: 60, minProfit: 25, maxTimeDays: 5, label: 'MEDIUM', desc: '60%+ win, 25%+ profit' },
  high: { minProbability: 50, minProfit: 40, maxTimeDays: 3, label: 'HIGH RISK', desc: '50%+ win, 40%+ profit' }
}

// Trading Card Component
const TradingCard = memo(({ market, onPlaceBet, compact = false }) => {
  const formatCurrency = (value) => `$${(value || 0).toFixed(2)}`
  const formatPercent = (value) => `${(value || 0).toFixed(1)}%`

  if (!market) return null

  return (
    <div className={`market-card ${compact ? 'compact' : ''}`}>
      <div className="market-header">
        <span className={`bet-direction ${market.bestBet?.toLowerCase()}`}>
          {market.bestBet}
        </span>
        <span className="time-badge">{market.timeRemainingFormatted}</span>
      </div>
      <h3 className="market-title">{market.title}</h3>

      <div className="market-stats">
        <div className="stat">
          <span className="stat-label">Win %</span>
          <span className="stat-value">{formatPercent(market.bestProbability)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Profit</span>
          <span className="stat-value edge">+{formatPercent(market.bestProfitPotential || 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Cost</span>
          <span className="stat-value">{formatCurrency(market.bestAskPrice)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Bet</span>
          <span className="stat-value kelly">{formatCurrency((market.recommendedBet || 0) / 100)}</span>
        </div>
      </div>

      <button
        className="bet-button"
        onClick={() => onPlaceBet(market.ticker, market.bestBet, (market.recommendedBet || 100) / 100)}
      >
        BET {formatCurrency((market.recommendedBet || 100) / 100)} on {market.bestBet}
      </button>
    </div>
  )
})

function App() {
  // Core state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('bets')

  // Risk & betting
  const [riskLevel, setRiskLevel] = useState('medium')
  const [optimalBets, setOptimalBets] = useState([])
  const [autoBetEnabled, setAutoBetEnabled] = useState(false)

  // Portfolio
  const [balance, setBalance] = useState(10)
  const [betHistory, setBetHistory] = useState([])
  const [isSimulated, setIsSimulated] = useState(true)

  // Auth
  const [showAuth, setShowAuth] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  const currentRisk = RISK_PRESETS[riskLevel]

  // Fetch optimal bets based on risk level
  const fetchBets = useCallback(async () => {
    try {
      setError(null)
      const { minProbability, minProfit, maxTimeDays } = RISK_PRESETS[riskLevel]

      // Update server settings first
      await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minProbability, minProfit, maxTimeDays })
      })

      const response = await fetch(`${API_BASE}/optimal-bets?maxTimeDays=${maxTimeDays}`)

      if (!response.ok) {
        throw new Error('Failed to fetch bets')
      }

      const data = await response.json()

      if (data.success) {
        setOptimalBets(data.bets || [])
      } else {
        setError(data.error || 'No bets available')
      }
    } catch (err) {
      console.error('Fetch error:', err)
      setError('Could not load bets. Pull down to retry.')
    } finally {
      setLoading(false)
    }
  }, [riskLevel])

  // Fetch portfolio
  const fetchPortfolio = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/portfolio`)
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setBalance(data.balance || 10)
          setBetHistory(data.betHistory || [])
          setIsSimulated(data.simulated !== false)
        }
      }
    } catch (err) {
      console.error('Portfolio error:', err)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchBets()
    fetchPortfolio()
  }, [])

  // Refetch when risk level changes
  useEffect(() => {
    setLoading(true)
    fetchBets()
  }, [riskLevel])

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchBets()
      fetchPortfolio()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchBets, fetchPortfolio])

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
        fetchBets()
        alert(`Bet placed: ${side} on ${ticker} for $${amount.toFixed(2)}`)
      } else {
        alert('Bet failed: ' + (data.error || 'Unknown error'))
      }
    } catch (err) {
      alert('Bet error: ' + err.message)
    }
  }

  // Auto-bet (place best available bet)
  const handleAutoBet = async () => {
    try {
      const response = await fetch(`${API_BASE}/auto-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTimeDays: currentRisk.maxTimeDays })
      })
      const data = await response.json()

      if (data.success && data.bet) {
        fetchPortfolio()
        fetchBets()
        alert(`Auto-bet placed: ${data.bet.side} on ${data.bet.ticker}`)
      } else if (data.success && !data.bet) {
        alert('No suitable bets found right now')
      } else {
        alert('Auto-bet failed: ' + (data.error || 'Unknown error'))
      }
    } catch (err) {
      alert('Auto-bet error: ' + err.message)
    }
  }

  // Toggle continuous auto-betting
  const handleToggleAuto = async () => {
    try {
      const response = await fetch(`${API_BASE}/auto-bet/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autoBetEnabled, intervalMinutes: 5 })
      })
      const data = await response.json()
      if (data.success) {
        setAutoBetEnabled(data.enabled)
      }
    } catch (err) {
      console.error('Toggle error:', err)
    }
  }

  // Connect Kalshi
  const handleConnect = async (e) => {
    e.preventDefault()
    setAuthLoading(true)
    setAuthError('')

    try {
      const response = await fetch(`${API_BASE}/auth/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKeyId: apiKey.trim(),
          privateKey: privateKey.trim()
        })
      })
      const data = await response.json()

      if (data.success) {
        setShowAuth(false)
        setApiKey('')
        setPrivateKey('')
        setIsSimulated(false)
        fetchPortfolio()
      } else {
        setAuthError(data.error || 'Connection failed')
      }
    } catch (err) {
      setAuthError('Connection error')
    } finally {
      setAuthLoading(false)
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1 className="logo">🎰 SHIMI</h1>
        </div>
        <div className="header-right">
          <div className="balance-badge">
            {isSimulated && <span className="sim-tag">SIM</span>}
            <span className="balance-amount">${balance.toFixed(2)}</span>
          </div>
        </div>
      </header>

      {/* Risk Level Selector */}
      <div className="risk-selector">
        {Object.entries(RISK_PRESETS).map(([key, preset]) => (
          <button
            key={key}
            className={`risk-btn ${riskLevel === key ? 'active' : ''} ${key}`}
            onClick={() => setRiskLevel(key)}
          >
            <span className="risk-label">{preset.label}</span>
            <span className="risk-desc">{preset.desc}</span>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <nav className="tabs">
        <button
          className={`tab ${activeTab === 'bets' ? 'active' : ''}`}
          onClick={() => setActiveTab('bets')}
        >
          BETS ({optimalBets.length})
        </button>
        <button
          className={`tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          HISTORY ({betHistory.length})
        </button>
        <button
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          SETTINGS
        </button>
      </nav>

      {/* Error */}
      {error && (
        <div className="error-banner" onClick={() => { setLoading(true); fetchBets(); }}>
          {error} <span className="retry">Tap to retry</span>
        </div>
      )}

      {/* Main Content */}
      <main className="main">
        {/* Bets Tab */}
        {activeTab === 'bets' && (
          <div className="bets-view">
            {/* Auto-bet controls */}
            <div className="auto-controls">
              <button
                className="auto-bet-now"
                onClick={handleAutoBet}
                disabled={loading || optimalBets.length === 0}
              >
                🎯 PLACE BEST BET NOW
              </button>
              <button
                className={`auto-toggle ${autoBetEnabled ? 'active' : ''}`}
                onClick={handleToggleAuto}
              >
                {autoBetEnabled ? '⏹ STOP AUTO' : '▶ AUTO EVERY 5m'}
              </button>
            </div>

            {/* Bets list */}
            {loading ? (
              <div className="loading">
                <div className="spinner"></div>
                <p>Finding {currentRisk.label} bets...</p>
              </div>
            ) : optimalBets.length > 0 ? (
              <div className="bets-grid">
                {optimalBets.map(bet => (
                  <TradingCard
                    key={bet.ticker}
                    market={bet}
                    onPlaceBet={handlePlaceBet}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <p>No bets match {currentRisk.label} criteria</p>
                <p className="hint">Try a different risk level</p>
              </div>
            )}
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="history-view">
            <h2>Bet History</h2>
            {betHistory.length > 0 ? (
              <div className="history-list">
                {betHistory.map(bet => (
                  <div key={bet.id} className={`history-item ${bet.status}`}>
                    <div className="history-main">
                      <span className={`history-side ${bet.side}`}>{bet.side?.toUpperCase()}</span>
                      <span className="history-title">{bet.title || bet.ticker}</span>
                    </div>
                    <div className="history-details">
                      <span className="history-amount">${((bet.totalCost || 0) / 100).toFixed(2)}</span>
                      <span className={`history-status ${bet.status}`}>{bet.status}</span>
                      <span className="history-time">
                        {new Date(bet.timestamp).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <p>No bets yet</p>
                <p className="hint">Place your first bet!</p>
              </div>
            )}
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="settings-view">
            <div className="settings-section">
              <h2>Account</h2>
              {isSimulated ? (
                <div className="connect-section">
                  <p>Currently using simulated $10 balance</p>
                  <button className="connect-btn" onClick={() => setShowAuth(true)}>
                    Connect Real Kalshi Account
                  </button>
                </div>
              ) : (
                <div className="connected-section">
                  <p className="connected-status">✓ Connected to Kalshi</p>
                  <p>Balance: ${balance.toFixed(2)}</p>
                </div>
              )}
            </div>

            <div className="settings-section">
              <h2>Current Settings</h2>
              <div className="settings-info">
                <div className="setting-item">
                  <span>Risk Level</span>
                  <span>{currentRisk.label}</span>
                </div>
                <div className="setting-item">
                  <span>Min Win Probability</span>
                  <span>{currentRisk.minProbability}%</span>
                </div>
                <div className="setting-item">
                  <span>Min Profit Potential</span>
                  <span>{currentRisk.minProfit}%</span>
                </div>
                <div className="setting-item">
                  <span>Max Time to Close</span>
                  <span>{currentRisk.maxTimeDays} days</span>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <h2>How It Works</h2>
              <p className="how-it-works">
                Shimi uses the Kelly Criterion to find mathematically optimal bets.
                It calculates the ideal bet size based on win probability and potential payout.
              </p>
              <ul className="risk-explanation">
                <li><strong>LOW RISK:</strong> 75%+ win chance, safer bets, lower returns</li>
                <li><strong>MEDIUM:</strong> 60%+ win chance, balanced risk/reward</li>
                <li><strong>HIGH RISK:</strong> 50%+ win chance, higher edge required, bigger potential</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      {/* Auth Modal */}
      {showAuth && (
        <div className="modal-overlay" onClick={() => !authLoading && setShowAuth(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Connect Kalshi</h2>
            <p>Get your API keys from kalshi.com/account/api-keys</p>

            {authError && <div className="auth-error">{authError}</div>}

            <form onSubmit={handleConnect}>
              <div className="form-group">
                <label>API Key ID</label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="Your API Key ID"
                  autoComplete="off"
                  disabled={authLoading}
                />
              </div>
              <div className="form-group">
                <label>Private Key</label>
                <textarea
                  value={privateKey}
                  onChange={e => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  rows={6}
                  autoComplete="off"
                  disabled={authLoading}
                />
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowAuth(false)} disabled={authLoading}>
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

      {/* Footer */}
      <footer className="footer">
        <button className="refresh-btn" onClick={() => { setLoading(true); fetchBets(); fetchPortfolio(); }}>
          ↻ Refresh
        </button>
      </footer>
    </div>
  )
}

export default App
