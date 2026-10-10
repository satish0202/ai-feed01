require('dotenv').config();
const express = require('express');
const path = require('path');

const om = require('./lib/openmeteo');
const climate = require('./lib/climate');
const ai = require('./lib/ai');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_EFFORT = process.env.DEFAULT_EFFORT || 'high';

const HORIZONS = {
  1: { months: 1, label: '1-month (weekly breakdown)' },
  3: { months: 3, label: '3-month (seasonal)' },
  6: { months: 6, label: '6-month' },
  12: { months: 12, label: '12-month (annual)' },
};

// Cache finished AI outlooks so the same request doesn't re-run deep reasoning
const outlookCache = new Map();
const OUTLOOK_TTL_MS = 6 * 3600e3;

function parseCoords(req) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const r1 = v => climate.round(v, 1);

// Health check for hosting platforms; answers before the password check
app.get('/healthz', (req, res) => res.send('ok'));

// Optional password for public deployments, so strangers can't spend the
// Anthropic key. The browser shows its own sign-in prompt; any username works.
if (process.env.APP_PASSWORD) {
  const crypto = require('crypto');
  const expected = crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const password = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    if (crypto.timingSafeEqual(crypto.createHash('sha256').update(password).digest(), expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Horizon", charset="UTF-8"').status(401).send('Password required.');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    model: ai.MODEL,
    efforts: ai.EFFORTS,
    defaultEffort: DEFAULT_EFFORT,
    aiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  });
});

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ results: [] });
  try {
    res.json({ results: await om.geocode(q) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Current conditions, hourly, 16-day forecast, plus climate normals when the
// history download succeeds (the page still works without them).
app.get('/api/weather', async (req, res) => {
  const coords = parseCoords(req);
  if (!coords) return res.status(400).json({ error: 'Valid lat and lon are required.' });
  try {
    const fc = await om.getForecast(coords.lat, coords.lon);
    let climateInfo = null;
    try {
      const history = await om.getHistory(coords.lat, coords.lon, fc.timezone);
      const profile = climate.buildClimateProfile(history);
      climateInfo = {
        normalsPeriod: profile.normals.period,
        historyYears: profile.historyYears,
        months: profile.normals.months.map(m => ({
          month: m.month, name: m.name, tmax: r1(m.tmax), tmin: r1(m.tmin), precip: r1(m.precip),
          wetDays: r1(m.wetDays), snow: r1(m.snow), recordHigh: r1(m.recordHigh), recordLow: r1(m.recordLow),
        })),
        trendPerDecade: climate.round(profile.trend.perDecade, 2),
        recent: profile.recent,
        dailyNormals: fc.daily.time.map(t => ({
          tmax: r1(climate.dailyNormal(profile.normals, t, 'tmax')),
          tmin: r1(climate.dailyNormal(profile.normals, t, 'tmin')),
        })),
      };
    } catch (err) {
      console.warn(`climate history unavailable: ${err.message}`);
    }
    res.json({ ...fc, today: om.todayIn(fc.timezone), climate: climateInfo });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Long-range outlook, streamed as Server-Sent Events:
//   status → data (statistical baseline) → thinking/search… → result | failure → done
app.get('/api/outlook', async (req, res) => {
  const coords = parseCoords(req);
  const horizon = HORIZONS[req.query.horizon] || HORIZONS[3];
  const effort = ai.EFFORTS.includes(req.query.effort) ? req.query.effort : DEFAULT_EFFORT;
  const webSearch = req.query.web !== '0';
  const units = req.query.units === 'imperial' ? 'imperial' : 'metric';
  const name = String(req.query.name || 'Selected location').slice(0, 120);
  const question = String(req.query.question || '').trim().slice(0, 500);
  if (!coords) return res.status(400).json({ error: 'Valid lat and lon are required.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  let stage = 'data';

  try {
    send('status', { message: 'Loading current forecast…' });
    const fc = await om.getForecast(coords.lat, coords.lon);
    const today = om.todayIn(fc.timezone);

    send('status', { message: 'Analyzing 35 years of daily climate history and the seasonal ensemble…' });
    const [historyR, seasonalR] = await Promise.allSettled([
      om.getHistory(coords.lat, coords.lon, fc.timezone),
      om.getSeasonal(coords.lat, coords.lon, fc.timezone),
    ]);
    if (historyR.status !== 'fulfilled') throw new Error(`Climate history unavailable: ${historyR.reason.message}`);
    if (seasonalR.status !== 'fulfilled') console.warn(`seasonal ensemble unavailable: ${seasonalR.reason.message}`);

    const profile = climate.buildClimateProfile(historyR.value);
    const seasonalMonths = seasonalR.status === 'fulfilled' ? climate.summarizeSeasonal(seasonalR.value, profile.normals) : null;
    const periods = climate.buildPeriods(horizon.months, today);
    const baseline = climate.computeBaseline({ periods, today, profile, forecastDaily: fc.daily, seasonalMonths });

    const location = {
      name,
      latitude: coords.lat,
      longitude: coords.lon,
      elevationM: fc.elevation,
      timezone: fc.timezone,
      hemisphere: coords.lat >= 0 ? 'northern' : 'southern',
    };

    send('data', {
      location,
      today,
      horizon,
      baseline,
      trendPerDecade: climate.round(profile.trend.perDecade, 2),
      recent: profile.recent,
      seasonalAvailable: Boolean(seasonalMonths),
      normalsPeriod: profile.normals.period,
    });

    const cacheKey = JSON.stringify([coords.lat.toFixed(2), coords.lon.toFixed(2), horizon.months, effort, webSearch, units, question, today]);
    const hit = outlookCache.get(cacheKey);
    if (hit && Date.now() - hit.at < OUTLOOK_TTL_MS) {
      send('result', { ...hit.value, cached: true });
      return;
    }

    const ctx = {
      location,
      today,
      units,
      horizon,
      question,
      currentConditions: {
        temperatureC: fc.current.temperature_2m,
        feelsLikeC: fc.current.apparent_temperature,
        humidityPct: fc.current.relative_humidity_2m,
        weatherCode: fc.current.weather_code,
        windKmh: fc.current.wind_speed_10m,
      },
      next16Days: fc.daily.time.map((t, i) => ({
        date: t,
        tmax: fc.daily.tmax[i],
        tmin: fc.daily.tmin[i],
        precipMm: fc.daily.precip[i],
        precipProbPct: fc.daily.precipProb[i],
        weatherCode: fc.daily.code[i],
      })),
      climateNormals: {
        period: profile.normals.period,
        months: profile.normals.months.map(m => ({
          month: m.name, tmax: r1(m.tmax), tmin: r1(m.tmin), tmeanStd: climate.round(m.tmeanStd, 2),
          precipMm: r1(m.precip), precipTercilesMm: [r1(m.precipP33), r1(m.precipP67)], wetDays: r1(m.wetDays),
          snowCm: r1(m.snow), recordHigh: r1(m.recordHigh), recordLow: r1(m.recordLow),
          warmestYear: m.warmestYear, coldestYear: m.coldestYear,
        })),
      },
      warmingTrend: {
        perDecadeC: climate.round(profile.trend.perDecade, 2),
        historyYears: profile.historyYears,
      },
      recentAnomalies: profile.recent,
      seasonalEnsemble: seasonalMonths
        ? { model: 'ECMWF SEAS5 via Open-Meteo, raw (not bias-corrected)', months: seasonalMonths }
        : 'unavailable',
      statisticalBaseline: baseline.map(p => ({
        id: p.id, label: p.label, start: p.start, end: p.end, leadDays: p.leadDays,
        normal: p.normal, baseline: p.baseline, sources: p.sources,
      })),
      baselineMethod: 'Climatology (1991–2020) + linear warming trend + damped persistence of the last 30 days, blended with the seasonal ensemble anomaly (weight 0.2–0.5) and, for the first 16 days, the deterministic forecast.',
    };

    stage = 'ai';
    send('status', { message: `Claude is reasoning about ${horizon.label} drivers…` });
    const result = await ai.generateForecast(ctx, {
      effort,
      webSearch,
      signal: controller.signal,
      emit: send,
    });
    const value = { ...result, effort, webSearch, generatedAt: new Date().toISOString() };
    if (outlookCache.size >= 200) outlookCache.delete(outlookCache.keys().next().value);
    outlookCache.set(cacheKey, { at: Date.now(), value });
    send('result', value);
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(`outlook failed: ${err.message}`);
    send('failure', { stage, message: err.message });
  } finally {
    clearInterval(heartbeat);
    send('done', {});
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  Horizon long-range weather → http://localhost:${PORT}\n`);
});
