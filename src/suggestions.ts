/**
 * Article suggestion engine (WU 043).
 *
 * The LLM reads the existing wiki and new sources via NuVector retrieval,
 * then suggests articles that should exist but don't.
 *
 * Flow:
 *   1. List existing articles in scope (metadata)
 *   2. Retrieve source context from NuVector (retrieveContext)
 *   3. Build LLM prompt (existing articles + sources)
 *   4. Call LLM with structured output schema
 *   5. Parse and filter (drop duplicates)
 */

import type {
  MetadataAdapter,
  NuVectorAdapter,
  LLMAdapter,
} from './adapters.js';
import type {
  ArticleSuggestion,
  DocumentType,
  SourceRef,
  SuggestionScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SuggestionEngineConfig {
  metadata: MetadataAdapter;
  memoryAdapter: NuVectorAdapter;
  llmAdapter: LLMAdapter;
  tenant: string;
  getDocumentType(type: string): DocumentType | undefined;
  now?: () => string;
  idFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LLMSuggestionParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(`NuWiki suggestion: LLM output parse error — ${message}`);
    this.raw = raw;
    this.name = 'LLMSuggestionParseError';
  }
}

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

export const LLM_SUGGESTION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['documentType', 'subject', 'rationale', 'estimatedValue'],
        properties: {
          documentType: { type: 'string' },
          subject: {
            type: 'object',
            required: ['kind', 'id'],
            properties: {
              kind: { type: 'string' },
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
          rationale: { type: 'string' },
          evidenceRefs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'ref'],
              properties: {
                kind: { type: 'string' },
                ref: { type: 'string' },
                citationLabel: { type: 'string' },
              },
            },
          },
          estimatedValue: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSuggestionSystemPrompt(_scope: SuggestionScope): string {
  return `You are a knowledge-base curator for an educational institution.

Your job: review the existing wiki articles and the recent source records, then suggest new articles that should exist but don't.

Rules:
- Only suggest articles where there is clear evidence in the sources.
- Each suggestion must name a documentType, a subject (kind + id), a rationale, and an estimated value (high/medium/low).
- If the evidence is weak or ambiguous, do not suggest.
- If no articles are missing, return an empty suggestions array.

Output strictly as JSON matching the provided schema.`;
}

function formatExistingArticles(articles: Awaited<ReturnType<MetadataAdapter['listArticles']>>): string {
  if (articles.length === 0) return 'No existing articles.';
  const lines = articles.map(
    (a) => `- ${a.documentType} / ${a.subject.kind}:${a.subject.id}${a.subject.label ? ` (${a.subject.label})` : ''}`,
  );
  return `Existing articles (${articles.length}):\n${lines.join('\n')}`;
}

function formatSources(items: { ref: string; kind: string; summary: string }[]): string {
  if (items.length === 0) return 'No source records retrieved.';
  const lines = items.map((it) => `- [${it.kind}] ${it.ref}: ${it.summary}`);
  return `Recent source records (${items.length}):\n${lines.join('\n')}`;
}

