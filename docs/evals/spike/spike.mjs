// Phase 1 memory spike harness (throwaway; NOT pipeline code).
// Runs one document page through an Ollama VLM with a Zod-derived JSON-schema
// `format`, validates the output, and reports timing. Memory (RSS) is captured
// separately by `ollama ps` in the driver script while the model is resident.
//
// Usage: node spike.mjs <model> <image.png> [--no-image]
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const [, , MODEL, IMAGE, flag] = process.argv;
const NO_IMAGE = flag === '--no-image';
const HOST = 'http://127.0.0.1:11434';

// ---- ADR-0004 extraction contract: DocumentBase + `type` discriminant ------
// A genuine discriminated union (not just an enum) so the spike exercises the
// exact construct ADR-0004 flags as an open question for the grammar compiler.
const ActionItem = z.object({
  text: z.string(),
  due_date: z.string().nullable(), // ISO date or null
});

const Base = {
  summary: z.string(),
  action_items: z.array(ActionItem),
};

const Doc = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bill'),
    ...Base,
    payee: z.string(),
    amount_due: z.string(),
    due_date: z.string().nullable(),
    late_fee: z.string().nullable(),
  }),
  z.object({
    type: z.literal('letter'),
    ...Base,
    sender: z.string(),
    subject: z.string(),
  }),
  z.object({
    type: z.literal('id_document'),
    ...Base,
    id_number: z.string(),
    expiry_date: z.string().nullable(),
  }),
  z.object({
    type: z.literal('unknown'),
    ...Base,
  }),
]);

const jsonSchema = z.toJSONSchema(Doc);

const PROMPT = [
  'You are a document triage assistant. Classify this document into exactly one',
  'type (bill, letter, id_document, or unknown) and extract its fields.',
  'A vehicle-registration renewal notice with an amount due is a `bill`.',
  'Put every deadline or required payment into action_items with its due_date',
  'in ISO 8601 (YYYY-MM-DD). Respond only with JSON matching the schema.',
].join(' ');

const body = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: PROMPT,
      ...(NO_IMAGE ? {} : { images: [readFileSync(IMAGE).toString('base64')] }),
    },
  ],
  format: jsonSchema,
  think: process.env.THINK === '1', // Qwen3-VL is a reasoning model; default OFF so tokens go to JSON, not <think>
  stream: true, // stream so headers return immediately (avoids undici 300s headersTimeout on the tight box)
  options: {
    temperature: 0,
    num_ctx: Number(process.env.NUM_CTX || 4096),
    num_predict: Number(process.env.NUM_PREDICT || -1), // -1 = unbounded (default)
  },
  keep_alive: '5m',
};

const wall0 = process.hrtime.bigint();
let res;
try {
  res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
} catch (e) {
  console.log(JSON.stringify({ model: MODEL, ok: false, stage: 'fetch', error: String(e) }));
  process.exit(2);
}

if (!res.ok) {
  const errText = await res.text();
  console.log(
    JSON.stringify({
      model: MODEL,
      ok: false,
      stage: 'http',
      status: res.status,
      error: errText.slice(0, 800),
    }),
  );
  process.exit(2);
}

// Accumulate the NDJSON stream; the final `done:true` line carries the timing counters.
let content = '';
let thinking = '';
let data = {};
let buf = '';
const dec = new TextDecoder();
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.message?.content) content += j.message.content;
    if (j.message?.thinking) thinking += j.message.thinking;
    if (j.done) data = j;
  }
}
const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;

// Always dump raw model text for diagnosis (constrained decoding can still
// produce truncated / degenerate output).
const slug = MODEL.replace(/[:/]/g, '_');
try {
  writeFileSync(`${slug}.raw.txt`, content);
} catch {}
try {
  if (thinking) writeFileSync(`${slug}.thinking.txt`, thinking);
} catch {}

// Timing from Ollama's own counters (nanoseconds).
const ns = (x) => (typeof x === 'number' ? x : 0);
const tokSec = ns(data.eval_duration) > 0 ? data.eval_count / (ns(data.eval_duration) / 1e9) : null;
const promptTokSec =
  ns(data.prompt_eval_duration) > 0
    ? data.prompt_eval_count / (ns(data.prompt_eval_duration) / 1e9)
    : null;

// Parse-time validation (ADR-0004: constrained decoding guarantees shape, not
// semantics; we still run the Zod validator).
// FINDING: with Qwen3-VL on Ollama 0.32.1 the format-constrained JSON is
// emitted into `message.thinking`, not `message.content`. Try content first,
// then fall back to thinking so we validate the JSON the model actually made.
let parsed = null,
  valid = false,
  validationError = null,
  jsonSource = null;
for (const [src, text] of [
  ['content', content],
  ['thinking', thinking],
]) {
  const t = (text || '').trim();
  if (!t) continue;
  try {
    const p = JSON.parse(t);
    const r = Doc.safeParse(p);
    parsed = p;
    jsonSource = src;
    valid = r.success;
    validationError = r.success ? null : r.error.issues.slice(0, 5);
    break;
  } catch (e) {
    validationError = `JSON.parse(${src}) failed: ${String(e)}`;
  }
}

console.log(
  JSON.stringify(
    {
      model: MODEL,
      ok: true,
      num_ctx: Number(process.env.NUM_CTX || 4096),
      image: NO_IMAGE ? null : IMAGE.split('/').pop(),
      discriminated_union_accepted: true, // if we got here, Ollama compiled the schema's grammar
      wall_ms: Math.round(wallMs),
      load_ms: Math.round(ns(data.load_duration) / 1e6),
      prompt_eval_count: data.prompt_eval_count,
      prompt_tok_per_sec: promptTokSec ? +promptTokSec.toFixed(1) : null,
      eval_count: data.eval_count,
      done_reason: data.done_reason, // "stop" = model emitted end; "length" = hit num_ctx/num_predict
      think: body.think,
      thinking_chars: thinking.length,
      gen_tok_per_sec: tokSec ? +tokSec.toFixed(1) : null,
      total_ms: Math.round(ns(data.total_duration) / 1e6),
      validates_against_zod: valid,
      json_channel: jsonSource, // "content" (expected) or "thinking" (Ollama+Qwen3-VL quirk)
      validation_error: validationError,
      extracted: parsed,
    },
    null,
    2,
  ),
);
