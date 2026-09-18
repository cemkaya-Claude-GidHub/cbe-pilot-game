// netlify/functions/transcribe-flightpack.js
//
// Receives an attached flight pack (or Teclog) as base64 file(s) + a date from the game's
// "Read with Claude" button, sends it to the Claude API with a forced tool call so the reply
// comes back as clean structured JSON (not prose to parse), and returns that JSON to the game.
// The Anthropic API key lives ONLY here as a server-side environment variable — it is never
// sent to, or visible from, the browser.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const FLIGHTPACK_TOOL = {
  name: 'record_flight_day',
  description: "Records a day's stops and legs transcribed from an attached flight pack (OFP/Brief).",
  input_schema: {
    type: 'object',
    properties: {
      tail: { type: 'string' },
      flightNo: { type: 'string' },
      stops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            airport: { type: 'string' },
            phase: { type: 'string', enum: ['preflight', 'turnaround', 'postflight'] },
            label: { type: 'string' },
            baselineMin: { type: 'number' },
            fuelPrice: { type: 'number', description: 'EUR per litre. 0 if genuinely not stated on the Brief — never guess.' },
            toiletPrice: { type: 'number', description: 'EUR. Use 100 as the fallback only if truly not stated.' },
            waterPrice: { type: 'number', description: 'EUR. Use 100 as the fallback only if truly not stated.' },
            gpuPrice: { type: 'number', description: 'EUR. Use 100 as the fallback only if truly not stated.' },
            note: { type: 'string', description: 'Where each figure came from, plus any currency conversion or fallback used.' }
          },
          required: ['airport', 'phase', 'label', 'baselineMin', 'fuelPrice', 'toiletPrice', 'waterPrice', 'gpuPrice', 'note']
        }
      },
      legs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            offBlock: { type: 'string' }, tO: { type: 'string' }, landing: { type: 'string' }, onBlock: { type: 'string' },
            offBlockFuel: { type: 'number' }, tOFuel: { type: 'number' }, landingFuel: { type: 'number' }, onBlockFuel: { type: 'number' },
            refuelQty: { type: 'number' },
            ofpTotal: { type: 'number' },
            ofpSavingsPerKlbs: { type: 'number' },
            burnAdjPer1000: { type: 'number' },
            tankerAllowed: { type: 'boolean' },
            tankerNote: { type: 'string' }
          },
          required: ['from', 'to']
        }
      }
    },
    required: ['stops', 'legs']
  }
};

const TECLOG_TOOL = {
  name: 'record_teclog_actuals',
  description: 'Records actual flown times and fuel readings per leg from an attached Teclog / Journey Log.',
  input_schema: {
    type: 'object',
    properties: {
      legs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            offBlock: { type: 'string' }, tO: { type: 'string' }, landing: { type: 'string' }, onBlock: { type: 'string' },
            offBlockFuel: { type: 'number' }, tOFuel: { type: 'number' }, landingFuel: { type: 'number' }, onBlockFuel: { type: 'number' },
            refuelQty: { type: 'number' }
          },
          required: ['from', 'to']
        }
      }
    },
    required: ['legs']
  }
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, body: 'Server is missing the ANTHROPIC_API_KEY environment variable.' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON body.' }; }

  const { date, files, docType } = payload;
  if (!Array.isArray(files) || files.length === 0) return { statusCode: 400, body: 'No files attached.' };

  const isTeclog = docType === 'teclog';
  const tool = isTeclog ? TECLOG_TOOL : FLIGHTPACK_TOOL;

  const instruction = isTeclog
    ? `Attached is a Teclog / Journey Log for ${date}. Read the ACTUAL flown Off Block, T.O., Landing, On Block times and the actual fuel readings (Off Block, T.O., Landing, On Block, in lbs) for each leg. Derive refuelQty for each leg as the fuel-state jump from the previous leg's On Block fuel to this leg's Off Block fuel (0 for the day's first leg — that uplift isn't derivable this way). Call record_teclog_actuals with one entry per leg, matched by from/to airport codes.`
    : `Attached is a flight pack (OFP/Brief) for ${date}. Transcribe every stop (preflight before leg 1, turnaround between legs, postflight after the last leg) and every leg into the record_flight_day tool. For each stop: fuelPrice in EUR/litre (0 if genuinely not stated — don't guess). toiletPrice/waterPrice/gpuPrice in EUR — convert GBP/USD at a sensible approximate rate and explain it in the note, or use 100 as the fallback only if truly not stated. For each leg: use the OFP's planned/computed figures (times are STD in UTC unless stated otherwise), the OFP TOTAL fuel figure as ofpTotal, the "SAVINGS=xxx(USD) PER KLBS" figure as ofpSavingsPerKlbs, the +1000LBS burn-off-adjustment row as burnAdjPer1000, and tankerAllowed/tankerNote from the OFP remarks (false + the quoted reason if remarks explicitly prohibit tankering, e.g. a restricted Union airport — true otherwise, even if uneconomical). Leave offBlockFuel/tOFuel/landingFuel/onBlockFuel/refuelQty at 0 on this pass — those come from the Teclog, not the OFP. Always explain sources/conversions/fallbacks in each stop's note field.`;

  const content = [{ type: 'text', text: instruction }];
  for (const f of files) {
    if (!f || !f.base64) continue;
    const mime = f.mime || 'application/octet-stream';
    if (mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } });
    else if (mime.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: f.base64 } });
  }

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4096,
        tools: [tool], tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content }]
      })
    });
  } catch (e) {
    return { statusCode: 502, body: 'Could not reach the Claude API: ' + e.message };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { statusCode: resp.status, body: 'Claude API error: ' + errText.slice(0, 500) };
  }

  const data = await resp.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) return { statusCode: 502, body: 'Claude did not return structured data.' };

  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(toolUse.input) };
};
