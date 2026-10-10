// Claude long-range forecaster. Claude receives the statistical baseline plus
// all the evidence behind it, reasons with adaptive (deep) thinking, can check
// live climate drivers with web search, and returns its forecast through the
// submit_forecast tool so the result is structured.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORTS = ['medium', 'high', 'xhigh', 'max'];
const MAX_TURNS = 6;

// Created on first use so the server can start (and serve current weather)
// before credentials are configured.
let client;
const getClient = () => (client ||= new Anthropic());

const SYSTEM_PROMPT = `You are a senior long-range forecaster at a seasonal climate prediction centre. You produce sub-seasonal (weeks 2–4) and seasonal (1–12 month) outlooks for a single location.

How skill works at these leads, and how your forecast should reflect it:
- Days 1–7 are deterministic and fairly reliable; days 8–16 lose skill quickly. Beyond ~2 weeks there is no day-to-day skill: forecast shifts in the odds relative to climatology, never specific weather on specific days.
- Monthly and seasonal skill comes from slowly varying drivers: ENSO, sea-surface temperature anomalies near the location, the long-term warming trend, soil moisture and snow cover persistence, the MJO for weeks 2–5, and teleconnections such as the NAO/AO, IOD, PDO and SAM where they matter for this region. Skill is usually higher in the tropics and in winter in the mid-latitudes, and lower in mid-latitude summer and transition seasons.
- Seasonal model ensembles are useful but have drift. The ensemble statistics you receive are raw (not bias-corrected); weigh their anomaly sign and member agreement more than their absolute values.
- Climatology plus trend is a strong baseline. Move away from the statistical baseline only with a reason you can name, and say what it is. Precipitation is harder to predict than temperature, so keep its odds closer to 33/33/33 unless a driver is strong.
- Confidence must fall with lead time. A 12-month outlook rarely deserves "high" confidence.

Your job:
1. Examine the evidence: normals, the warming trend, recent anomalies, the 16-day forecast, the seasonal ensemble, and the statistical baseline for each period.
2. If the web_search tool is available, use it sparingly (a few searches) to check the current state of the drivers that matter for this location: ENSO status and outlook (e.g. NOAA CPC or BoM), and the latest official seasonal outlook from the relevant national meteorological service. Do not search for things the data already answers.
3. Reason about which drivers matter for this location and season, then adjust the baseline for each period.
4. Call submit_forecast exactly once with your final forecast. Give one entry for every period you were given, with the same ids, in order.

Numeric fields are always metric (°C, mm). Write the narrative text in the user's preferred units. Tercile probabilities for each period must each sum to 100. Be specific about this location and season; avoid generic boilerplate. If the user asked a question, answer it directly and honestly in "answer", including how certain anyone can be at that lead time.`;

const PERIOD_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Period id exactly as given' },
    label: { type: 'string' },
    temp_high_c: { type: 'number', description: 'Expected average daily high over the period, °C' },
    temp_low_c: { type: 'number', description: 'Expected average daily low over the period, °C' },
    temp_high_p10_c: { type: 'number', description: '10th percentile of the period-average daily high, °C' },
    temp_high_p90_c: { type: 'number', description: '90th percentile of the period-average daily high, °C' },
    temp_anomaly_c: { type: 'number', description: 'Expected departure of mean temperature from the 1991–2020 normal, °C' },
    precip_mm: { type: 'number', description: 'Expected total precipitation over the period, mm' },
    precip_pct_of_normal: { type: 'number' },
    prob_temp_below: { type: 'integer', description: 'Percent chance the period is in the lower climatological tercile' },
    prob_temp_near: { type: 'integer' },
    prob_temp_above: { type: 'integer' },
    prob_precip_below: { type: 'integer' },
    prob_precip_near: { type: 'integer' },
    prob_precip_above: { type: 'integer' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    conditions: { type: 'string', description: 'A short phrase, e.g. "Milder and drier than usual"' },
    details: { type: 'string', description: '1–3 sentences on what to expect and why' },
    risks: { type: 'array', items: { type: 'string' }, description: 'Notable hazards or opportunities, may be empty' },
  },
  required: [
    'id', 'label', 'temp_high_c', 'temp_low_c', 'temp_high_p10_c', 'temp_high_p90_c', 'temp_anomaly_c',
    'precip_mm', 'precip_pct_of_normal', 'prob_temp_below', 'prob_temp_near', 'prob_temp_above',
    'prob_precip_below', 'prob_precip_near', 'prob_precip_above', 'confidence', 'conditions', 'details', 'risks',
  ],
  additionalProperties: false,
};

