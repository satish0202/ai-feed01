// Pure statistics for long-range forecasting.
// Everything here works in metric units (°C, mm) on plain arrays so it can be
// unit-tested without network access.

const NORMALS_START = 1991;
const NORMALS_END = 2020;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Date helpers (all dates are 'YYYY-MM-DD' strings in the location's timezone) ──

function parseDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const ymd = s => ({ y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) });

// ── Small math helpers ──

const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = arr => {
  const xs = arr.filter(finite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const std = arr => {
  const xs = arr.filter(finite);
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const quantile = (arr, q) => {
  const xs = arr.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
};
const round = (v, dp = 1) => (finite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Standard normal CDF (Abramowitz & Stegun 7.1.26)
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function linearRegression(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => finite(x) && finite(y));
  if (pts.length < 10) return null;
  const mx = mean(pts.map(p => p[0]));
  const my = mean(pts.map(p => p[1]));
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den ? { slope: num / den, intercept: my - (num / den) * mx } : null;
}

// ── Climatology from daily history ──

// Groups daily history into calendar months. Months with fewer than 25 valid
// days are dropped so partial months don't skew normals.
function monthlyAggregates(daily) {
  const buckets = new Map();
  daily.time.forEach((t, i) => {
    const { y, m } = ymd(t);
    const key = `${y}-${m}`;
    if (!buckets.has(key)) buckets.set(key, { year: y, month: m, tmax: [], tmin: [], tmean: [], precip: [], snow: [] });
    const b = buckets.get(key);
    b.tmax.push(daily.tmax[i]);
    b.tmin.push(daily.tmin[i]);
    b.tmean.push(finite(daily.tmean[i]) ? daily.tmean[i] : (finite(daily.tmax[i]) && finite(daily.tmin[i]) ? (daily.tmax[i] + daily.tmin[i]) / 2 : null));
    b.precip.push(daily.precip[i]);
    b.snow.push(daily.snow ? daily.snow[i] : null);
  });

  const months = [];
  for (const b of buckets.values()) {
    const valid = b.tmean.filter(finite).length;
    if (valid < 25) continue;
    const dim = daysInMonth(b.year, b.month);
    const precipDays = b.precip.filter(finite);
    const scale = precipDays.length ? dim / precipDays.length : 1;
    months.push({
      year: b.year,
      month: b.month,
      tmax: mean(b.tmax),
      tmin: mean(b.tmin),
      tmean: mean(b.tmean),
      precip: precipDays.reduce((a, x) => a + x, 0) * scale,
      wetDays: precipDays.filter(x => x >= 1).length * scale,
      snow: b.snow.some(finite) ? b.snow.filter(finite).reduce((a, x) => a + x, 0) * scale : null,
      recordHigh: Math.max(...b.tmax.filter(finite)),
      recordLow: Math.min(...b.tmin.filter(finite)),
    });
  }
  return months.sort((a, b) => a.year - b.year || a.month - b.month);
}

// 30-year normals per calendar month (WMO 1991–2020 when the history covers it).
function computeNormals(months) {
  const inNormals = months.filter(r => r.year >= NORMALS_START && r.year <= NORMALS_END);
  const base = inNormals.length >= 12 * 10 ? inNormals : months;
  const years = base.map(r => r.year);

  const normals = [];
  for (let m = 1; m <= 12; m++) {
    const rows = base.filter(r => r.month === m);
    const all = months.filter(r => r.month === m);
    normals.push({
      month: m,
      name: MONTH_NAMES[m - 1],
      tmax: mean(rows.map(r => r.tmax)),
      tmin: mean(rows.map(r => r.tmin)),
      tmean: mean(rows.map(r => r.tmean)),
      tmeanStd: std(rows.map(r => r.tmean)),
      precip: mean(rows.map(r => r.precip)),
      precipP33: quantile(rows.map(r => r.precip), 1 / 3),
      precipP67: quantile(rows.map(r => r.precip), 2 / 3),
      precipCv: (() => {
        const m0 = mean(rows.map(r => r.precip));
        const s0 = std(rows.map(r => r.precip));
        return m0 ? s0 / m0 : null;
      })(),
      wetDays: mean(rows.map(r => r.wetDays)),
      snow: mean(rows.map(r => r.snow)),
      recordHigh: all.length ? Math.max(...all.map(r => r.recordHigh)) : null,
      recordLow: all.length ? Math.min(...all.map(r => r.recordLow)) : null,
      warmestYear: all.length ? all.reduce((a, r) => (r.tmean > a.tmean ? r : a)).year : null,
      coldestYear: all.length ? all.reduce((a, r) => (r.tmean < a.tmean ? r : a)).year : null,
    });
  }
  return {
    period: base.length ? `${Math.min(...years)}–${Math.max(...years)}` : null,
    months: normals,
  };
}

// Linear warming trend of monthly mean-temperature anomalies, in °C per year.
function computeTrend(months, normals) {
  const xs = [];
  const ys = [];
  for (const r of months) {
    const n = normals.months[r.month - 1];
    if (!finite(n.tmean)) continue;
    xs.push(r.year + (r.month - 0.5) / 12);
    ys.push(r.tmean - n.tmean);
  }
  const fit = linearRegression(xs, ys);
  if (!fit) return { perYear: 0, perDecade: 0, years: 0 };
  return {
    perYear: fit.slope,
    perDecade: fit.slope * 10,
    years: Math.round(xs[xs.length - 1] - xs[0]),
    // Normals are centred on the middle of their reference period
    normalsCentre: (NORMALS_START + NORMALS_END + 1) / 2,
  };
}

// Smooth daily normal: linear interpolation between mid-month normals.
function dailyNormal(normals, dateStr, key) {
  const { y, m, d } = ymd(dateStr);
  const dim = daysInMonth(y, m);
  const pos = (d - 0.5) / dim; // 0..1 within the month; mid-month = 0.5
  const cur = normals.months[m - 1][key];
  const otherIdx = pos < 0.5 ? (m + 10) % 12 : m % 12;
  const other = normals.months[otherIdx][key];
  if (!finite(cur)) return null;
  if (!finite(other)) return cur;
  const w = Math.abs(pos - 0.5); // 0 at mid-month, 0.5 at month boundary
  return cur * (1 - w) + other * w;
}

function dailyNormalPrecip(normals, dateStr) {
  const { y, m } = ymd(dateStr);
  const p = normals.months[m - 1].precip;
  return finite(p) ? p / daysInMonth(y, m) : null;
}

// Recent anomalies drive "persistence" — soils, sea surface and snowpack carry
// a memory of the last few weeks into the next one or two months.
function recentAnomalies(daily, normals, months) {
  const n = daily.time.length;
  const window = days => {
    const anoms = [];
    let precip = 0;
    let precipNormal = 0;
    for (let i = Math.max(0, n - days); i < n; i++) {
      const t = daily.time[i];
      const tm = finite(daily.tmean[i]) ? daily.tmean[i] : null;
      const nm = dailyNormal(normals, t, 'tmean');
      if (finite(tm) && finite(nm)) anoms.push(tm - nm);
      if (finite(daily.precip[i])) {
        precip += daily.precip[i];
        precipNormal += dailyNormalPrecip(normals, t) || 0;
      }
    }
    return {
      tempAnomaly: round(mean(anoms), 2),
      precipPctOfNormal: precipNormal > 0 ? Math.round((precip / precipNormal) * 100) : null,
    };
  };

  const last12 = months.slice(-12).map(r => ({
    label: `${MONTH_NAMES[r.month - 1]} ${r.year}`,
    tempAnomaly: round(r.tmean - normals.months[r.month - 1].tmean, 2),
    precipPctOfNormal: normals.months[r.month - 1].precip ? Math.round((r.precip / normals.months[r.month - 1].precip) * 100) : null,
  }));

  return {
    lastObservedDate: daily.time[n - 1],
    last30: window(30),
    last90: window(90),
    last12Months: last12,
  };
}

function buildClimateProfile(daily) {
  const months = monthlyAggregates(daily);
  const normals = computeNormals(months);
  const trend = computeTrend(months, normals);
  const recent = recentAnomalies(daily, normals, months);
  const firstYear = months.length ? months[0].year : null;
  return { normals, trend, recent, historyYears: firstYear ? `${firstYear}–${months[months.length - 1].year}` : null };
}

// ── Seasonal ensemble (ECMWF SEAS5 via Open-Meteo) ──

// Collapses ensemble members into per-month statistics. Values are raw model
// output: they are not bias-corrected against the station/reanalysis climate,
// which the AI is told about explicitly.
function summarizeSeasonal(seasonal, normals) {
  if (!seasonal || !seasonal.time || !seasonal.time.length) return null;
  const byMonth = new Map();
  seasonal.time.forEach((t, i) => {
    const { y, m } = ymd(t);
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { year: y, month: m, idx: [] });
    byMonth.get(key).idx.push(i);
  });

  const out = [];
  for (const b of byMonth.values()) {
    if (b.idx.length < 10) continue;
    const memberStats = (members, agg) => members.map(series => {
      const vals = b.idx.map(i => series[i]).filter(finite);
      if (vals.length < b.idx.length * 0.8) return null;
      return agg === 'sum'
        ? (vals.reduce((a, x) => a + x, 0) * daysInMonth(b.year, b.month)) / vals.length
        : mean(vals);
    }).filter(finite);

    const tmax = memberStats(seasonal.tmax, 'mean');
    const tmin = memberStats(seasonal.tmin, 'mean');
    const precip = memberStats(seasonal.precip, 'sum');
    if (!tmax.length || !tmin.length) continue;
    const n = normals.months[b.month - 1];
    const tmean = tmax.map((x, i) => (finite(tmin[i]) ? (x + tmin[i]) / 2 : null)).filter(finite);
    const tmeanEns = mean(tmean);
    out.push({
      key: `${b.year}-${String(b.month).padStart(2, '0')}`,
      label: `${MONTH_NAMES[b.month - 1]} ${b.year}`,
      members: tmax.length,
      daysCovered: b.idx.length,
      tmax: round(mean(tmax)),
      tmin: round(mean(tmin)),
      tmeanSpread: round(std(tmean), 2),
      precip: round(mean(precip)),
      precipSpread: round(std(precip)),
      rawTempAnomaly: finite(n.tmean) ? round(tmeanEns - n.tmean, 2) : null,
      rawPrecipPctOfNormal: n.precip ? Math.round((mean(precip) / n.precip) * 100) : null,
      // Share of members warmer/wetter than the ERA5 normal (biased by model drift)
      pctMembersWarmer: finite(n.tmean) ? Math.round((tmean.filter(x => x > n.tmean).length / tmean.length) * 100) : null,
      pctMembersWetter: n.precip ? Math.round((precip.filter(x => x > n.precip).length / precip.length) * 100) : null,
    });
  }
  return out.length ? out : null;
}

// ── Forecast periods & statistical baseline ──

// 1-month outlooks are broken into weeks; longer horizons into calendar months,
// starting with the remainder of the current month.
function buildPeriods(horizonMonths, today) {
  const periods = [];
  if (horizonMonths <= 1) {
    const spans = [[0, 6, 'Week 1'], [7, 13, 'Week 2'], [14, 20, 'Week 3'], [21, 29, 'Week 4+']];
    for (const [a, b, name] of spans) {
      const start = addDays(today, a);
      const end = addDays(today, b);
      periods.push({ id: `w${periods.length + 1}`, label: name, kind: 'week', start, end });
    }
    return periods;
  }

  const { y, m, d } = ymd(today);
  const dim = daysInMonth(y, m);
  if (dim - d + 1 >= 7) {
    periods.push({
      id: `${y}-${String(m).padStart(2, '0')}`,
      label: `Rest of ${MONTH_NAMES[m - 1]} ${y}`,
      kind: 'partial-month',
      start: today,
      end: `${y}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`,
    });
  }
  for (let i = 1; i <= horizonMonths; i++) {
    const mm = ((m - 1 + i) % 12) + 1;
    const yy = y + Math.floor((m - 1 + i) / 12);
    const mmS = String(mm).padStart(2, '0');
    periods.push({
      id: `${yy}-${mmS}`,
      label: `${MONTH_NAMES[mm - 1]} ${yy}`,
      kind: 'month',
      start: `${yy}-${mmS}-01`,
      end: `${yy}-${mmS}-${String(daysInMonth(yy, mm)).padStart(2, '0')}`,
    });
  }
  return periods;
}

// Statistical baseline per period. Blends, in order of lead time:
//   1. the deterministic 16-day forecast (high skill, fading after ~day 7),
//   2. damped persistence of the last 30 days' anomaly,
//   3. the seasonal ensemble's anomaly (when available),
//   4. climatology shifted by the long-term warming trend.
function computeBaseline({ periods, today, profile, forecastDaily, seasonalMonths }) {
  const { normals, trend, recent } = profile;
  const fcIndex = new Map((forecastDaily?.time || []).map((t, i) => [t, i]));
  const seasonalByKey = new Map((seasonalMonths || []).map(s => [s.key, s]));
  const persist = finite(recent.last30.tempAnomaly) ? recent.last30.tempAnomaly : 0;
  const precipPersist = finite(recent.last90.precipPctOfNormal) ? recent.last90.precipPctOfNormal / 100 : 1;

  return periods.map(p => {
    const nDays = daysBetween(p.start, p.end) + 1;
    let sumTmax = 0, sumTmin = 0, sumNTmax = 0, sumNTmin = 0, sumPrecip = 0, sumNPrecip = 0;
    let fcDays = 0, seasonalDays = 0;
    const leads = [];

    for (let k = 0; k < nDays; k++) {
      const date = addDays(p.start, k);
      const lead = daysBetween(today, date);
      leads.push(lead);
      const nTmax = dailyNormal(normals, date, 'tmax');
      const nTmin = dailyNormal(normals, date, 'tmin');
      const nPrecip = dailyNormalPrecip(normals, date) || 0;
      const { y, m } = ymd(date);

      // Statistical estimate for this day
      const trendAdj = trend.perYear * (y + (m - 0.5) / 12 - trend.normalsCentre);
      const persistAdj = persist * Math.exp(-Math.max(lead, 0) / 40);
      const seas = seasonalByKey.get(`${y}-${String(m).padStart(2, '0')}`);
      let seasAdj = 0;
      let precipRatio = 1 + 0.25 * (precipPersist - 1) * Math.exp(-Math.max(lead, 0) / 30);
      if (seas && finite(seas.rawTempAnomaly)) {
        seasonalDays++;
        // Weight the model's signal less the further out it is and the larger its spread
        const w = clamp(0.5 - lead / 600, 0.2, 0.5);
        // Remove the part of the model anomaly already explained by trend so it isn't double-counted
        seasAdj = w * clamp(seas.rawTempAnomaly - trendAdj, -4, 4);
        if (finite(seas.rawPrecipPctOfNormal)) {
          precipRatio = precipRatio * (1 + w * (clamp(seas.rawPrecipPctOfNormal / 100, 0.3, 2.5) - 1));
        }
      }
      let tmax = nTmax + trendAdj + persistAdj + seasAdj;
      let tmin = nTmin + trendAdj + persistAdj + seasAdj;
      let precip = nPrecip * clamp(precipRatio, 0.4, 1.8);

      // Deterministic forecast dominates early, fades to ~0 by day 16
      const fi = fcIndex.get(date);
      if (fi !== undefined && finite(forecastDaily.tmax[fi])) {
        fcDays++;
        const w = clamp(1 - Math.max(lead - 5, 0) / 12, 0.15, 1);
        tmax = w * forecastDaily.tmax[fi] + (1 - w) * tmax;
        tmin = w * forecastDaily.tmin[fi] + (1 - w) * tmin;
        if (finite(forecastDaily.precip[fi])) precip = w * forecastDaily.precip[fi] + (1 - w) * precip;
      }

      sumTmax += tmax; sumTmin += tmin; sumPrecip += precip;
      sumNTmax += nTmax; sumNTmin += nTmin; sumNPrecip += nPrecip;
    }

    const normalTmax = sumNTmax / nDays;
    const normalTmin = sumNTmin / nDays;
    const tmax = sumTmax / nDays;
    const tmin = sumTmin / nDays;
    const anomaly = (tmax + tmin) / 2 - (normalTmax + normalTmin) / 2;

    // Climatological spread of a period mean: monthly std, inflated for shorter periods
    const midMonth = ymd(addDays(p.start, Math.floor(nDays / 2))).m;
    const sigmaClim = Math.max(normals.months[midMonth - 1].tmeanStd || 1.5, 0.8) * Math.sqrt(30 / Math.max(nDays, 7));
    const fcFrac = fcDays / nDays;
    // Forecast spread: tight where the deterministic model covers, near-climatological otherwise
    const sigmaFc = Math.max(0.6, fcFrac * 1.2 + (1 - fcFrac) * sigmaClim * (seasonalDays ? 0.9 : 1));

    const tercile = 0.43 * sigmaClim;
    let pBelow = normCdf((-tercile - anomaly) / sigmaFc);
    let pAbove = 1 - normCdf((tercile - anomaly) / sigmaFc);
    if (fcFrac < 0.5) {
      // Beyond the deterministic range real-world skill is modest: never near-certain
      pBelow = clamp(pBelow, 0.05, 0.75);
      pAbove = clamp(pAbove, 0.05, 0.75);
      const near = Math.max(1 - pBelow - pAbove, 0.15);
      [pBelow, pAbove] = [pBelow, pAbove].map(p => (p / (pBelow + pAbove)) * (1 - near));
    }

    const precipRatio = sumNPrecip > 0 ? sumPrecip / sumNPrecip : 1;
    const cv = normals.months[midMonth - 1].precipCv || 0.6;
    const pZ = (precipRatio - 1) / Math.max(cv * Math.sqrt(30 / Math.max(nDays, 7)), 0.2);
    const pWet = clamp(0.333 + 0.25 * Math.tanh(pZ), 0.1, 0.8);
    const pDry = clamp(0.333 - 0.25 * Math.tanh(pZ), 0.1, 0.8);

    const leadStart = Math.min(...leads);
    return {
      ...p,
      days: nDays,
      leadDays: [leadStart, Math.max(...leads)],
      normal: { tmax: round(normalTmax), tmin: round(normalTmin), precip: round(sumNPrecip) },
      baseline: {
        tmax: round(tmax),
        tmin: round(tmin),
        tempAnomaly: round(anomaly),
        tmaxP10: round(tmax - 1.28 * sigmaFc),
        tmaxP90: round(tmax + 1.28 * sigmaFc),
        precip: round(sumPrecip),
        precipPctOfNormal: Math.round(precipRatio * 100),
        probTemp: toPct([pBelow, 1 - pBelow - pAbove, pAbove]),
        probPrecip: toPct([pDry, 1 - pDry - pWet, pWet]),
      },
      sources: {
        deterministicForecastDays: fcDays,
        seasonalEnsembleDays: seasonalDays,
        climatologyOnly: fcDays === 0 && seasonalDays === 0,
      },
    };
  });
}

// Rounds three probabilities to integer percentages that sum to exactly 100.
function toPct(ps) {
  const raw = ps.map(p => Math.max(p, 0) * 100);
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const scaled = raw.map(p => (p / total) * 100);
  const floored = scaled.map(Math.floor);
  let rem = 100 - floored.reduce((a, b) => a + b, 0);
  const order = scaled.map((p, i) => [p - floored[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rem-- <= 0) break;
    floored[i]++;
  }
  return { below: floored[0], near: floored[1], above: floored[2] };
}

module.exports = {
  MONTH_NAMES,
  addDays,
  daysBetween,
  monthlyAggregates,
  computeNormals,
  computeTrend,
  dailyNormal,
  buildClimateProfile,
  summarizeSeasonal,
  buildPeriods,
  computeBaseline,
  toPct,
  normCdf,
  round,
};
