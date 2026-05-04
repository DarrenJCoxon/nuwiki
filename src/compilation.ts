/**
 * NuWiki compilation engine (WU 036).
 *
 * The runtime that wires the five adapters (metadata, object storage,
 * NuVector, LLM, database source) into the compile-and-publish flow
 * defined by the NuWiki contract:
 *
 *   1. Resolve source queries
 *   2. Fetch existing article version
 *   3. Build LLM request and parse structured output
 *   4. Compute embeddings
 *   5. Store body in object storage
 *   6. Update metadata
 *   7. Atomic publish-to-NuVector (layers 1–4 + provenance + supersede)
 *
 * Quality / correctness layers go on top in subsequent WUs:
 * - WU 037: token budget enforcement
 * - WU 038: section-summary-prefix invariant
 * - WU 039: citation validation
 * - WU 040: backlink graph forward/back integrity
 * - WU 041: role-aware redaction
 * - WU 042: integrity pass loop
 */

import type {
  DatabaseSourceAdapter,
  LLMAdapter,
  MetadataAdapter,
  NuVectorAdapter,
  ObjectStorageAdapter,
} from './adapters.js';
import type {
  ArticleStatus,
  ArticleWarning,
  CompileRequest,
  CompilationResult,
  DocumentType,
  GenerationTrigger,
  LLMCompilationOutput,
  LLMCompilationOutputCitation,
  LLMCompilationOutputLink,
  LLMCompilationOutputSection,
  NuWikiArticle,
  SourceQuery,
  SubjectRef,
} from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LLMOutputParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(`NuWiki compilation: LLM output parse error — ${message}`);
    this.raw = raw;
    this.name = 'LLMOutputParseError';
  }
}

// ---------------------------------------------------------------------------
// Engine config
// ---------------------------------------------------------------------------

export interface CompilationEngineConfig {
  metadata: MetadataAdapter;
  bodies: ObjectStorageAdapter;
  memoryAdapter: NuVectorAdapter;
  llmAdapter: LLMAdapter;
  databaseSource?: DatabaseSourceAdapter;
  tenant: string;
  /** Resolves a DocumentType by string id. Pulled from the NuWiki runtime registry. */
  getDocumentType(type: string): DocumentType | undefined;
  /** Stable id factory; defaults to a counter-based pseudo id. Tests inject deterministic ids. */
  idFactory?: () => string;
  /** Stable clock; defaults to `() => new Date().toISOString()`. Tests inject a fixed clock. */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// CompilationEngine
// ---------------------------------------------------------------------------

const DEFAULT_VERSION = 'v1';

export class CompilationEngine {
  readonly #cfg: CompilationEngineConfig;
  readonly #now: () => string;
  readonly #id: () => string;
  #idCounter = 0;

  constructor(cfg: CompilationEngineConfig) {
    this.#cfg = cfg;
    this.#now = cfg.now ?? (() => new Date().toISOString());
    this.#id =
      cfg.idFactory ??
      (() => {
        this.#idCounter += 1;
        return `id_${this.#idCounter.toString(36)}_${Date.now().toString(36)}`;
      });
  }

