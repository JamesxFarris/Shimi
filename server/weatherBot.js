// WEATHER MARKET BOT
// Trades Kalshi daily high temperature markets (KXHIGH series) using GFS ensemble forecasts.
//
// THE EDGE:
//   Kalshi weather markets settle using the NWS Daily Climate Report — the same official
//   data that the GFS (Global Forecast System) ensemble is designed to predict.
//   The 30-member GFS ensemble (free via Open-Meteo) gives a full probability distribution
//   over the daily high temperature. When the ensemble probability diverges from the market
//   price by >10%, we have a genuine, documentable, non-circular edge.
//
// WHY THIS BEATS CRYPTO:
//   - Settlement source is publicly known (NWS) and matches our forecast model
//   - GFS ensemble runs update every 6 hours; market prices lag behind
//   - No adverse selection from HFT — weather forecasters can't front-run us
//   - Documented profits: $24K-$2M from weather bots on similar prediction markets
//
// ARCHITECTURE:
//   scanWeatherMarkets(kalshiReq, userConfig) → [WeatherOpportunity]
//   Each opportunity has edge, probability, threshold, city, date, and bet direction.

import fetch from 'node-fetch';

// ──────────────────────────────────────────────
// MATH HELPERS
// ──────────────────────────────────────────────

// Normal CDF (Abramowitz & Stegun, accurate to ±7.5e-8)
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

// P(daily_high >= threshold) from a deterministic point forecast + uncertainty (std dev °F)
function forecastToProb(forecastHigh, threshold, uncertainty) {
  return Math.max(0.01, Math.min(0.99, normalCDF((forecastHigh - threshold) / Math.max(1.5, uncertainty))));
}

// ──────────────────────────────────────────────
// CITY CONFIG
// NWS stations must match Kalshi's settlement station exactly.
// ──────────────────────────────────────────────
const WEATHER_CITIES = {
  KXHIGHNY: {
    name: 'New York City',
    lat: 40.7829,
    lon: -73.9654,
    station: 'KNYC',  // Central Park — Kalshi's official settlement station for NYC
    tz: 'America/New_York',
    nwsOffice: 'OKX',
    nwsGridX: 33,
    nwsGridY: 37,
  },
  KXHIGHCHI: {
    name: 'Chicago',
    lat: 41.7868,
    lon: -87.7522,
    station: 'KMDW',  // Midway Airport
    tz: 'America/Chicago',
    nwsOffice: 'LOT',
    nwsGridX: 75,
    nwsGridY: 67,
  },
  KXHIGHMIA: {
    name: 'Miami',
    lat: 25.7959,
    lon: -80.2870,
    station: 'KMIA',  // Miami International Airport
    tz: 'America/New_York',
    nwsOffice: 'MFL',
    nwsGridX: 109,
    nwsGridY: 38,
  },
  KXHIGHAUS: {
    name: 'Austin',
    lat: 30.1975,
    lon: -97.6664,
    station: 'KAUS',  // Austin-Bergstrom International Airport
    tz: 'America/Chicago',
    nwsOffice: 'EWX',
    nwsGridX: 155,
    nwsGridY: 85,
  },
  KXHIGHLAX: {
    name: 'Los Angeles',
    lat: 33.9425,
    lon: -118.4081,
    station: 'KLAX',  // LAX
    tz: 'America/Los_Angeles',
    nwsOffice: 'LOX',
    nwsGridX: 150,
    nwsGridY: 48,
  },
  KXHIGHDEN: {
    name: 'Denver',
    lat: 39.8561,
    lon: -104.6737,
    station: 'KDEN',  // Denver International
    tz: 'America/Denver',
    nwsOffice: 'BOU',
    nwsGridX: 62,
    nwsGridY: 61,
  },
};

// Month abbreviation → zero-padded month number
const MONTH_MAP = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// ──────────────────────────────────────────────
// GFS ENSEMBLE FORECAST (Open-Meteo)
// Free, no API key. Updates every 6 hours.
// 30 independent ensemble members → probability distribution.
// ──────────────────────────────────────────────
const gfsCache = new Map(); // key: `${lat},${lon}` → { data, fetchedAt }
const GFS_CACHE_TTL_MS = 60 * 60 * 1000; // Re-fetch at most once per hour

