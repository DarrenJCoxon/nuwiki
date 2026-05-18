/**
 * `@nusoft/nuwiki` — the compiled knowledge engine of NuOS.
 *
 * v0.1.0 status (post-WU-036): the compilation engine is wired. The runtime
 * methods that depend on the engine (compile, refresh, list, archive,
 * delete, affectedDocuments) are implemented. Methods that depend on
 * later WUs still throw `NotImplementedError` pointing at the WU that
 * will implement them.
 *
 * Implementation order:
 * - WU 031–035: Adapter reference implementations ✅
 * - WU 036: Compilation engine ✅ (this WU)
 * - WU 037: Summary compilation with token budget enforcement
 * - WU 038: Section embedding with article-summary prefix
 * - WU 039: Citation validation
 * - WU 040: Backlink graph maintenance + followLinks
 * - WU 041: Role-aware redaction + read()
 * - WU 042: Integrity pass loop ✅
 * - WU 043: Article-suggestion engine (this WU)
 * - WU 044: WikiPack interface + domain-neutral core (packs contribute DocumentTypes)
 * - WU 045: Conformance test suite
 * - WU 046: Documentation
 * - WU 047: v0.1.0 publish
 */

import { CompilationEngine, buildSectionEmbeddingText } from './compilation.js';
import { redactArticle } from './redaction.js';
import { runIntegrityPass } from './integrity.js';
import { suggestNewArticles } from './suggestions.js';
import { NotImplementedError } from './errors.js';
import type {
  ArchiveRequest,
  ArticleSuggestion,
  CompilationResult,
  CompileRequest,
  DeletionQuery,
  DeletionResult,
  DocumentType,
  ExportFormat,
  ExportRef,
  FollowLinksRequest,
  GenerationRecord,
  IntegrityPassRequest,
  IntegrityPassResult,
  KnowledgeRef,
  LLMCompilationOutput,
  ListFilters,
  NuWikiArticle,
  ReadRequest,
  RefreshRef,
  RefreshResult,
  RenderedArticle,
  SubjectRef,
  SuggestionScope,
  WorkflowCommitEnvelope,
  WorkflowIntentEnvelope,
} from './types.js';
import type {
  DatabaseSourceAdapter,
  LLMAdapter,
  MetadataAdapter,
  NuVectorAdapter,
  ObjectStorageAdapter,
} from './adapters.js';

export * from './types.js';
export * from './adapters.js';
export { NotImplementedError } from './errors.js';
export {
  CompilationEngine,
  LLMOutputParseError,
  LLM_COMPILATION_OUTPUT_SCHEMA,
  parseLLMCompilationOutput,
  buildSectionEmbeddingText,
} from './compilation.js';
export {
  estimateTokenCount,
  assertWithinTokenBudget,
  TokenBudgetExceededError,
} from './tokens.js';
export {
  validateCitations,
  CitationValidationError,
} from './citations.js';
export type {
  CitationValidationReport,
  CitationValidationIssue,
  CitationValidationIssueKind,
} from './citations.js';
export {
  diffOutboundLinks,
  BrokenLinkChecker,
} from './backlinks.js';
export type { OutboundLinkRef, BrokenLinkReport } from './backlinks.js';
export { redactArticle } from './redaction.js';
export type { RedactArticleInput, RedactArticleOutput } from './redaction.js';
export {
  runIntegrityPass,
  IntegrityCheckers,
  applyAutoRemediation,
  applyAutoRemediations,
} from './integrity.js';
export type { IntegrityPassAdapters } from './integrity.js';
export {
  suggestNewArticles,
  LLM_SUGGESTION_OUTPUT_SCHEMA,
  parseLLMSuggestionOutput,
  LLMSuggestionParseError,
} from './suggestions.js';
export type { SuggestionEngineConfig } from './suggestions.js';
export { defineWikiPack } from './pack.js';
export type { WikiPack } from './pack.js';

export interface NuWikiConfig {
  metadata: MetadataAdapter;
  bodies: ObjectStorageAdapter;
  memoryAdapter: NuVectorAdapter;
  llmAdapter: LLMAdapter;
  databaseSource?: DatabaseSourceAdapter;
  tenant: string;
  documentTypes?: DocumentType[];
  /** Test-only injection points. Production callers omit. */
  idFactory?: () => string;
  now?: () => string;
  /**
   * Optional token counter for summary-budget enforcement. Defaults to
   * the heuristic in `./tokens.js`. Consumers who need vendor-accurate
   * counts inject their own (e.g. `tiktoken`, the Vertex tokenizer);
   * NuWiki stays model-agnostic per D020.
   */
  tokenCounter?: (text: string) => number;
}

