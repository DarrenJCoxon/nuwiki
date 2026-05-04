/**
 * NuWiki adapter contracts.
 *
 * The five adapters NuWiki delegates to. Consumers wire concrete implementations
 * at runtime. The reference implementations land in WUs 031–035:
 * - WU 031: MetadataAdapter (Postgres reference impl)
 * - WU 032: ObjectStorageAdapter (Supabase / SharePoint / Drive reference impls; D018)
 * - WU 033: NuVectorAdapter (thin wrapper around @nusoft/nuvector)
 * - WU 034: LLMAdapter (Vertex AI reference impl)
 * - WU 035: DatabaseSourceAdapter
 *
 * Where the contract specifies "no translation", types are imported verbatim
 * from `@nusoft/nuvector`.
 */

import type {
  ContextPack,
  DeletionQuery as NvDeletionQuery,
  DeletionResult as NvDeletionResult,
  InvalidationHandler,
  MemoryRecord,
  ProvenanceRecord,
  RetrievalQuery,
  SearchKnowledgeRequest,
  Unsubscribe,
  UpsertRef,
} from '@nusoft/nuvector';
import type {
  ArticleStatus,
  ISODateString,
  NuWikiArticle,
  NuWikiArticleVersion,
  ObjectStorageRef,
  SubjectRef,
} from './types.js';

// ---------------------------------------------------------------------------
// MetadataAdapter — article metadata in the consumer's relational database
// ---------------------------------------------------------------------------

export interface ArticleMetadataRecord {
  id: string;
  tenant: string;
  documentType: string;
  subject: SubjectRef;
  path: string;
  currentVersion: string;
  status: ArticleStatus;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface VersionMetadataRecord {
  id: string;
  articleId: string;
  version: string;
  bodyRef: ObjectStorageRef;
  bodyHash: string;
  publishedAt?: ISODateString;
  archivedAt?: ISODateString;
  predecessorVersion?: string;
}

export interface MetadataAdapter {
  upsertArticle(record: ArticleMetadataRecord): Promise<void>;
  getArticle(id: string): Promise<NuWikiArticle | undefined>;
  findArticle(documentType: string, subject: SubjectRef): Promise<NuWikiArticle | undefined>;
  listArticles(filters: { tenant?: string; documentType?: string; status?: ArticleStatus; limit?: number }): Promise<NuWikiArticle[]>;

  upsertVersion(record: VersionMetadataRecord): Promise<void>;
  getVersion(versionId: string): Promise<NuWikiArticleVersion | undefined>;
  listVersions(articleId: string): Promise<NuWikiArticleVersion[]>;

  recordBacklink(fromArticleId: string, toArticleId: string, linkType: string): Promise<void>;
  removeBacklinksFor(articleId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ObjectStorageAdapter — article bodies and exports
// ---------------------------------------------------------------------------

export interface ObjectStorageAdapter {
  put(ref: ObjectStorageRef, body: string | Uint8Array): Promise<ObjectStorageRef>;
  get(ref: ObjectStorageRef): Promise<string>;
  delete(ref: ObjectStorageRef): Promise<void>;
  exists(ref: ObjectStorageRef): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// NuVectorAdapter — the most critical adapter
// ---------------------------------------------------------------------------

export interface GraphEdgeSpec {
  to: string;
  type: string;
  weight?: number;
}

export interface GraphNodeUpsert {
  nodeId: string;
  outboundEdges: GraphEdgeSpec[];
}

export interface SupersedeQuery {
  pattern: string;
}

export interface BacklinkTraversalRequest {
  fromArticleId: string;
  linkTypes?: string[];
  maxDepth?: number;
}

export interface BacklinkTraversalEdge {
  from: string;
  to: string;
  type: string;
  weight?: number;
}

export interface BacklinkTraversalResult {
  edges: BacklinkTraversalEdge[];
  visitedArticleIds: string[];
}

export interface NuVectorGraphAdapter {
  upsertNodeWithEdges(spec: GraphNodeUpsert): Promise<void>;
  archiveNode(nodeId: string): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  traverse(request: BacklinkTraversalRequest): Promise<BacklinkTraversalResult>;
}

export interface NuVectorAdapter {
  // Source retrieval during compilation
  searchKnowledge(request: SearchKnowledgeRequest): Promise<ContextPack>;
  retrieveContext(query: RetrievalQuery): Promise<ContextPack>;

  // Atomic four-layer publish
  upsertBatch(records: MemoryRecord[]): Promise<UpsertRef[]>;
  graph: NuVectorGraphAdapter;
  markSuperseded(query: SupersedeQuery): Promise<void>;

  // Provenance
  remember(record: ProvenanceRecord): Promise<{ ref: string }>;

  // Erasure
  delete(query: NvDeletionQuery): Promise<NvDeletionResult>;

  // Invalidation events (NuWiki listens; surfacing here for completeness)
  subscribeToInvalidations(handler: InvalidationHandler): Unsubscribe;
}

// ---------------------------------------------------------------------------
// LLMAdapter — for compilation and embeddings
// ---------------------------------------------------------------------------

export interface LLMContextItem {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  context: LLMContextItem[];
  outputSchema?: unknown;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMGenerationResult {
  content: string;
  finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMAdapter {
  generate(request: LLMGenerationRequest): Promise<LLMGenerationResult>;
  embed(text: string): Promise<Float32Array>;
}

// ---------------------------------------------------------------------------
// DatabaseSourceAdapter — direct queries to the consumer's database
// ---------------------------------------------------------------------------

export interface DatabaseSourceQueryResult {
  rows: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface DatabaseSourceAdapter {
  query(query: { kind: string; payload: Record<string, unknown> }): Promise<DatabaseSourceQueryResult>;
}
