/**
 * `@nusoft/nuwiki` — the compiled knowledge engine of NuOS.
 *
 * v0.1.0 status: this package is a **scaffolding skeleton** (WU 030). The
 * type surface is complete; the runtime is stubbed. Each method throws a
 * `NotImplementedError` pointing at the WU that will implement it.
 *
 * Implementation order:
 * - WU 031–035: Adapter reference implementations
 * - WU 036: Compilation engine (the central runtime piece)
 * - WU 037: Summary compilation with token budget enforcement
 * - WU 038: Section embedding with article-summary prefix
 * - WU 039: Citation validation
 * - WU 040: Backlink graph maintenance
 * - WU 041: Role-aware redaction
 * - WU 042: Integrity pass loop
 * - WU 043: Article-suggestion engine
 * - WU 044: Starter education DocumentTypes (subpath: `./templates`)
 * - WU 045: Conformance test suite
 * - WU 046: Documentation
 * - WU 047: v0.1.0 publish
 */

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

export interface NuWikiConfig {
  metadata: MetadataAdapter;
  bodies: ObjectStorageAdapter;
  memoryAdapter: NuVectorAdapter;
  llmAdapter: LLMAdapter;
  databaseSource?: DatabaseSourceAdapter;
  tenant: string;
  documentTypes?: DocumentType[];
}

/**
 * The main entry point of `@nusoft/nuwiki`.
 *
 * v0.1.0 status: every method is a stub. The runtime implementation lands
 * in WU 036 onwards. This class exists at WU 030 to fix the public surface
 * and let downstream WUs implement against it.
 */
export class NuWiki {
  readonly #tenant: string;
  readonly #documentTypes: Map<string, DocumentType>;

  private constructor(tenant: string, documentTypes: DocumentType[]) {
    this.#tenant = tenant;
    this.#documentTypes = new Map(documentTypes.map((d) => [d.type, d]));
  }

  static async open(config: NuWikiConfig): Promise<NuWiki> {
    const tenant = config.tenant;
    if (!tenant) throw new Error('NuWiki.open() requires a tenant');
    return new NuWiki(tenant, config.documentTypes ?? []);
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

  async compile(_request: CompileRequest): Promise<CompilationResult> {
    throw new NotImplementedError('NuWiki.compile', 'WU 036 (compilation engine)');
  }

  async read(_request: ReadRequest): Promise<RenderedArticle> {
    throw new NotImplementedError('NuWiki.read', 'WU 041 (role-aware redaction)');
  }

  async followLinks(_request: FollowLinksRequest): Promise<RenderedArticle[]> {
    throw new NotImplementedError('NuWiki.followLinks', 'WU 040 (backlink graph maintenance)');
  }

  async refresh(_ref: RefreshRef): Promise<RefreshResult> {
    throw new NotImplementedError('NuWiki.refresh', 'WU 036 (compilation engine)');
  }

  async affectedDocuments(
    _commit: { commitRef: string; recordType: string; recordId: string; committedAt: string },
    _intent: { type: string; subjects: SubjectRef[] }
  ): Promise<KnowledgeRef[]> {
    throw new NotImplementedError(
      'NuWiki.affectedDocuments',
      'WU 036 (compilation engine) and WU 040 (backlink graph)'
    );
  }

  async runIntegrityPass(_request: IntegrityPassRequest): Promise<IntegrityPassResult> {
    throw new NotImplementedError('NuWiki.runIntegrityPass', 'WU 042 (integrity pass loop)');
  }

  async suggestNewArticles(_scope: SuggestionScope): Promise<ArticleSuggestion[]> {
    throw new NotImplementedError('NuWiki.suggestNewArticles', 'WU 043 (article-suggestion engine)');
  }

  async list(_filters: ListFilters): Promise<NuWikiArticle[]> {
    throw new NotImplementedError('NuWiki.list', 'WU 031 (MetadataAdapter Postgres reference impl)');
  }

  async archive(_request: ArchiveRequest): Promise<void> {
    throw new NotImplementedError('NuWiki.archive', 'WU 036 (compilation engine)');
  }

  async delete(_query: DeletionQuery): Promise<DeletionResult> {
    throw new NotImplementedError('NuWiki.delete', 'WU 036 (compilation engine)');
  }

  async export(_articleId: string, _format: ExportFormat): Promise<ExportRef> {
    throw new NotImplementedError('NuWiki.export', '`@nusoft/nuwiki/export` subpath (post-v0.1.0)');
  }

  /** @internal — used for tests at WU 030 to confirm the tenant is plumbed through. */
  _getTenant(): string {
    return this.#tenant;
  }
}
