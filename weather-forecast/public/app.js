// Horizon — long-range weather front end (vanilla JS, no build step).
// All data arrives metric; conversion to the viewer's units happens at render time.

const $ = sel => document.querySelector(sel);

const POPULAR = [
  { name: 'New York', admin1: 'New York', country: 'United States', latitude: 40.71, longitude: -74.01 },
  { name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.51, longitude: -0.13 },
  { name: 'Chicago', admin1: 'Illinois', country: 'United States', latitude: 41.88, longitude: -87.63 },
  { name: 'Mumbai', admin1: 'Maharashtra', country: 'India', latitude: 19.08, longitude: 72.88 },
  { name: 'Tokyo', admin1: 'Tokyo', country: 'Japan', latitude: 35.69, longitude: 139.69 },
  { name: 'Sydney', admin1: 'New South Wales', country: 'Australia', latitude: -33.87, longitude: 151.21 },
  { name: 'Toronto', admin1: 'Ontario', country: 'Canada', latitude: 43.65, longitude: -79.38 },
  { name: 'Denver', admin1: 'Colorado', country: 'United States', latitude: 39.74, longitude: -104.99 },
];

const WMO = {
  0: ['Clear sky', '☀️', '🌙'], 1: ['Mainly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Severe thunderstorm, hail', '⛈️'],
};
const wmo = (code, isDay = 1) => {
  const w = WMO[code] || ['—', '🌡️'];
  return { text: w[0], icon: !isDay && w[2] ? w[2] : w[1] };
};

// localStorage can be unavailable (private mode, blocked storage); never let it break the page
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`horizon:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`horizon:${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

const state = {
  units: store.get('units') || 'metric',
  loc: null,
  weather: null,
  horizon: 3,
  outlookData: null,
  outlookResult: null,
  es: null,
  config: null,
};

// ── Helpers ──

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const imperial = () => state.units === 'imperial';
const num = v => typeof v === 'number' && Number.isFinite(v);
const tVal = c => (num(c) ? (imperial() ? c * 9 / 5 + 32 : c) : null);
const T = c => (num(c) ? `${Math.round(tVal(c))}°` : '–');
const dT = c => {
  if (!num(c)) return '–';
  const v = imperial() ? c * 9 / 5 : c;
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}°`;
};
const pVal = mm => (num(mm) ? (imperial() ? mm / 25.4 : mm) : null);
const P = mm => (num(mm) ? (imperial() ? `${(mm / 25.4).toFixed(mm < 25 ? 2 : 1)} in` : `${Math.round(mm)} mm`) : '–');
const W = kmh => (num(kmh) ? (imperial() ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`) : '–');
const compass = deg => (num(deg) ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8] : '');
const dateOf = s => new Date(`${s.slice(0, 10)}T12:00:00Z`);
const fmtDay = (s, opts) => dateOf(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
const fmtRange = (a, b) => `${fmtDay(a, { month: 'short', day: 'numeric' })} – ${fmtDay(b, { month: 'short', day: 'numeric' })}`;
const locLabel = l => [l.name, l.admin1 && l.admin1 !== l.name ? l.admin1 : null, l.country].filter(Boolean).join(', ');

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ── Search ──

let searchTimer;
let suggestionItems = [];
let activeSuggestion = -1;

function showSuggestions(items) {
  suggestionItems = items;
  activeSuggestion = -1;
  const ul = $('#suggestions');
  if (!items.length) { ul.classList.add('hidden'); return; }
  ul.innerHTML = items.map((r, i) => `<li role="option" data-i="${i}"><span>${esc(r.name)}</span><span class="muted small">${esc([r.admin1, r.country].filter(Boolean).join(', '))}</span></li>`).join('');
  ul.classList.remove('hidden');
}

$('#search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return showSuggestions([]);
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await getJson(`/api/geocode?q=${encodeURIComponent(q)}`);
      showSuggestions(results);
    } catch { showSuggestions([]); }
  }, 250);
});

$('#search-input').addEventListener('keydown', e => {
  if (!suggestionItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) % suggestionItems.length;
    document.querySelectorAll('#suggestions li').forEach((li, i) => li.setAttribute('aria-selected', i === activeSuggestion));
  } else if (e.key === 'Escape') {
    showSuggestions([]);
  }
});

$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  const pick = suggestionItems[Math.max(activeSuggestion, 0)];
  if (pick) selectLocation(pick);
});

$('#suggestions').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (li) selectLocation(suggestionItems[+li.dataset.i]);
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) showSuggestions([]); });

