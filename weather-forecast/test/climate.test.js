const test = require('node:test');
const assert = require('node:assert/strict');
const climate = require('../lib/climate');
const { validateForecast, normalizeProbabilities } = require('../lib/ai');

// Deterministic pseudo-random noise so tests are reproducible
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };
}

// Synthetic mid-latitude climate: 10 °C mean, ±12 °C seasonal swing peaking in
// July, a 0.3 °C/decade warming trend, and 2 mm/day of rain.
function syntheticHistory({ start = '1991-01-01', end = '2026-10-03', trendPerYear = 0.03 } = {}) {
  const noise = rng(42);
  const daily = { time: [], tmax: [], tmin: [], tmean: [], precip: [], snow: [] };
  for (let d = start; d <= end; d = climate.addDays(d, 1)) {
    const doy = climate.daysBetween(`${d.slice(0, 4)}-01-01`, d);
    const year = +d.slice(0, 4) + doy / 365;
    const tmean = 10 - 12 * Math.cos((2 * Math.PI * (doy - 15)) / 365) + trendPerYear * (year - 2006) + noise() * 2;
    daily.time.push(d);
    daily.tmean.push(tmean);
    daily.tmax.push(tmean + 5);
    daily.tmin.push(tmean - 5);
    daily.precip.push(noise() > 0.2 ? 6.5 : 0.5);
    daily.snow.push(0);
  }
  return daily;
}

const history = syntheticHistory();
const profile = climate.buildClimateProfile(history);

test('normals capture the seasonal cycle', () => {
  const jan = profile.normals.months[0];
  const jul = profile.normals.months[6];
  assert.equal(profile.normals.period, '1991–2020');
  assert.ok(jan.tmean < 0 && jan.tmean > -4, `Jan mean ${jan.tmean}`);
  assert.ok(jul.tmean > 19 && jul.tmean < 23, `Jul mean ${jul.tmean}`);
  assert.ok(Math.abs(jul.tmax - jul.tmin - 10) < 0.01);
  assert.ok(jan.precip > 30 && jan.precip < 100, `Jan precip ${jan.precip}`);
});

test('trend recovers the inserted warming rate', () => {
  assert.ok(Math.abs(profile.trend.perDecade - 0.3) < 0.08, `trend ${profile.trend.perDecade}`);
});

test('daily normal interpolates smoothly across month boundaries', () => {
  const endJun = climate.dailyNormal(profile.normals, '2026-06-30', 'tmax');
  const startJul = climate.dailyNormal(profile.normals, '2026-07-01', 'tmax');
  assert.ok(Math.abs(endJun - startJul) < 0.5, `${endJun} vs ${startJul}`);
});

test('recent anomalies reflect the warming trend relative to 1991–2020', () => {
  // Expected ≈ 0.03 °C/yr × (2026.7 − 2006) ≈ 0.6 °C
  assert.ok(profile.recent.last90.tempAnomaly > 0.2 && profile.recent.last90.tempAnomaly < 1.1, `${profile.recent.last90.tempAnomaly}`);
  assert.equal(profile.recent.last12Months.length, 12);
});

test('periods: 1 month is four weekly blocks covering 30 days', () => {
  const p = climate.buildPeriods(1, '2026-10-10');
  assert.deepEqual(p.map(x => x.label), ['Week 1', 'Week 2', 'Week 3', 'Week 4+']);
  assert.equal(p[0].start, '2026-10-10');
  assert.equal(p[3].end, '2026-11-08');
});

test('periods: monthly horizons start with the rest of the current month and roll over the year', () => {
  const p = climate.buildPeriods(12, '2026-10-10');
  assert.equal(p.length, 13);
  assert.equal(p[0].label, 'Rest of Oct 2026');
  assert.equal(p[1].id, '2026-11');
  assert.equal(p[3].id, '2027-01');
  assert.equal(p[12].end, '2027-10-31');
  // Too few days left: skip the partial month
  assert.equal(climate.buildPeriods(3, '2026-10-28')[0].id, '2026-11');
});

test('baseline with no model data stays near trend-adjusted normals with valid probabilities', () => {
  const today = '2026-10-10';
  const periods = climate.buildPeriods(6, today);
  const base = climate.computeBaseline({ periods, today, profile, forecastDaily: null, seasonalMonths: null });
  for (const p of base) {
    const t = p.baseline.probTemp;
    const pr = p.baseline.probPrecip;
    assert.equal(t.below + t.near + t.above, 100);
    assert.equal(pr.below + pr.near + pr.above, 100);
    assert.ok(Math.abs(p.baseline.tempAnomaly) < 1.5, `${p.label} anomaly ${p.baseline.tempAnomaly}`);
    assert.ok(p.baseline.tmaxP10 < p.baseline.tmax && p.baseline.tmax < p.baseline.tmaxP90);
    assert.ok(p.sources.climatologyOnly);
  }
  // Warming trend tilts odds toward "above"
  assert.ok(base[3].baseline.probTemp.above > base[3].baseline.probTemp.below);
});