async function fetchGFSEnsemble(lat, lon) {
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = gfsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < GFS_CACHE_TTL_MS) {
    return cached.data;
  }

  // Build member field list: temperature_2m_max_member00 … member30 (31 members: control + 30 perturbations)
  const memberFields = Array.from({ length: 31 }, (_, i) =>
    `temperature_2m_max_member${String(i).padStart(2, '0')}`
  ).join(',');

  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble` +
    `?latitude=${lat}&longitude=${lon}` +
    `&models=gfs025` +
    `&daily=temperature_2m_max,${memberFields}` +
    `&temperature_unit=fahrenheit` +
    `&forecast_days=7` +
    `&timezone=auto`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Shimi-WeatherBot/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Open-Meteo API error ${resp.status}`);

  const data = await resp.json();
  gfsCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

// ──────────────────────────────────────────────
// HRRR + NBM DETERMINISTIC FORECASTS (Open-Meteo)
// HRRR: 3 km resolution, hourly updates, best accuracy within 48 h
// NBM:  2.5 km bias-corrected blend including ECMWF, hourly updates
// ──────────────────────────────────────────────
const detModelCache = new Map();
const DET_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — these models update hourly

async function fetchDetModel(model, lat, lon, forecastDays = 3) {
  const cacheKey = `${model}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = detModelCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < DET_CACHE_TTL_MS) return cached.data;

  const url =
    `https://api.open-meteo.com/v1/gfs` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max` +
    `&models=${model}` +
    `&temperature_unit=fahrenheit` +
    `&forecast_days=${forecastDays}` +
    `&timezone=auto`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Shimi-WeatherBot/1.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`Open-Meteo ${model} API error ${resp.status}`);

  const data = await resp.json();
  detModelCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

// Extract forecasted daily high (°F) for a specific date from Open-Meteo deterministic response
function getModelHigh(modelData, targetDate) {
  const times = modelData?.daily?.time;
  const highs = modelData?.daily?.temperature_2m_max;
  if (!times || !highs) return null;
  const idx = times.indexOf(targetDate);
  if (idx === -1) return null;
  const val = highs[idx];
  return (val !== null && val !== undefined && !isNaN(val)) ? val : null;
}

// Blend GEFS ensemble probability with HRRR and NBM deterministic forecasts.
// Weights shift toward higher-resolution models as the market approaches close.
function blendModelProbs(gfsProb, hrrrHigh, nbmHigh, gfsSpread, threshold, hoursToClose) {
  const sigma = Math.max(2, gfsSpread || 4); // minimum 2°F for converting point forecast → prob
  const hrrrProb = hrrrHigh !== null ? forecastToProb(hrrrHigh, threshold, sigma) : null;
  const nbmProb  = nbmHigh  !== null ? forecastToProb(nbmHigh,  threshold, sigma) : null;

  // Time-based weights: HRRR/NBM gain weight as market approaches close
  let [wGefs, wNbm, wHrrr] =
    hoursToClose > 24 ? [0.70, 0.20, 0.10] :
    hoursToClose > 12 ? [0.40, 0.35, 0.25] :
    hoursToClose >  6 ? [0.20, 0.30, 0.50] :
                        [0.10, 0.20, 0.70];

  // Redistribute weight if a model is unavailable
  if (hrrrProb === null) { wGefs += wHrrr * 0.6; wNbm += wHrrr * 0.4; wHrrr = 0; }
  if (nbmProb  === null) { wGefs += wNbm; wNbm = 0; }

  const total = wGefs + wHrrr + wNbm;
  if (total === 0) return gfsProb;

  const blended = (gfsProb * wGefs) + (hrrrProb ?? 0) * wHrrr + (nbmProb ?? 0) * wNbm;
  return Math.max(0.02, Math.min(0.98, blended / total));
}

// Calculate P(daily_high >= threshold) from GFS025 ensemble members on targetDate (YYYY-MM-DD)
function gfsEnsembleProb(ensembleData, targetDate, threshold) {
  const idx = ensembleData.daily?.time?.indexOf(targetDate);
  if (idx === undefined || idx === -1) return null;

  let above = 0;
  let total = 0;
  for (let m = 0; m <= 30; m++) {
    const key = `temperature_2m_max_member${String(m).padStart(2, '0')}`;
    const val = ensembleData.daily?.[key]?.[idx];
    if (val !== null && val !== undefined && !isNaN(val)) {
      if (val >= threshold) above++;
      total++;
    }
  }

  if (total < 10) return null; // not enough members
  return above / total;
}