$('#locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Location is not available in this browser.');
  navigator.geolocation.getCurrentPosition(
    pos => selectLocation({ name: 'My location', latitude: +pos.coords.latitude.toFixed(3), longitude: +pos.coords.longitude.toFixed(3) }),
    () => alert('Could not get your location. Try searching instead.'),
    { timeout: 10000 },
  );
});

$('#popular').innerHTML = POPULAR.map((p, i) => `<button type="button" class="chip" data-i="${i}">${esc(p.name)}</button>`).join('');
$('#popular').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) selectLocation(POPULAR[+b.dataset.i]);
});

// ── Units ──

function syncUnitButtons() {
  document.querySelectorAll('[data-units]').forEach(b => b.setAttribute('aria-pressed', b.dataset.units === state.units));
}
document.querySelectorAll('[data-units]').forEach(b => b.addEventListener('click', () => {
  state.units = b.dataset.units;
  store.set('units', state.units);
  syncUnitButtons();
  renderAll();
}));

// ── Location & current weather ──

async function selectLocation(loc) {
  showSuggestions([]);
  $('#search-input').value = '';
  state.loc = loc;
  store.set('loc', loc);
  state.outlookData = null;
  state.outlookResult = null;
  state.outlookFailure = null;
  closeStream();
  $('#outlook-result').innerHTML = '';
  $('#reasoning').classList.add('hidden');
  $('#welcome').classList.add('hidden');
  $('#current').classList.remove('hidden');
  $('#current').innerHTML = `<div><div class="loc">${esc(locLabel(loc))}</div><div class="asof">Loading current conditions…</div></div>`;
  $('#outlook').classList.remove('hidden');
  $('#outlook-title').textContent = `Long-range forecast for ${loc.name}`;
  document.title = `${loc.name} · Horizon Weather`;

  try {
    state.weather = await getJson(`/api/weather?lat=${loc.latitude}&lon=${loc.longitude}`);
    $('#lower').classList.remove('hidden');
    renderAll();
  } catch (err) {
    $('#current').innerHTML = `<div><div class="loc">${esc(locLabel(loc))}</div><div class="asof">Could not load weather: ${esc(err.message)}</div></div>`;
  }
}

function renderAll() {
  if (state.weather) {
    renderCurrent();
    renderDays();
    renderHours();
    renderNormals();
  }
  if (state.outlookData) renderOutlook();
}

