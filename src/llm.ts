/**
 * `@nusoft/nuwiki/llm` — `LLMAdapter` reference implementations.
 *
 * Two production references plus a deterministic test stub:
 *
 * - `ScalewayLLMAdapter` — Tier 2 cloud / frontier reasoning via Scaleway's
 *   Generative APIs (Paris EU data centre; no US parent company; no data
 *   retention by default). Default models per D069: qwen3.5-397b-a17b for
 *   generation; qwen3-embedding-8b with 1024-dim Matryoshka for embeddings.
 *   Static Bearer auth (SCW_SECRET_KEY); project UUID in the URL path
 *   (SCW_DEFAULT_PROJECT_ID). Preserves WU 094 retry+backoff and embedBatch
 *   chunked-semaphore work.
 * - `OpenAICompatibleLLMAdapter` — Tier 1 local, or anything else exposing
 *   the OpenAI Chat Completions shape. Works against Ollama, vLLM, OpenRouter,
 *   any compatible endpoint.
 * - `createStubLLMAdapter(scripted)` — deterministic test adapter.
 *
 * Adapters do not bundle provider SDKs. Each accepts a generic HTTP client
 * (`HttpClient`) so consumers wire their preferred fetch implementation.
 *
 * @see D068 — Scaleway as backend LLM provider
 * @see D069 — default models by tier
 * @see D070 — semantic-tier abstraction (tier map lives in scaleway-config.ts)
 * @see D071 — 1024-dim Matryoshka embedding default
 */

import type { LLMAdapter, LLMGenerationRequest, LLMGenerationResult } from './adapters.js';
import {
  SCALEWAY_MODELS,
  SCALEWAY_EMBEDDING_DIMENSIONS,
  SCALEWAY_BASE_URL,
} from './scaleway-config.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

const defaultHttp: HttpClient = (url, init) => fetch(url, init);

// ---------------------------------------------------------------------------
// Scaleway adapter (Tier 2 — frontier cloud, EU-resident, OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface ScalewayLLMAdapterConfig {
  /** Scaleway project UUID. From SCW_DEFAULT_PROJECT_ID. */
  projectId: string;
  /** Scaleway secret key (used as Bearer token). From SCW_SECRET_KEY. */
  secretKey: string;
  /** Generation model — defaults to qwen3.5-397b-a17b per D069. */
  generationModel?: string;
  /** Embedding model — defaults to qwen3-embedding-8b per D069. */
  embeddingModel?: string;
  /**
   * Embedding output dimension via Matryoshka truncation. Defaults to 1024
   * per D071. The pgvector index dimensionality is set by this value and
   * cannot be changed without a re-embed (drain-and-refill per D071).
   */
  embeddingDimensions?: number;
  /** API base URL. Defaults to `https://api.scaleway.ai`. */
  baseUrl?: string;
  /** HTTP client. Defaults to globalThis.fetch. */
  http?: HttpClient;
  /**
   * Max concurrent embed requests in flight. Default 4. Scaleway's per-minute
   * rate limits trip easily under unconcurrency-limited Promise.all bursts
   * (a NuWiki seed of 4 articles fires ~30+ embed requests in parallel).
   */
  maxConcurrentEmbeds?: number;
  /**
   * Max retries on 429 / 5xx for both embed and generate. Default 5. Set to 0
   * to disable retries (the adapter then throws on the first transient failure).
   */
  maxRetries?: number;
  /**
   * Base delay (ms) for exponential backoff. Actual wait is
   * `baseRetryDelayMs * 2^attempt + jitter`. Scaleway's `Retry-After` header,
   * when present, takes precedence. Default 1000.
   */
  baseRetryDelayMs?: number;
}

export class ScalewayLLMAdapter implements LLMAdapter {
  readonly #projectId: string;
  readonly #secretKey: string;
  readonly #generationModel: string;
  readonly #embeddingModel: string;
  readonly #embeddingDimensions: number;
  readonly #baseUrl: string;
  readonly #http: HttpClient;
  readonly #maxConcurrentEmbeds: number;
  readonly #maxRetries: number;
  readonly #baseRetryDelayMs: number;
  #embedSlotsAvailable: number;
  #embedWaiters: Array<() => void> = [];

