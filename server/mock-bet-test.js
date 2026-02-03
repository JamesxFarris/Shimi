/**
 * Mock Bet Test
 * Tests the full betting flow without placing a real bet
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3002';

async function mockBet() {
  console.log('\n🎲 MOCK BET TEST');
  console.log('='.repeat(50));

  // 1. Get opportunities
  console.log('\n📊 Fetching opportunities...');
  const oppsRes = await fetch(API_BASE + '/api/crypto/opportunities');
  const opps = await oppsRes.json();

  console.log('   Price source:', opps.prices?.source || 'unknown');
  console.log('   Total markets:', opps.stats?.totalAnalyzed || 0);

  const allOpps = opps.opportunities || [];

  // Find any opportunity with edge (even if not optimal)
  const withEdge = allOpps.filter(o => o.edge > 0 && o.isLocked !== true);

  if (withEdge.length === 0) {
    console.log('\n⚠️  No opportunities with edge right now');
    console.log('   Creating MOCK opportunity for testing...\n');

    // Create a fake opportunity to test the flow
    const mockOpp = {
      ticker: 'MOCK-TEST-123',
      assetType: 'BTC',
      cryptoType: 'BTC',
      betSide: 'YES',
      betPrice: 0.65,
      betPriceCents: 65,
      winProbability: 72,
      edge: 7,
      isSafe: true,
      timeRemainingFormatted: '8m 30s'
    };

    console.log('📋 MOCK OPPORTUNITY:');
    console.log('   Token:', mockOpp.assetType);
    console.log('   Side:', mockOpp.betSide);
    console.log('   Price:', mockOpp.betPriceCents + '¢');
    console.log('   Win Prob:', mockOpp.winProbability + '%');
    console.log('   Edge: +' + mockOpp.edge + '%');
    console.log('   Safe:', mockOpp.isSafe ? 'YES (would auto-bet)' : 'NO');
    console.log('   Time:', mockOpp.timeRemainingFormatted);

    // Calculate what would happen
    console.log('\n💰 BET CALCULATION (Kelly Criterion):');
    const price = mockOpp.betPriceCents;
    const prob = mockOpp.winProbability / 100;
    const edge = prob - (price / 100);
    const kelly = edge / (1 - price/100);
    const halfKelly = kelly * 0.5;
    const bankroll = 2000; // $20 in cents
    const betSize = Math.min(500, Math.floor(halfKelly * bankroll)); // Max $5
    const contracts = Math.floor(betSize / price);
    const totalCost = contracts * price;

    console.log('   Kelly fraction:', (kelly * 100).toFixed(1) + '%');
    console.log('   Half Kelly:', (halfKelly * 100).toFixed(1) + '%');
    console.log('   Bet size: $' + (betSize/100).toFixed(2));
    console.log('   Contracts:', contracts);
    console.log('   Total cost: $' + (totalCost/100).toFixed(2));

    // Expected value
    const winAmount = contracts * (100 - price);
    const ev = (prob * winAmount) - ((1-prob) * totalCost);
    console.log('   Expected value: $' + (ev/100).toFixed(2));

    console.log('\n✅ MOCK BET RESULT:');
    console.log('   ' + contracts + 'x ' + mockOpp.betSide + ' @ ' + price + '¢ = $' + (totalCost/100).toFixed(2));
    console.log('   Status: WOULD SUCCEED (simulated)');

  } else {
    // Use real opportunity
    withEdge.sort((a,b) => parseFloat(b.edge) - parseFloat(a.edge));
    const best = withEdge[0];

    console.log('\n📋 REAL OPPORTUNITY FOUND:');
    console.log('   Ticker:', best.ticker);
    console.log('   Token:', best.assetType || best.cryptoType);
    console.log('   Side:', best.betSide);
    console.log('   Price:', best.betPriceCents + '¢');
    console.log('   Win Prob:', best.winProbability + '%');
    console.log('   Edge: +' + parseFloat(best.edge).toFixed(1) + '%');
    console.log('   Safe:', best.isSafe ? 'YES (would auto-bet)' : 'NO (manual/degen)');
    console.log('   Time:', best.timeRemainingFormatted);

    // Check risk
    console.log('\n💰 RISK CHECK:');
    try {
      const riskRes = await fetch(API_BASE + '/api/risk');
      const risk = await riskRes.json();

      console.log('   Current exposure: $' + ((risk.current || 0)/100).toFixed(2));
      console.log('   Max allowed: $' + ((risk.max || 2000)/100).toFixed(2));
      console.log('   Remaining: $' + ((risk.remaining || 2000)/100).toFixed(2));

      const remaining = risk.remaining || 2000;
      if (remaining >= best.betPriceCents) {
        // Calculate Kelly
        const price = best.betPriceCents;
        const prob = parseFloat(best.winProbability) / 100;
        const edge = prob - (price / 100);
        const kelly = edge / (1 - price/100);
        const halfKelly = kelly * 0.5;
        const betSize = Math.min(500, Math.floor(halfKelly * 2000));
        const contracts = Math.floor(betSize / price);
        const totalCost = contracts * price;

        console.log('\n📊 BET CALCULATION:');
        console.log('   Kelly: ' + (halfKelly * 100).toFixed(1) + '% (half)');
        console.log('   Contracts:', contracts);
        console.log('   Total cost: $' + (totalCost/100).toFixed(2));

        console.log('\n✅ MOCK BET RESULT:');
        console.log('   ' + contracts + 'x ' + best.betSide + ' @ ' + price + '¢ = $' + (totalCost/100).toFixed(2));
        console.log('   Status: WOULD SUCCEED');
      } else {
        console.log('\n⚠️  MOCK BET BLOCKED - insufficient budget');
      }
    } catch (e) {
      console.log('   Could not fetch risk:', e.message);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('🎲 Mock test complete - no real bet placed\n');
}

mockBet().catch(e => console.error('Error:', e.message));
