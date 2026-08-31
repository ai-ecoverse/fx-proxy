/**
 * Post-deploy smoke test: drives a live deployment over HTTP and says
 * whether it is the thing we think we deployed.
 *
 *   SMOKE_URL=https://eagerly-witty-burro.edgecompute.app node --test scripts/smoke.mjs
 *   AI_GATEWAY_API_KEY=vck_… SMOKE_URL=… node --test scripts/smoke.mjs
 *
 * Node's own runner, and no dependencies at all — it wants `fetch` and
 * `node:test`, both in the runtime since 18. That is the whole point: a
 * post-deploy check should run from anywhere against anything, without
 * installing this project first. `npm ci` is not a prerequisite for
 * asking a URL whether it is healthy.
 *
 * The same file runs against Fastly Compute and Cloudflare Workers. The
 * deployments are built differently and should be indistinguishable to a
 * client, which is the property worth having a test for.
 *
 * Without a gateway key the three checks that reach the model skip and
 * the rest still run: a malformed body is refused before fx starts and
 * before the gateway is called, so those pass a throwaway bearer token
 * and spend nothing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const url = (process.env.SMOKE_URL ?? '').replace(/\/$/, '');
const key = process.env.AI_GATEWAY_API_KEY;

if (!url) {
  console.error('SMOKE_URL is required, e.g.');
  console.error('  SMOKE_URL=https://example.edgecompute.app node --test scripts/smoke.mjs');
  process.exit(2);
}

const noKey = key ? false : 'no gateway key (set AI_GATEWAY_API_KEY)';
const auth = key ? { authorization: `Bearer ${key}` } : {};

// Credentials are resolved before the body is parsed, so the validation
// checks need *a* token to get past the 401 — but not a real one. A
// malformed body is refused before fx starts and before the gateway is
// reached, so this spends nothing and works without a key.
const probeAuth = key ? auth : { authorization: 'Bearer smoke-probe-not-a-key' };

async function call(path, { method = 'GET', body, headers = {}, ms = 20000 } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body,
    signal: AbortSignal.timeout(ms),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not every reply is JSON, and some are event streams */
  }
  return { status: response.status, headers: response.headers, text, json };
}

const turn = (input, extra = {}) =>
  call('/v1/responses', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input, ...extra }),
    ms: 300000,
  });

/** /health is asked for by several tests; ask once. */
let healthPromise;
const health = () => (healthPromise ??= call('/health'));

describe(`fx-proxy at ${url}`, () => {
  test('health answers with the service', async () => {
    const { status, json } = await health();
    assert.equal(status, 200);
    assert.equal(json?.service, 'fx-proxy');
  });

  // The check this file exists for. A stale deployment is alive, answers
  // correctly, and is the wrong build.
  test('the deployment is the Hot Glue build', async () => {
    const { json } = await health();
    assert.equal(json?.agent, 'hotglue', `agent is ${JSON.stringify(json?.agent)}`);
  });

  test('health names a runtime we build for', async () => {
    const { json } = await health();
    assert.ok(
      json?.runtime === 'fastly-compute' || json?.runtime === 'cloudflare-workers',
      `unexpected runtime ${JSON.stringify(json?.runtime)}`,
    );
  });

  test('models agrees with health on the model', async () => {
    const { json: h } = await health();
    const { status, json } = await call('/v1/models');
    assert.equal(status, 200);
    assert.equal(json?.object, 'list');
    assert.equal(json?.data?.[0]?.id, h?.model);
  });

  describe('errors', () => {
    test('CORS preflight answers 204 and allows an origin', async () => {
      const { status, headers } = await call('/v1/responses', { method: 'OPTIONS' });
      assert.equal(status, 204);
      assert.equal(headers.get('access-control-allow-origin'), '*');
    });

    test('an unknown route is 404', async () => {
      assert.equal((await call('/v1/nope')).status, 404);
    });

    test('the wrong method is 405', async () => {
      assert.equal((await call('/v1/models', { method: 'POST', body: '{}' })).status, 405);
    });

    test('a request with no credential is 401', async () => {
      const r = await call('/v1/responses', { method: 'POST', body: JSON.stringify({ input: 'hi' }) });
      assert.equal(r.status, 401);
    });

    // The streaming JSON reader, reached over HTTP: a body that starts
    // well and falls apart must be named, not swallowed.
    test('a truncated body says where it ended', async () => {
      const r = await call('/v1/responses', { method: 'POST', headers: probeAuth, body: '{"input":"hi' });
      assert.equal(r.status, 400);
      assert.equal(
        r.json?.error?.message,
        'request body is not valid JSON: the document ended in the middle of a value',
      );
    });

    test('a bad \\u escape is named', async () => {
      const r = await call('/v1/responses', { method: 'POST', headers: probeAuth, body: '{"input":"a\\u00zz"}' });
      assert.equal(r.status, 400);
      assert.equal(r.json?.error?.message, 'request body is not valid JSON: invalid \\u escape');
    });

    test('a body with no input is 400 on `input`', async () => {
      const r = await call('/v1/responses', { method: 'POST', headers: probeAuth, body: '{}' });
      assert.equal(r.status, 400);
      assert.equal(r.json?.error?.param, 'input');
    });
  });

  describe('the agent', () => {
    test('a plain turn completes', { skip: noKey, timeout: 300000 }, async () => {
      const { json: h } = await health();
      const { status, json, text } = await turn('Reply with exactly one word: banana');
      assert.equal(status, 200, text.slice(0, 300));
      assert.equal(json.object, 'response');
      assert.equal(json.status, 'completed');
      assert.ok(json.output_text?.length > 0, 'no output text');
      assert.equal(json.fx?.agent, 'hotglue');
      assert.equal(json.fx?.runtime, h?.runtime);
      assert.ok(json.fx?.model_requests >= 1, `model_requests=${json.fx?.model_requests}`);
      assert.ok(json.created_at > 1700000000, `created_at=${json.created_at}`);
    });

    // Assert the tool *ran*, never what the model said about it: the
    // wording is the model's business and makes for a flaky test.
    test('a turn calls a host tool', { skip: noKey, timeout: 300000 }, async () => {
      const { status, json, text } = await turn(
        'Search the web for the current stable Zig version, then answer in one sentence.',
      );
      assert.equal(status, 200, text.slice(0, 300));
      const items = (json.output ?? []).map((i) => i.type);
      assert.ok(items.includes('web_search_call'), `items: ${items.join(', ')}`);
      assert.equal(items.at(-1), 'message', `items: ${items.join(', ')}`);
      assert.ok(json.fx?.tool_calls >= 1, `tool_calls=${json.fx?.tool_calls}`);
    });

    test('a streamed turn emits the event sequence', { skip: noKey, timeout: 300000 }, async () => {
      const r = await call('/v1/responses', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ input: 'Count: one two three', stream: true }),
        ms: 300000,
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/event-stream/);
      const events = [...r.text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
      assert.equal(events[0], 'response.created');
      assert.ok(events.includes('response.output_text.delta'), `events: ${events.join(', ')}`);
      assert.equal(events.at(-1), 'response.completed', `events: ${events.join(', ')}`);
    });
  });
});