test('deterministic forecast dominates the first week', () => {
  const today = '2026-10-10';
  const periods = climate.buildPeriods(1, today);
  const time = Array.from({ length: 16 }, (_, i) => climate.addDays(today, i));
  const forecastDaily = { time, tmax: time.map(() => 30), tmin: time.map(() => 20), precip: time.map(() => 0) };
  const [week1, week2, week3] = climate.computeBaseline({ periods, today, profile, forecastDaily, seasonalMonths: null });
  assert.ok(Math.abs(week1.baseline.tmax - 30) < 0.5, `week1 ${week1.baseline.tmax}`);
  assert.ok(week1.baseline.probTemp.above > 90);
  assert.ok(week1.baseline.precip < 1);
  assert.ok(week2.baseline.tmax < week1.baseline.tmax);
  assert.equal(week3.sources.deterministicForecastDays, 2);
});

test('seasonal ensemble is summarized per month and shifts the baseline', () => {
  const today = '2026-10-10';
  const time = Array.from({ length: 120 }, (_, i) => climate.addDays(today, i));
  const members = (offset, spread) => Array.from({ length: 5 }, (_, k) => time.map(t => climate.dailyNormal(profile.normals, t, 'tmax') + offset + (k - 2) * spread));
  const seasonal = {
    time,
    tmax: members(3, 0.3),
    tmin: time.length && members(-7, 0.3),
    precip: Array.from({ length: 5 }, () => time.map(() => 4)),
  };
  const months = climate.summarizeSeasonal(seasonal, profile.normals);
  const nov = months.find(m => m.key === '2026-11');
  assert.equal(nov.members, 5);
  assert.ok(nov.rawTempAnomaly > 2, `nov anomaly ${nov.rawTempAnomaly}`);
  assert.equal(nov.pctMembersWarmer, 100);

  const periods = climate.buildPeriods(3, today);
  const withSeas = climate.computeBaseline({ periods, today, profile, forecastDaily: null, seasonalMonths: months });
  const without = climate.computeBaseline({ periods, today, profile, forecastDaily: null, seasonalMonths: null });
  assert.ok(withSeas[1].baseline.tempAnomaly > without[1].baseline.tempAnomaly + 0.5);
  assert.ok(withSeas[1].sources.seasonalEnsembleDays > 25);
  // Even a strong, unanimous signal stays short of certainty at monthly leads
  for (const p of withSeas.slice(1)) {
    assert.ok(p.baseline.probTemp.above <= 76 && p.baseline.probTemp.near >= 14, JSON.stringify(p.baseline.probTemp));
  }
});

test('a seasonal month without precipitation members does not read as 0% of normal', () => {
  // Live SEAS5 output: precipitation turns null weeks before temperature does
  const today = '2026-10-10';
  const time = Array.from({ length: 60 }, (_, i) => climate.addDays(today, i));
  const temp = Array.from({ length: 3 }, () => time.map(t => climate.dailyNormal(profile.normals, t, 'tmax')));
  const precip = Array.from({ length: 3 }, () => time.map(t => (t < '2026-11-01' ? 3 : null)));
  const months = climate.summarizeSeasonal({ time, tmax: temp, tmin: temp, precip }, profile.normals);
  const nov = months.find(m => m.key === '2026-11');
  assert.equal(nov.members, 3);
  assert.equal(nov.precip, null);
  assert.equal(nov.rawPrecipPctOfNormal, null);
  assert.equal(nov.pctMembersWetter, null);

  const periods = climate.buildPeriods(3, today);
  const withSeas = climate.computeBaseline({ periods, today, profile, forecastDaily: null, seasonalMonths: months });
  const without = climate.computeBaseline({ periods, today, profile, forecastDaily: null, seasonalMonths: null });
  const novIdx = periods.findIndex(p => p.id === '2026-11');
  assert.equal(withSeas[novIdx].baseline.precip, without[novIdx].baseline.precip);
});

test('toPct always sums to 100', () => {
  for (const ps of [[0.1, 0.2, 0.7], [1 / 3, 1 / 3, 1 / 3], [0, 0, 1], [0.005, 0.49, 0.505]]) {
    const r = climate.toPct(ps);
    assert.equal(r.below + r.near + r.above, 100);
  }
});

test('forecast validation catches missing periods and normalizes probabilities', () => {
  const periods = [{ id: 'a' }, { id: 'b' }];
  const good = {
    headline: 'h', summary: 's', overall_confidence: 'low', confidence_explanation: 'c', key_drivers: [],
    watch_items: [], planning_tips: [], answer: '', method_notes: 'm',
    periods: ['a', 'b'].map(id => ({
      id, temp_high_c: 10, temp_low_c: 2, temp_anomaly_c: 0.5, precip_mm: 40,
      prob_temp_below: 20, prob_temp_near: 30, prob_temp_above: 60,
      prob_precip_below: 0, prob_precip_near: 0, prob_precip_above: 0,
    })),
  };
  assert.deepEqual(validateForecast(good, periods), []);
  assert.match(validateForecast({ ...good, periods: good.periods.slice(0, 1) }, periods).join(), /missing periods: b/);

  const norm = normalizeProbabilities(structuredClone(good));
  const p = norm.periods[0];
  assert.equal(p.prob_temp_below + p.prob_temp_near + p.prob_temp_above, 100);
  assert.equal(p.prob_precip_below + p.prob_precip_near + p.prob_precip_above, 100);
});
