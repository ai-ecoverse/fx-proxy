#!/usr/bin/env node
/**
 * Post-deploy smoke test: drives a live deployment over HTTP and says
 * whether it is the thing we think we deployed.
 *
 *   node scripts/smoke.mjs https://eagerly-witty-burro.edgecompute.app
 *   node scripts/smoke.mjs $URL --key vck_…      # + the checks that spend
 *
 * Dependency-free on purpose: the container that runs this needs a node
 * image and one file, nothing installed, nothing locked. The same script
 * runs against Fastly Compute and Cloudflare Workers — the deployments
 * differ in how they are built and in nothing a client can see, which is
 * the property worth having a test for.
 *
 * Without a gateway key it runs only the free checks. Those are the ones
 * that catch the failure this was written after: a deployment that is
 * alive, answers correctly, and is *the wrong build* — production
 * answering `"agent": "fx"` long after the Hot Glue rewrite shipped.
 *
 * Exit 0 if every check passed, 1 otherwise.
 */

const args = process.argv.slice(2);
const url = (args.find((a) => !a.startsWith('--')) ?? process.env.SMOKE_URL ?? '').replace(/\/$/, '');
const keyArg = args.indexOf('--key');
const key = keyArg >= 0 ? args[keyArg + 1] : process.env.AI_GATEWAY_API_KEY;
const quiet = args.includes('--quiet');

if (!url) {
  console.error('usage: node scripts/smoke.mjs <url> [--key <gateway key>]');
  console.error('   or: SMOKE_URL=<url> node scripts/smoke.mjs');
  process.exit(2);
}

const results = [];
let failures = 0;