  async compile(request: CompileRequest): Promise<CompilationResult> {
    const startedAt = Date.now();
    const warnings: ArticleWarning[] = [];

    const docType = this.#cfg.getDocumentType(request.documentType);
    if (!docType) {
      return blockedResult({
        articleId: subjectArticleId(request.documentType, request.subject),
        versionId: '',
        warnings: [
          {
            kind: 'compilation_blocked',
            message: `Unknown documentType '${request.documentType}'`,
          },
        ],
        durationMs: Date.now() - startedAt,
      });
    }

    const articleId = subjectArticleId(request.documentType, request.subject);
    const existing = await this.#cfg.metadata.getArticle(articleId);
    const predecessorVersion = existing?.currentVersion;

    // Step 1 — resolve source queries
    let sources: ResolvedSource[];
    try {
      sources = await this.#resolveSources(docType.sourceQueries);
    } catch (err) {
      return blockedResult({
        articleId,
        versionId: '',
        warnings: [
          {
            kind: 'missing_evidence',
            message: `Source resolution failed: ${(err as Error).message}`,
          },
        ],
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 2 — call LLM
    let parsed: LLMCompilationOutput;
    try {
      parsed = await this.#callLLM({
        docType,
        subject: request.subject,
        existing,
        sources,
      });
    } catch (err) {
      const message = (err as Error).message;
      const kind: ArticleWarning['kind'] =
        err instanceof LLMOutputParseError ? 'compilation_blocked' : 'compilation_blocked';
      return blockedResult({
        articleId,
        versionId: '',
        warnings: [{ kind, message: `LLM compilation failed: ${message}` }],
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 3 — compute embeddings
    const llm = this.#cfg.llmAdapter;
    const summaryEmbedding = await llm.embed(parsed.summary);
    const sectionEmbeddings = await Promise.all(
      parsed.sections.map((s) => llm.embed(this.#sectionEmbeddingText(s, parsed.summary))),
    );
    const citationEmbeddings = docType.precisionIndexable
      ? await Promise.all(parsed.citations.map((c) => llm.embed(c.claim)))
      : [];

    // Step 4 — write body to object storage
    const newVersionId = `${request.documentType}/${request.subject.id}/${nextVersion(predecessorVersion)}`;
    const bodyKey = `nuwiki/${this.#cfg.tenant}/${articleId}/${newVersionId}.md`;
    const body = renderMarkdownBody(parsed);
    let bodyRef;
    try {
      bodyRef = await this.#cfg.bodies.put({ key: bodyKey, contentType: 'text/markdown' }, body);
    } catch (err) {
      return blockedResult({
        articleId,
        versionId: newVersionId,
        warnings: [
          {
            kind: 'compilation_blocked',
            message: `Body storage write failed: ${(err as Error).message}`,
          },
        ],
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 5 — write metadata (article + version)
    const compiledAt = this.#now();
    const versionRecord = {
      id: newVersionId,
      articleId,
      version: nextVersion(predecessorVersion),
      bodyRef,
      bodyHash: cheapHash(body),
      publishedAt: compiledAt,
      predecessorVersion,
    };
    try {
      await this.#cfg.metadata.upsertVersion(versionRecord);
      await this.#cfg.metadata.upsertArticle({
        id: articleId,
        tenant: this.#cfg.tenant,
        documentType: request.documentType,
        subject: request.subject,
        path: pathFor(request.documentType, request.subject),
        currentVersion: versionRecord.version,
        status: 'compiling',
        metadata: {},
        createdAt: existing?.createdAt ?? compiledAt,
        updatedAt: compiledAt,
      });
    } catch (err) {
      return blockedResult({
        articleId,
        versionId: newVersionId,
        warnings: [
          {
            kind: 'compilation_blocked',
            message: `Metadata write failed: ${(err as Error).message}`,
          },
        ],
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 6 — atomic publish-to-NuVector
    try {
      await this.#publishToNuVector({
        articleId,
        version: versionRecord.version,
        documentType: docType,
        subject: request.subject,
        compiledAt,
        parsed,
        summaryEmbedding,
        sectionEmbeddings,
        citationEmbeddings,
        sources,
        predecessorVersion,
        trigger: request.trigger,
      });
    } catch (err) {
      // Flip article to blocked. Body + metadata stay (forward-write
      // pragma documented in the WU spec; integrity pass surfaces these).
      try {
        await this.#cfg.metadata.upsertArticle({
          id: articleId,
          tenant: this.#cfg.tenant,
          documentType: request.documentType,
          subject: request.subject,
          path: pathFor(request.documentType, request.subject),
          currentVersion: versionRecord.version,
          status: 'blocked',
          metadata: {},
          createdAt: existing?.createdAt ?? compiledAt,
          updatedAt: this.#now(),
        });
      } catch {
        // Best effort. The publish failure is the primary signal.
      }
      return blockedResult({
        articleId,
        versionId: newVersionId,
        warnings: [
          {
            kind: 'compilation_blocked',
            message: `NuVector publish failed: ${(err as Error).message}`,
          },
        ],
        durationMs: Date.now() - startedAt,
      });
    }

    // Step 7 — flip status to published
    await this.#cfg.metadata.upsertArticle({
      id: articleId,
      tenant: this.#cfg.tenant,
      documentType: request.documentType,
      subject: request.subject,
      path: pathFor(request.documentType, request.subject),
      currentVersion: versionRecord.version,
      status: 'published',
      metadata: { lastTrigger: request.trigger.kind },
      createdAt: existing?.createdAt ?? compiledAt,
      updatedAt: this.#now(),
    });

    return {
      articleId,
      versionId: newVersionId,
      status: 'published',
      warnings,
      publishedAt: compiledAt,
      durationMs: Date.now() - startedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #resolveSources(queries: SourceQuery[]): Promise<ResolvedSource[]> {
    const out: ResolvedSource[] = [];
    for (const q of queries) {
      if (q.kind === 'database') {
        if (!this.#cfg.databaseSource) {
          throw new Error(`SourceQuery kind 'database' but no DatabaseSourceAdapter configured`);
        }
        const namedKind = (q.query.kind as string) ?? '';
        const payload = (q.query.payload as Record<string, unknown>) ?? {};
        const result = await this.#cfg.databaseSource.query({ kind: namedKind, payload });
        out.push({ kind: 'database', queryKind: namedKind, rows: result.rows });
      } else if (q.kind === 'nuvector') {
        // The NuVector path is intentionally minimal at WU 036: callers pass a
        // pre-built SearchKnowledgeRequest in q.query. Future WUs may add
        // helper builders / convention layers.
        const result = await this.#cfg.memoryAdapter.searchKnowledge(
          q.query as unknown as Parameters<NuVectorAdapter['searchKnowledge']>[0],
        );
        out.push({ kind: 'nuvector', items: result.items, retrievalId: result.retrievalId });
      } else {
        // Unknown kind — leave the resolver permissive and pass through.
        out.push({ kind: q.kind, raw: q.query });
      }
    }
    return out;
  }

  async #callLLM(input: {
    docType: DocumentType;
    subject: SubjectRef;
    existing: NuWikiArticle | undefined;
    sources: ResolvedSource[];
  }): Promise<LLMCompilationOutput> {
    const systemPrompt = buildSystemPrompt(input.docType);
    const userPrompt = buildUserPrompt(input);
    const result = await this.#cfg.llmAdapter.generate({
      systemPrompt,
      userPrompt,
      context: [],
      outputSchema: LLM_COMPILATION_OUTPUT_SCHEMA,
    });
    return parseLLMCompilationOutput(result.content);
  }

