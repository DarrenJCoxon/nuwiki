/**
 * Integrity pass loop (WU 042).
 *
 * Walks articles in scope and runs the canonical check set
 * (nuwiki contract §408 / §835). Reuses validateCitations from WU 039
 * and BrokenLinkChecker from WU 040; adds new checkers for staleness,
 * orphan articles, duplicate subjects, and missing index entries.
 *
 * Auto-remediation is intentionally narrow at v0.1.0: only stale / uncited
 * findings are auto-fixable (re-run compile). Other remediations need
 * workflow approval.
 */

import type {
  MetadataAdapter,
  ObjectStorageAdapter,
  NuVectorAdapter,
  LLMAdapter,
  DatabaseSourceAdapter,
} from './adapters.js';
import type {
  CompileRequest,
  CompilationResult,
  DocumentType,
  IntegrityFinding,
  IntegrityFindingKind,
  IntegrityPassRequest,
  IntegrityPassResult,
  LLMCompilationOutput,
  NuWikiArticle,
  ResolvedFinding,
  SubjectRef,
} from './types.js';
import { validateCitations } from './citations.js';
import { BrokenLinkChecker } from './backlinks.js';

// ---------------------------------------------------------------------------
// Adapter bundle (the surface the pass needs)
// ---------------------------------------------------------------------------

export interface IntegrityPassAdapters {
  metadata: MetadataAdapter;
  bodies: ObjectStorageAdapter;
  memoryAdapter: NuVectorAdapter;
  llmAdapter: LLMAdapter;
  databaseSource?: DatabaseSourceAdapter;
  tenant: string;
  getDocumentType: (type: string) => DocumentType | undefined;
  /** Used to invoke wiki.compile during auto-remediation. */
  compile: (request: CompileRequest) => Promise<CompilationResult>;
  now?: () => string;
  idFactory?: () => string;
  /** How old (days) a no-link article must be before it counts as orphaned. Default 90. */
  orphanStaleAfterDays?: number;
}

// ---------------------------------------------------------------------------
// runIntegrityPass — orchestrator
// ---------------------------------------------------------------------------