  constructor(config: ScalewayLLMAdapterConfig) {
    if (!config.projectId || config.projectId.trim() === '') {
      throw new Error('ScalewayLLMAdapter: projectId is required');
    }
    if (!config.secretKey || config.secretKey.trim() === '') {
      throw new Error('ScalewayLLMAdapter: secretKey is required');
    }
    this.#projectId = config.projectId;
    this.#secretKey = config.secretKey;
    this.#generationModel = config.generationModel ?? SCALEWAY_MODELS.reasoning;
    this.#embeddingModel = config.embeddingModel ?? SCALEWAY_MODELS.embedding;
    this.#embeddingDimensions = config.embeddingDimensions ?? SCALEWAY_EMBEDDING_DIMENSIONS;
    this.#baseUrl = config.baseUrl ?? SCALEWAY_BASE_URL;
    this.#http = config.http ?? defaultHttp;
    this.#maxConcurrentEmbeds = config.maxConcurrentEmbeds ?? 4;
    this.#maxRetries = config.maxRetries ?? 5;
    this.#baseRetryDelayMs = config.baseRetryDelayMs ?? 1000;
    this.#embedSlotsAvailable = this.#maxConcurrentEmbeds;
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  // Semaphore so a Promise.all over embed() doesn't fire more than
  // maxConcurrentEmbeds requests in parallel.
  async #acquireEmbedSlot(): Promise<void> {
    if (this.#embedSlotsAvailable > 0) {
      this.#embedSlotsAvailable--;
      return;
    }
    await new Promise<void>((resolve) => this.#embedWaiters.push(resolve));
    this.#embedSlotsAvailable--;
  }

  #releaseEmbedSlot(): void {
    this.#embedSlotsAvailable++;
    const next = this.#embedWaiters.shift();
    if (next) next();
  }

  // Retryable POST with exponential backoff on 429 + 5xx. Honours the
  // `Retry-After` header (seconds) when Scaleway sends it.
  async #postWithRetry(
    url: string,
    body: unknown,
    label: 'generate' | 'embed',
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      const res = await this.#http(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.#maxRetries) {
        throw new Error(`Scaleway ${label} failed: ${res.status} ${res.statusText}`);
      }
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      // `Retry-After: 0` is treated as "no useful hint, use exponential backoff"
      // rather than "retry immediately". RFC 7231 does not mandate a literal-zero
      // interpretation; falling through to backoff is at most as permissive and
      // protects the server from a tight retry loop.
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : this.#baseRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
    }
  }

  async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
    const model = this.#generationModel;
    const url = `${this.#baseUrl}/${this.#projectId}/v1/chat/completions`;
    const messages = [
      { role: 'system', content: request.systemPrompt },
      ...request.context.map((c) => ({ role: c.role, content: c.content })),
      { role: 'user', content: request.userPrompt },
    ];
    const body = {
      model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };
    const res = await this.#postWithRetry(url, body, 'generate');
    const data = (await res.json()) as ScalewayGenerateResponse;
    const choice = data.choices?.[0];
    // The `reasoning` field on choice.message carries Qwen3's chain-of-thought.
    // It is not included in the returned content — the LLMAdapter contract is
    // unchanged; callers receive only the visible response text.
    return {
      content: choice?.message?.content ?? '',
      finishReason: mapOpenAIFinishReason(choice?.finish_reason),
      model: data.model ?? model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }

  async embed(text: string): Promise<Float32Array> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  /**
   * Batch embed via Scaleway's embeddings endpoint (OpenAI-compatible).
   * Scaleway accepts both single strings and arrays; we chunk conservatively
   * at 100 to stay well under per-request payload size limits and keep
   * individual retries small.
   *
   * Every request passes `dimensions: <embeddingDimensions>` to activate
   * Matryoshka truncation (default 1024 per D071). Without this parameter
   * the endpoint returns full 4096-dim vectors.
   *
   * Concurrency across chunks is limited by the embed-slot semaphore, so a
   * caller passing 500 texts hits Scaleway with `maxConcurrentEmbeds`
   * simultaneous chunks, not 5 simultaneous chunks.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const model = this.#embeddingModel;
    const url = `${this.#baseUrl}/${this.#projectId}/v1/embeddings`;
    const CHUNK_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      chunks.push(texts.slice(i, i + CHUNK_SIZE));
    }
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        await this.#acquireEmbedSlot();
        try {
          const body = {
            model,
            input: chunk,
            dimensions: this.#embeddingDimensions,
          };
          const res = await this.#postWithRetry(url, body, 'embed');
          const data = (await res.json()) as ScalewayEmbedResponse;
          // Scaleway returns an ordered array with stable `index` fields.
          // Sort by index to guarantee input order is preserved.
          const sorted = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          return sorted.map((d) => new Float32Array(d.embedding ?? []));
        } finally {
          this.#releaseEmbedSlot();
        }
      }),
    );
    return results.flat();
  }
}

interface ScalewayGenerateResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string; reasoning?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ScalewayEmbedResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (Tier 1 local — Ollama, vLLM, OpenRouter, etc.)
// ---------------------------------------------------------------------------

export interface OpenAICompatibleConfig {
  /**
   * Base URL exposing OpenAI-compatible endpoints. Examples:
   * - `http://localhost:11434/v1` (Ollama)
   * - `http://nuos-local:8000/v1` (vLLM on a school-local server)
   * - `https://openrouter.ai/api/v1` (OpenRouter)
   * - `https://api.openai.com/v1` (OpenAI itself)
   */
  baseUrl: string;
  /** Generation model name (e.g. `qwen3.6:27b`, `llama3.3:8b`). */
  model: string;
  /** Embedding model name. Optional — embeddings can be omitted if the deployment uses a separate provider. */
  embeddingModel?: string;
  /** Optional auth token. Local Ollama typically needs none; OpenRouter / OpenAI need one. */
  getAuthToken?: () => Promise<string>;
  http?: HttpClient;
}