  #sectionEmbeddingText(section: LLMCompilationOutputSection, _summary: string): string {
    // WU 038 will introduce the article-summary prefix invariant.
    return `${section.heading}\n${section.text}`;
  }

  async #publishToNuVector(args: {
    articleId: string;
    version: string;
    documentType: DocumentType;
    subject: SubjectRef;
    compiledAt: string;
    parsed: LLMCompilationOutput;
    summaryEmbedding: Float32Array;
    sectionEmbeddings: Float32Array[];
    citationEmbeddings: Float32Array[];
    sources: ResolvedSource[];
    predecessorVersion?: string;
    trigger: GenerationTrigger;
  }): Promise<void> {
    const {
      articleId,
      version,
      documentType,
      subject,
      compiledAt,
      parsed,
      summaryEmbedding,
      sectionEmbeddings,
      citationEmbeddings,
      predecessorVersion,
      trigger,
    } = args;
    const tenant = this.#cfg.tenant;

    // Layer 1 + 2 + 3 records
    const records: Parameters<NuVectorAdapter['upsertBatch']>[0] = [];
    records.push({
      id: `summary:${articleId}:${version}`,
      kind: 'nuwiki_article_summary',
      embedding: summaryEmbedding,
      text: parsed.summary,
      tenant,
      metadata: {
        articleId,
        documentType: documentType.type,
        subject,
        version,
        sectionCount: parsed.sections.length,
        lastCompiledAt: compiledAt,
        isFresh: true,
        agentReadingHints: documentType.retrievalHints.agentReadingHints,
        summaryTokenLength: cheapTokenCount(parsed.summary),
      },
    });
    parsed.sections.forEach((s, i) => {
      records.push({
        id: `section:${articleId}:${version}:${s.key}`,
        kind: 'nuwiki_section',
        embedding: sectionEmbeddings[i],
        text: s.text,
        tenant,
        metadata: {
          articleId,
          documentType: documentType.type,
          subject,
          version,
          sectionKey: s.key,
          sectionHeading: s.heading,
          citationCount: s.citationIds.length,
          parentArticleSummary: parsed.summary,
          position: s.position,
        },
      });
    });
    if (documentType.precisionIndexable) {
      parsed.citations.forEach((c, i) => {
        records.push({
          id: `citation:${articleId}:${version}:${c.id}`,
          kind: 'nuwiki_citation',
          embedding: citationEmbeddings[i],
          text: c.claim,
          tenant,
          metadata: {
            articleId,
            documentType: documentType.type,
            subject,
            version,
            citationId: c.id,
            sourceRef: c.source,
            confidence: c.confidence,
          },
        });
      });
    }

    await this.#cfg.memoryAdapter.upsertBatch(records);

    // Layer 4 — graph
    await this.#cfg.memoryAdapter.graph.upsertNodeWithEdges({
      nodeId: articleId,
      outboundEdges: parsed.outboundLinks.map((l) => ({
        to: l.toArticleId,
        type: l.linkType,
      })),
    });

    // Provenance
    await this.#cfg.memoryAdapter.remember({
      id: `prov_compile_${this.#id()}`,
      kind: 'nuwiki_compile',
      capturedAt: compiledAt,
      evidence: [],
      outcome: 'compiled',
      metadata: {
        articleId,
        version,
        documentType: documentType.type,
        triggerKind: trigger.kind,
      },
    });

    // Supersede predecessor records (no-op at v0.1.0; documented in WU 033)
    if (predecessorVersion) {
      await this.#cfg.memoryAdapter.markSuperseded({
        pattern: `*:${articleId}:${predecessorVersion}*`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// LLM output schema + parsing
// ---------------------------------------------------------------------------

export const LLM_COMPILATION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary', 'sections', 'citations', 'outboundLinks'],
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'heading', 'text', 'citationIds', 'position'],
        properties: {
          key: { type: 'string' },
          heading: { type: 'string' },
          text: { type: 'string' },
          citationIds: { type: 'array', items: { type: 'string' } },
          position: { type: 'number' },
        },
      },
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'claim', 'source', 'confidence', 'position'],
      },
    },
    outboundLinks: { type: 'array' },
  },
};