function renderCurrent() {
  const w = state.weather;
  const c = w.current;
  const cond = wmo(c.weather_code, c.is_day);
  const n0 = w.climate?.dailyNormals?.[0];
  let vsNormal = '';
  if (n0 && num(n0.tmax) && num(w.daily.tmax[0])) {
    const diff = w.daily.tmax[0] - n0.tmax;
    const word = Math.abs(diff) < 1 ? 'near normal' : diff > 0 ? 'above normal' : 'below normal';
    vsNormal = `<div class="vs-normal">Today's high is ${Math.abs(diff) < 1 ? '' : dT(diff).replace(/^[+−]/, '') + ' '}${word} (normal ${T(n0.tmax)})</div>`;
  }
  const time = c.time ? new Date(`${c.time}:00Z`).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }) : '';
  const vis = num(c.visibility) ? (imperial() ? `${(c.visibility / 1609).toFixed(1)} mi` : `${(c.visibility / 1000).toFixed(1)} km`) : '–';
  const details = [
    ['Feels like', T(c.apparent_temperature)],
    ['Humidity', `${c.relative_humidity_2m ?? '–'}%`],
    ['Wind', `${W(c.wind_speed_10m)} ${compass(c.wind_direction_10m)}`],
    ['Gusts', W(c.wind_gusts_10m)],
    ['Dew point', T(c.dew_point_2m)],
    ['Pressure', num(c.pressure_msl) ? (imperial() ? `${(c.pressure_msl * 0.02953).toFixed(2)} inHg` : `${Math.round(c.pressure_msl)} hPa`) : '–'],
    ['UV index', num(c.uv_index) ? c.uv_index.toFixed(1) : '–'],
    ['Cloud cover', `${c.cloud_cover ?? '–'}%`],
    ['Visibility', vis],
    ['Precipitation', P(c.precipitation)],
    ['Sunrise', w.daily.sunrise?.[0] ? w.daily.sunrise[0].slice(11, 16) : '–'],
    ['Sunset', w.daily.sunset?.[0] ? w.daily.sunset[0].slice(11, 16) : '–'],
  ];
  $('#current').innerHTML = `
    <div>
      <div class="loc">${esc(locLabel(state.loc))}</div>
      <div class="asof">As of ${esc(time)} local time · ${esc(w.timezone || '')}</div>
      <div class="now"><span class="temp">${T(c.temperature_2m)}</span><span class="icon" aria-hidden="true">${cond.icon}</span></div>
      <div class="desc">${esc(cond.text)}</div>
      <div class="hilo">H ${T(w.daily.tmax[0])} · L ${T(w.daily.tmin[0])} · ${w.daily.precipProb?.[0] ?? 0}% chance of precipitation</div>
      ${vsNormal}
    </div>
    <div class="details">${details.map(([k, v]) => `<div class="detail"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`;
}

function renderDays() {
  const d = state.weather.daily;
  const normals = state.weather.climate?.dailyNormals || [];
  const lo = Math.min(...d.tmin.filter(num), ...normals.map(n => n.tmin).filter(num));
  const hi = Math.max(...d.tmax.filter(num), ...normals.map(n => n.tmax).filter(num));
  const pct = v => ((v - lo) / (hi - lo || 1)) * 100;
  $('#days').innerHTML = d.time.map((t, i) => {
    const cond = wmo(d.code[i]);
    const n = normals[i];
    const name = i === 0 ? 'Today' : fmtDay(t, { weekday: 'short' });
    return `<div class="day${i >= 10 ? ' extended' : ''}" title="${esc(cond.text)}">
      <div class="dname">${name}<small>${fmtDay(t, { month: 'short', day: 'numeric' })}</small></div>
      <div class="dicon" aria-label="${esc(cond.text)}">${cond.icon}</div>
      <div class="dpop">${d.precipProb[i] ? `${d.precipProb[i]}%` : ''}</div>
      <div class="dlo">${T(d.tmin[i])}</div>
      <div class="range">
        <div class="fill" style="left:${pct(d.tmin[i])}%; right:${100 - pct(d.tmax[i])}%"></div>
        ${n && num(n.tmax) ? `<div class="norm" style="left:${pct(n.tmax)}%" title="Normal high ${T(n.tmax)}"></div>` : ''}
      </div>
      <div class="dhi">${T(d.tmax[i])}</div>
    </div>`;
  }).join('');
}

function renderHours() {
  const h = state.weather.hourly;
  const nowIdx = Math.max(0, h.time.findIndex(t => t >= (state.weather.current.time || '').slice(0, 13)));
  const rows = h.time.slice(nowIdx, nowIdx + 24).map((t, k) => {
    const i = nowIdx + k;
    const cond = wmo(h.weather_code[i], h.is_day[i]);
    const label = k === 0 ? 'Now' : new Date(`${t}:00Z`).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric' });
    return `<div class="hour"><div class="muted">${label}</div><div class="h-icon" title="${esc(cond.text)}">${cond.icon}</div><div class="h-temp">${T(h.temperature_2m[i])}</div><div class="h-pop">${h.precipitation_probability[i] ? `${h.precipitation_probability[i]}%` : ''}</div></div>`;
  });
  $('#hours').innerHTML = rows.join('');
}

function renderNormals() {
  const c = state.weather.climate;
  if (!c) {
    $('#normals-sub').textContent = 'Climate history is unavailable right now.';
    $('#normals-body').innerHTML = '';
    return;
  }
  const curMonth = +state.weather.today.slice(5, 7);
  $('#normals-sub').textContent = `Normals ${c.normalsPeriod} from ERA5 reanalysis (history ${c.historyYears}).`;
  const r = c.recent;
  const stats = [
    ['Last 30 days', dT(r.last30.tempAnomaly), 'vs normal temperature'],
    ['Last 90 days', num(r.last90.precipPctOfNormal) ? `${r.last90.precipPctOfNormal}%` : '–', 'of normal precipitation'],
    ['Warming trend', `${dT(c.trendPerDecade)}`, 'per decade since 1991'],
  ];
  $('#normals-body').innerHTML = `
    <div class="recent">${stats.map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="k">${s}</div></div>`).join('')}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Month</th><th>High</th><th>Low</th><th>Precip</th><th>Wet days</th><th>Record</th></tr></thead>
      <tbody>${c.months.map(m => `<tr${m.month === curMonth ? ' style="font-weight:700"' : ''}><td>${m.name}</td><td>${T(m.tmax)}</td><td>${T(m.tmin)}</td><td>${P(m.precip)}</td><td>${num(m.wetDays) ? Math.round(m.wetDays) : '–'}</td><td>${T(m.recordHigh)} / ${T(m.recordLow)}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// ── Long-range outlook ──

document.querySelectorAll('[data-horizon]').forEach(b => b.addEventListener('click', () => {
  state.horizon = +b.dataset.horizon;
  document.querySelectorAll('[data-horizon]').forEach(x => x.setAttribute('aria-pressed', x === b));
}));

$('#generate').addEventListener('click', startOutlook);
$('#question').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startOutlook(); }
});

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
  $('#generate').disabled = false;
  $('#spinner').classList.add('hidden');
}