export async function runIntegrityPass(
  adapters: IntegrityPassAdapters,
  request: IntegrityPassRequest,
): Promise<IntegrityPassResult> {
  const now = adapters.now ?? (() => new Date().toISOString());
  const id = adapters.idFactory ?? (() => `pass_${Math.random().toString(36).slice(2, 10)}`);
  const startedAt = now();
  const passId = id();

  const articles = await selectArticlesInScope(adapters.metadata, adapters.tenant, request);
  const findings: IntegrityFinding[] = [];

  // Cross-article checks (only run once per pass, not per article).
  const crossArticleKinds: ReadonlySet<IntegrityFindingKind> = new Set(['duplicate_subject_articles']);

  for (const article of articles) {
    for (const kind of request.checks) {
      if (crossArticleKinds.has(kind)) continue;
      const checker = IntegrityCheckers[kind];
      if (!checker) continue;
      const out = await Promise.resolve(checker(article, adapters, articles));
      findings.push(...out);
    }
  }

  for (const kind of request.checks) {
    if (!crossArticleKinds.has(kind)) continue;
    const checker = IntegrityCheckers[kind];
    if (!checker) continue;
    const out = await Promise.resolve(checker(null, adapters, articles));
    findings.push(...out);
  }

  // Auto-remediation
  const resolved: ResolvedFinding[] = [];
  if (request.autoApplyRemediations?.length) {
    for (const finding of findings) {
      if (!request.autoApplyRemediations.includes(finding.kind)) continue;
      const resolution = await applyAutoRemediation(finding, adapters);
      if (resolution) {
        resolved.push({ finding, resolution, resolvedAt: now() });
      }
    }
  }

  return {
    passId,
    scope: request.scope,
    startedAt,
    completedAt: now(),
    findings,
    resolved,
  };
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

async function selectArticlesInScope(
  metadata: MetadataAdapter,
  tenant: string,
  request: IntegrityPassRequest,
): Promise<NuWikiArticle[]> {
  const all = await metadata.listArticles({ tenant });
  if (request.scope === 'tenant') return all;
  if (request.scope === 'documentType') {
    return all.filter((a) => a.documentType === request.documentType);
  }
  if (request.scope === 'subject' && request.subject) {
    return all.filter(
      (a) => a.subject.kind === request.subject!.kind && a.subject.id === request.subject!.id,
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Per-kind checkers
// ---------------------------------------------------------------------------

type Checker = (
  article: NuWikiArticle | null,
  adapters: IntegrityPassAdapters,
  allArticles: NuWikiArticle[],
) => Promise<IntegrityFinding[]> | IntegrityFinding[];

export const IntegrityCheckers: Record<string, Checker> = {
  async missing_evidence(article, adapters) {
    if (!article) return [];
    const findings: IntegrityFinding[] = [];
    if (article.status === 'blocked') {
      findings.push({
        kind: 'missing_evidence',
        articleId: article.id,
        description: `Article '${article.id}' is blocked`,
        severity: 'error',
        suggestedAction: { kind: 'recompile', description: 'Re-run wiki.compile() to retry compilation' },
      });
    }
    // Forward-write orphan check: version exists in metadata but the .json
    // companion is missing from object storage.
    const versionId = `${article.documentType}/${article.subject.id}/${article.currentVersion}`;
    const structuredKey = `nuwiki/${adapters.tenant}/${article.id}/${versionId}.json`;
    try {
      const exists = await adapters.bodies.exists({ key: structuredKey });
      if (!exists) {
        findings.push({
          kind: 'missing_evidence',
          articleId: article.id,
          description: `Article '${article.id}' version body missing from object storage (forward-write orphan)`,
          severity: 'warning',
          suggestedAction: { kind: 'recompile', description: 'Re-run wiki.compile() to rewrite the body' },
        });
      }
    } catch {
      // exists() not implemented or threw — skip silently
    }
    return findings;
  },

  contradiction() {
    // v0.1.0: deferred. Contradictions require LLM judgment against
    // the source corpus and belong in a richer pass.
    return [];
  },

  stale_article(article) {
    if (!article) return [];
    const isStale =
      !article.freshness.isFresh ||
      (article.freshness.lastSourceChangeAt &&
        article.freshness.lastSourceChangeAt > article.freshness.lastCompiledAt);
    if (!isStale) return [];
    return [
      {
        kind: 'stale_article',
        articleId: article.id,
        description: article.freshness.reason
          ? `Article '${article.id}' is stale: ${article.freshness.reason}`
          : `Article '${article.id}' is stale`,
        severity: 'warning',
        suggestedAction: {
          kind: 'recompile',
          description: 'Re-run wiki.compile() to refresh against current sources',
        },
      },
    ];
  },

  async broken_backlink(article, adapters) {
    if (!article) return [];
    // Read the article's stored outbound links from the .json companion.
    const versionId = `${article.documentType}/${article.subject.id}/${article.currentVersion}`;
    const structuredKey = `nuwiki/${adapters.tenant}/${article.id}/${versionId}.json`;
    let parsed: LLMCompilationOutput;
    try {
      const json = await adapters.bodies.get({ key: structuredKey });
      parsed = JSON.parse(json);
    } catch {
      return [];
    }
    const checker = new BrokenLinkChecker(adapters.metadata);
    const report = await checker.check(
      parsed.outboundLinks.map((l) => ({ toArticleId: l.toArticleId, linkType: l.linkType })),
    );
    return report.brokenLinks.map((b) => ({
      kind: 'broken_backlink' as IntegrityFindingKind,
      articleId: article.id,
      description: `Outbound link from '${article.id}' to '${b.toArticleId}' is ${b.reason}`,
      severity: 'warning',
      suggestedAction: { kind: 'manual_review', description: 'Inspect the link target and either restore or remove the link' },
    }));
  },

  async uncited_claim(article, adapters) {
    if (!article) return [];
    const versionId = `${article.documentType}/${article.subject.id}/${article.currentVersion}`;
    const structuredKey = `nuwiki/${adapters.tenant}/${article.id}/${versionId}.json`;
    let parsed: LLMCompilationOutput;
    try {
      const json = await adapters.bodies.get({ key: structuredKey });
      parsed = JSON.parse(json);
    } catch {
      return [];
    }
    // Pass an empty retrievedSourceRefs — at integrity-pass time we
    // don't have the original retrieval set. Rule 3 (source_not_retrieved)
    // becomes noisy when checked offline, so we skip it by including all
    // citation source refs in the retrieved set (effectively disabling rule 3).
    const allRefs = new Set<string>();
    for (const c of parsed.citations) {
      const ref = (c.source as unknown as Record<string, unknown>).ref;
      if (typeof ref === 'string') allRefs.add(ref);
    }
    const report = validateCitations(parsed, allRefs);
    if (report.ok) return [];
    return report.issues.map((issue) => ({
      kind: 'uncited_claim' as IntegrityFindingKind,
      articleId: article.id,
      description: `Citation issue in '${article.id}': ${issue.message}`,
      severity: 'error',
      suggestedAction: { kind: 'recompile', description: 'Re-run wiki.compile() to regenerate citations' },
    }));
  },

  async orphan_article(article, adapters, allArticles) {
    if (!article) return [];
    const orphanStaleAfterDays = adapters.orphanStaleAfterDays ?? 90;
    // Has any other article's outbound links target this one?
    let hasInbound = false;
    for (const other of allArticles) {
      if (other.id === article.id) continue;
      try {
        const versionId = `${other.documentType}/${other.subject.id}/${other.currentVersion}`;
        const json = await adapters.bodies.get({
          key: `nuwiki/${adapters.tenant}/${other.id}/${versionId}.json`,
        });
        const parsed = JSON.parse(json) as LLMCompilationOutput;
        if (parsed.outboundLinks.some((l) => l.toArticleId === article.id)) {
          hasInbound = true;
          break;
        }
      } catch {
        // skip missing bodies
      }
    }
    if (hasInbound) return [];
    // Has this article got any outbound links?
    const versionId = `${article.documentType}/${article.subject.id}/${article.currentVersion}`;
    let hasOutbound = false;
    try {
      const json = await adapters.bodies.get({
        key: `nuwiki/${adapters.tenant}/${article.id}/${versionId}.json`,
      });
      const parsed = JSON.parse(json) as LLMCompilationOutput;
      hasOutbound = parsed.outboundLinks.length > 0;
    } catch {
      // missing body is its own missing_evidence finding
    }
    if (hasOutbound) return [];
    // Is it old enough to count as orphaned?
    const compiledAt = Date.parse(article.freshness.lastCompiledAt);
    const ageDays = (Date.now() - compiledAt) / (1000 * 60 * 60 * 24);
    if (ageDays < orphanStaleAfterDays) return [];
    return [
      {
        kind: 'orphan_article' as IntegrityFindingKind,
        articleId: article.id,
        description: `Article '${article.id}' has no inbound or outbound links and is ${Math.round(ageDays)} days old`,
        severity: 'info',
        suggestedAction: { kind: 'manual_review', description: 'Consider archiving if no longer relevant' },
      },
    ];
  },

  missing_index_entry() {
    // v0.1.0: deferred. Probing NuVector layer 1 for a specific article id
    // requires a lookup-by-id surface that isn't on the adapter at v0.1.0.
    return [];
  },

  duplicate_subject_articles(_article, _adapters, allArticles) {
    const groups = new Map<string, NuWikiArticle[]>();
    for (const a of allArticles) {
      if (a.status === 'archived') continue;
      const key = `${a.documentType}::${a.subject.kind}::${a.subject.id}`;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    const findings: IntegrityFinding[] = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      findings.push({
        kind: 'duplicate_subject_articles',
        description: `${list.length} non-archived articles share subject '${key}': ${list.map((a) => a.id).join(', ')}`,
        severity: 'error',
        suggestedAction: {
          kind: 'merge',
          description: 'Merge or archive duplicates so a single canonical article remains',
          payload: { articleIds: list.map((a) => a.id) },
        },
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Auto-remediation
// ---------------------------------------------------------------------------

const AUTO_REMEDIATION_KINDS: Set<IntegrityFindingKind> = new Set([
  'stale_article',
  'uncited_claim',
]);

export async function applyAutoRemediation(
  finding: IntegrityFinding,
  adapters: IntegrityPassAdapters,
): Promise<string | undefined> {
  if (!AUTO_REMEDIATION_KINDS.has(finding.kind)) return undefined;
  if (!finding.articleId) return undefined;
  // Look up the article so we can re-derive documentType + subject.
  const articles = await adapters.metadata.listArticles({ tenant: adapters.tenant });
  const article = articles.find((a) => a.id === finding.articleId);
  if (!article) return undefined;
  const result = await adapters.compile({
    documentType: article.documentType,
    subject: article.subject,
    trigger: { kind: 'integrity_pass', passId: 'auto' },
  });
  if (result.status === 'published') {
    return `Recompiled article ${finding.articleId} to version ${result.versionId}`;
  }
  return undefined;
}

export async function applyAutoRemediations(
  adapters: IntegrityPassAdapters,
  findings: IntegrityFinding[],
  request: IntegrityPassRequest,
): Promise<ResolvedFinding[]> {
  const out: ResolvedFinding[] = [];
  if (!request.autoApplyRemediations?.length) return out;
  const now = adapters.now ?? (() => new Date().toISOString());
  for (const finding of findings) {
    if (!request.autoApplyRemediations.includes(finding.kind)) continue;
    const resolution = await applyAutoRemediation(finding, adapters);
    if (resolution) out.push({ finding, resolution, resolvedAt: now() });
  }
  return out;
}

// Note: SubjectRef import retained as a type-only via NuWikiArticle.subject usage above.
export type _SubjectRefRefAlias = SubjectRef;
