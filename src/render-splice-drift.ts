/**
 * NuWiki core render / splice / drift primitives (WU 113a — D132).
 *
 * Three reusable, model-agnostic, STATE-agnostic functions:
 *
 *   renderArticleMarkdown  — deterministic markdown from a structured article
 *   spliceGeneratedRegions — merge generated content into sentinel regions of a file
 *   checkArticleDrift      — verify on-disk generated regions against expected content
 *
 * These functions have no knowledge of STATE.md, any specific sentinel format,
 * or any consumer domain. The caller supplies a `SentinelConfig` describing
 * its chosen marker scheme and the region keys it uses.
 */

import type {
  DriftReport,
  LLMCompilationOutput,
  RegionDriftEntry,
  RenderArticleMarkdownOptions,
  RenderedArticle,
  SentinelConfig,
  SpliceResult,
} from './types.js';

// ---------------------------------------------------------------------------
// renderArticleMarkdown
// ---------------------------------------------------------------------------

/**
 * Render a structured article body to a deterministic markdown string.
 *
 * Accepts either an `LLMCompilationOutput` (the structured form produced by
 * `seed()` or the compile engine) or a `RenderedArticle` (the read()-time
 * projection). Sections are always sorted by `position` ascending, providing
 * a stable ordering regardless of how the caller assembled the input.
 *
 * Options (all optional):
 * - `sections` — restrict to specific section keys; order preserved within subset
 * - `frontMatter` — prepend a YAML-style front-matter block
 *
 * @example
 * ```ts
 * import { renderArticleMarkdown } from '@nusoft/nuwiki';
 *
 * const md = renderArticleMarkdown(structuredBody);
 * // → "## Overview\n\nText here.\n\n## Details\n\nMore text.\n"
 *
 * const withFm = renderArticleMarkdown(structuredBody, {
 *   frontMatter: { title: 'My Article', renderedAt: new Date().toISOString() },
 * });
 * // → "---\ntitle: My Article\nrenderedAt: 2026-06-01T…\n---\n\n## Overview\n…"
 * ```
 */
export function renderArticleMarkdown(
  article: LLMCompilationOutput | RenderedArticle,
  options: RenderArticleMarkdownOptions = {},
): string {
  const rawSections = 'body' in article
    // RenderedArticle — body is pre-rendered markdown; no sections array exposed.
    // Treat body as a single pre-rendered block. Per-region options are not
    // applicable to RenderedArticle (the redaction layer already handled them).
    ? undefined
    : (article as LLMCompilationOutput).sections;

  let parts: string[] = [];

  if (rawSections !== undefined) {
    // LLMCompilationOutput path: stable section ordering by position.
    let sorted = [...rawSections].sort((a, b) => a.position - b.position);
    if (options.sections?.length) {
      const allowed = new Set(options.sections);
      sorted = sorted.filter((s) => allowed.has(s.key));
    }
    for (const s of sorted) {
      parts.push(`## ${s.heading}`, '', s.text, '');
    }
  } else {
    // RenderedArticle path: body is already a markdown string.
    const body = (article as RenderedArticle).body;
    if (body) {
      parts.push(body);
    }
  }

  const body = parts.join('\n').trim();
  const bodyText = body ? body + '\n' : '';

  if (!options.frontMatter) {
    return bodyText;
  }

  const fm = renderFrontMatter(options.frontMatter);
  return bodyText ? `${fm}\n${bodyText}` : fm;
}