// Also compute the ensemble mean and spread (for logging/diagnostics)
function gfsEnsembleStats(ensembleData, targetDate) {
  const idx = ensembleData.daily?.time?.indexOf(targetDate);
  if (idx === undefined || idx === -1) return null;

  const vals = [];
  for (let m = 0; m <= 30; m++) {
    const key = `temperature_2m_max_member${String(m).padStart(2, '0')}`;
    const val = ensembleData.daily?.[key]?.[idx];
    if (val !== null && val !== undefined && !isNaN(val)) vals.push(val);
  }

  if (vals.length === 0) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
  const spread = Math.sqrt(variance);
  return { mean: mean.toFixed(1), spread: spread.toFixed(1), members: vals.length };
}

// ──────────────────────────────────────────────
// NWS POINT FORECAST (secondary signal / validation)
// api.weather.gov is the same data source Kalshi uses for settlement.
// Use as a secondary check when GFS ensemble probability is borderline.
// ──────────────────────────────────────────────
const nwsCache = new Map();
const NWS_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

async function fetchNWSForecast(office, gridX, gridY) {
  const cacheKey = `${office}-${gridX}-${gridY}`;
  const cached = nwsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NWS_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://api.weather.gov/gridpoints/${office}/${gridX},${gridY}/forecast`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': '(Shimi WeatherBot, contact@shimi.app)',
      'Accept': 'application/geo+json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  nwsCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

// Extract the forecasted high temperature for a target date from NWS forecast
function nwsForecastHigh(nwsData, targetDate) {
  if (!nwsData?.properties?.periods) return null;

  // NWS periods are named "Today", "Tonight", "Monday", etc.
  // Daytime periods have isDaytime = true and carry the daily high.
  for (const period of nwsData.properties.periods) {
    if (!period.isDaytime) continue;
    const start = period.startTime?.substring(0, 10);
    if (start === targetDate) {
      return period.temperature; // already in °F
    }
  }
  return null;
}

// ──────────────────────────────────────────────
// KALSHI MARKET PARSING
// ──────────────────────────────────────────────

// Parse a Kalshi KXHIGH market into structured data.
// Handles both threshold (>= X°F) and range (X-Y°F) market types.
//
// Example tickers seen:
//   KXHIGHNY-26MAR10-T65       → NYC high >= 65°F on 2026-03-10
//   KXHIGHCHI-26MAR10-B60T65   → Chicago high between 60-65°F
//
// We also parse from the title string as a reliable fallback.
function parseKalshiWeatherMarket(market, seriesTicker) {
  const ticker = market.ticker || '';
  const title = (market.title || '').toLowerCase();

  // --- Threshold (above) market: "at or above X°F" ---
  const aboveMatch =
    title.match(/(?:at or above|at least|above|exceed)\s+(\d+)\s*°?f/i) ||
    ticker.match(/-T(\d+)$/i);
  const isAboveMarket = !!aboveMatch;

  // --- Range market: "between X and Y°F" ---
  const rangeMatch = title.match(/between\s+(\d+)\s+and\s+(\d+)\s*°?f/i);
  const isRangeMarket = !!rangeMatch && !isAboveMarket;

  if (!isAboveMarket && !isRangeMarket) return null;

  // Extract threshold(s)
  let thresholdLow, thresholdHigh;
  if (isRangeMarket) {
    thresholdLow = parseInt(rangeMatch[1]);
    thresholdHigh = parseInt(rangeMatch[2]);
  } else {
    thresholdLow = parseInt(aboveMatch[1]);
  }

  // Extract date from ticker (e.g. -26MAR10 → 2026-03-10)
  const dateMatch = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/i);
  let targetDate = null;
  if (dateMatch) {
    const year = '20' + dateMatch[1];
    const month = MONTH_MAP[dateMatch[2].toUpperCase()];
    if (!month) return null;
    const day = dateMatch[3].padStart(2, '0');
    targetDate = `${year}-${month}-${day}`;
  }

  // If no date in ticker, check market close_time
  if (!targetDate && market.close_time) {
    targetDate = market.close_time.substring(0, 10);
  }

  if (!targetDate) return null;
  if (isNaN(thresholdLow)) return null;

  // How many hours until the market closes? Don't bet if < 2h or > 36h
  const closeMs = market.close_time ? new Date(market.close_time).getTime() : 0;
  const hoursToClose = (closeMs - Date.now()) / 3600000;
  if (hoursToClose < 2 || hoursToClose > 36) return null;

  const city = WEATHER_CITIES[seriesTicker];

  return {
    ticker: market.ticker,
    seriesTicker,
    city: city?.name || seriesTicker,
    targetDate,
    isAboveMarket,
    isRangeMarket,
    thresholdLow,
    thresholdHigh: thresholdHigh || null,
    hoursToClose,
    yesAsk: (market.yes_ask ?? 50) / 100,  // Kalshi returns cents (0-100)
    noAsk: (market.no_ask ?? 50) / 100,
    yesBid: (market.yes_bid ?? 50) / 100,
    noBid: (market.no_bid ?? 50) / 100,
    volume: market.volume || 0,
    liquidity: market.open_interest || 0,
    closeTime: market.close_time,
  };
}