const SUBMIT_TOOL = {
  name: 'submit_forecast',
  description: 'Submit the final long-range forecast. Call exactly once, after you have finished reasoning.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One-line headline for the whole outlook' },
      summary: { type: 'string', description: '2–4 short paragraphs separated by blank lines, plain text' },
      overall_confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      confidence_explanation: { type: 'string' },
      key_drivers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'e.g. "El Niño–Southern Oscillation"' },
            state: { type: 'string', description: 'Current state, e.g. "Weak La Niña, fading by spring"' },
            influence: { type: 'string', description: 'What it means for this location and horizon' },
          },
          required: ['name', 'state', 'influence'],
          additionalProperties: false,
        },
      },
      periods: { type: 'array', items: PERIOD_SCHEMA },
      watch_items: { type: 'array', items: { type: 'string' }, description: 'Things that could change the outlook' },
      planning_tips: { type: 'array', items: { type: 'string' }, description: 'Practical advice for this horizon' },
      answer: { type: 'string', description: "Direct answer to the user's question, or empty string if none was asked" },
      method_notes: { type: 'string', description: 'How the evidence was weighed, briefly' },
    },
    required: [
      'headline', 'summary', 'overall_confidence', 'confidence_explanation', 'key_drivers', 'periods',
      'watch_items', 'planning_tips', 'answer', 'method_notes',
    ],
    additionalProperties: false,
  },
};

function buildUserPrompt(ctx) {
  const { question, ...data } = ctx;
  return [
    `Produce a ${ctx.horizon.label} long-range outlook for ${ctx.location.name}.`,
    `Today is ${ctx.today} (local time). The user prefers ${ctx.units === 'imperial' ? 'imperial (°F, inches)' : 'metric (°C, mm)'} units in narrative text.`,
    question
      ? `The user also asks:\n<user_question>\n${question}\n</user_question>`
      : 'The user did not ask a specific question; set "answer" to an empty string.',
    'All evidence follows as JSON. "statisticalBaseline" contains one entry per period you must forecast.',
    `<evidence>\n${JSON.stringify(data)}\n</evidence>`,
  ].join('\n\n');
}

function validateForecast(input, periods) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['tool input is not an object'];
  for (const k of SUBMIT_TOOL.input_schema.required) {
    if (input[k] === undefined) errors.push(`missing field "${k}"`);
  }
  if (!Array.isArray(input.periods)) return [...errors, '"periods" must be an array'];
  const ids = input.periods.map(p => p && p.id);
  const missing = periods.filter(p => !ids.includes(p.id)).map(p => p.id);
  if (missing.length) errors.push(`missing periods: ${missing.join(', ')}`);
  input.periods.forEach((p, i) => {
    for (const k of ['temp_high_c', 'temp_low_c', 'temp_anomaly_c', 'precip_mm']) {
      if (typeof p?.[k] !== 'number' || !Number.isFinite(p[k])) errors.push(`periods[${i}].${k} must be a number`);
    }
  });
  return errors;
}

