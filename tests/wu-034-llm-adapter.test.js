/**
 * WU 034 — NuWiki LLMAdapter acceptance test.
 *
 * Three implementations covered: ScalewayLLMAdapter (Tier 2 — Scaleway
 * Generative APIs), OpenAICompatibleLLMAdapter (Tier 1 — Ollama / vLLM /
 * OpenRouter / OpenAI itself), and createStubLLMAdapter (tests). Cloud
 * adapters use a mocked HTTP client; no live API calls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  ScalewayLLMAdapter,
  OpenAICompatibleLLMAdapter,
  createStubLLMAdapter,
} = await import('../dist/src/llm.js');

const { parseScalewayCredentialsFromEnv } = await import('../dist/src/scaleway-config.js');

// ---------------------------------------------------------------------------
// HTTP client mock
// ---------------------------------------------------------------------------

function mockHttp(responses) {
  const calls = [];
  const queue = [...responses];
  const http = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { ok: true, status: 200, body: '', json: {} };
    return {
      ok: next.ok,
      status: next.status,
      statusText: next.statusText ?? '',
      headers: next.headers ?? new Headers(),
      text: async () => next.body ?? '',
      json: async () => next.json ?? {},
    };
  };
  return { http, calls };
}

// Scaleway chat completions response shape
function scwChatResponse(content, finishReason = 'stop', model = 'qwen3.5-397b-a17b') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content, reasoning: '' }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// Scaleway embeddings response shape
function scwEmbedResponse(vectors) {
  return {
    object: 'list',
    model: 'qwen3-embedding-8b',
    data: vectors.map((v, i) => ({ object: 'embedding', index: i, embedding: v })),
    usage: { prompt_tokens: vectors.length, total_tokens: vectors.length },
  };
}

// ---------------------------------------------------------------------------
// § 1  ScalewayLLMAdapter — credentials + config
// ---------------------------------------------------------------------------

describe('§1 ScalewayLLMAdapter — credentials and config', () => {
  test('constructor throws if projectId is missing', () => {
    assert.throws(
      () => new ScalewayLLMAdapter({ projectId: '', secretKey: 'sk-test' }),
      /projectId is required/,
    );
  });

  test('constructor throws if secretKey is missing', () => {
    assert.throws(
      () => new ScalewayLLMAdapter({ projectId: 'proj-uuid', secretKey: '' }),
      /secretKey is required/,
    );
  });

  test('parseScalewayCredentialsFromEnv parses valid SCW_* env vars', () => {
    const creds = parseScalewayCredentialsFromEnv({
      SCW_SECRET_KEY: 'my-secret-key',
      SCW_DEFAULT_PROJECT_ID: 'my-project-uuid',
    });
    assert.equal(creds.secretKey, 'my-secret-key');
    assert.equal(creds.projectId, 'my-project-uuid');
  });

  test('parseScalewayCredentialsFromEnv throws with clear message on missing SCW_SECRET_KEY', () => {
    assert.throws(
      () => parseScalewayCredentialsFromEnv({ SCW_DEFAULT_PROJECT_ID: 'my-project-uuid' }),
      /SCW_SECRET_KEY/,
    );
  });

  test('parseScalewayCredentialsFromEnv throws with clear message on missing SCW_DEFAULT_PROJECT_ID', () => {
    assert.throws(
      () => parseScalewayCredentialsFromEnv({ SCW_SECRET_KEY: 'my-secret-key' }),
      /SCW_DEFAULT_PROJECT_ID/,
    );
  });
});

// ---------------------------------------------------------------------------
// § 2  ScalewayLLMAdapter — request construction
// ---------------------------------------------------------------------------

describe('§2 ScalewayLLMAdapter — request construction', () => {
  test('auth header is Bearer <secretKey> on every generate request', async () => {
    const m = mockHttp([{ ok: true, status: 200, json: scwChatResponse('hi') }]);
    const a = new ScalewayLLMAdapter({ projectId: 'proj', secretKey: 'sk-secret', http: m.http });
    await a.generate({ systemPrompt: 'sys', userPrompt: 'usr', context: [] });
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-secret');
  });

  test('auth header is Bearer <secretKey> on every embed request', async () => {
    const m = mockHttp([{ ok: true, status: 200, json: scwEmbedResponse([[0.1, 0.2]]) }]);
    const a = new ScalewayLLMAdapter({ projectId: 'proj', secretKey: 'sk-secret', http: m.http });
    await a.embed('hello');
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-secret');
  });

  test('URL construction — chat completions uses <baseUrl>/<projectId>/v1/chat/completions', async () => {
    const m = mockHttp([{ ok: true, status: 200, json: scwChatResponse('hi') }]);
    const a = new ScalewayLLMAdapter({ projectId: 'my-proj-id', secretKey: 'sk', http: m.http });
    await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    assert.equal(m.calls[0].url, 'https://api.scaleway.ai/my-proj-id/v1/chat/completions');
  });

  test('URL construction — embeddings uses <baseUrl>/<projectId>/v1/embeddings', async () => {
    const m = mockHttp([{ ok: true, status: 200, json: scwEmbedResponse([[0.1]]) }]);
    const a = new ScalewayLLMAdapter({ projectId: 'my-proj-id', secretKey: 'sk', http: m.http });
    await a.embed('hello');
    assert.equal(m.calls[0].url, 'https://api.scaleway.ai/my-proj-id/v1/embeddings');
  });

  test('generate posts correct OpenAI-compatible body and parses response', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: {
        model: 'qwen3.5-397b-a17b',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Generated text', reasoning: 'chain of thought' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const result = await a.generate({
      systemPrompt: 'System',
      userPrompt: 'User question',
      context: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
      temperature: 0.7,
      maxTokens: 256,
    });
    assert.equal(result.content, 'Generated text');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'qwen3.5-397b-a17b');
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);

    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'System');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, 'earlier');
    assert.equal(body.messages[2].role, 'assistant');
    assert.equal(body.messages[2].content, 'reply');
    assert.equal(body.messages[3].role, 'user');
    assert.equal(body.messages[3].content, 'User question');
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 256);
  });

  test('generate ignores the reasoning field — content from message.content only', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: {
        choices: [{
          message: { role: 'assistant', content: 'Final answer', reasoning: 'step 1: ...\nstep 2: ...' },
          finish_reason: 'stop',
        }],
      },
    }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const result = await a.generate({ systemPrompt: '', userPrompt: 'q', context: [] });
    assert.equal(result.content, 'Final answer');
    assert.ok(!result.content.includes('step 1'));
  });

  test('non-retryable non-ok response throws immediately (e.g. 400)', async () => {
    const m = mockHttp([{ ok: false, status: 400, statusText: 'Bad Request', headers: new Headers() }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    await assert.rejects(
      () => a.generate({ systemPrompt: '', userPrompt: 'x', context: [] }),
      /400/,
    );
  });
});

// ---------------------------------------------------------------------------
// § 3  ScalewayLLMAdapter — retry behaviour (WU 094 preserved)
// ---------------------------------------------------------------------------

describe('§3 ScalewayLLMAdapter — retry behaviour', () => {
  test('retryable 429 is retried with backoff; succeeds on retry', async () => {
    const m = mockHttp([
      { ok: false, status: 429, statusText: 'Too Many Requests', headers: new Headers() },
      { ok: true, status: 200, json: scwEmbedResponse([[0.1, 0.2, 0.3]]) },
    ]);
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      baseRetryDelayMs: 1, // keep test fast
    });
    const out = await a.embed('hello');
    assert.equal(out.length, 3);
    assert.equal(m.calls.length, 2);
  });

  test('retryable 5xx is retried; succeeds on retry', async () => {
    const m = mockHttp([
      { ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers() },
      { ok: true, status: 200, json: scwChatResponse('hi') },
    ]);
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      baseRetryDelayMs: 1,
    });
    const result = await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    assert.equal(result.content, 'hi');
    assert.equal(m.calls.length, 2);
  });

  test('retryable 5xx exhausts retries then throws', async () => {
    const m = mockHttp([
      { ok: false, status: 500, statusText: 'Internal', headers: new Headers() },
      { ok: false, status: 500, statusText: 'Internal', headers: new Headers() },
      { ok: false, status: 500, statusText: 'Internal', headers: new Headers() },
    ]);
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      maxRetries: 2, // 1 initial + 2 retries = 3 attempts
      baseRetryDelayMs: 1,
    });
    await assert.rejects(
      () => a.generate({ systemPrompt: '', userPrompt: 'x', context: [] }),
      /500/,
    );
    assert.equal(m.calls.length, 3);
  });

  test('Retry-After header respected — overrides exponential backoff delay', async () => {
    let callTimestamps = [];
    const m = {
      calls: [],
      http: async (url, init = {}) => {
        m.calls.push({ url, init });
        callTimestamps.push(Date.now());
        if (m.calls.length === 1) {
          // First call: 429 with Retry-After: 0 (use 0 to keep test fast)
          const headers = new Headers({ 'retry-after': '0' });
          return { ok: false, status: 429, statusText: 'Too Many Requests', headers, json: async () => ({}), text: async () => '' };
        }
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => scwChatResponse('ok'),
          text: async () => '',
        };
      },
    };
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      baseRetryDelayMs: 10000, // would make test slow if not overridden by Retry-After
    });
    const result = await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    assert.equal(result.content, 'ok');
    assert.equal(m.calls.length, 2);
  });

  test('Retry-After non-zero value: waitMs = retryAfterSec * 1000 (math verification)', async () => {
    // The implementation branches: retryAfterSec > 0 → waitMs = retryAfterSec * 1000.
    // Use Retry-After: 1 with a very short baseRetryDelayMs so we can distinguish
    // which branch fires by measuring elapsed time (should be ≥ 1000ms, not ~ 0ms).
    // We collect timestamps to verify the Retry-After branch was used.
    const callTimestamps = [];
    const m = {
      calls: [],
      http: async (url, init = {}) => {
        m.calls.push({ url, init });
        callTimestamps.push(Date.now());
        if (m.calls.length === 1) {
          const headers = new Headers({ 'retry-after': '1' }); // 1 second
          return { ok: false, status: 429, statusText: 'Too Many Requests', headers, json: async () => ({}), text: async () => '' };
        }
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => scwChatResponse('retry-after-nonzero'),
          text: async () => '',
        };
      },
    };
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      baseRetryDelayMs: 1, // 1ms base — if branch falls to exponential, wait ≈ 1ms not 1000ms
    });
    const t0 = Date.now();
    const result = await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    const elapsed = Date.now() - t0;
    assert.equal(result.content, 'retry-after-nonzero');
    assert.equal(m.calls.length, 2);
    // The Retry-After: 1 branch waits ≥ 1000ms; the exponential branch with
    // baseRetryDelayMs=1 waits ~1ms. Verify we waited at least 900ms.
    assert.ok(elapsed >= 900, `Expected elapsed ≥ 900ms (Retry-After branch), got ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// § 4  ScalewayLLMAdapter — embedBatch behaviour (WU 094 preserved)
// ---------------------------------------------------------------------------

describe('§4 ScalewayLLMAdapter — embedBatch', () => {
  test('embedBatch sends a single request with input array', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: scwEmbedResponse([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]),
    }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const out = await a.embedBatch(['a', 'b', 'c']);
    assert.equal(m.calls.length, 1);
    assert.equal(out.length, 3);
    assert.ok(out[0] instanceof Float32Array);
    const body = JSON.parse(m.calls[0].init.body);
    assert.deepEqual(body.input, ['a', 'b', 'c']);
  });

  test('embedBatch passes dimensions: 1024 to the endpoint (Matryoshka per D071)', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: scwEmbedResponse([[0.1, 0.2]]),
    }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    await a.embedBatch(['hello']);
    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.dimensions, 1024);
  });

  test('embeddingDimensions config override is passed through', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: scwEmbedResponse([[0.1]]),
    }]);
    const a = new ScalewayLLMAdapter({
      projectId: 'p', secretKey: 'sk', http: m.http,
      embeddingDimensions: 512,
    });
    await a.embedBatch(['hello']);
    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.dimensions, 512);
  });

  test('embedBatch chunks at 100 instances per request (250 texts → 3 requests)', async () => {
    const responses = [
      { ok: true, status: 200, json: scwEmbedResponse(Array.from({ length: 100 }, (_, i) => [i])) },
      { ok: true, status: 200, json: scwEmbedResponse(Array.from({ length: 100 }, (_, i) => [100 + i])) },
      { ok: true, status: 200, json: scwEmbedResponse(Array.from({ length: 50 }, (_, i) => [200 + i])) },
    ];
    const m = mockHttp(responses);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const out = await a.embedBatch(texts);
    assert.equal(m.calls.length, 3);
    // Verify chunk sizes
    assert.equal(JSON.parse(m.calls[0].init.body).input.length, 100);
    assert.equal(JSON.parse(m.calls[1].init.body).input.length, 100);
    assert.equal(JSON.parse(m.calls[2].init.body).input.length, 50);
    assert.equal(out.length, 250);
  });

  test('embedBatch returns ordered Float32Arrays matching input order', async () => {
    // Response deliberately returns indices in reverse order to verify sort
    const m = mockHttp([{
      ok: true, status: 200,
      json: {
        object: 'list',
        model: 'qwen3-embedding-8b',
        data: [
          { object: 'embedding', index: 2, embedding: [0.5, 0.6] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
        ],
      },
    }]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const out = await a.embedBatch(['a', 'b', 'c']);
    assert.equal(out.length, 3);
    assert.equal(out[0][0], Math.fround(0.1)); // index 0
    assert.equal(out[1][0], Math.fround(0.3)); // index 1
    assert.equal(out[2][0], Math.fround(0.5)); // index 2
  });
});

// ---------------------------------------------------------------------------
// § 5  ScalewayLLMAdapter — finish-reason mapping
// ---------------------------------------------------------------------------

describe('§5 ScalewayLLMAdapter — finish-reason mapping', () => {
  test('finish-reason mapping: stop/length/tool_calls/content_filter', async () => {
    const m = mockHttp([
      { ok: true, status: 200, json: { choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'b' }, finish_reason: 'length' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'c' }, finish_reason: 'tool_calls' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'd' }, finish_reason: 'content_filter' }] } },
    ]);
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk', http: m.http });
    const r1 = await a.generate({ systemPrompt: '', userPrompt: 'a', context: [] });
    const r2 = await a.generate({ systemPrompt: '', userPrompt: 'b', context: [] });
    const r3 = await a.generate({ systemPrompt: '', userPrompt: 'c', context: [] });
    const r4 = await a.generate({ systemPrompt: '', userPrompt: 'd', context: [] });
    assert.equal(r1.finishReason, 'stop');
    assert.equal(r2.finishReason, 'length');
    assert.equal(r3.finishReason, 'tool_call');
    assert.equal(r4.finishReason, 'content_filter');
  });
});

// ---------------------------------------------------------------------------
// § 6  OpenAICompatibleLLMAdapter
// ---------------------------------------------------------------------------

describe('§6 OpenAICompatibleLLMAdapter', () => {
  test('generate posts to /chat/completions with messages array', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: {
        model: 'qwen3.6:27b',
        choices: [{ message: { content: 'Generated' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      },
    }]);
    const a = new OpenAICompatibleLLMAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.6:27b',
      http: m.http,
    });
    const result = await a.generate({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      context: [{ role: 'user', content: 'earlier' }],
      temperature: 0.5,
      maxTokens: 128,
    });
    assert.equal(m.calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(m.calls[0].init.method, 'POST');
    assert.equal(result.content, 'Generated');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'qwen3.6:27b');
    assert.equal(result.usage.promptTokens, 8);

    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.model, 'qwen3.6:27b');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'sys');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, 'earlier');
    assert.equal(body.messages[2].role, 'user');
    assert.equal(body.messages[2].content, 'usr');
    assert.equal(body.temperature, 0.5);
    assert.equal(body.max_tokens, 128);
  });

  test('local Ollama works without auth token', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
    }]);
    const a = new OpenAICompatibleLLMAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.6:27b',
      http: m.http,
    });
    await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    assert.equal(m.calls[0].init.headers.Authorization, undefined);
  });

  test('OpenRouter / OpenAI-style endpoint with auth token', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
    }]);
    const a = new OpenAICompatibleLLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.3-8b',
      getAuthToken: async () => 'sk-test',
      http: m.http,
    });
    await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-test');
  });

  test('embed posts to /embeddings and parses response', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
    }]);
    const a = new OpenAICompatibleLLMAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.6:27b',
      embeddingModel: 'nomic-embed-text',
      http: m.http,
    });
    const vec = await a.embed('hello');
    assert.equal(m.calls[0].url, 'http://localhost:11434/v1/embeddings');
    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.model, 'nomic-embed-text');
    assert.equal(body.input, 'hello');
    assert.ok(vec instanceof Float32Array);
    assert.equal(vec.length, 3);
  });

  test('embed throws if embeddingModel not configured', async () => {
    const m = mockHttp([]);
    const a = new OpenAICompatibleLLMAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3.6:27b',
      http: m.http,
    });
    await assert.rejects(() => a.embed('hello'), /embeddingModel not configured/);
  });

  test('finish-reason mapping (stop/length/tool_calls/content_filter)', async () => {
    const m = mockHttp([
      { ok: true, status: 200, json: { choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'b' }, finish_reason: 'length' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'c' }, finish_reason: 'tool_calls' }] } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'd' }, finish_reason: 'content_filter' }] } },
    ]);
    const a = new OpenAICompatibleLLMAdapter({ baseUrl: 'http://x/v1', model: 'm', http: m.http });
    const r1 = await a.generate({ systemPrompt: '', userPrompt: 'a', context: [] });
    const r2 = await a.generate({ systemPrompt: '', userPrompt: 'b', context: [] });
    const r3 = await a.generate({ systemPrompt: '', userPrompt: 'c', context: [] });
    const r4 = await a.generate({ systemPrompt: '', userPrompt: 'd', context: [] });
    assert.equal(r1.finishReason, 'stop');
    assert.equal(r2.finishReason, 'length');
    assert.equal(r3.finishReason, 'tool_call');
    assert.equal(r4.finishReason, 'content_filter');
  });
});

// ---------------------------------------------------------------------------
// § 7  Stub adapter
// ---------------------------------------------------------------------------

describe('§7 createStubLLMAdapter', () => {
  test('returns scripted responses in order', async () => {
    const stub = createStubLLMAdapter([
      { content: 'first' },
      { content: 'second', model: 'qwen' },
      { embedding: new Float32Array([0.1, 0.2]) },
    ]);
    const r1 = await stub.generate({ systemPrompt: '', userPrompt: 'a', context: [] });
    const r2 = await stub.generate({ systemPrompt: '', userPrompt: 'b', context: [] });
    const v = await stub.embed('text');
    assert.equal(r1.content, 'first');
    assert.equal(r2.content, 'second');
    assert.equal(r2.model, 'qwen');
    assert.equal(v.length, 2);
  });

  test('records calls for assertion', async () => {
    const stub = createStubLLMAdapter([{ content: 'x' }, { embedding: [1, 2] }]);
    await stub.generate({ systemPrompt: 'sys', userPrompt: 'usr', context: [] });
    await stub.embed('hello');
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].kind, 'generate');
    assert.equal(stub.calls[0].request.systemPrompt, 'sys');
    assert.equal(stub.calls[1].kind, 'embed');
    assert.equal(stub.calls[1].text, 'hello');
  });

  test('throws when scripted responses exhausted', async () => {
    const stub = createStubLLMAdapter([{ content: 'a' }]);
    await stub.generate({ systemPrompt: '', userPrompt: 'a', context: [] });
    await assert.rejects(
      () => stub.generate({ systemPrompt: '', userPrompt: 'b', context: [] }),
      /exhausted/,
    );
  });
});

// ---------------------------------------------------------------------------
// § 8  Interface conformance
// ---------------------------------------------------------------------------

describe('§8 LLMAdapter conformance', () => {
  test('all three implementations expose generate + embed', () => {
    const adapters = [
      new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk' }),
      new OpenAICompatibleLLMAdapter({ baseUrl: 'http://x', model: 'm' }),
      createStubLLMAdapter([]),
    ];
    for (const a of adapters) {
      assert.equal(typeof a.generate, 'function', `missing generate on ${a.constructor?.name ?? 'stub'}`);
      assert.equal(typeof a.embed, 'function', `missing embed on ${a.constructor?.name ?? 'stub'}`);
    }
  });

  test('ScalewayLLMAdapter implements optional embedBatch', () => {
    const a = new ScalewayLLMAdapter({ projectId: 'p', secretKey: 'sk' });
    assert.equal(typeof a.embedBatch, 'function');
  });
});

console.log('\nWU 034 — LLMAdapter acceptance complete\n');