/**
 * The main entry point of `@nusoft/nuwiki`.
 */
export class NuWiki {
  readonly #tenant: string;
  readonly #documentTypes: Map<string, DocumentType>;
  readonly #metadata: MetadataAdapter;
  readonly #bodies: ObjectStorageAdapter;
  readonly #memoryAdapter: NuVectorAdapter;
  readonly #llmAdapter: LLMAdapter;
  readonly #databaseSource?: DatabaseSourceAdapter;
  readonly #engine: CompilationEngine;

  private constructor(config: NuWikiConfig) {
    this.#tenant = config.tenant;
    this.#documentTypes = new Map((config.documentTypes ?? []).map((d) => [d.type, d]));
    this.#metadata = config.metadata;
    this.#bodies = config.bodies;
    this.#memoryAdapter = config.memoryAdapter;
    this.#llmAdapter = config.llmAdapter;
    this.#databaseSource = config.databaseSource;
    this.#engine = new CompilationEngine({
      metadata: config.metadata,
      bodies: config.bodies,
      memoryAdapter: config.memoryAdapter,
      llmAdapter: config.llmAdapter,
      databaseSource: config.databaseSource,
      tenant: config.tenant,
      getDocumentType: (type) => this.#documentTypes.get(type),
      idFactory: config.idFactory,
      now: config.now,
      tokenCounter: config.tokenCounter,
    });
  }

  static async open(config: NuWikiConfig): Promise<NuWiki> {
    if (!config.tenant) throw new Error('NuWiki.open() requires a tenant');
    return new NuWiki(config);
  }

  registerDocumentType(definition: DocumentType): void {
    if (this.#documentTypes.has(definition.type)) {
      throw new Error(`DocumentType already registered: ${definition.type}`);
    }
    this.#documentTypes.set(definition.type, definition);
  }

  listDocumentTypes(): DocumentType[] {
    return [...this.#documentTypes.values()];
  }

  async compile(request: CompileRequest): Promise<CompilationResult> {
    return this.#engine.compile(request);
  }

  async read(request: ReadRequest): Promise<RenderedArticle> {
    const articleId = `${request.documentType}:${request.subject.kind}:${request.subject.id}`;
    const article = await this.#metadata.getArticle(articleId);
    if (!article) {
      throw new Error(`NuWiki.read: article not found for ${articleId}`);
    }
    const docType = this.#documentTypes.get(article.documentType);
    if (!docType) {
      throw new Error(`NuWiki.read: documentType not registered: ${article.documentType}`);
    }
    const version = request.version ?? article.currentVersion;
    const versionId = `${article.documentType}/${article.subject.id}/${version}`;
    const structuredKey = `nuwiki/${this.#tenant}/${articleId}/${versionId}.json`;
    const structuredJson = await this.#bodies.get({ key: structuredKey });
    const parsed = JSON.parse(structuredJson);

    // Hydrate link targets so RenderedLink carries subject + documentType.
    const linkTargets: Record<string, { subject: SubjectRef; documentType: string }> = {};
    for (const l of parsed.outboundLinks ?? []) {
      const target = await this.#metadata.getArticle(l.toArticleId);
      if (target) {
        linkTargets[l.toArticleId] = { subject: target.subject, documentType: target.documentType };
      }
    }

    const redacted = redactArticle({
      documentType: docType,
      parsed,
      viewerRole: request.viewerRole,
      linkTargets,
    });

    return {
      articleId,
      documentType: article.documentType,
      subject: article.subject,
      version,
      freshness: article.freshness,
      body: redacted.body,
      citations: redacted.citations,
      outboundLinks: redacted.outboundLinks,
      warnings: redacted.warnings,
      viewerRole: request.viewerRole,
      renderedAt: new Date().toISOString(),
      agentMetadata: docType.retrievalHints.agentReadingHints,
    };
  }

  async followLinks(request: FollowLinksRequest): Promise<RenderedArticle[]> {
    const traversal = await this.#memoryAdapter.graph.traverse({
      fromArticleId: request.fromArticleId,
      linkTypes: request.linkTypes,
      maxDepth: request.maxDepth ?? 1,
    });
    const linkedIds = traversal.visitedArticleIds.filter((id) => id !== request.fromArticleId);
    const out: RenderedArticle[] = [];
    const renderedAt = new Date().toISOString();
    for (const id of linkedIds) {
      const article = await this.#metadata.getArticle(id);
      if (!article) continue;
      try {
        const rendered = await this.read({
          documentType: article.documentType,
          subject: article.subject,
          viewerRole: request.viewerRole,
        });
        out.push(rendered);
      } catch {
        // Article exists in metadata but storage / docType missing — fall
        // back to a minimal RenderedArticle so the traversal still
        // surfaces the link. Integrity pass (WU 042) flags the gap.
        out.push({
          articleId: article.id,
          documentType: article.documentType,
          subject: article.subject,
          version: article.currentVersion,
          freshness: article.freshness,
          body: '',
          citations: [],
          outboundLinks: [],
          warnings: [{ kind: 'missing_evidence', message: 'Article body not available for rendering', details: { articleId: article.id } }],
          viewerRole: request.viewerRole,
          renderedAt,
        });
      }
    }
    return out;
  }

  async refresh(ref: RefreshRef): Promise<RefreshResult> {
    const articleId = `${ref.documentType}:${ref.subject.kind}:${ref.subject.id}`;
    const result = await this.#engine.compile({
      documentType: ref.documentType,
      subject: ref.subject,
      trigger: ref.trigger ?? { kind: 'scheduled_refresh' },
    });
    return {
      articleId,
      refreshTriggered: result.status === 'published',
      versionId: result.versionId || undefined,
      reason: result.warnings[0]?.message,
    };
  }

  async affectedDocuments(
    _commit: WorkflowCommitEnvelope,
    intent: WorkflowIntentEnvelope,
  ): Promise<KnowledgeRef[]> {
    const refs: KnowledgeRef[] = [];
    for (const docType of this.#documentTypes.values()) {
      const triggersMatch = docType.refreshTriggers.some(
        (t) => t.kind === 'workflow_commit' && (!t.intentType || t.intentType === intent.type),
      );
      if (!triggersMatch) continue;
      for (const subject of intent.subjects) {
        if (subject.kind !== docType.subjectKind && docType.subjectKind !== 'institution') continue;
        refs.push({
          documentType: docType.type,
          subject,
          refreshTriggered: false,
          documentId: `${docType.type}:${subject.kind}:${subject.id}`,
        });
      }
    }
    return refs;
  }

  async runIntegrityPass(request: IntegrityPassRequest): Promise<IntegrityPassResult> {
    return runIntegrityPass(
      {
        metadata: this.#metadata,
        bodies: this.#bodies,
        memoryAdapter: this.#memoryAdapter,
        llmAdapter: this.#llmAdapter,
        databaseSource: this.#databaseSource,
        tenant: this.#tenant,
        getDocumentType: (type) => this.#documentTypes.get(type),
        compile: (req) => this.#engine.compile(req),
      },
      request,
    );
  }

  async suggestNewArticles(scope: SuggestionScope): Promise<ArticleSuggestion[]> {
    return suggestNewArticles(
      {
        metadata: this.#metadata,
        memoryAdapter: this.#memoryAdapter,
        llmAdapter: this.#llmAdapter,
        tenant: this.#tenant,
        getDocumentType: (type) => this.#documentTypes.get(type),
      },
      scope,
    );
  }

  async list(filters: ListFilters): Promise<NuWikiArticle[]> {
    return this.#metadata.listArticles({
      tenant: filters.tenant ?? this.#tenant,
      documentType: filters.documentType,
      status: filters.status,
      limit: filters.limit,
    });
  }

  /**
   * Seed a pre-authored article directly into NuWiki, bypassing LLM compilation.
   *
   * For content packs that ship pre-authored articles without LLM compilation
   * (e.g. operator-verified statutory guidance). The `structuredBody` must
   * conform to `LLMCompilationOutput` shape and is produced by the pack's
   * deterministic parser, not by an LLM call.
   *
   * Idempotent: re-seeding the same article (same documentType + subject) will
   * upsert metadata and overwrite the stored body to the pack's current version.
   *
   * The LLM adapter is used only for computing embeddings (section + citation
   * vectors). No generative call is made.
   *
   * @see WU 094 architect brief — Choice 5 (direct-seed bypass entry point)
   */
  async seed(args: {
    documentType: string;
    subject: SubjectRef;
    structuredBody: LLMCompilationOutput;
    generatedBy: GenerationRecord;
  }): Promise<{ articleId: string; versionId: string }> {
    const { documentType, subject, structuredBody, generatedBy } = args;

    const docType = this.#documentTypes.get(documentType);
    if (!docType) {
      throw new Error(`NuWiki.seed: documentType '${documentType}' is not registered`);
    }

    const articleId = `${documentType}:${subject.kind}:${subject.id}`;
    const existing = await this.#metadata.getArticle(articleId);

    // Compute the next version (v1 for new articles, v2+ for re-seeds).
    const predecessorVersion = existing?.currentVersion;
    const newVersion = predecessorVersion
      ? `v${parseInt(predecessorVersion.slice(1), 10) + 1}`
      : 'v1';
    const versionId = `${documentType}/${subject.id}/${newVersion}`;
    const now = new Date().toISOString();

    // Write the structured body to object storage.
    const structuredKey = `nuwiki/${this.#tenant}/${articleId}/${versionId}.json`;
    const bodyJson = JSON.stringify(structuredBody);
    const bodyRef = await this.#bodies.put(
      { key: structuredKey, contentType: 'application/json' },
      bodyJson,
    );

    // Compute a cheap hash for the version record.
    const bodyHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-1',
          new TextEncoder().encode(bodyJson.slice(0, 512)),
        ),
      ),
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);

    // Upsert the article record first (parent row required by the version FK).
    const path = `/${documentType}/${subject.kind}/${subject.id}`;
    await this.#metadata.upsertArticle({
      id: articleId,
      tenant: this.#tenant,
      documentType,
      subject,
      path,
      currentVersion: newVersion,
      status: 'published',
      metadata: { seededBy: 'nuwiki_seed', packVersion: generatedBy.promptVersion ?? 'unknown' },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    // Then upsert the version record (article_id FK is now satisfied).
    await this.#metadata.upsertVersion({
      id: versionId,
      articleId,
      version: newVersion,
      bodyRef,
      bodyHash,
      publishedAt: now,
      predecessorVersion,
    });

    // Compute embeddings (LLM used for embeddings only — no generative call).
    const summaryEmbedding = await this.#llmAdapter.embed(structuredBody.summary);
    const usePrefix = docType.retrievalHints.embedSectionsWithSummaryPrefix !== false;
    const sectionEmbeddings = await Promise.all(
      structuredBody.sections.map((s) =>
        this.#llmAdapter.embed(
          buildSectionEmbeddingText(structuredBody.summary, s, { withPrefix: usePrefix }),
        ),
      ),
    );
    const citationEmbeddings = docType.precisionIndexable
      ? await Promise.all(structuredBody.citations.map((c) => this.#llmAdapter.embed(c.claim)))
      : [];

    // Publish to NuVector (layers 1–4).
    const tenant = this.#tenant;
    const records: Parameters<NuVectorAdapter['upsertBatch']>[0] = [];

    records.push({
      id: `summary:${articleId}:${newVersion}`,
      kind: 'nuwiki_article_summary',
      embedding: summaryEmbedding,
      text: structuredBody.summary,
      tenant,
      metadata: {
        articleId,
        documentType: docType.type,
        subject,
        version: newVersion,
        sectionCount: structuredBody.sections.length,
        lastCompiledAt: now,
        isFresh: true,
        agentReadingHints: docType.retrievalHints.agentReadingHints,
      },
    });

    structuredBody.sections.forEach((s, i) => {
      records.push({
        id: `section:${articleId}:${newVersion}:${s.key}`,
        kind: 'nuwiki_section',
        embedding: sectionEmbeddings[i],
        text: s.text,
        tenant,
        metadata: {
          articleId,
          documentType: docType.type,
          subject,
          version: newVersion,
          sectionKey: s.key,
          sectionHeading: s.heading,
          citationCount: s.citationIds.length,
          parentArticleSummary: structuredBody.summary,
          position: s.position,
        },
      });
    });

    if (docType.precisionIndexable) {
      structuredBody.citations.forEach((c, i) => {
        records.push({
          id: `citation:${articleId}:${newVersion}:${c.id}`,
          kind: 'nuwiki_citation',
          embedding: citationEmbeddings[i],
          text: c.claim,
          tenant,
          metadata: {
            articleId,
            documentType: docType.type,
            subject,
            version: newVersion,
            citationId: c.id,
            sourceRef: c.source,
            confidence: c.confidence,
          },
        });
      });
    }

    await this.#memoryAdapter.upsertBatch(records);

    // Layer 4 — graph node (no outbound edges from statutory articles at v0.1).
    await this.#memoryAdapter.graph.upsertNodeWithEdges({
      nodeId: articleId,
      outboundEdges: structuredBody.outboundLinks.map((l) => ({
        to: l.toArticleId,
        type: l.linkType,
      })),
    });

    // Provenance record. Uses 'nuwiki_compile' kind (established NuVector kind)
    // with outcome 'compiled'. The seed operation is distinguished from LLM
    // compilation by metadata.seededBy='nuwiki_seed'.
    await this.#memoryAdapter.remember({
      id: `prov_seed_${articleId}_${newVersion}`,
      kind: 'nuwiki_compile',
      capturedAt: now,
      evidence: [],
      outcome: 'compiled',
      metadata: {
        articleId,
        version: newVersion,
        documentType,
        seededBy: 'nuwiki_seed',
        triggeredBy: generatedBy.triggeredBy,
      },
    });

    // Supersede predecessor NuVector records on re-seed.
    if (predecessorVersion) {
      await this.#memoryAdapter.markSuperseded({
        pattern: `*:${articleId}:${predecessorVersion}*`,
      });
    }

    return { articleId, versionId };
  }

  async archive(request: ArchiveRequest): Promise<void> {
    const articleId = `${request.documentType}:${request.subject.kind}:${request.subject.id}`;
    const existing = await this.#metadata.getArticle(articleId);
    if (!existing) return;
    await this.#memoryAdapter.graph.archiveNode(articleId);
    await this.#metadata.upsertArticle({
      id: articleId,
      tenant: this.#tenant,
      documentType: request.documentType,
      subject: request.subject,
      path: existing.path,
      currentVersion: existing.currentVersion,
      status: 'archived',
      metadata: { ...existing.metadata, archiveReason: request.reason },
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(query: DeletionQuery): Promise<DeletionResult> {
    const affected: string[] = [];
    let vectorRecordsRemoved = 0;

    if (query.ids?.length) {
      affected.push(...query.ids);
    } else if (query.subject) {
      const list = await this.#metadata.listArticles({ tenant: this.#tenant });
      for (const a of list) {
        if (
          a.subject.kind === query.subject.kind &&
          a.subject.id === query.subject.id &&
          (!query.documentType || a.documentType === query.documentType)
        ) {
          affected.push(a.id);
        }
      }
    } else if (query.documentType) {
      const list = await this.#metadata.listArticles({ tenant: this.#tenant, documentType: query.documentType });
      affected.push(...list.map((a) => a.id));
    }

    for (const articleId of affected) {
      const existing = await this.#metadata.getArticle(articleId);
      if (!existing) continue;
      const versions = await this.#metadata.listVersions(articleId);
      for (const v of versions) {
        try {
          await this.#bodies.delete(v.bodyRef);
        } catch {
          // best-effort; missing bodies are non-fatal at delete time
        }
      }
      const result = await this.#memoryAdapter.delete({
        articleId,
        tenant: this.#tenant,
        reason: query.reason ?? 'gdpr_erasure',
      });
      vectorRecordsRemoved += result.deletedCount;
      await this.#memoryAdapter.graph.removeNode(articleId);
    }

    return {
      deletedCount: affected.length,
      affectedArticles: affected,
      vectorRecordsRemoved,
    };
  }

  async export(_articleId: string, _format: ExportFormat): Promise<ExportRef> {
    throw new NotImplementedError('NuWiki.export', '`@nusoft/nuwiki/export` subpath (post-v0.1.0)');
  }

  /** @internal — used for tests at WU 030 to confirm the tenant is plumbed through. */
  _getTenant(): string {
    return this.#tenant;
  }
}