function buildSuggestionUserPrompt(
  existingArticles: Awaited<ReturnType<MetadataAdapter['listArticles']>>,
  sources: { ref: string; kind: string; summary: string }[],
): string {
  return `${formatExistingArticles(existingArticles)}

${formatSources(sources)}

What articles should exist but don't? Return JSON.`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseLLMSuggestionOutput(content: string): ArticleSuggestion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new LLMSuggestionParseError(`not valid JSON (${(err as Error).message})`, content);
  }
  if (!raw || typeof raw !== 'object') {
    throw new LLMSuggestionParseError('output is not a JSON object', content);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.suggestions)) {
    throw new LLMSuggestionParseError('missing or invalid suggestions array', content);
  }

  const out: ArticleSuggestion[] = [];
  for (const s of obj.suggestions) {
    if (!s || typeof s !== 'object') continue;
    const sug = s as Record<string, unknown>;

    if (typeof sug.documentType !== 'string') {
      throw new LLMSuggestionParseError('suggestion missing documentType', content);
    }
    if (!sug.subject || typeof sug.subject !== 'object') {
      throw new LLMSuggestionParseError('suggestion missing subject', content);
    }
    const subject = sug.subject as Record<string, unknown>;
    if (typeof subject.kind !== 'string' || typeof subject.id !== 'string') {
      throw new LLMSuggestionParseError('subject missing kind or id', content);
    }
    if (typeof sug.rationale !== 'string') {
      throw new LLMSuggestionParseError('suggestion missing rationale', content);
    }
    const estimatedValue = sug.estimatedValue as string;
    if (!['high', 'medium', 'low'].includes(estimatedValue)) {
      throw new LLMSuggestionParseError(`invalid estimatedValue: ${estimatedValue}`, content);
    }

    const evidenceRefs: SourceRef[] = [];
    if (Array.isArray(sug.evidenceRefs)) {
      for (const ref of sug.evidenceRefs) {
        if (ref && typeof ref === 'object') {
          const r = ref as Record<string, unknown>;
          if (typeof r.kind === 'string' && typeof r.ref === 'string') {
            evidenceRefs.push({
              kind: r.kind as SourceRef['kind'],
              ref: r.ref,
              citationLabel: typeof r.citationLabel === 'string' ? r.citationLabel : undefined,
            });
          }
        }
      }
    }

    out.push({
      documentType: sug.documentType,
      subject: {
        kind: subject.kind,
        id: subject.id,
        label: typeof subject.label === 'string' ? subject.label : undefined,
      },
      rationale: sug.rationale,
      evidenceRefs,
      estimatedValue: estimatedValue as 'high' | 'medium' | 'low',
      suggestedAt: '', // overwritten by orchestrator with real timestamp
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function suggestNewArticles(
  cfg: SuggestionEngineConfig,
  scope: SuggestionScope,
): Promise<ArticleSuggestion[]> {
  // 1. List existing articles in scope
  const existingArticles = await cfg.metadata.listArticles({
    tenant: cfg.tenant,
    documentType: scope.scope === 'documentType' ? scope.documentType : undefined,
    limit: 1000,
  });

  // If scope is 'subject', filter post-list
  const scopedExisting =
    scope.scope === 'subject' && scope.subject
      ? existingArticles.filter(
          (a) => a.subject.kind === scope.subject!.kind && a.subject.id === scope.subject!.id,
        )
      : existingArticles;

  // 2. Retrieve source context from NuVector
  const queryEmbedding = await cfg.llmAdapter.embed(
    'recent records and documents that may need articles',
  );
  const contextResult = await cfg.memoryAdapter.retrieveContext({
    embedding: queryEmbedding,
    tenant: cfg.tenant,
    topK: 50,
  });

  // 3. Build LLM prompt
  const systemPrompt = buildSuggestionSystemPrompt(scope);
  const userPrompt = buildSuggestionUserPrompt(
    scopedExisting,
    contextResult.items.map((it) => ({
      ref: it.ref,
      kind: it.kind,
      summary: it.summary,
    })),
  );

  // 4. Call LLM
  const result = await cfg.llmAdapter.generate({
    systemPrompt,
    userPrompt,
    context: [],
    outputSchema: LLM_SUGGESTION_OUTPUT_SCHEMA,
    maxTokens: 4096,
  });

  // 5. Parse
  const suggestions = parseLLMSuggestionOutput(result.content);

  // 6. Filter out existing articles and stamp suggestedAt
  const existingKeys = new Set(
    scopedExisting.map((a) => `${a.documentType}:${a.subject.kind}:${a.subject.id}`),
  );
  const now = (cfg.now ?? (() => new Date().toISOString()))();
  return suggestions
    .filter((s) => {
      const key = `${s.documentType}:${s.subject.kind}:${s.subject.id}`;
      return !existingKeys.has(key);
    })
    .map((s) => ({ ...s, suggestedAt: now }));
}