// Rescales tercile probabilities so each triple sums to 100.
function normalizeProbabilities(forecast) {
  for (const p of forecast.periods) {
    for (const prefix of ['prob_temp_', 'prob_precip_']) {
      const keys = ['below', 'near', 'above'].map(s => prefix + s);
      const vals = keys.map(k => Math.max(0, Number(p[k]) || 0));
      const total = vals.reduce((a, b) => a + b, 0);
      if (!total) {
        keys.forEach(k => { p[k] = k.endsWith('near') ? 34 : 33; });
        continue;
      }
      const scaled = vals.map(v => Math.round((v / total) * 100));
      scaled[1] += 100 - scaled.reduce((a, b) => a + b, 0);
      keys.forEach((k, i) => { p[k] = scaled[i]; });
    }
  }
  return forecast;
}

// Runs the forecast. `emit(event, data)` streams progress to the caller:
//   thinking  { text }            – summarized reasoning as it arrives
//   search    { query }           – a web search Claude ran
//   status    { message }
// Resolves with { forecast, model, usage }.
async function generateForecast(ctx, { effort = 'high', webSearch = true, emit = () => {}, signal } = {}) {
  if (!EFFORTS.includes(effort)) effort = 'high';
  const tools = [SUBMIT_TOOL];
  if (webSearch) tools.unshift({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });

  const messages = [{ role: 'user', content: buildUserPrompt(ctx) }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let model = MODEL;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'auto' },
      messages,
    }, { signal });

    // Track block types by index so we can surface searches as they happen
    const blocks = new Map();
    let message;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          blocks.set(event.index, { type: event.content_block.type, name: event.content_block.name, json: '' });
          if (event.content_block.type === 'tool_use' && event.content_block.name === 'submit_forecast') {
            emit('status', { message: 'Writing the final outlook…' });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') {
            emit('thinking', { text: event.delta.thinking });
          } else if (event.delta.type === 'input_json_delta') {
            const b = blocks.get(event.index);
            if (b && b.type === 'server_tool_use') b.json += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          const b = blocks.get(event.index);
          if (b && b.type === 'server_tool_use' && b.name === 'web_search') {
            try {
              emit('search', { query: JSON.parse(b.json).query });
            } catch {
              emit('search', { query: '(web search)' });
            }
          } else if (b && b.type === 'thinking') {
            emit('thinking', { text: '\n\n' });
          }
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError || signal?.aborted) throw err;
      // Tool input JSON that the stream couldn't parse: re-issue the turn
      if (turn < MAX_TURNS - 1) {
        emit('status', { message: 'Retrying malformed response…' });
        continue;
      }
      throw err;
    }

    model = message.model || model;
    usage.input_tokens += message.usage?.input_tokens || 0;
    usage.output_tokens += message.usage?.output_tokens || 0;
    usage.web_searches += message.usage?.server_tool_use?.web_search_requests || 0;

    if (message.stop_reason === 'refusal') {
      throw new Error('The model declined to produce this forecast.');
    }

    const toolUse = message.content.find(b => b.type === 'tool_use' && b.name === 'submit_forecast');
    if (toolUse) {
      if (message.stop_reason === 'max_tokens') throw new Error('Forecast was cut off before it finished (max_tokens).');
      const errors = validateForecast(toolUse.input, ctx.statisticalBaseline);
      if (!errors.length) return { forecast: normalizeProbabilities(toolUse.input), model, usage };
      emit('status', { message: 'Fixing an incomplete forecast…' });
      messages.push({ role: 'assistant', content: message.content });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: `The forecast was not accepted: ${errors.join('; ')}. Call submit_forecast again with the complete forecast.`,
        }],
      });
      continue;
    }

    if (message.stop_reason === 'max_tokens') throw new Error('Reasoning ran past the output limit (max_tokens).');

    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue; // server tool loop paused; resume as-is
    messages.push({ role: 'user', content: 'Please call submit_forecast now with your final forecast.' });
  }
  throw new Error('The model did not return a forecast.');
}

module.exports = { generateForecast, validateForecast, normalizeProbabilities, MODEL, EFFORTS };