function ok(cond, name, detail) {
  if (cond) {
    results.push({ name, pass: true });
    if (!quiet) console.log(`ok   ${name}`);
  } else {
    failures++;
    results.push({ name, pass: false, detail });
    console.log(`FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
  return cond;
}

function skip(name, why) {
  results.push({ name, skip: true });
  if (!quiet) console.log(`skip ${name} — ${why}`);
}

/** fetch with a deadline; agent turns are slow and that is not a failure. */
async function get(path, { method = 'GET', body, headers = {}, ms = 20000 } = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    const response = await fetch(url + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body,
      signal: control.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* not every reply is JSON, and some are event streams */
    }
    return { status: response.status, headers: response.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

const auth = key ? { authorization: `Bearer ${key}` } : {};

// Credentials are resolved before the body is parsed, so the validation
// checks need *a* token to get past the 401 — but not a real one. A
// malformed body is refused before fx starts and before the gateway is
// called, so this spends nothing and works without a key.
const probeAuth = key ? auth : { authorization: 'Bearer smoke-probe-not-a-key' };
const turn = (input, extra = {}) =>
  get('/v1/responses', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input, ...extra }),
    ms: 300000,
  });

console.log(`smoke: ${url}`);

// ---------------------------------------------------------------- shape

const health = await get('/health');
ok(health.status === 200, 'health answers 200', `got ${health.status}`);

const h = health.json ?? {};
ok(h.service === 'fx-proxy', 'health names the service', `got ${JSON.stringify(h.service)}`);

// The check this file exists for. Both deployments run the Hot Glue
// build; anything else is a stale deploy wearing a working endpoint.
ok(h.agent === 'hotglue', 'the deployment is the Hot Glue build', `agent is ${JSON.stringify(h.agent)}, expected "hotglue"`);

const runtime = h.runtime;
ok(
  runtime === 'fastly-compute' || runtime === 'cloudflare-workers',
  'health names a runtime we build for',
  `got ${JSON.stringify(runtime)}`,
);
console.log(`     runtime=${runtime} model=${h.model} search=${h.search_provider}`);

const models = await get('/v1/models');
ok(models.status === 200 && models.json?.object === 'list', 'models lists the default model', `got ${models.status}`);
ok(models.json?.data?.[0]?.id === h.model, 'models agrees with health on the model');

// --------------------------------------------------------------- errors

const preflight = await get('/v1/responses', { method: 'OPTIONS' });
ok(preflight.status === 204, 'CORS preflight answers 204', `got ${preflight.status}`);
ok(
  (preflight.headers.get('access-control-allow-origin') ?? '') === '*',
  'CORS preflight allows an origin',
);

const missing = await get('/v1/nope');
ok(missing.status === 404, 'an unknown route is 404', `got ${missing.status}`);

const wrongMethod = await get('/v1/models', { method: 'POST', body: '{}' });
ok(wrongMethod.status === 405, 'the wrong method is 405', `got ${wrongMethod.status}`);

const noCreds = await get('/v1/responses', { method: 'POST', body: JSON.stringify({ input: 'hi' }) });
ok(noCreds.status === 401, 'a request with no credential is 401', `got ${noCreds.status}`);

// The streaming JSON reader, reached over HTTP: a body that starts well
// and falls apart must be named, not swallowed.
const truncated = await get('/v1/responses', { method: 'POST', headers: probeAuth, body: '{"input":"hi' });
ok(truncated.status === 400, 'a truncated body is 400', `got ${truncated.status}`);
ok(
  truncated.json?.error?.message === 'request body is not valid JSON: the document ended in the middle of a value',
  'a truncated body says where it ended',
  `got ${JSON.stringify(truncated.json?.error?.message)}`,
);

const badEscape = await get('/v1/responses', { method: 'POST', headers: probeAuth, body: '{"input":"a\\u00zz"}' });
ok(
  badEscape.json?.error?.message === 'request body is not valid JSON: invalid \\u escape',
  'a bad \\u escape is named',
  `got ${JSON.stringify(badEscape.json?.error?.message)}`,
);

const noInput = await get('/v1/responses', { method: 'POST', headers: probeAuth, body: '{}' });
ok(noInput.status === 400 && noInput.json?.error?.param === 'input', 'a body with no input is 400 on `input`');

// ----------------------------------------------------------- the agent
// These spend tokens, so they need a key and are skipped without one.

if (!key) {
  skip('a plain turn completes', 'no gateway key');
  skip('a turn calls a host tool', 'no gateway key');
  skip('a streamed turn emits the event sequence', 'no gateway key');
} else {
  const plain = await turn('Reply with exactly one word: banana');
  if (ok(plain.status === 200, 'a plain turn completes', `got ${plain.status}: ${plain.text.slice(0, 200)}`)) {
    const d = plain.json ?? {};
    ok(d.object === 'response' && d.status === 'completed', 'the turn reports itself completed');
    ok(typeof d.output_text === 'string' && d.output_text.length > 0, 'the turn produced output text');
    ok(d.fx?.agent === 'hotglue' && d.fx?.runtime === runtime, 'the fx block agrees with health');
    ok(d.fx?.model_requests >= 1, 'the turn reached the model', `model_requests=${d.fx?.model_requests}`);
    ok(Number.isInteger(d.created_at) && d.created_at > 1700000000, 'the turn carries a real timestamp', `created_at=${d.created_at}`);
  }

  // Assert the tool *ran*, never what the model said about it: the
  // wording is the model's business and makes for a flaky test.
  const tooled = await turn('Search the web for the current stable Zig version, then answer in one sentence.');
  if (ok(tooled.status === 200, 'a turn calls a host tool', `got ${tooled.status}: ${tooled.text.slice(0, 200)}`)) {
    const items = (tooled.json?.output ?? []).map((i) => i.type);
    ok(items.includes('web_search_call'), 'the turn emitted a web_search_call item', `items: ${items.join(', ')}`);
    ok(items[items.length - 1] === 'message', 'the turn ended with a message', `items: ${items.join(', ')}`);
    ok((tooled.json?.fx?.tool_calls ?? 0) >= 1, 'the fx block counted the tool call');
  }

  const streamed = await get('/v1/responses', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input: 'Count: one two three', stream: true }),
    ms: 300000,
  });
  if (ok(streamed.status === 200, 'a streamed turn completes', `got ${streamed.status}`)) {
    const ct = streamed.headers.get('content-type') ?? '';
    ok(ct.startsWith('text/event-stream'), 'the stream is an event stream', `content-type: ${ct}`);
    const events = [...streamed.text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    ok(events[0] === 'response.created', 'the stream opens with response.created', `first: ${events[0]}`);
    ok(events.includes('response.output_text.delta'), 'the stream carries text deltas');
    ok(events[events.length - 1] === 'response.completed', 'the stream closes with response.completed', `last: ${events[events.length - 1]}`);
  }
}

// ---------------------------------------------------------------- verdict

const passed = results.filter((r) => r.pass).length;
const skipped = results.filter((r) => r.skip).length;
console.log(`\n${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''} — ${url}`);
process.exit(failures ? 1 : 0);