// ──────────────────────────────────────────────
// EDGE CALCULATION
// ──────────────────────────────────────────────

function calcKalshiFee(price, maker = true) {
  // Maker fee multiplier: 1.75 (vs 7 for taker)
  const mult = maker ? 1.75 : 7;
  return Math.min(0.02, Math.ceil(mult * price * (1 - price) * 100) / 100);
}

function calcWeatherEdge(modelProb, marketAskPrice, maker = true) {
  const fee = calcKalshiFee(marketAskPrice, maker);
  const spreadPenalty = 0.01; // conservative 1% spread/slippage buffer
  const grossEdge = modelProb - marketAskPrice;
  const netEdge = grossEdge - (fee / marketAskPrice) * 100 / 100 - spreadPenalty;
  // Simplify: edge in probability units (0-1)
  const feeFraction = fee / marketAskPrice;
  const netEdgeFraction = modelProb - marketAskPrice - feeFraction - spreadPenalty;
  return { grossEdge, netEdgeFraction, fee, feeFraction };
}

// ──────────────────────────────────────────────
// MAIN SCANNER
// ──────────────────────────────────────────────

export async function scanWeatherMarkets(kalshiReq, userConfig = {}) {
  const cfg = userConfig?.weatherBetting || {};
  const minEdge = cfg.minEdge ?? 0.10;            // 10% minimum net edge
  const minLiquidity = cfg.minLiquidity ?? 500;   // $500 minimum open interest
  const maxHoursToClose = cfg.maxHoursToClose ?? 30; // Don't bet >30h before close
  const minHoursToClose = cfg.minHoursToClose ?? 2;  // Don't bet <2h before close
  const useMaker = cfg.makerMode !== false;

  const opportunities = [];
  const errors = [];

  // Process each city series in parallel
  const seriesList = Object.keys(WEATHER_CITIES);

  await Promise.allSettled(seriesList.map(async (seriesTicker) => {
    const cityConfig = WEATHER_CITIES[seriesTicker];

    try {
      // 1. Fetch open Kalshi markets for this series
      const marketResp = await kalshiReq(
        'GET',
        `/markets?series_ticker=${seriesTicker}&status=open&limit=50`,
        null,
        userConfig
      );
      const markets = marketResp?.markets || [];
      if (markets.length === 0) return;

      // 2. Fetch GFS ensemble once for this city (cached)
      const ensemble = await fetchGFSEnsemble(cityConfig.lat, cityConfig.lon);

      // 3. Fetch HRRR (3 km, hourly updates) and NBM (2.5 km bias-corrected) in parallel
      let hrrrData = null, nbmData = null;
      try {
        [hrrrData, nbmData] = await Promise.all([
          fetchDetModel('hrrr_conus', cityConfig.lat, cityConfig.lon, 3).catch(() => null),
          fetchDetModel('nbm_conus',  cityConfig.lat, cityConfig.lon, 7).catch(() => null),
        ]);
      } catch { /* deterministic models optional — GEFS alone is still valid */ }

      // 4. Evaluate each market
      for (const market of markets) {
        try {
          const parsed = parseKalshiWeatherMarket(market, seriesTicker);
          if (!parsed) continue;
          if (parsed.hoursToClose > maxHoursToClose) continue;
          if (parsed.hoursToClose < minHoursToClose) continue;
          if (parsed.liquidity < minLiquidity && parsed.volume < minLiquidity) continue;

          const { targetDate, isAboveMarket, isRangeMarket, thresholdLow, thresholdHigh } = parsed;

          // 5. Calculate model probability from GFS ensemble
          let modelProb = null;
          if (isAboveMarket) {
            modelProb = gfsEnsembleProb(ensemble, targetDate, thresholdLow);
          } else if (isRangeMarket && thresholdHigh != null) {
            // P(in range) = P(>= low) - P(>= high)
            const probAboveLow = gfsEnsembleProb(ensemble, targetDate, thresholdLow);
            const probAboveHigh = gfsEnsembleProb(ensemble, targetDate, thresholdHigh);
            if (probAboveLow !== null && probAboveHigh !== null) {
              modelProb = probAboveLow - probAboveHigh;
            }
          }

          if (modelProb === null) continue;

          // 6. Blend GEFS + HRRR + NBM for final probability
          const stats = gfsEnsembleStats(ensemble, targetDate);
          const gfsSpreadVal = parseFloat(stats?.spread || 4);
          const hrrrHigh = hrrrData ? getModelHigh(hrrrData, targetDate) : null;
          const nbmHigh  = nbmData  ? getModelHigh(nbmData,  targetDate) : null;

          let finalModelProb;
          if (isAboveMarket) {
            finalModelProb = blendModelProbs(
              modelProb, hrrrHigh, nbmHigh, gfsSpreadVal, thresholdLow, parsed.hoursToClose
            );
          } else {
            // Range market: blend each bound separately, then take the difference
            const gfsProbLow  = gfsEnsembleProb(ensemble, targetDate, thresholdLow) ?? modelProb;
            const gfsProbHigh = thresholdHigh ? (gfsEnsembleProb(ensemble, targetDate, thresholdHigh) ?? 0) : 0;
            const blendedLow  = blendModelProbs(gfsProbLow,  hrrrHigh, nbmHigh, gfsSpreadVal, thresholdLow,  parsed.hoursToClose);
            const blendedHigh = thresholdHigh
              ? blendModelProbs(gfsProbHigh, hrrrHigh, nbmHigh, gfsSpreadVal, thresholdHigh, parsed.hoursToClose)
              : 0;
            finalModelProb = Math.max(0.01, blendedLow - blendedHigh);
          }

          // 7. Evaluate both YES and NO sides
          const yesEdge = calcWeatherEdge(finalModelProb, parsed.yesAsk, useMaker);
          const noEdge = calcWeatherEdge(1 - finalModelProb, parsed.noAsk, useMaker);

          // Log every market evaluated (for diagnostics)
          console.log(
            `  [WEATHER] ${parsed.city} ${targetDate} ${isAboveMarket ? '>=' : 'range'} ${thresholdLow}°F` +
            ` | GEFS:${(modelProb * 100).toFixed(1)}%` +
            ` HRRR:${hrrrHigh !== null ? hrrrHigh.toFixed(1) + '°F' : 'n/a'}` +
            ` NBM:${nbmHigh !== null ? nbmHigh.toFixed(1) + '°F' : 'n/a'}` +
            ` → blend:${(finalModelProb * 100).toFixed(1)}% (±${gfsSpreadVal.toFixed(1)}°F)` +
            ` | market: YES=${(parsed.yesAsk * 100).toFixed(0)}c NO=${(parsed.noAsk * 100).toFixed(0)}c` +
            ` | yesEdge=${(yesEdge.netEdgeFraction * 100).toFixed(1)}% noEdge=${(noEdge.netEdgeFraction * 100).toFixed(1)}%` +
            ` | ${parsed.hoursToClose.toFixed(1)}h to close`
          );

          // 8. Find the best side if edge exists
          let betSide = null, betEdge = null, betPrice = null, betModelProb = null;

          if (yesEdge.netEdgeFraction >= minEdge && yesEdge.netEdgeFraction >= noEdge.netEdgeFraction) {
            betSide = 'YES'; betEdge = yesEdge.netEdgeFraction;
            betPrice = parsed.yesAsk; betModelProb = finalModelProb;
          } else if (noEdge.netEdgeFraction >= minEdge) {
            betSide = 'NO'; betEdge = noEdge.netEdgeFraction;
            betPrice = parsed.noAsk; betModelProb = 1 - finalModelProb;
          }

          if (betSide) {
            opportunities.push({
              ticker: parsed.ticker,
              seriesTicker,
              city: parsed.city,
              targetDate,
              threshold: thresholdLow,
              thresholdHigh: parsed.thresholdHigh,
              isAboveMarket,
              isRangeMarket,
              betSide,
              betPrice,
              betEdge,
              betModelProb,
              gfsRawProb: modelProb,
              gfsMean: parseFloat(stats?.mean || 0),
              gfsSpread: gfsSpreadVal,
              gfsMembers: stats?.members || 0,
              hrrrForecastHigh: hrrrHigh,
              nbmForecastHigh: nbmHigh,
              yesAsk: parsed.yesAsk,
              noAsk: parsed.noAsk,
              hoursToClose: parsed.hoursToClose,
              volume: parsed.volume,
              liquidity: parsed.liquidity,
              marketType: 'weather',
              token: `${parsed.city} temp`,
            });
          }
        } catch (marketErr) {
          // Skip individual market errors silently
        }
      }
    } catch (seriesErr) {
      errors.push({ series: seriesTicker, error: seriesErr.message });
      console.error(`[WEATHER] Error scanning ${seriesTicker}: ${seriesErr.message}`);
    }
  }));

  // Sort by edge descending
  opportunities.sort((a, b) => b.betEdge - a.betEdge);

  if (opportunities.length > 0) {
    console.log(`\n☁ WEATHER SCAN: ${opportunities.length} opportunity(ies) found`);
    for (const opp of opportunities) {
      console.log(
        `  ★ ${opp.betSide} on ${opp.city} ${opp.isAboveMarket ? '>=' : 'range'} ${opp.threshold}°F` +
        ` on ${opp.targetDate} | edge=${(opp.betEdge * 100).toFixed(1)}%` +
        ` | GFS=${(opp.betModelProb * 100).toFixed(1)}% vs market=${(opp.betPrice * 100).toFixed(0)}c`
      );
    }
  } else {
    console.log(`☁ WEATHER SCAN: no opportunities above ${(minEdge * 100).toFixed(0)}% edge threshold`);
  }

  return { opportunities, errors };
}

