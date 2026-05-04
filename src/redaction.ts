/**
 * Role-aware redaction (WU 041).
 *
 * Pure renderer that applies article-level VisibilityRule.excludedRoles
 * and per-section RoleRedactionRule actions to produce a role-redacted
 * markdown body, citation list, and outbound-link list.
 *
 * Same input → same output. No I/O.
 */

import type {
  ArticleWarning,
  DocumentType,
  LinkType,
  LLMCompilationOutput,
  LLMCompilationOutputSection,
  RenderedCitation,
  RenderedLink,
  RoleRedactionRule,
  SubjectRef,
  VisibilityRule,
} from './types.js';

export interface RedactArticleInput {
  documentType: DocumentType;
  parsed: LLMCompilationOutput;
  viewerRole: string;
  /** Map of toArticleId → { subject, documentType } for hydrating outbound links. */
  linkTargets?: Record<string, { subject: SubjectRef; documentType: string }>;
}

export interface RedactArticleOutput {
  body: string;
  citations: RenderedCitation[];
  outboundLinks: RenderedLink[];
  warnings: ArticleWarning[];
}

export function redactArticle(input: RedactArticleInput): RedactArticleOutput {
  const { documentType, parsed, viewerRole } = input;
  const visibility = documentType.visibility;
  const linkTargets = input.linkTargets ?? {};

  // Article-level: explicitly excluded roles.
  if (visibility.excludedRoles?.includes(viewerRole)) {
    return hiddenArticle(viewerRole, 'role_excluded');
  }

  // Article-level: role not in defaultRoles AND no section redactionRules
  // mention the role → article is hidden.
  const roleInDefault = visibility.defaultRoles.includes(viewerRole);
  const roleMentionedInAnySectionRule = (documentType.sections ?? []).some(
    (s) => roleAppearsInRules(viewerRole, s.redactionRules),
  );
  if (!roleInDefault && !roleMentionedInAnySectionRule) {
    return hiddenArticle(viewerRole, 'role_not_in_default');
  }

  // Section-level: apply per-section RoleRedactionRule actions.
  const warnings: ArticleWarning[] = [];
  let anyRedaction = false;
  const visibleSectionKeys = new Set<string>();
  const lines: string[] = [];

  const sortedSections = [...parsed.sections].sort((a, b) => a.position - b.position);
  for (const section of sortedSections) {
    const sectionDef = (documentType.sections ?? []).find((s) => s.key === section.key);
    const rule = lookupRule(viewerRole, sectionDef?.redactionRules, visibility.redactionRules);
    const action = rule?.action ?? 'show';

    if (action === 'show') {
      lines.push(`## ${section.heading}`, '', section.text, '');
      visibleSectionKeys.add(section.key);
      continue;
    }

    anyRedaction = true;

    if (action === 'hide') {
      // Section omitted entirely. Citations and outbound links anchored to
      // this section are stripped below.
      continue;
    }

    if (action === 'redact') {
      const replacement = rule?.replacement ?? `[Section redacted: ${section.heading}]`;
      lines.push(`## ${section.heading}`, '', replacement, '');
      visibleSectionKeys.add(section.key);
      continue;
    }

    if (action === 'summarise') {
      const replacement = rule?.replacement ?? summariseSection(section, parsed.summary);
      lines.push(`## ${section.heading}`, '', replacement, '');
      visibleSectionKeys.add(section.key);
      continue;
    }
  }

  const body = lines.join('\n').trim() + '\n';

  // Citations: keep only those referenced by visible sections.
  const visibleCitationIds = new Set<string>();
  for (const section of parsed.sections) {
    if (!visibleSectionKeys.has(section.key)) continue;
    for (const cid of section.citationIds ?? []) visibleCitationIds.add(cid);
  }
  const citations: RenderedCitation[] = parsed.citations
    .filter((c) => visibleCitationIds.has(c.id))
    .map((c) => ({
      citationId: c.id,
      inlineMarker: `[^${c.id}]`,
      source: c.source,
      citationLabel: c.claim.length > 80 ? c.claim.slice(0, 77) + '…' : c.claim,
      retrievable: true,
    }));

  // Outbound links: keep only those whose context appears in a visible section.
  // At WU 041 outbound links are not anchored per-section in the parsed
  // output, so we keep all links when at least one section is visible.
  const outboundLinks: RenderedLink[] = visibleSectionKeys.size > 0
    ? parsed.outboundLinks.map((l) => ({
        toArticleId: l.toArticleId,
        linkType: l.linkType as LinkType,
        toSubject: linkTargets[l.toArticleId]?.subject ?? { kind: 'unknown', id: l.toArticleId },
        toDocumentType: linkTargets[l.toArticleId]?.documentType ?? 'unknown',
        context: l.context,
      }))
    : [];

  if (anyRedaction) {
    warnings.push({
      kind: 'limited_view',
      message: `Some sections are not visible to role '${viewerRole}'`,
      details: { viewerRole, visibleSectionKeys: [...visibleSectionKeys] },
    });
  }

  return { body, citations, outboundLinks, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hiddenArticle(viewerRole: string, reason: string): RedactArticleOutput {
  return {
    body: `[Article hidden for role: ${viewerRole}]\n`,
    citations: [],
    outboundLinks: [],
    warnings: [
      {
        kind: 'limited_view',
        message: `Article is not visible to role '${viewerRole}'`,
        details: { viewerRole, reason },
      },
    ],
  };
}

function roleAppearsInRules(
  viewerRole: string,
  rules?: Record<string, RoleRedactionRule>,
): boolean {
  if (!rules) return false;
  for (const r of Object.values(rules)) {
    if (r.role === viewerRole) return true;
  }
  return false;
}

function lookupRule(
  viewerRole: string,
  sectionRules: Record<string, RoleRedactionRule> | undefined,
  visibilityRules: Record<string, RoleRedactionRule> | undefined,
): RoleRedactionRule | undefined {
  // Section-level rules win over visibility-level rules.
  if (sectionRules) {
    for (const r of Object.values(sectionRules)) {
      if (r.role === viewerRole) return r;
    }
  }
  if (visibilityRules) {
    for (const r of Object.values(visibilityRules)) {
      if (r.role === viewerRole) return r;
    }
  }
  return undefined;
}

function summariseSection(section: LLMCompilationOutputSection, articleSummary: string): string {
  // Default summarise behaviour: derive a one-line stub from the section's
  // own text (first 120 chars) so the body still mentions the topic
  // without the full content. The fallback is the article summary.
  const trimmed = section.text.trim();
  if (trimmed.length === 0) return articleSummary;
  return trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
}
