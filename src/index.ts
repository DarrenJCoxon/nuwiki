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
 * - WU 042: Integrity pass loop
 * - WU 043: Article-suggestion engine
 * - WU 044: Starter education DocumentTypes (subpath: `./templates`)
 * - WU 045: Conformance test suite
 * - WU 046: Documentation
 * - WU 047: v0.1.0 publish
 */

import { CompilationEngine } from './compilation.js';
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
  IntegrityPassRequest,
  IntegrityPassResult,
  KnowledgeRef,
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

  async read(_request: ReadRequest): Promise<RenderedArticle> {
    throw new NotImplementedError('NuWiki.read', 'WU 041 (role-aware redaction)');
  }

  async followLinks(_request: FollowLinksRequest): Promise<RenderedArticle[]> {
    throw new NotImplementedError('NuWiki.followLinks', 'WU 040 (backlink graph maintenance)');
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

  async runIntegrityPass(_request: IntegrityPassRequest): Promise<IntegrityPassResult> {
    throw new NotImplementedError('NuWiki.runIntegrityPass', 'WU 042 (integrity pass loop)');
  }

  async suggestNewArticles(_scope: SuggestionScope): Promise<ArticleSuggestion[]> {
    throw new NotImplementedError('NuWiki.suggestNewArticles', 'WU 043 (article-suggestion engine)');
  }

  async list(filters: ListFilters): Promise<NuWikiArticle[]> {
    return this.#metadata.listArticles({
      tenant: filters.tenant ?? this.#tenant,
      documentType: filters.documentType,
      status: filters.status,
      limit: filters.limit,
    });
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
