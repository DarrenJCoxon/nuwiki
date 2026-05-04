/**
 * WU 034 — NuWiki LLMAdapter acceptance test.
 *
 * Three implementations covered: VertexAILLMAdapter (Tier 2),
 * OpenAICompatibleLLMAdapter (Tier 1 — Ollama / vLLM / OpenRouter / OpenAI
 * itself), and createStubLLMAdapter (tests). Cloud adapters use a mocked
 * HTTP client; no live API calls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  VertexAILLMAdapter,
  OpenAICompatibleLLMAdapter,
  createStubLLMAdapter,
} = await import('../dist/src/llm.js');

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
      text: async () => next.body ?? '',
      json: async () => next.json ?? {},
    };
  };
  return { http, calls };
}

// ---------------------------------------------------------------------------
// § 1  VertexAILLMAdapter
// ---------------------------------------------------------------------------

describe('§1 VertexAILLMAdapter', () => {
  test('defaults to europe-west2 region', async () => {
    const m = mockHttp([{ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }]);
    const a = new VertexAILLMAdapter({
      projectId: 'my-project',
      generationModel: 'gemini-flash-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => 'token',
      http: m.http,
    });
    await a.generate({
      systemPrompt: 'You are helpful',
      userPrompt: 'Hello',
      context: [],
    });
    assert.match(m.calls[0].url, /europe-west2/);
    assert.match(m.calls[0].url, /\/projects\/my-project\/locations\/europe-west2\//);
  });

  test('generate posts correct body and parses response', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: {
        candidates: [{ content: { parts: [{ text: 'Generated text' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    }]);
    const a = new VertexAILLMAdapter({
      projectId: 'p',
      generationModel: 'gemini-flash-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => 't',
      http: m.http,
    });
    const result = await a.generate({
      systemPrompt: 'System',
      userPrompt: 'User question',
      context: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
      temperature: 0.7,
      maxTokens: 256,
    });
    assert.equal(result.content, 'Generated text');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'gemini-flash-3');
    assert.match(m.calls[0].url, /gemini-flash-3:generateContent$/);
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);

    const body = JSON.parse(m.calls[0].init.body);
    assert.equal(body.systemInstruction.parts[0].text, 'System');
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[1].role, 'model'); // assistant maps to 'model' for Gemini
    assert.equal(body.contents[2].parts[0].text, 'User question');
    assert.equal(body.generationConfig.temperature, 0.7);
    assert.equal(body.generationConfig.maxOutputTokens, 256);
  });

  test('embed posts to the configured embedding model and returns Float32Array', async () => {
    const m = mockHttp([{
      ok: true, status: 200,
      json: { predictions: [{ embeddings: { values: [0.1, 0.2, 0.3, 0.4] } }] },
    }]);
    const a = new VertexAILLMAdapter({
      projectId: 'p',
      generationModel: 'gemini-flash-lite-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => 't',
      http: m.http,
    });
    const vec = await a.embed('hello');
    assert.match(m.calls[0].url, /text-embedding-005:predict$/);
    assert.ok(vec instanceof Float32Array);
    assert.equal(vec.length, 4);
    assert.equal(vec[0], Math.fround(0.1));
  });

  test('finish-reason mapping (STOP/MAX_TOKENS/SAFETY)', async () => {
    const m = mockHttp([
      { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }] } },
      { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'MAX_TOKENS' }] } },
      { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'c' }] }, finishReason: 'SAFETY' }] } },
    ]);
    const a = new VertexAILLMAdapter({
      projectId: 'p',
      generationModel: 'gemini-flash-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => 't',
      http: m.http,
    });
    const r1 = await a.generate({ systemPrompt: '', userPrompt: 'a', context: [] });
    const r2 = await a.generate({ systemPrompt: '', userPrompt: 'b', context: [] });
    const r3 = await a.generate({ systemPrompt: '', userPrompt: 'c', context: [] });
    assert.equal(r1.finishReason, 'stop');
    assert.equal(r2.finishReason, 'length');
    assert.equal(r3.finishReason, 'content_filter');
  });

  test('auth token is requested per call', async () => {
    let count = 0;
    const m = mockHttp([
      { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }] } },
      { ok: true, status: 200, json: { predictions: [{ embeddings: { values: [0] } }] } },
    ]);
    const a = new VertexAILLMAdapter({
      projectId: 'p',
      generationModel: 'gemini-flash-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => { count++; return 'token_' + count; },
      http: m.http,
    });
    await a.generate({ systemPrompt: '', userPrompt: 'x', context: [] });
    await a.embed('x');
    assert.equal(count, 2);
  });

  test('non-ok response throws', async () => {
    const m = mockHttp([{ ok: false, status: 500, statusText: 'Internal' }]);
    const a = new VertexAILLMAdapter({
      projectId: 'p',
      generationModel: 'gemini-flash-3',
      embeddingModel: 'text-embedding-005',
      getAuthToken: async () => 't',
      http: m.http,
    });
    await assert.rejects(() => a.generate({ systemPrompt: '', userPrompt: 'x', context: [] }), /500/);
  });
});

// ---------------------------------------------------------------------------
// § 2  OpenAICompatibleLLMAdapter
// ---------------------------------------------------------------------------

describe('§2 OpenAICompatibleLLMAdapter', () => {
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
// § 3  Stub adapter
// ---------------------------------------------------------------------------

describe('§3 createStubLLMAdapter', () => {
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
      /exhausted/
    );
  });
});

// ---------------------------------------------------------------------------
// § 4  Interface conformance
// ---------------------------------------------------------------------------

describe('§4 LLMAdapter conformance', () => {
  test('all three implementations expose generate + embed', () => {
    const adapters = [
      new VertexAILLMAdapter({
        projectId: 'p',
        generationModel: 'gemini-flash-3',
        embeddingModel: 'text-embedding-005',
        getAuthToken: async () => 't',
      }),
      new OpenAICompatibleLLMAdapter({ baseUrl: 'http://x', model: 'm' }),
      createStubLLMAdapter([]),
    ];
    for (const a of adapters) {
      assert.equal(typeof a.generate, 'function', `missing generate on ${a.constructor?.name ?? 'stub'}`);
      assert.equal(typeof a.embed, 'function', `missing embed on ${a.constructor?.name ?? 'stub'}`);
    }
  });
});

console.log('\nWU 034 — LLMAdapter acceptance complete\n');