// ──────────────────────────────────────────────
// KELLY BET SIZING (fractional)
// ──────────────────────────────────────────────
export function calcWeatherBetSize(modelProb, marketPrice, bankroll, cfg = {}) {
  const maxPct = cfg.maxBankrollPct ?? 0.05;   // max 5% of bankroll per bet
  const kellyFraction = cfg.kellyFraction ?? 0.15; // conservative 15% Kelly
  const maxDollars = cfg.maxDollarsPerBet ?? 25;   // hard cap

  if (modelProb <= marketPrice) return 0;

  // Kelly formula for binary bet: f* = (p - q*b) / b where b = (1-price)/price (odds)
  const b = (1 - marketPrice) / marketPrice; // net odds on YES
  const p = modelProb;
  const q = 1 - modelProb;
  const fullKelly = (p - q * (1 / b)) / (1 / b); // simplified: (p*b - q) / b... let me redo
  // Actually: f* = (p * (b+1) - 1) / b for a bet that returns b per dollar wagered
  // For prediction market: if you pay $price and win $1, your profit is $(1-price)
  // So b_net = (1 - price) / price, and f* = (p - (1-p)/b_net) ... let's use standard:
  // f* = (p*(b_net+1) - 1) / b_net = (p/price - 1) / ((1-price)/price) = (p - price) / (1 - price)
  const kellySizing = (modelProb - marketPrice) / (1 - marketPrice);

  const fractional = kellySizing * kellyFraction;
  const capped = Math.min(fractional, maxPct);
  const dollars = Math.min(capped * bankroll, maxDollars);

  return Math.max(1, Math.round(dollars)); // minimum $1
}

// ──────────────────────────────────────────────
// DIAGNOSTIC: Get current NWS observed temperature for a station
// Useful for checking if a market is about to settle and comparing to forecast
// ──────────────────────────────────────────────
export async function getNWSCurrentObservation(station) {
  try {
    const url = `https://api.weather.gov/stations/${station}/observations/latest`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': '(Shimi WeatherBot, contact@shimi.app)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const tempC = data.properties?.temperature?.value;
    if (tempC === null || tempC === undefined) return null;
    return (tempC * 9 / 5) + 32; // convert C to F
  } catch {
    return null;
  }
}

// Expose city list for use in index.js dashboard API
export { WEATHER_CITIES };
