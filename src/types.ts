/**
 * NuWiki public type surface.
 *
 * Mirrors `nuos/docs/contracts/nuwiki.md` exactly. The types in this file are
 * the **stability contract** of `@nusoft/nuwiki` v0.1.0. The NuWiki authoritative
 * reference is the contract document; this file is the TypeScript projection.
 *
 * Adapter contracts (in `./adapters.ts`) consume `@nusoft/nuvector` types
 * verbatim — `ContextPack`, `RetrievalQuery`, `MemoryRecord`, `ProvenanceRecord`,
 * etc. are imported, not redefined.
 */

import type { SourceRef as NvSourceRef } from '@nusoft/nuvector';

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

export type ISODateString = string;

// SourceRef is shared verbatim with NuVector.
export type SourceRef = NvSourceRef;

// NuWiki's SubjectRef adds a human-readable label, matching NuFlow's shape.
// (NuVector's SubjectRef is `{ kind, id }`; NuWiki and NuFlow extend it with
// an optional `label` for rendering and audit.)
export interface SubjectRef {
  kind: string;
  id: string;
  label?: string;
}

export interface ActorRef {
  kind: string;
  id: string;
  displayName?: string;
  role?: string;
}

// ---------------------------------------------------------------------------
// Subject kinds
// ---------------------------------------------------------------------------

export type SubjectKind = 'pupil' | 'staff' | 'class' | 'group' | 'institution' | 'patient' | 'matter' | 'client' | string;

// ---------------------------------------------------------------------------
// Object storage references
// ---------------------------------------------------------------------------

export interface ObjectStorageRef {
  bucket?: string;
  key: string;
  contentType?: string;
  bytes?: number;
}

// ---------------------------------------------------------------------------
// Visibility / redaction
// ---------------------------------------------------------------------------

export interface VisibilityRule {
  defaultRoles: string[];
  excludedRoles?: string[];
  redactionRules?: Record<string, RoleRedactionRule>;
}

export interface RoleRedactionRule {
  role: string;
  action: 'hide' | 'redact' | 'summarise' | 'show';
  replacement?: string;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  retainForDays?: number;
  archiveOnSubjectExit: boolean;
  legalHoldHonoured: boolean;
}

// ---------------------------------------------------------------------------
// Article types
// ---------------------------------------------------------------------------

export type ArticleStatus = 'compiling' | 'published' | 'stale' | 'blocked' | 'archived';

export interface FreshnessIndicator {
  lastCompiledAt: ISODateString;
  lastSourceChangeAt?: ISODateString;
  isFresh: boolean;
  reason?: string;
}

export interface BacklinkSummary {
  inboundCount: number;
  outboundCount: number;
  recentlyAdded?: string[];
}