function setStatus(msg) { $('#status').textContent = msg; }

function startOutlook() {
  if (!state.loc) return;
  closeStream();
  state.outlookData = null;
  state.outlookResult = null;
  state.outlookFailure = null;
  state.question = $('#question').value.trim();
  $('#outlook-result').innerHTML = '';
  $('#thinking').textContent = '';
  $('#searches').innerHTML = '';
  $('#reasoning').classList.remove('hidden');
  $('#reasoning').open = true;
  $('#spinner').classList.remove('hidden');
  $('#generate').disabled = true;
  setStatus('Starting…');

  const params = new URLSearchParams({
    lat: state.loc.latitude,
    lon: state.loc.longitude,
    name: locLabel(state.loc),
    horizon: state.horizon,
    effort: $('#effort').value,
    web: $('#web').checked ? '1' : '0',
    units: state.units,
    question: state.question,
  });
  const es = new EventSource(`/api/outlook?${params}`);
  state.es = es;
  const on = (name, fn) => es.addEventListener(name, e => fn(JSON.parse(e.data)));
  let finished = false;
  let gotResult = false;

  on('status', d => setStatus(d.message));
  on('data', d => {
    state.outlookData = d;
    renderOutlook();
  });
  on('thinking', d => {
    const el = $('#thinking');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.textContent += d.text;
    if (atBottom) el.scrollTop = el.scrollHeight;
  });
  on('search', d => {
    const s = document.createElement('span');
    s.textContent = `🔎 ${d.query}`;
    $('#searches').appendChild(s);
  });
  on('result', d => {
    gotResult = true;
    state.outlookResult = d;
    setStatus(d.cached ? 'Loaded from recent analysis' : 'Done');
    $('#reasoning').open = false;
    renderOutlook();
  });
  on('failure', d => {
    setStatus('Stopped');
    state.outlookFailure = d;
    if (d.stage === 'data' || !state.outlookData) {
      $('#outlook-result').innerHTML = `<div class="notice warn">Could not build the outlook: ${esc(d.message)}</div>`;
    } else {
      renderOutlook();
    }
  });
  on('done', () => {
    finished = true;
    if (!gotResult && !$('#thinking').textContent) $('#reasoning').classList.add('hidden');
    closeStream();
  });
  es.onerror = () => {
    if (finished) return;
    setStatus('Connection lost');
    closeStream();
  };
}

// Merges the statistical baseline with Claude's forecast (when present) into display rows.
function outlookRows() {
  const ai = state.outlookResult?.forecast;
  const aiById = new Map((ai?.periods || []).map(p => [p.id, p]));
  return state.outlookData.baseline.map(b => {
    const p = aiById.get(b.id);
    if (p) {
      return {
        ...b, source: 'ai',
        high: p.temp_high_c, low: p.temp_low_c, p10: p.temp_high_p10_c, p90: p.temp_high_p90_c,
        anomaly: p.temp_anomaly_c, precip: p.precip_mm, precipPct: p.precip_pct_of_normal,
        probT: { below: p.prob_temp_below, near: p.prob_temp_near, above: p.prob_temp_above },
        probP: { below: p.prob_precip_below, near: p.prob_precip_near, above: p.prob_precip_above },
        confidence: p.confidence, conditions: p.conditions, details: p.details, risks: p.risks || [],
      };
    }
    const x = b.baseline;
    return {
      ...b, source: 'baseline',
      high: x.tmax, low: x.tmin, p10: x.tmaxP10, p90: x.tmaxP90, anomaly: x.tempAnomaly,
      precip: x.precip, precipPct: x.precipPctOfNormal, probT: x.probTemp, probP: x.probPrecip,
      confidence: b.leadDays[0] < 10 ? 'medium' : 'low',
      conditions: baselineConditions(x),
      details: b.sources.climatologyOnly
        ? 'Climatology plus warming trend only — no model data reaches this far.'
        : `Based on ${[b.sources.deterministicForecastDays && 'the 16-day forecast', b.sources.seasonalEnsembleDays && 'the seasonal ensemble', 'climatology and trend'].filter(Boolean).join(', ')}.`,
      risks: [],
    };
  });
}