export function parseLLMCompilationOutput(content: string): LLMCompilationOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new LLMOutputParseError(`not valid JSON (${(err as Error).message})`, content);
  }
  if (!raw || typeof raw !== 'object') {
    throw new LLMOutputParseError('output is not a JSON object', content);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== 'string') {
    throw new LLMOutputParseError('missing string field: summary', content);
  }
  if (!Array.isArray(obj.sections)) {
    throw new LLMOutputParseError('missing array field: sections', content);
  }
  if (!Array.isArray(obj.citations)) {
    throw new LLMOutputParseError('missing array field: citations', content);
  }
  if (!Array.isArray(obj.outboundLinks)) {
    throw new LLMOutputParseError('missing array field: outboundLinks', content);
  }
  return {
    summary: obj.summary,
    sections: obj.sections as LLMCompilationOutputSection[],
    citations: obj.citations as LLMCompilationOutputCitation[],
    outboundLinks: obj.outboundLinks as LLMCompilationOutputLink[],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedSource {
  kind: string;
  queryKind?: string;
  rows?: Array<Record<string, unknown>>;
  items?: unknown[];
  retrievalId?: string;
  raw?: unknown;
}

function subjectArticleId(documentType: string, subject: SubjectRef): string {
  return `${documentType}:${subject.kind}:${subject.id}`;
}

function pathFor(documentType: string, subject: SubjectRef): string {
  return `nuwiki/${documentType}/${subject.kind}/${subject.id}`;
}

function nextVersion(predecessor?: string): string {
  if (!predecessor) return DEFAULT_VERSION;
  const match = predecessor.match(/^v(\d+)$/);
  if (!match) return `${predecessor}.1`;
  return `v${parseInt(match[1], 10) + 1}`;
}

function cheapHash(s: string): string {
  // Non-cryptographic; acceptable for at-most-once forward-write integrity.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `h_${(h >>> 0).toString(16)}_${s.length}`;
}

function cheapTokenCount(s: string): number {
  // Proper tokenisation lands in WU 037. Whitespace approximation suffices.
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function renderMarkdownBody(o: LLMCompilationOutput): string {
  const lines: string[] = [];
  for (const s of [...o.sections].sort((a, b) => a.position - b.position)) {
    lines.push(`## ${s.heading}`, '', s.text, '');
  }
  return lines.join('\n').trim() + '\n';
}

function buildSystemPrompt(docType: DocumentType): string {
  return [
    `You are compiling a NuWiki article of type "${docType.type}" (${docType.description}).`,
    `Return a JSON object conforming to the LLMCompilationOutput schema.`,
    `Do not include prose outside the JSON.`,
  ].join(' ');
}

function buildUserPrompt(input: {
  docType: DocumentType;
  subject: SubjectRef;
  existing: NuWikiArticle | undefined;
  sources: ResolvedSource[];
}): string {
  return JSON.stringify({
    subject: input.subject,
    documentType: input.docType.type,
    sections: input.docType.sections.map((s) => ({ key: s.key, heading: s.heading })),
    sources: input.sources,
    existingArticleId: input.existing?.id,
  });
}

interface BlockedResultArgs {
  articleId: string;
  versionId: string;
  warnings: ArticleWarning[];
  durationMs: number;
}

function blockedResult(args: BlockedResultArgs): CompilationResult {
  const status: ArticleStatus = 'blocked';
  return {
    articleId: args.articleId,
    versionId: args.versionId,
    status,
    warnings: args.warnings,
    durationMs: args.durationMs,
  };
}