export interface NuWikiArticle {
  id: string;
  tenant: string;
  documentType: string;
  subject: SubjectRef;
  path: string;
  currentVersion: string;
  status: ArticleStatus;
  freshness: FreshnessIndicator;
  backlinks: BacklinkSummary;
  visibility: VisibilityRule;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Article versions
// ---------------------------------------------------------------------------

export type LinkType =
  | 'mentions'
  | 'supports_outcome'
  | 'contradicts'
  | 'supersedes'
  | 'related_to'
  | 'evidence_for'
  | string;

export interface SectionRecord {
  key: string;
  heading: string;
  text: string;
  embedding?: Float32Array;
  citationIds: string[];
  position: number;
}

export interface Citation {
  id: string;
  claim: string;
  source: SourceRef;
  retrievalId?: string;
  confidence: number;
  embedding?: Float32Array;
  position: { start: number; end: number };
}

export interface OutboundLink {
  toArticleId: string;
  linkType: LinkType;
  context: string;
  position: { start: number; end: number };
}

export type GenerationTrigger =
  | { kind: 'scheduled_refresh' }
  | { kind: 'workflow_commit'; workflowId: string; intentType: string }
  | { kind: 'source_changed'; sourceRef: SourceRef }
  | { kind: 'human_request'; actor: ActorRef; reason: string }
  | { kind: 'integrity_pass'; passId: string }
  | { kind: 'backlink_added'; fromArticleId: string };

export interface GenerationRecord {
  triggeredBy: GenerationTrigger;
  llmModel?: string;
  promptVersion?: string;
  sourceCount: number;
  retrievalIds: string[];
  generationDurationMs: number;
}

export interface NuWikiArticleVersion {
  id: string;
  articleId: string;
  version: string;
  bodyRef: ObjectStorageRef;
  bodyHash: string;
  summary: string;
  summaryEmbedding?: Float32Array;
  sections: SectionRecord[];
  citations: Citation[];
  outboundLinks: OutboundLink[];
  generatedBy: GenerationRecord;
  publishedAt?: ISODateString;
  archivedAt?: ISODateString;
  predecessorVersion?: string;
}

// ---------------------------------------------------------------------------
// DocumentType (with retrieval hints)
// ---------------------------------------------------------------------------

export interface RefreshTrigger {
  kind: 'workflow_commit' | 'schedule' | 'source_change' | 'manual' | string;
  workflowType?: string;
  intentType?: string;
  cron?: string;
  sourceKinds?: string[];
}

export interface SourceQuery {
  kind: 'database' | 'nuvector' | 'object_storage' | string;
  query: Record<string, unknown>;
  description?: string;
}

export interface DocumentSection {
  key: string;
  heading: string;
  required: boolean;
  redactionRules?: Record<string, RoleRedactionRule>;
}

export interface AgentReadingHints {
  primaryUseCases: string[];
  recommendedSectionsForQuery: Record<string, string[]>;
  followLinksFor?: LinkType[];
}

export interface RetrievalHints {
  summaryTokenBudget: number;
  primaryQueryUseCases: string[];
  sectionsPriorityForSummary: string[];
  embedSectionsWithSummaryPrefix: boolean;
  agentReadingHints?: AgentReadingHints;
}

export interface DocumentType {
  type: string;
  version: string;
  subjectKind: SubjectKind;
  description: string;
  sections: DocumentSection[];
  sourceQueries: SourceQuery[];
  refreshTriggers: RefreshTrigger[];
  visibility: VisibilityRule;
  retentionPolicy: RetentionPolicy;
  precisionIndexable: boolean;
  retrievalHints: RetrievalHints;
}

// ---------------------------------------------------------------------------
// Rendered article (what wiki.read() returns)
// ---------------------------------------------------------------------------

export interface RenderedCitation {
  citationId: string;
  inlineMarker: string;
  source: SourceRef;
  citationLabel: string;
  retrievable: boolean;
}

export interface RenderedLink {
  toArticleId: string;
  linkType: LinkType;
  toSubject: SubjectRef;
  toDocumentType: string;
  context: string;
}

export interface ArticleWarning {
  kind:
    | 'stale'
    | 'missing_evidence'
    | 'contradiction'
    | 'limited_view'
    | 'compilation_blocked'
    | 'over_budget_summary'
    | 'broken_backlink';
  message: string;
  details?: Record<string, unknown>;
}

export interface RenderedArticle {
  articleId: string;
  documentType: string;
  subject: SubjectRef;
  version: string;
  freshness: FreshnessIndicator;
  body: string;
  citations: RenderedCitation[];
  outboundLinks: RenderedLink[];
  warnings: ArticleWarning[];
  viewerRole: string;
  renderedAt: ISODateString;
  agentMetadata?: AgentReadingHints;
}

// ---------------------------------------------------------------------------
// Compile / refresh
// ---------------------------------------------------------------------------

export interface CompileRequest {
  documentType: string;
  subject: SubjectRef;
  trigger: GenerationTrigger;
  force?: boolean;
}

export interface CompilationResult {
  articleId: string;
  versionId: string;
  status: ArticleStatus;
  warnings: ArticleWarning[];
  publishedAt?: ISODateString;
  durationMs: number;
}

export interface RefreshRef {
  documentType: string;
  subject: SubjectRef;
  trigger?: GenerationTrigger;
}

export interface RefreshResult {
  articleId: string;
  refreshTriggered: boolean;
  versionId?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Read / followLinks
// ---------------------------------------------------------------------------

export interface ReadRequest {
  documentType: string;
  subject: SubjectRef;
  viewerRole: string;
  version?: string;
}

export interface FollowLinksRequest {
  fromArticleId: string;
  linkTypes?: LinkType[];
  maxDepth?: number;
  viewerRole: string;
}

// ---------------------------------------------------------------------------
// Integrity pass
// ---------------------------------------------------------------------------

export type IntegrityFindingKind =
  | 'missing_evidence'
  | 'contradiction'
  | 'stale_article'
  | 'broken_backlink'
  | 'uncited_claim'
  | 'orphan_article'
  | 'missing_index_entry'
  | 'duplicate_subject_articles';

export interface SuggestedAction {
  kind: 'recompile' | 'archive' | 'merge' | 'manual_review' | string;
  description: string;
  payload?: Record<string, unknown>;
}

export interface IntegrityFinding {
  kind: IntegrityFindingKind;
  articleId?: string;
  description: string;
  suggestedAction?: SuggestedAction;
  severity: 'info' | 'warning' | 'error';
}

export interface ResolvedFinding {
  finding: IntegrityFinding;
  resolution: string;
  resolvedAt: ISODateString;
}

export interface IntegrityPassRequest {
  scope: 'tenant' | 'subject' | 'documentType';
  subject?: SubjectRef;
  documentType?: string;
  checks: IntegrityFindingKind[];
  autoApplyRemediations?: IntegrityFindingKind[];
}

export interface IntegrityPassResult {
  passId: string;
  scope: 'tenant' | 'subject' | 'documentType';
  startedAt: ISODateString;
  completedAt: ISODateString;
  findings: IntegrityFinding[];
  resolved: ResolvedFinding[];
}

// ---------------------------------------------------------------------------
// Article suggestions
// ---------------------------------------------------------------------------

export interface SuggestionScope {
  scope: 'tenant' | 'subject' | 'documentType';
  subject?: SubjectRef;
  documentType?: string;
}

export interface ArticleSuggestion {
  documentType: string;
  subject: SubjectRef;
  rationale: string;
  evidenceRefs: SourceRef[];
  estimatedValue: 'high' | 'medium' | 'low';
  suggestedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// List / archive / delete / export
// ---------------------------------------------------------------------------

export interface ListFilters {
  documentType?: string;
  subjectKind?: SubjectKind;
  status?: ArticleStatus;
  freshness?: 'fresh' | 'stale' | 'any';
  tenant?: string;
  limit?: number;
}

export interface ArchiveRequest {
  documentType: string;
  subject: SubjectRef;
  reason?: string;
}

export interface DeletionQuery {
  ids?: string[];
  documentType?: string;
  subject?: SubjectRef;
  reason?: 'gdpr_erasure' | 'cleanup' | string;
}

export interface DeletionResult {
  deletedCount: number;
  affectedArticles: string[];
  vectorRecordsRemoved: number;
}

export type ExportFormat = 'pdf' | 'slides' | 'json' | 'html' | string;

export interface ExportRef {
  articleId: string;
  format: ExportFormat;
  ref: ObjectStorageRef;
  generatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// LLM compilation output (the structured shape the LLM is asked to return)
// ---------------------------------------------------------------------------

export interface LLMCompilationOutputSection {
  key: string;
  heading: string;
  text: string;
  citationIds: string[];
  position: number;
}

export interface LLMCompilationOutputCitation {
  id: string;
  claim: string;
  source: SourceRef;
  confidence: number;
  position: { start: number; end: number };
}

export interface LLMCompilationOutputLink {
  toArticleId: string;
  linkType: LinkType;
  context: string;
  position: { start: number; end: number };
}

export interface LLMCompilationOutput {
  summary: string;
  sections: LLMCompilationOutputSection[];
  citations: LLMCompilationOutputCitation[];
  outboundLinks: LLMCompilationOutputLink[];
}

// ---------------------------------------------------------------------------
// Knowledge ref (consumed by NuFlow)
// ---------------------------------------------------------------------------

export interface KnowledgeRef {
  documentType: string;
  subject: SubjectRef;
  refreshTriggered: boolean;
  documentId?: string;
}

// ---------------------------------------------------------------------------
// Workflow commit envelope (consumed by affectedDocuments)
// ---------------------------------------------------------------------------

export interface WorkflowCommitEnvelope {
  commitRef: string;
  recordType: string;
  recordId: string;
  committedAt: ISODateString;
}

export interface WorkflowIntentEnvelope {
  type: string;
  subjects: SubjectRef[];
}

// ---------------------------------------------------------------------------
// Render / splice / drift surface (WU 113a — D132 sanctioned)
// ---------------------------------------------------------------------------

/**
 * Options for `renderArticleMarkdown`.
 *
 * All fields are optional — calling with no options renders the full article.
 */
export interface RenderArticleMarkdownOptions {
  /**
   * Restrict output to these section keys only (by `section.key`).
   * Sections are still sorted by `position` within the subset.
   * If omitted, all sections are rendered.
   */
  sections?: string[];
  /**
   * When provided, a YAML-style front-matter block is prepended.
   * The value is an arbitrary record; callers control shape (e.g.
   * `{ title, documentType, subject, renderedAt }`).
   */
  frontMatter?: Record<string, unknown>;
}

/**
 * Configuration for a sentinel-delimited region scheme.
 *
 * A sentinel pair marks the start and end of a generated region in a file.
 * The sentinel format is caller-controlled — NuWiki core has no knowledge of
 * STATE.md's specific markers or any other consumer's scheme.
 *
 * Concrete example (STATE.md uses HTML-comment sentinels):
 * ```
 * {
 *   markerPattern: 'nuos:generated:{{key}}',
 *   openTemplate: '<!-- {{marker}}:start -->',
 *   closeTemplate: '<!-- {{marker}}:end -->',
 * }
 * ```
 * where `{{key}}` is replaced with the region key and `{{marker}}` is replaced
 * with the expanded marker string.
 */
export interface SentinelConfig {
  /**
   * Template for the marker name. `{{key}}` is replaced with the region key.
   * Example: `'nuos:generated:{{key}}'` → `'nuos:generated:active_wu'`
   */
  markerPattern: string;
  /**
   * Template for the opening sentinel line. `{{marker}}` is replaced with the
   * expanded marker name. Example: `'<!-- {{marker}}:start -->'`
   */
  openTemplate: string;
  /**
   * Template for the closing sentinel line. `{{marker}}` is replaced with the
   * expanded marker name. Example: `'<!-- {{marker}}:end -->'`
   */
  closeTemplate: string;
}

/**
 * Result of `spliceGeneratedRegions`.
 */
export interface SpliceResult {
  /** The merged file content with generated regions replaced. */
  merged: string;
  /** Keys of regions that were updated (content changed). */
  updatedRegions: string[];
  /** Keys of regions whose content was unchanged (idempotent). */
  unchangedRegions: string[];
}

/**
 * Per-region status reported by `checkArticleDrift`.
 */
export type RegionDriftStatus = 'clean' | 'drifted' | 'missing';

/**
 * Per-region entry in a `DriftReport`.
 */
export interface RegionDriftEntry {
  key: string;
  status: RegionDriftStatus;
  /**
   * Present when `status === 'drifted'`: the content currently in the file
   * differs from what the canonical source produces.
   */
  actualContent?: string;
  /**
   * Present when `status === 'drifted'`: what the canonical source produces.
   */
  expectedContent?: string;
}

/**
 * Result of `checkArticleDrift`.
 */
export interface DriftReport {
  /** True only when every expected region is present and matches the source. */
  clean: boolean;
  /** Per-region breakdown. */
  regions: RegionDriftEntry[];
}

// ---------------------------------------------------------------------------
// Re-export selected NuVector types so consumers don't need a direct dep
// ---------------------------------------------------------------------------

export type {
  ContextPack,
  MemoryRecord,
  ProvenanceRecord,
  RetrievalQuery,
  SearchKnowledgeRequest,
  UpsertRef,
  InvalidationHandler,
  Unsubscribe,
} from '@nusoft/nuvector';