function baselineConditions(x) {
  const t = x.probTemp.above >= 45 ? 'Warmer' : x.probTemp.below >= 45 ? 'Cooler' : 'Near-normal temperatures';
  const p = x.probPrecip.above >= 42 ? 'wetter' : x.probPrecip.below >= 42 ? 'drier' : '';
  if (t.startsWith('Near')) return p ? `${t}, ${p} than usual` : t;
  return `${t}${p ? ` and ${p}` : ''} than usual`;
}

function renderOutlook() {
  const errorMessage = state.outlookFailure?.message;
  const data = state.outlookData;
  const res = state.outlookResult;
  const ai = res?.forecast;
  const rows = outlookRows();
  const box = $('#outlook-result');

  let notice = '';
  if (errorMessage) {
    notice = `<div class="notice warn"><b>AI analysis unavailable:</b> ${esc(errorMessage)}<br>Showing the statistical baseline (climatology + trend + persistence${data.seasonalAvailable ? ' + seasonal ensemble' : ''}).</div>`;
  } else if (!ai) {
    notice = '<div class="notice">Showing the statistical baseline while Claude analyses the climate drivers…</div>';
  }
  if (!data.seasonalAvailable) {
    notice += '<div class="notice">The seasonal ensemble was unavailable; months beyond the 16-day forecast lean on climatology, trend and persistence.</div>';
  }

  const meta = ai
    ? `<span class="conf ${esc(ai.overall_confidence)}">${esc(ai.overall_confidence)} confidence</span>
       <span>${esc(res.model)} · ${esc(effortLabel(res.effort))} thinking${res.usage?.web_searches ? ` · ${res.usage.web_searches} web searches` : ''}</span>
       <span>· Generated ${new Date(res.generatedAt).toLocaleString()}</span>`
    : `<span>Statistical baseline · normals ${esc(data.normalsPeriod)} · trend ${dT(data.trendPerDecade)}/decade</span>`;

  const question = state.question;
  box.innerHTML = `
    ${notice}
    ${ai ? `<div class="headline">${esc(ai.headline)}</div>` : ''}
    <div class="meta-row">${meta}</div>
    ${ai?.answer ? `<div class="answer"><div class="q">${esc(question || 'Your question')}</div>${paragraphs(ai.answer)}</div>` : ''}
    ${ai ? `<div class="summary">${paragraphs(ai.summary)}</div>` : ''}
    <div class="charts">
      <div class="chart-card">
        <h3>Temperature outlook</h3>
        <div class="legend">
          <span><i style="border-color:var(--series-high)"></i>Avg high</span>
          <span><i class="dash" style="border-color:var(--series-high)"></i>Normal high</span>
          <span><i style="border-color:var(--series-low)"></i>Avg low</span>
          <span><i class="dash" style="border-color:var(--series-low)"></i>Normal low</span>
          <span><i class="band" style="background:var(--series-high)"></i>80% range (high)</span>
        </div>
        <div class="chart" id="temp-chart"></div>
      </div>
      <div class="chart-card">
        <h3>Precipitation outlook</h3>
        <div class="legend">
          <span><i class="bar" style="background:var(--series-precip)"></i>Expected total</span>
          <span><i style="border-color:var(--text-2)"></i>Normal</span>
        </div>
        <div class="chart" id="precip-chart"></div>
      </div>
    </div>
    <details class="table-view"><summary>Show as table</summary>${outlookTable(rows)}</details>
    <div class="periods">${rows.map(periodCard).join('')}</div>
    ${ai ? aiExtras(ai) : ''}
    <div class="method">${ai ? `<b>Method:</b> ${esc(ai.method_notes)} ` : ''}Baseline: 1991–2020 normals from ERA5, a ${dT(data.trendPerDecade)}/decade warming trend, persistence of the last 30 days (${dT(data.recent.last30.tempAnomaly)}), ${data.seasonalAvailable ? 'the ECMWF SEAS5 ensemble, ' : ''}and the 16-day forecast. Tercile probabilities compare each period with its own 1991–2020 distribution; 33% each means no signal.</div>`;

  drawCharts(rows);
}

const effortLabel = e => ({ medium: 'standard', high: 'deep', xhigh: 'extra-deep', max: 'maximum' }[e] || e);

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).filter(Boolean).map(p => `<p>${esc(p.trim())}</p>`).join('');
}

