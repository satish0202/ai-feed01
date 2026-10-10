// Open-Meteo data access (free, no API key): geocoding, current + 16-day
// forecast, ERA5 history for climatology, and the ECMWF seasonal ensemble.
// All requests are metric; the browser converts for display.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const SEASONAL_URL = 'https://seasonal-api.open-meteo.com/v1/seasonal';

const HISTORY_START = '1991-01-01';

// Simple in-memory TTL cache, keyed by request. Stores the promise so
// concurrent callers share one in-flight fetch; failures are not cached.
const cache = new Map();
const MAX_CACHE_ENTRIES = 500;

function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  const promise = fn();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

async function getJson(url, params, timeoutMs = 20000) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Open-Meteo ${new URL(url).hostname}: ${body.reason || res.statusText || res.status}`);
  }
  return body;
}

const coordKey = (lat, lon) => `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;

function todayIn(timezone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
}

async function geocode(query) {
  return cached(`geo:${query.toLowerCase()}`, 24 * 3600e3, async () => {
    const data = await getJson(GEOCODE_URL, { name: query, count: 8, language: 'en', format: 'json' }, 8000);
    return (data.results || []).map(r => ({
      name: r.name,
      admin1: r.admin1 || null,
      country: r.country || null,
      countryCode: r.country_code || null,
      latitude: r.latitude,
      longitude: r.longitude,
      elevation: r.elevation,
      timezone: r.timezone,
      population: r.population || null,
    }));
  });
}

async function getForecast(lat, lon) {
  return cached(`fc:${coordKey(lat, lon)}`, 10 * 60e3, async () => {
    const data = await getJson(FORECAST_URL, {
      latitude: lat,
      longitude: lon,
      timezone: 'auto',
      forecast_days: 16,
      current: [
        'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation',
        'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
        'dew_point_2m', 'uv_index', 'visibility',
      ].join(','),
      hourly: ['temperature_2m', 'precipitation_probability', 'weather_code', 'is_day'].join(','),
      daily: [
        'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
        'precipitation_probability_max', 'wind_speed_10m_max', 'sunrise', 'sunset', 'uv_index_max',
      ].join(','),
    });
    const d = data.daily;
    return {
      timezone: data.timezone,
      elevation: data.elevation,
      current: data.current,
      hourly: data.hourly,
      daily: {
        time: d.time,
        code: d.weather_code,
        tmax: d.temperature_2m_max,
        tmin: d.temperature_2m_min,
        precip: d.precipitation_sum,
        precipProb: d.precipitation_probability_max,
        windMax: d.wind_speed_10m_max,
        sunrise: d.sunrise,
        sunset: d.sunset,
        uvMax: d.uv_index_max,
      },
    };
  });
}

// ~35 years of daily ERA5 reanalysis: the backbone of normals, trend and anomalies.
async function getHistory(lat, lon, timezone) {
  return cached(`hist:${coordKey(lat, lon)}`, 24 * 3600e3, async () => {
    // ERA5 lags real time by ~5 days
    const end = new Date(Date.now() - 6 * 86400e3).toISOString().slice(0, 10);
    const data = await getJson(ARCHIVE_URL, {
      latitude: lat,
      longitude: lon,
      timezone: timezone || 'auto',
      start_date: HISTORY_START,
      end_date: end,
      daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,snowfall_sum',
    }, 60000);
    const d = data.daily;
    // Trim trailing days that haven't been filled yet
    let n = d.time.length;
    while (n > 0 && d.temperature_2m_max[n - 1] == null) n--;
    return {
      time: d.time.slice(0, n),
      tmax: d.temperature_2m_max.slice(0, n),
      tmin: d.temperature_2m_min.slice(0, n),
      tmean: d.temperature_2m_mean.slice(0, n),
      precip: d.precipitation_sum.slice(0, n),
      snow: d.snowfall_sum ? d.snowfall_sum.slice(0, n) : null,
    };
  });
}

// ECMWF SEAS5 51-member ensemble, ~7 months out. Each member arrives as its
// own key (e.g. temperature_2m_max_member01) next to the control run.
async function getSeasonal(lat, lon, timezone) {
  return cached(`seas:${coordKey(lat, lon)}`, 6 * 3600e3, async () => {
    let lastErr;
    // The maximum horizon has varied between model versions; step down until accepted
    for (const days of [214, 183, 92]) {
      try {
        const data = await getJson(SEASONAL_URL, {
          latitude: lat,
          longitude: lon,
          timezone: timezone || 'auto',
          forecast_days: days,
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
        }, 45000);
        const d = data.daily || {};
        const members = name => Object.keys(d)
          .filter(k => k === name || k.startsWith(`${name}_member`))
          .map(k => d[k]);
        const result = {
          time: d.time || [],
          tmax: members('temperature_2m_max'),
          tmin: members('temperature_2m_min'),
          precip: members('precipitation_sum'),
        };
        if (!result.time.length || !result.tmax.length) throw new Error('Open-Meteo seasonal: empty response');
        return result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  });
}

module.exports = { geocode, getForecast, getHistory, getSeasonal, todayIn };
