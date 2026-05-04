/**
 * Citation validation (WU 039).
 *
 * Pure / dependency-free validator for the LLM compilation output.
 * Runs at compile time (after LLM parse + token budget, before embed)
 * and again inside the integrity pass (WU 042) for the `uncited_claim`
 * finding kind.
 */

import type { LLMCompilationOutput } from './types.js';

// ---------------------------------------------------------------------------
// Issue surface
// ---------------------------------------------------------------------------

export type CitationValidationIssueKind =
  | 'orphan_section_citation_id'
  | 'orphan_citation'
  | 'source_not_retrieved'
  | 'empty_claim'
  | 'invalid_confidence';

export interface CitationValidationIssue {
  kind: CitationValidationIssueKind;
  /** Citation id, section key, or other identifying token. */
  ref: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CitationValidationReport {
  ok: boolean;
  issues: CitationValidationIssue[];
}

export class CitationValidationError extends Error {
  readonly report: CitationValidationReport;
  constructor(report: CitationValidationReport) {
    super(
      `Citation validation failed: ${report.issues.length} issue(s) — ` +
        report.issues.map((i) => `${i.kind}:${i.ref}`).join('; '),
    );
    this.report = report;
    this.name = 'CitationValidationError';
  }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * `retrievedSourceRefs` is the set of `ref` strings observed across the
 * compilation's resolved sources. The check at rule 3 is soft: a
 * citation whose source object has no `ref` (or whose source kind is
 * one we cannot match) is tolerated. The aim is to catch hallucinated
 * sources, not to over-constrain consumers whose source shape differs.
 */
export function validateCitations(
  parsed: LLMCompilationOutput,
  retrievedSourceRefs: ReadonlySet<string>,
): CitationValidationReport {
  const issues: CitationValidationIssue[] = [];

  const citationIds = new Set(parsed.citations.map((c) => c.id));
  const referencedCitationIds = new Set<string>();

  // Rule 1 — every section.citationIds[] entry resolves to a real citation
  for (const section of parsed.sections) {
    for (const cid of section.citationIds ?? []) {
      if (!citationIds.has(cid)) {
        issues.push({
          kind: 'orphan_section_citation_id',
          ref: cid,
          message: `Section '${section.key}' references citation '${cid}' that does not exist in citations[]`,
          details: { sectionKey: section.key, citationId: cid },
        });
      } else {
        referencedCitationIds.add(cid);
      }
    }
  }

  for (const citation of parsed.citations) {
    // Rule 2 — every citation is referenced by at least one section
    if (!referencedCitationIds.has(citation.id)) {
      issues.push({
        kind: 'orphan_citation',
        ref: citation.id,
        message: `Citation '${citation.id}' is not referenced by any section`,
      });
    }

    // Rule 3 — every citation source appears in retrieved sources (soft check)
    const sourceRef = extractSourceRef(citation.source);
    if (sourceRef && !retrievedSourceRefs.has(sourceRef)) {
      issues.push({
        kind: 'source_not_retrieved',
        ref: citation.id,
        message: `Citation '${citation.id}' references source '${sourceRef}' that was not retrieved during compilation`,
        details: { sourceRef },
      });
    }

    // Rule 4 — claim is non-empty
    if (!citation.claim || !citation.claim.trim()) {
      issues.push({
        kind: 'empty_claim',
        ref: citation.id,
        message: `Citation '${citation.id}' has an empty claim`,
      });
    }

    // Rule 5 — confidence is finite number in [0, 1]
    const conf = citation.confidence;
    if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      issues.push({
        kind: 'invalid_confidence',
        ref: citation.id,
        message: `Citation '${citation.id}' has invalid confidence: ${String(conf)}`,
        details: { confidence: conf },
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Source-ref extraction
// ---------------------------------------------------------------------------

/**
 * Extract the `ref` string from a citation source for soft matching.
 * NuVector's `SourceRef` shape carries either a `ref` string field
 * (`{ kind, ref }`) or a `recordId` field (`{ kind, recordId }`) in
 * various deployments. Falls back to undefined when neither is present
 * — the caller skips rule 3 in that case.
 */
function extractSourceRef(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const obj = source as Record<string, unknown>;
  if (typeof obj.ref === 'string') return obj.ref;
  if (typeof obj.recordId === 'string') return obj.recordId;
  if (typeof obj.id === 'string') return obj.id;
  return undefined;
}