export class OpenAICompatibleLLMAdapter implements LLMAdapter {
  readonly #config: OpenAICompatibleConfig;
  readonly #http: HttpClient;

  constructor(config: OpenAICompatibleConfig) {
    this.#config = config;
    this.#http = config.http ?? defaultHttp;
  }

  async #headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#config.getAuthToken) {
      const token = await this.#config.getAuthToken();
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
    const url = `${this.#config.baseUrl}/chat/completions`;
    const messages = [
      { role: 'system', content: request.systemPrompt },
      ...request.context.map((c) => ({ role: c.role, content: c.content })),
      { role: 'user', content: request.userPrompt },
    ];
    const body = {
      model: this.#config.model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };
    const res = await this.#http(url, {
      method: 'POST',
      headers: await this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI-compatible generate failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: mapOpenAIFinishReason(choice?.finish_reason),
      model: data.model ?? this.#config.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.#config.embeddingModel) {
      throw new Error('OpenAICompatibleLLMAdapter: embeddingModel not configured; embed() is unavailable');
    }
    const url = `${this.#config.baseUrl}/embeddings`;
    const body = { model: this.#config.embeddingModel, input: text };
    const res = await this.#http(url, {
      method: 'POST',
      headers: await this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI-compatible embed failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as OpenAIEmbedResponse;
    const values = data.data?.[0]?.embedding ?? [];
    return new Float32Array(values);
  }
}

interface OpenAIChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIEmbedResponse {
  data?: Array<{ embedding?: number[] }>;
}

function mapOpenAIFinishReason(reason?: string): LLMGenerationResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'content_filter':
      return 'content_filter';
    default:
      return reason ? 'error' : 'stop';
  }
}

// ---------------------------------------------------------------------------
// Stub adapter — for tests
// ---------------------------------------------------------------------------

export interface StubLLMScript {
  content?: string;
  embedding?: Float32Array | number[];
  finishReason?: LLMGenerationResult['finishReason'];
  model?: string;
}

export interface StubLLMAdapter extends LLMAdapter {
  /** Records each request and embed call for assertion. */
  readonly calls: Array<
    | { kind: 'generate'; request: LLMGenerationRequest }
    | { kind: 'embed'; text: string }
  >;
}

export function createStubLLMAdapter(scripted: StubLLMScript[]): StubLLMAdapter {
  let i = 0;
  const calls: StubLLMAdapter['calls'] = [];
  const next = (): StubLLMScript => {
    if (i >= scripted.length) throw new Error('Stub LLM exhausted');
    return scripted[i++];
  };
  return {
    calls,
    async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
      calls.push({ kind: 'generate', request });
      const s = next();
      return {
        content: s.content ?? '',
        finishReason: s.finishReason ?? 'stop',
        model: s.model ?? 'stub',
      };
    },
    async embed(text: string): Promise<Float32Array> {
      calls.push({ kind: 'embed', text });
      const s = next();
      if (s.embedding instanceof Float32Array) return s.embedding;
      return new Float32Array(s.embedding ?? []);
    },
  };
}
