/**
 * `@nusoft/nuwiki/llm` — `LLMAdapter` reference implementations.
 *
 * Two production references plus a deterministic test stub. The pair covers
 * the operational topology described in
 * `nuos/docs/LOCAL-MODELS-FOR-SENSIGHT.md`:
 *
 * - `VertexAILLMAdapter` — Tier 2 cloud / frontier reasoning. UK-resident
 *   region by default (`europe-west2`). Model-agnostic: the consumer names
 *   the current Gemini generation (Flash 3 / Flash Lite 3 / Pro 3 / etc.)
 *   and the current Vertex embedding model at deployment time.
 * - `OpenAICompatibleLLMAdapter` — Tier 1 local, or anything else exposing
 *   the OpenAI completion shape. Works against Ollama, vLLM, OpenRouter,
 *   any compatible endpoint. Tier 0 (Phi-3 on a laptop CPU) is also reachable
 *   through this adapter when served via Ollama or llama-server.
 * - `createStubLLMAdapter(scripted)` — deterministic test adapter.
 *
 * Adapters do not bundle provider SDKs. Each accepts a generic HTTP client
 * (`HttpClient`) so consumers wire their preferred fetch implementation, and
 * a per-call `getAuthToken()` so tokens can rotate without restarting the runtime.
 */

import type { LLMAdapter, LLMGenerationRequest, LLMGenerationResult } from './adapters.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

const defaultHttp: HttpClient = (url, init) => fetch(url, init);

// ---------------------------------------------------------------------------
// Vertex AI adapter (Tier 2 — frontier cloud, UK-resident by default)
// ---------------------------------------------------------------------------

export interface VertexAIConfig {
  /** GCP project ID. */
  projectId: string;
  /** Vertex region. Defaults to `europe-west2` (London) for UK data residency. */
  region?: string;
  /**
   * Generation model — required. The Vertex / Gemini lineup turns over every
   * few months; the adapter is deliberately model-agnostic so it does not rot.
   * The consumer names the current generation at deployment time
   * (e.g. `gemini-flash-3`, `gemini-flash-lite-3`, `gemini-pro-3`, or whatever
   * the live model IDs are when this is wired up).
   */
  generationModel: string;
  /**
   * Embedding model — required. Same reasoning as `generationModel`: the
   * embedding lineup also evolves. Pick whatever Vertex currently exposes in
   * your region (e.g. `text-embedding-005`, `text-embedding-large-exp-03-07`,
   * etc.).
   */
  embeddingModel: string;
  /** Returns a fresh OAuth bearer token. Called per request. */
  getAuthToken: () => Promise<string>;
  /** HTTP client. Defaults to `globalThis.fetch`. */
  http?: HttpClient;
  /** Vertex API endpoint. Defaults to the regional endpoint. */
  endpoint?: string;
}

export class VertexAILLMAdapter implements LLMAdapter {
  readonly #config: VertexAIConfig;
  readonly #http: HttpClient;
  readonly #region: string;
  readonly #endpoint: string;

  constructor(config: VertexAIConfig) {
    this.#config = config;
    this.#http = config.http ?? defaultHttp;
    this.#region = config.region ?? 'europe-west2';
    this.#endpoint =
      config.endpoint ?? `https://${this.#region}-aiplatform.googleapis.com/v1`;
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#config.getAuthToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async generate(request: LLMGenerationRequest): Promise<LLMGenerationResult> {
    const model = this.#config.generationModel;
    const url = `${this.#endpoint}/projects/${this.#config.projectId}/locations/${this.#region}/publishers/google/models/${model}:generateContent`;
    const contents = [
      ...request.context.map((c) => ({
        role: c.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: c.content }],
      })),
      { role: 'user', parts: [{ text: request.userPrompt }] },
    ];
    const body = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      },
    };
    const res = await this.#http(url, {
      method: 'POST',
      headers: await this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vertex generate failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as VertexGenerateResponse;
    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts?.[0]?.text ?? '';
    return {
      content,
      finishReason: mapVertexFinishReason(candidate?.finishReason),
      model,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount ?? 0,
            completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }

  async embed(text: string): Promise<Float32Array> {
    const model = this.#config.embeddingModel;
    const url = `${this.#endpoint}/projects/${this.#config.projectId}/locations/${this.#region}/publishers/google/models/${model}:predict`;
    const body = { instances: [{ content: text }] };
    const res = await this.#http(url, {
      method: 'POST',
      headers: await this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vertex embed failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as VertexEmbedResponse;
    const values = data.predictions?.[0]?.embeddings?.values ?? [];
    return new Float32Array(values);
  }
}

interface VertexGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface VertexEmbedResponse {
  predictions?: Array<{ embeddings?: { values?: number[] } }>;
}

function mapVertexFinishReason(reason?: string): LLMGenerationResult['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    default:
      return reason ? 'error' : 'stop';
  }
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