function renderFrontMatter(fm: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    const scalar = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`${k}: ${scalar}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// spliceGeneratedRegions
// ---------------------------------------------------------------------------

/**
 * Arguments for `spliceGeneratedRegions`.
 */
export interface SpliceGeneratedRegionsArgs {
  /** The full current content of the target file. */
  existingFile: string;
  /**
   * Map of region key → new markdown content to write inside the sentinel pair.
   * The content should NOT include the sentinel lines themselves.
   */
  regions: Record<string, string>;
  /** The sentinel configuration describing how regions are delimited. */
  sentinelConfig: SentinelConfig;
}

/**
 * Merge generated region content into sentinel-delimited regions of a file.
 *
 * **Byte-preservation guarantee:** every byte outside the sentinel-delimited
 * regions is identical to the input. The only bytes that change are the content
 * lines between an opening sentinel line and its paired closing sentinel line.
 * The sentinel lines themselves are preserved verbatim.
 *
 * **Idempotent:** if the existing file already contains the exact content for
 * every region, the returned `merged` string is identical to `existingFile`.
 *
 * **Error conditions:**
 * - If a key in `regions` has no matching opening sentinel in `existingFile`,
 *   the function throws with a clear message naming the missing region.
 * - If a sentinel pair is malformed (opening found but no closing), the
 *   function throws with a clear message naming the malformed region.
 *
 * @example
 * ```ts
 * const { merged } = spliceGeneratedRegions({
 *   existingFile: currentStatemd,
 *   regions: { active_wu: '**WU 113a** — in progress\n' },
 *   sentinelConfig: {
 *     markerPattern: 'nuos:generated:{{key}}',
 *     openTemplate: '<!-- {{marker}}:start -->',
 *     closeTemplate: '<!-- {{marker}}:end -->',
 *   },
 * });
 * ```
 */
export function spliceGeneratedRegions(args: SpliceGeneratedRegionsArgs): SpliceResult {
  const { existingFile, regions, sentinelConfig } = args;

  // Validate that every requested region key has a sentinel pair in the file.
  for (const key of Object.keys(regions)) {
    const open = expandTemplate(sentinelConfig.openTemplate, sentinelConfig.markerPattern, key);
    if (!existingFile.includes(open)) {
      throw new Error(
        `spliceGeneratedRegions: opening sentinel not found for region "${key}". ` +
        `Expected to find: ${JSON.stringify(open)}`,
      );
    }
    const close = expandTemplate(sentinelConfig.closeTemplate, sentinelConfig.markerPattern, key);
    const openIdx = existingFile.indexOf(open);
    const closeIdx = existingFile.indexOf(close, openIdx);
    if (closeIdx === -1) {
      throw new Error(
        `spliceGeneratedRegions: closing sentinel not found for region "${key}". ` +
        `Expected to find: ${JSON.stringify(close)}`,
      );
    }
  }

  const updatedRegions: string[] = [];
  const unchangedRegions: string[] = [];

  // Process each region, rebuilding the file content.
  // We process regions in left-to-right file order to handle non-overlapping
  // replacements correctly with a single scan.
  let result = existingFile;

  // Collect all regions with their positions, sorted by occurrence order.
  const regionEntries = Object.entries(regions).map(([key, content]) => {
    const open = expandTemplate(sentinelConfig.openTemplate, sentinelConfig.markerPattern, key);
    const close = expandTemplate(sentinelConfig.closeTemplate, sentinelConfig.markerPattern, key);
    return { key, open, close, content };
  });

  // Sort by position of opening sentinel in the current result string.
  regionEntries.sort((a, b) => result.indexOf(a.open) - result.indexOf(b.open));

  for (const { key, open, close, content } of regionEntries) {
    const currentResult = result;
    const openIdx = currentResult.indexOf(open);
    if (openIdx === -1) {
      throw new Error(`spliceGeneratedRegions: sentinel for "${key}" not found during replacement`);
    }
    const afterOpen = openIdx + open.length;
    // The region content starts after the opening sentinel line (including its newline).
    const regionStart = currentResult.indexOf('\n', afterOpen);
    if (regionStart === -1) {
      throw new Error(`spliceGeneratedRegions: no newline after opening sentinel for "${key}"`);
    }
    const regionContentStart = regionStart + 1; // first byte of region body

    const closeIdx = currentResult.indexOf(close, regionContentStart);
    if (closeIdx === -1) {
      throw new Error(`spliceGeneratedRegions: closing sentinel for "${key}" not found during replacement`);
    }

    // The existing content between sentinel lines (may include trailing newline before close).
    const existingContent = currentResult.slice(regionContentStart, closeIdx);

    // Normalise: ensure new content ends with a newline so close sentinel is on its own line.
    const normalisedContent = content.endsWith('\n') ? content : content + '\n';

    if (existingContent === normalisedContent) {
      unchangedRegions.push(key);
      continue;
    }

    updatedRegions.push(key);
    result =
      currentResult.slice(0, regionContentStart) +
      normalisedContent +
      currentResult.slice(closeIdx);
  }

  return { merged: result, updatedRegions, unchangedRegions };
}

// ---------------------------------------------------------------------------
// checkArticleDrift
// ---------------------------------------------------------------------------

/**
 * Arguments for `checkArticleDrift`.
 */
export interface CheckArticleDriftArgs {
  /** The full current content of the on-disk file. */
  file: string;
  /** The sentinel configuration. */
  sentinelConfig: SentinelConfig;
  /**
   * Map of region key → the content the canonical source currently produces.
   * This is what `spliceGeneratedRegions` would write for each region.
   */
  expectedRegions: Record<string, string>;
}

/**
 * Verify that the generated regions of an on-disk file match what the
 * canonical source currently produces.
 *
 * Returns a `DriftReport`:
 * - `clean: true` when every expected region is present and its content
 *   matches the canonical source exactly.
 * - `clean: false` when any region is missing from the file or its content
 *   differs from expected. The `regions` array names the drifted region(s).
 *
 * This is a **disk-file-vs-source** check, distinct from `runIntegrityPass`
 * (which checks article freshness/staleness against the NuWiki store). It is
 * the surface the pre-commit hook calls.
 *
 * @example
 * ```ts
 * const report = checkArticleDrift({
 *   file: currentStatemd,
 *   sentinelConfig,
 *   expectedRegions: { active_wu: compiledActiveWuMarkdown },
 * });
 * if (!report.clean) {
 *   const drifted = report.regions.filter(r => r.status !== 'clean');
 *   console.error('Drift detected:', drifted.map(r => r.key).join(', '));
 * }
 * ```
 */
export function checkArticleDrift(args: CheckArticleDriftArgs): DriftReport {
  const { file, sentinelConfig, expectedRegions } = args;
  const regionEntries: RegionDriftEntry[] = [];
  let allClean = true;

  for (const [key, expected] of Object.entries(expectedRegions)) {
    const open = expandTemplate(sentinelConfig.openTemplate, sentinelConfig.markerPattern, key);
    const close = expandTemplate(sentinelConfig.closeTemplate, sentinelConfig.markerPattern, key);

    const openIdx = file.indexOf(open);
    if (openIdx === -1) {
      allClean = false;
      regionEntries.push({ key, status: 'missing' });
      continue;
    }

    const afterOpen = openIdx + open.length;
    const regionStart = file.indexOf('\n', afterOpen);
    if (regionStart === -1) {
      allClean = false;
      regionEntries.push({ key, status: 'missing' });
      continue;
    }
    const regionContentStart = regionStart + 1;

    const closeIdx = file.indexOf(close, regionContentStart);
    if (closeIdx === -1) {
      allClean = false;
      regionEntries.push({ key, status: 'missing' });
      continue;
    }

    const actualContent = file.slice(regionContentStart, closeIdx);
    const normalisedExpected = expected.endsWith('\n') ? expected : expected + '\n';

    if (actualContent === normalisedExpected) {
      regionEntries.push({ key, status: 'clean' });
    } else {
      allClean = false;
      regionEntries.push({
        key,
        status: 'drifted',
        actualContent,
        expectedContent: normalisedExpected,
      });
    }
  }

  return { clean: allClean, regions: regionEntries };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Expand a sentinel template for a specific region key.
 *
 * Replaces `{{key}}` in `markerPattern` to get the marker name, then
 * replaces `{{marker}}` in `template` with the marker name.
 */
function expandTemplate(template: string, markerPattern: string, key: string): string {
  const marker = markerPattern.replace('{{key}}', key);
  return template.replace('{{marker}}', marker);
}