function tercileBar(label, probs, kind) {
  const colors = kind === 'temp'
    ? ['var(--tercile-below)', 'var(--tercile-near)', 'var(--tercile-above)']
    : ['var(--tercile-dry)', 'var(--tercile-near)', 'var(--tercile-wet)'];
  const names = kind === 'temp' ? ['Cooler', 'Near', 'Warmer'] : ['Drier', 'Near', 'Wetter'];
  const vals = [probs.below, probs.near, probs.above];
  return `<div class="tercile">
    <div class="t-label"><b>${label}</b><span>${names.map((n, i) => `${n} ${vals[i]}%`).join(' · ')}</span></div>
    <div class="t-bar" role="img" aria-label="${label}: ${names.map((n, i) => `${n} ${vals[i]} percent`).join(', ')}">
      ${vals.map((v, i) => `<div class="${i === 1 ? 'near' : ''}" style="flex:${Math.max(v, 1)}; background:${colors[i]}">${v >= 18 ? `${v}%` : ''}</div>`).join('')}
    </div></div>`;
}

function periodCard(r) {
  const anomClass = r.anomaly >= 0.5 ? 'warm' : r.anomaly <= -0.5 ? 'cool' : '';
  return `<article class="period">
    <div class="p-head"><span class="p-label">${esc(r.label)}</span><span class="conf ${esc(r.confidence)}" title="Confidence">${esc(r.confidence)}</span></div>
    <div class="p-dates">${fmtRange(r.start, r.end)} · ${r.days} days${r.source === 'baseline' ? ' · baseline' : ''}</div>
    <div class="p-cond">${esc(r.conditions)}</div>
    <div class="p-temps">
      <span class="hi">${T(r.high)}</span><span class="lo">/ ${T(r.low)}</span>
      <span class="anom ${anomClass}">${dT(r.anomaly)} vs normal</span>
    </div>
    <div class="small muted">Normal ${T(r.normal.tmax)} / ${T(r.normal.tmin)} · Precip ${P(r.precip)} (${num(r.precipPct) ? Math.round(r.precipPct) : '–'}% of normal ${P(r.normal.precip)})</div>
    ${tercileBar('Temperature', r.probT, 'temp')}
    ${tercileBar('Precipitation', r.probP, 'precip')}
    <div class="p-details">${esc(r.details)}</div>
    ${r.risks.length ? `<ul>${r.risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  </article>`;
}

function outlookTable(rows) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Period</th><th>Avg high</th><th>Normal</th><th>Avg low</th><th>Normal</th><th>Anomaly</th><th>Precip</th><th>Normal</th><th>Cooler/Near/Warmer</th><th>Drier/Near/Wetter</th><th>Confidence</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${T(r.high)}</td><td>${T(r.normal.tmax)}</td><td>${T(r.low)}</td><td>${T(r.normal.tmin)}</td><td>${dT(r.anomaly)}</td><td>${P(r.precip)}</td><td>${P(r.normal.precip)}</td><td>${r.probT.below}/${r.probT.near}/${r.probT.above}%</td><td>${r.probP.below}/${r.probP.near}/${r.probP.above}%</td><td>${esc(r.confidence)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function aiExtras(ai) {
  const list = (title, items) => (items?.length ? `<div class="list-block"><h3>${title}</h3><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  return `<div class="two-col">
    <div class="list-block"><h3>Key climate drivers</h3><div class="drivers">${(ai.key_drivers || []).map(d => `
      <div class="driver"><div class="d-name">${esc(d.name)}</div><div class="d-state">${esc(d.state)}</div><div class="d-inf">${esc(d.influence)}</div></div>`).join('')}</div></div>
    <div style="display:grid; gap:16px; align-content:start">
      ${list('Planning tips', ai.planning_tips)}
      ${list('What could change this outlook', ai.watch_items)}
      <div class="list-block"><h3>Why this confidence</h3><p class="small" style="color:var(--text-2)">${esc(ai.confidence_explanation)}</p></div>
    </div>
  </div>`;
}

// ── Charts (inline SVG, one y-axis each) ──

const SVG_NS = 'http://www.w3.org/2000/svg';

function drawCharts(rows) {
  drawTempChart($('#temp-chart'), rows);
  drawPrecipChart($('#precip-chart'), rows);
}

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
  const ticks = [];
  const top = Math.ceil(max / step) * step;
  for (let v = Math.floor(min / step) * step; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function chartFrame(container, height) {
  container.innerHTML = '';
  const width = Math.max(container.clientWidth, 260);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' }, container);
  return { svg, width, height, m: { l: 40, r: 40, t: 10, b: 36 } };
}

function xLabels(rows) {
  return rows.map(r => (r.kind === 'week' ? r.label.replace('Week ', 'Wk ') : r.label.replace(/^Rest of /, '').replace(/ \d{4}$/, '')));
}

function drawTempChart(container, rows) {
  const { svg, width, height, m } = chartFrame(container, 240);
  svg.setAttribute('aria-label', 'Temperature outlook chart; values are listed in the table view');
  const vals = rows.flatMap(r => [r.low, r.normal.tmin, r.p10, r.p90, r.normal.tmax, r.high]).map(tVal).filter(num);
  const ticks = niceTicks(Math.min(...vals) - 1, Math.max(...vals) + 1);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const step = (width - m.l - m.r) / rows.length;
  const x = i => m.l + step * (i + 0.5);
  const y = v => m.t + (1 - (tVal(v) - y0) / (y1 - y0)) * (height - m.t - m.b);

  for (const t of ticks) {
    const yy = m.t + (1 - (t - y0) / (y1 - y0)) * (height - m.t - m.b);
    svgEl('line', { x1: m.l, x2: width - m.r, y1: yy, y2: yy, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, svg).textContent = `${t}°`;
  }
  const labels = xLabels(rows);
  const every = Math.ceil(rows.length / Math.max(1, Math.floor((width - m.l - m.r) / 44)));
  labels.forEach((l, i) => {
    if (i % every) return;
    svgEl('text', { x: x(i), y: height - m.b + 18, 'text-anchor': 'middle' }, svg).textContent = l;
  });

  // 80% range band for the average high
  const band = rows.map((r, i) => [x(i), y(r.p90)]).concat(rows.map((r, i) => [x(i), y(r.p10)]).reverse());
  svgEl('path', { d: `M${band.map(p => p.join(',')).join('L')}Z`, fill: 'var(--series-high)', opacity: 0.15 }, svg);

  const line = (key, color, dashed) => {
    const pts = rows.map((r, i) => [x(i), y(key(r))]);
    svgEl('path', {
      d: `M${pts.map(p => p.join(',')).join('L')}`, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(dashed ? { 'stroke-dasharray': '5 4', opacity: 0.8 } : {}),
    }, svg);
    if (!dashed) pts.forEach(([px, py]) => svgEl('circle', { cx: px, cy: py, r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg));
    return pts;
  };
  line(r => r.normal.tmax, 'var(--series-high)', true);
  line(r => r.normal.tmin, 'var(--series-low)', true);
  const hiPts = line(r => r.high, 'var(--series-high)');
  const loPts = line(r => r.low, 'var(--series-low)');
  // Direct labels at the line ends
  svgEl('text', { x: hiPts.at(-1)[0] + 8, y: hiPts.at(-1)[1] + 4 }, svg).textContent = 'High';
  svgEl('text', { x: loPts.at(-1)[0] + 8, y: loPts.at(-1)[1] + 4 }, svg).textContent = 'Low';

  attachCrosshair(container, svg, { rows, x, step, m, height, tooltip: r => [
    ['var(--series-high)', 'Avg high', T(r.high)],
    ['var(--series-high)', 'Normal high', T(r.normal.tmax), true],
    ['var(--series-high)', '80% range', `${T(r.p10)} – ${T(r.p90)}`, false, true],
    ['var(--series-low)', 'Avg low', T(r.low)],
    ['var(--series-low)', 'Normal low', T(r.normal.tmin), true],
  ] });
}

function drawPrecipChart(container, rows) {
  const { svg, width, height, m } = chartFrame(container, 240);
  svg.setAttribute('aria-label', 'Precipitation outlook chart; values are listed in the table view');
  m.r = 12;
  const vals = rows.flatMap(r => [r.precip, r.normal.precip]).map(pVal).filter(num);
  const ticks = niceTicks(0, Math.max(...vals, imperial() ? 0.5 : 10) * 1.05, 4);
  const y1 = ticks[ticks.length - 1];
  const step = (width - m.l - m.r) / rows.length;
  const x = i => m.l + step * (i + 0.5);
  const y = v => m.t + (1 - pVal(v) / y1) * (height - m.t - m.b);
  const unit = imperial() ? '"' : '';

  for (const t of ticks) {
    const yy = m.t + (1 - t / y1) * (height - m.t - m.b);
    svgEl('line', { x1: m.l, x2: width - m.r, y1: yy, y2: yy, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, svg).textContent = `${t}${unit}`;
  }
  const labels = xLabels(rows);
  const every = Math.ceil(rows.length / Math.max(1, Math.floor((width - m.l - m.r) / 40)));
  labels.forEach((l, i) => {
    if (i % every) return;
    svgEl('text', { x: x(i), y: height - m.b + 18, 'text-anchor': 'middle' }, svg).textContent = l;
  });

  const bw = Math.min(28, step - 4);
  const base = height - m.b;
  rows.forEach((r, i) => {
    const top = y(r.precip);
    const h = Math.max(base - top, 0);
    const rad = Math.min(4, h, bw / 2);
    const x0 = x(i) - bw / 2;
    // Rounded top, square base
    svgEl('path', {
      d: `M${x0},${base}V${top + rad}Q${x0},${top} ${x0 + rad},${top}H${x0 + bw - rad}Q${x0 + bw},${top} ${x0 + bw},${top + rad}V${base}Z`,
      fill: 'var(--series-precip)',
    }, svg);
    const ny = y(r.normal.precip);
    svgEl('line', { x1: x0 - 3, x2: x0 + bw + 3, y1: ny, y2: ny, stroke: 'var(--text-2)', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
  });

  attachCrosshair(container, svg, { rows, x, step, m, height, tooltip: r => [
    ['var(--series-precip)', 'Expected', P(r.precip)],
    ['var(--text-2)', 'Normal', P(r.normal.precip)],
    ['var(--tercile-wet)', 'Chance wetter', `${r.probP.above}%`],
    ['var(--tercile-dry)', 'Chance drier', `${r.probP.below}%`],
  ] });
}

// Vertical hairline that snaps to the nearest period, with one tooltip for all series.
function attachCrosshair(container, svg, { rows, x, step, m, height, tooltip }) {
  const hair = svgEl('line', { y1: m.t, y2: height - m.b, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip hidden';
  container.parentElement.appendChild(tip);
  container.parentElement.querySelectorAll('.tooltip').forEach(t => { if (t !== tip) t.remove(); });

  const show = i => {
    const r = rows[i];
    hair.setAttribute('x1', x(i));
    hair.setAttribute('x2', x(i));
    hair.setAttribute('opacity', 1);
    tip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 't';
    title.textContent = `${r.label} · ${fmtRange(r.start, r.end)}`;
    tip.appendChild(title);
    for (const [color, name, value, dashed, band] of tooltip(r)) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="key" style="border-color:${color};${dashed ? 'border-top-style:dashed;' : ''}${band ? 'opacity:.35;border-top-width:8px;' : ''}"></span>`;
      row.append(name);
      const b = document.createElement('b');
      b.textContent = value;
      row.appendChild(b);
      tip.appendChild(row);
    }
    tip.classList.remove('hidden');
    const svgBox = svg.getBoundingClientRect();
    const hostBox = container.parentElement.getBoundingClientRect();
    const scale = svgBox.width / (svg.viewBox.baseVal.width || svgBox.width);
    let left = svgBox.left - hostBox.left + x(i) * scale + 12;
    if (left + tip.offsetWidth > hostBox.width - 4) left -= tip.offsetWidth + 24;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${svgBox.top - hostBox.top + 16}px`;
  };
  const hide = () => { hair.setAttribute('opacity', 0); tip.classList.add('hidden'); };

  svg.addEventListener('pointermove', e => {
    const box = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal.width || box.width) / box.width;
    const px = (e.clientX - box.left) * scale;
    const i = Math.min(rows.length - 1, Math.max(0, Math.floor((px - m.l) / step)));
    show(i);
  });
  svg.addEventListener('pointerleave', hide);
  svg.setAttribute('tabindex', '0');
  let focusIdx = 0;
  svg.addEventListener('focus', () => show(focusIdx));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      focusIdx = (focusIdx + (e.key === 'ArrowRight' ? 1 : -1) + rows.length) % rows.length;
      show(focusIdx);
    }
  });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.outlookData) drawCharts(outlookRows()); }, 150);
});

// ── Boot ──

(async function init() {
  syncUnitButtons();
  try {
    state.config = await getJson('/api/config');
    $('#effort').value = state.config.defaultEffort;
    $('#model-note').textContent = state.config.aiKeyConfigured
      ? `Reasoning model: ${state.config.model} with adaptive thinking`
      : 'ANTHROPIC_API_KEY is not set: you will see the statistical baseline without AI analysis.';
  } catch { /* config is informational only */ }
  const saved = store.get('loc');
  if (saved && num(saved.latitude)) selectLocation(saved);
})();
