# Horizon — Long-Range Weather

A weather app in the spirit of weather.com, built around **long-range forecasting**: 1-month, 3-month, 6-month and 12-month outlooks, reasoned through by Claude with adaptive (deep) thinking.

## Features

**Long-range outlook (the main feature)**
- Horizons: **1 month** (weekly breakdown), **3**, **6** and **12 months** (monthly breakdown)
- For each period: expected average high and low, an 80% range, the departure from normal, expected precipitation versus normal, and **tercile probabilities** (cooler/near/warmer, drier/near/wetter)
- **Deep thinking**: Claude (`claude-opus-5-5`, adaptive thinking) weighs the evidence. You can pick Standard, Deep, Extra deep or Maximum thinking depth, and its reasoning summary streams live into the page
- **Live climate signals**: Claude can optionally search the web for the current ENSO state and official seasonal outlooks (NOAA CPC, BoM, Met Office, …)
- **Ask a question**, e.g. *"Will late December be snowy enough for skiing?"* or *"Best month for an outdoor wedding?"*, and get a direct answer that is honest about how certain anyone can be
- Key climate drivers, planning tips, what could change the outlook, and how confident it is
- Temperature and precipitation charts with hover tooltips, plus a table view

**Everyday weather**
- Location search with autocomplete, or "use my location"
- Current conditions: temperature, feels-like, humidity, wind and gusts, dew point, pressure, UV, cloud cover, visibility, sunrise and sunset, and today's high compared with normal
- Next 24 hours and the next 16 days, with normal highs marked
- Climate at a glance: monthly normals, records, the last 30 and 90 days compared with normal, and the local warming trend
- °C/°F toggle, light and dark themes, works on phones

## How the long-range forecast is built

1. **Data** (from [Open-Meteo](https://open-meteo.com), free, no key needed)
   - About 35 years of daily ERA5 reanalysis (1991 to the present) for the location
   - The ECMWF SEAS5 seasonal ensemble (51 members, about 7 months ahead)
   - The ECMWF 16-day forecast
2. **Statistical baseline** (`lib/climate.js`): 1991–2020 normals, plus the location's linear warming trend, plus persistence of the last 30 days' anomaly (damped with lead time), blended with the seasonal ensemble's anomaly and, for the first 16 days, the deterministic forecast. This gives expected values and tercile probabilities for every period.
3. **AI reasoning** (`lib/ai.js`): Claude gets the baseline and all the evidence behind it. It reasons about which drivers matter for this place and season, can check live ENSO and official outlooks, adjusts the baseline where it has a reason to, and returns a structured forecast through a tool call.

If the AI step is unavailable (for example, no API key), the page still shows the statistical baseline.

> Beyond about two weeks no one can forecast day-to-day weather. Long-range outlooks describe shifts in the odds compared with normal. Use official sources for safety-critical decisions.

## Setup

```bash
cd weather-forecast
npm install
cp .env.example .env
# Add your Anthropic API key to .env
npm start
```

Open `http://localhost:3001`.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Needed for the AI analysis |
| `PORT` | `3001` | Server port |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for the outlook |
| `DEFAULT_EFFORT` | `high` | Default thinking depth: `medium`, `high`, `xhigh` or `max` |

Requests use server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

## Costs

Open-Meteo is free for non-commercial use. Each outlook is one Claude request (more only if the model pauses or needs a retry) with roughly 10k input tokens. Output length grows with the thinking depth you pick, and with web search on it may run up to 5 searches. Finished outlooks are cached for 6 hours for each location, horizon and question.

## API

| Endpoint | Description |
|---|---|
| `GET /api/geocode?q=` | Location search |
| `GET /api/weather?lat=&lon=` | Current conditions, hourly, 16-day forecast and climate normals |
| `GET /api/outlook?lat=&lon=&name=&horizon=1\|3\|6\|12&effort=&web=1&units=&question=` | Long-range outlook as Server-Sent Events: `status`, `data` (baseline), `thinking`, `search`, `result`, `failure`, `done` |

## Tests

```bash
npm test
```

The tests check the climate statistics (normals, trend recovery, period building, baseline blending, probability handling) against synthetic data, so they need no network access.
