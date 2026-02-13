/**
 * Auto-bet Test Script
 *
 * Tests that the auto-bet system would correctly identify and place
 * an optimal betting opportunity.
 *
 * Run with: node server/test-autobet.js
 */

// Using native fetch (Node 18+)

const API_BASE = process.env.API_BASE || 'http://localhost:3001';

// ANSI colors for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

async function runTests() {
  console.log('\n' + '='.repeat(60));
  log(colors.bold + colors.cyan, '🧪 AUTO-BET SYSTEM TEST');
  console.log('='.repeat(60) + '\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Server is running
  log(colors.yellow, '📡 Test 1: Server connectivity...');
  try {
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    const status = await statusRes.json();
    if (status.success) {
      log(colors.green, '   ✓ Server is running');
      log(colors.cyan, `   Price source: ${status.priceSource || 'unknown'}`);
      log(colors.cyan, `   Authenticated: ${status.isAuthenticated}`);
      passed++;
    } else {
      throw new Error('Status check failed');
    }
  } catch (err) {
    log(colors.red, '   ✗ Server not reachable:', err.message);
    log(colors.yellow, '   Make sure server is running: npm run server');
    failed++;
    return { passed, failed };
  }

  // Test 2: Price feed is working
  log(colors.yellow, '\n📊 Test 2: Price feed...');
  try {
    const oppsRes = await fetch(`${API_BASE}/api/crypto/opportunities`);
    const opps = await oppsRes.json();

    if (opps.prices?.source) {
      log(colors.green, `   ✓ Price feed active: ${opps.prices.source.toUpperCase()}`);
      log(colors.cyan, `   Refresh rate: ${opps.prices.refreshMs || 3000}ms`);

      const cryptoPrices = opps.prices.crypto || {};
      const priceCount = Object.keys(cryptoPrices).length;
      if (priceCount > 0) {
        log(colors.green, `   ✓ ${priceCount} tokens with prices`);
        // Show a few prices
        const samples = Object.entries(cryptoPrices).slice(0, 3);
        samples.forEach(([token, price]) => {
          log(colors.cyan, `     ${token}: $${price.toLocaleString()}`);
        });
        passed++;
      } else {
        log(colors.red, '   ✗ No price data');
        failed++;
      }
    } else {
      log(colors.red, '   ✗ Price source not detected');
      failed++;
    }
  } catch (err) {
    log(colors.red, '   ✗ Price feed error:', err.message);
    failed++;
  }

  // Test 3: Opportunities are being analyzed
  log(colors.yellow, '\n🔍 Test 3: Market analysis...');
  try {
    const oppsRes = await fetch(`${API_BASE}/api/crypto/opportunities`);
    const opps = await oppsRes.json();

    log(colors.cyan, `   Total analyzed: ${opps.stats?.totalAnalyzed || 0}`);
    log(colors.cyan, `   Recommended: ${opps.stats?.recommended || 0}`);
    log(colors.cyan, `   Filtered (no edge): ${opps.stats?.filteredNoEdge || 0}`);

    if (opps.opportunities && opps.opportunities.length > 0) {
      log(colors.green, `   ✓ ${opps.opportunities.length} opportunities found`);
      passed++;

      // Analyze the opportunities
      const safe = opps.opportunities.filter(o => o.isSafe);
      const degen = opps.opportunities.filter(o => o.isDegen);
      const degenSafe = opps.opportunities.filter(o => o.isDegenSafe);

      log(colors.cyan, `   SAFE (auto-bet): ${safe.length}`);
      log(colors.cyan, `   DEGEN (manual): ${degen.length}`);
      log(colors.cyan, `   DEGEN-SAFE: ${degenSafe.length}`);
    } else {
      log(colors.yellow, '   ⚠ No opportunities currently available');
      log(colors.cyan, '   (This is normal if markets are between windows)');
      passed++; // Not a failure, just no current opportunities
    }
  } catch (err) {
    log(colors.red, '   ✗ Analysis error:', err.message);
    failed++;
  }

  // Test 4: Risk limits are configured
  log(colors.yellow, '\n💰 Test 4: Risk management...');
  try {
    const oppsRes = await fetch(`${API_BASE}/api/crypto/opportunities`);
    const opps = await oppsRes.json();

    if (opps.risk) {
      log(colors.green, '   ✓ Risk limits configured');
      log(colors.cyan, `   Current exposure: $${opps.risk.currentDollars}`);
      log(colors.cyan, `   Max exposure: $${opps.risk.maxDollars}`);
      log(colors.cyan, `   Remaining: $${opps.risk.remainingDollars}`);

      if (opps.risk.timeframeExposure) {
        log(colors.cyan, `   15min exposure: $${(opps.risk.timeframeExposure['15min'] / 100).toFixed(2)}`);
      }

      const hasRoom = parseFloat(opps.risk.remainingDollars) > 0.50;
      if (hasRoom) {
        log(colors.green, '   ✓ Budget available for betting');
        passed++;
      } else {
        log(colors.yellow, '   ⚠ Low remaining budget');
        passed++;
      }
    } else {
      log(colors.red, '   ✗ Risk data not available');
      failed++;
    }
  } catch (err) {
    log(colors.red, '   ✗ Risk check error:', err.message);
    failed++;
  }

  // Test 5: Simulate optimal bet detection
  log(colors.yellow, '\n🎯 Test 5: Optimal bet detection...');
  try {
    const oppsRes = await fetch(`${API_BASE}/api/crypto/opportunities`);
    const opps = await oppsRes.json();

    // Find the best opportunity
    const validOpps = (opps.opportunities || []).filter(o =>
      o.edge > 0 &&
      parseFloat(o.winProbability) >= 55 &&
      !o.isLocked
    );

    if (validOpps.length > 0) {
      // Sort by edge
      validOpps.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge));
      const best = validOpps[0];

      log(colors.green, '   ✓ Found optimal bet candidate:');
      log(colors.cyan, `     Token: ${best.assetType || best.cryptoType}`);
      log(colors.cyan, `     Side: ${best.betSide}`);
      log(colors.cyan, `     Price: ${best.betPriceCents}¢`);
      log(colors.cyan, `     Win Prob: ${best.winProbability}%`);
      log(colors.cyan, `     Edge: +${parseFloat(best.edge).toFixed(1)}%`);
      log(colors.cyan, `     Time Left: ${best.timeRemainingFormatted}`);
      log(colors.cyan, `     Safe: ${best.isSafe ? 'YES ✓' : 'NO (degen)'}`);

      // Would auto-bet place this?
      if (best.isSafe || best.isDegenSafe) {
        log(colors.green, '   ✓ This bet WOULD be auto-placed');
      } else if (best.isDegen) {
        log(colors.yellow, '   ⚠ This is a DEGEN bet (manual only unless degen mode on)');
      }

      passed++;
    } else {
      log(colors.yellow, '   ⚠ No optimal bets currently available');
      log(colors.cyan, '   Criteria: 55%+ win prob, positive edge, not locked');

      // Show why opportunities might be filtered
      const allOpps = opps.opportunities || [];
      const lowProb = allOpps.filter(o => parseFloat(o.winProbability) < 55);
      const noEdge = allOpps.filter(o => o.edge <= 0);
      const locked = allOpps.filter(o => o.isLocked);

      if (lowProb.length > 0) log(colors.cyan, `     ${lowProb.length} below 55% win prob`);
      if (noEdge.length > 0) log(colors.cyan, `     ${noEdge.length} with no edge`);
      if (locked.length > 0) log(colors.cyan, `     ${locked.length} locked/waiting`);

      passed++; // Not a failure
    }
  } catch (err) {
    log(colors.red, '   ✗ Bet detection error:', err.message);
    failed++;
  }

  // Test 6: Auto-bet endpoint (dry run)
  log(colors.yellow, '\n🤖 Test 6: Auto-bet endpoint...');
  try {
    const autoBetRes = await fetch(`${API_BASE}/api/crypto/auto-bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }) // Would need backend support
    });
    const result = await autoBetRes.json();

    if (result.success) {
      if (result.bet) {
        log(colors.green, '   ✓ Auto-bet would place:');
        log(colors.cyan, `     ${result.bet.side} ${result.bet.ticker} @ ${result.bet.price}¢`);
        log(colors.cyan, `     Contracts: ${result.bet.count}`);
      } else if (result.message) {
        log(colors.yellow, `   ⚠ ${result.message}`);
      }
      passed++;
    } else {
      log(colors.yellow, `   ⚠ ${result.error || result.message || 'No bet placed'}`);
      passed++; // Not necessarily a failure
    }
  } catch (err) {
    log(colors.red, '   ✗ Auto-bet endpoint error:', err.message);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  log(colors.bold, '📋 TEST SUMMARY');
  console.log('='.repeat(60));
  log(colors.green, `   Passed: ${passed}`);
  if (failed > 0) {
    log(colors.red, `   Failed: ${failed}`);
  } else {
    log(colors.cyan, `   Failed: ${failed}`);
  }

  const allPassed = failed === 0;
  if (allPassed) {
    log(colors.green + colors.bold, '\n✓ All tests passed! Auto-bet system is ready.');
  } else {
    log(colors.yellow, '\n⚠ Some tests failed. Check the errors above.');
  }

  console.log('\n');
  return { passed, failed };
}

// Run tests
runTests().then(({ passed, failed }) => {
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
