/**
 * WU 113a — render / splice / drift unit tests.
 *
 * Covers all three new public primitives per the acceptance criteria:
 *
 *   renderArticleMarkdown   — empty-sections, multi-section, per-region, front-matter,
 *                             RenderedArticle input, stable ordering
 *   spliceGeneratedRegions  — prose-preserved, missing-region-error,
 *                             malformed-sentinel-error, idempotency
 *   checkArticleDrift       — clean, drifted-generated-region,
 *                             hand-edited-generated-region, missing-region
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  renderArticleMarkdown,
  spliceGeneratedRegions,
  checkArticleDrift,
} = await import('../dist/src/index.js');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal LLMCompilationOutput with two sections. */
function makeStructuredBody(overrides = {}) {
  return {
    summary: 'An article about something important.',
    sections: [
      {
        key: 'overview',
        heading: 'Overview',
        text: 'This is the overview text.',
        citationIds: [],
        position: 0,
      },
      {
        key: 'details',
        heading: 'Details',
        text: 'These are the details.',
        citationIds: [],
        position: 1,
      },
    ],
    citations: [],
    outboundLinks: [],
    ...overrides,
  };
}

/** A minimal RenderedArticle. */
function makeRenderedArticle(body = '## Heading\n\nBody text.\n') {
  return {
    articleId: 'test:pupil:p1',
    documentType: 'test',
    subject: { kind: 'pupil', id: 'p1' },
    version: 'v1',
    freshness: { lastCompiledAt: '2026-06-01T00:00:00Z', isFresh: true },
    body,
    citations: [],
    outboundLinks: [],
    warnings: [],
    viewerRole: 'teacher',
    renderedAt: '2026-06-01T00:00:00Z',
  };
}

/** A sentinel config using HTML comments (the format STATE.md uses). */
const htmlSentinelConfig = {
  markerPattern: 'nuwiki:generated:{{key}}',
  openTemplate: '<!-- {{marker}}:start -->',
  closeTemplate: '<!-- {{marker}}:end -->',
};

/** Build a file string with a single sentinel-wrapped region. */
function buildFileWithRegion(key, regionContent, prose = '') {
  const open = `<!-- nuwiki:generated:${key}:start -->`;
  const close = `<!-- nuwiki:generated:${key}:end -->`;
  return `# File Header\n\n${prose}${open}\n${regionContent}${close}\n\nFinal prose.\n`;
}

// ---------------------------------------------------------------------------
// §1  renderArticleMarkdown
// ---------------------------------------------------------------------------

describe('§1 renderArticleMarkdown', () => {
  test('empty sections produces empty string', () => {
    const body = makeStructuredBody({ sections: [] });
    const result = renderArticleMarkdown(body);
    assert.equal(result, '');
  });

  test('single section renders heading and text', () => {
    const body = makeStructuredBody({
      sections: [{ key: 'only', heading: 'Only Section', text: 'Content here.', citationIds: [], position: 0 }],
    });
    const result = renderArticleMarkdown(body);
    assert.ok(result.includes('## Only Section'), 'heading present');
    assert.ok(result.includes('Content here.'), 'text present');
  });

  test('multi-section: stable ordering by position regardless of input order', () => {
    // Provide sections in reverse order — output must be position-sorted.
    const body = makeStructuredBody({
      sections: [
        { key: 'details', heading: 'Details', text: 'Details text.', citationIds: [], position: 1 },
        { key: 'overview', heading: 'Overview', text: 'Overview text.', citationIds: [], position: 0 },
      ],
    });
    const result = renderArticleMarkdown(body);
    const overviewIdx = result.indexOf('## Overview');
    const detailsIdx = result.indexOf('## Details');
    assert.ok(overviewIdx < detailsIdx, 'Overview (position 0) appears before Details (position 1)');
  });

  test('multi-section: both headings and texts appear', () => {
    const result = renderArticleMarkdown(makeStructuredBody());
    assert.ok(result.includes('## Overview'), 'Overview heading');
    assert.ok(result.includes('This is the overview text.'), 'overview text');
    assert.ok(result.includes('## Details'), 'Details heading');
    assert.ok(result.includes('These are the details.'), 'details text');
  });

  test('per-region output: only requested sections rendered', () => {
    const result = renderArticleMarkdown(makeStructuredBody(), { sections: ['details'] });
    assert.ok(!result.includes('## Overview'), 'Overview not in output');
    assert.ok(result.includes('## Details'), 'Details in output');
  });

  test('per-region output: empty result when requested key does not exist', () => {
    const result = renderArticleMarkdown(makeStructuredBody(), { sections: ['nonexistent'] });
    assert.equal(result, '');
  });

  test('front-matter prepended when option provided', () => {
    const result = renderArticleMarkdown(makeStructuredBody(), {
      frontMatter: { title: 'Test Article', version: 'v1' },
    });
    assert.ok(result.startsWith('---\n'), 'starts with front-matter fence');
    assert.ok(result.includes('title: Test Article'), 'title in front-matter');
    assert.ok(result.includes('version: v1'), 'version in front-matter');
    assert.ok(result.includes('## Overview'), 'body follows front-matter');
  });

  test('front-matter only (no sections) produces just the front-matter block', () => {
    const result = renderArticleMarkdown({ summary: '', sections: [], citations: [], outboundLinks: [] }, {
      frontMatter: { key: 'value' },
    });
    assert.ok(result.startsWith('---\n'), 'starts with front-matter fence');
    assert.ok(result.includes('key: value'), 'key in front-matter');
  });

  test('RenderedArticle input: body passed through', () => {
    const article = makeRenderedArticle('## Heading\n\nPre-rendered body.\n');
    const result = renderArticleMarkdown(article);
    assert.ok(result.includes('## Heading'), 'heading present');
    assert.ok(result.includes('Pre-rendered body.'), 'body text present');
  });

  test('output ends with a single trailing newline', () => {
    const result = renderArticleMarkdown(makeStructuredBody());
    assert.ok(result.endsWith('\n'), 'ends with newline');
    assert.ok(!result.endsWith('\n\n'), 'no double trailing newline');
  });
});

// ---------------------------------------------------------------------------
// §2  spliceGeneratedRegions
// ---------------------------------------------------------------------------

describe('§2 spliceGeneratedRegions', () => {
  test('authored prose outside sentinel regions is preserved byte-for-byte', () => {
    const prose = 'This is hand-authored prose that must never change.\n\n';
    const existingFile = buildFileWithRegion('active_wu', 'Old content.\n', prose);
    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { active_wu: 'New content.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    assert.ok(merged.includes('# File Header'), 'file header preserved');
    assert.ok(merged.includes(prose.trim()), 'authored prose preserved');
    assert.ok(merged.includes('Final prose.'), 'trailing prose preserved');
    assert.ok(!merged.includes('Old content.'), 'old region content replaced');
    assert.ok(merged.includes('New content.'), 'new region content present');
  });

  test('sentinel lines themselves are preserved verbatim', () => {
    const existingFile = buildFileWithRegion('status', 'Old.\n');
    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { status: 'New.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    assert.ok(merged.includes('<!-- nuwiki:generated:status:start -->'), 'open sentinel preserved');
    assert.ok(merged.includes('<!-- nuwiki:generated:status:end -->'), 'close sentinel preserved');
  });

  test('missing region key throws a clear error', () => {
    const existingFile = '# File\n\nNo sentinel here.\n';
    assert.throws(
      () =>
        spliceGeneratedRegions({
          existingFile,
          regions: { missing_key: 'content' },
          sentinelConfig: htmlSentinelConfig,
        }),
      /missing_key/,
      'error names the missing region key',
    );
  });

  test('malformed sentinel (opening present, closing absent) throws a clear error', () => {
    // File has opening sentinel but no closing sentinel.
    const existingFile =
      '# File\n\n<!-- nuwiki:generated:broken:start -->\nSome content.\n\nFinal prose.\n';
    assert.throws(
      () =>
        spliceGeneratedRegions({
          existingFile,
          regions: { broken: 'New content.' },
          sentinelConfig: htmlSentinelConfig,
        }),
      /broken/,
      'error names the malformed region key',
    );
  });

  test('idempotent: re-splicing identical content returns same string', () => {
    const existingFile = buildFileWithRegion('phase', 'Phase 5.\n');
    const first = spliceGeneratedRegions({
      existingFile,
      regions: { phase: 'Phase 5.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    // The content is identical, so merged === existingFile.
    assert.equal(first.merged, existingFile, 'merged === existingFile when content unchanged');
    assert.deepEqual(first.updatedRegions, [], 'no updated regions');
    assert.deepEqual(first.unchangedRegions, ['phase'], 'phase marked unchanged');
  });

  test('idempotent: second splice of result equals first splice', () => {
    const existingFile = buildFileWithRegion('phase', 'Old phase.\n');
    const first = spliceGeneratedRegions({
      existingFile,
      regions: { phase: 'New phase.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    const second = spliceGeneratedRegions({
      existingFile: first.merged,
      regions: { phase: 'New phase.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    assert.equal(second.merged, first.merged, 'second splice result equals first');
    assert.deepEqual(second.unchangedRegions, ['phase'], 'second splice is no-op');
  });

  test('multiple regions: each is updated independently', () => {
    const open1 = '<!-- nuwiki:generated:region_a:start -->';
    const close1 = '<!-- nuwiki:generated:region_a:end -->';
    const open2 = '<!-- nuwiki:generated:region_b:start -->';
    const close2 = '<!-- nuwiki:generated:region_b:end -->';
    const existingFile =
      `# Header\n\n${open1}\nOld A.\n${close1}\n\nMiddle prose.\n\n${open2}\nOld B.\n${close2}\n\nEnd.\n`;
    const { merged, updatedRegions } = spliceGeneratedRegions({
      existingFile,
      regions: { region_a: 'New A.\n', region_b: 'New B.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    assert.ok(merged.includes('New A.'), 'region_a updated');
    assert.ok(merged.includes('New B.'), 'region_b updated');
    assert.ok(merged.includes('Middle prose.'), 'middle prose preserved');
    assert.ok(!merged.includes('Old A.'), 'old region_a content gone');
    assert.ok(!merged.includes('Old B.'), 'old region_b content gone');
    assert.deepEqual(updatedRegions.sort(), ['region_a', 'region_b'], 'both regions in updatedRegions');
  });
});

// ---------------------------------------------------------------------------
// §3  checkArticleDrift
// ---------------------------------------------------------------------------

describe('§3 checkArticleDrift', () => {
  test('clean when all regions match expected', () => {
    const existingFile = buildFileWithRegion('status', 'Current status text.\n');
    const report = checkArticleDrift({
      file: existingFile,
      sentinelConfig: htmlSentinelConfig,
      expectedRegions: { status: 'Current status text.\n' },
    });
    assert.equal(report.clean, true);
    assert.equal(report.regions.length, 1);
    assert.equal(report.regions[0].status, 'clean');
    assert.equal(report.regions[0].key, 'status');
  });

  test('drifted when generated region content differs from expected', () => {
    const existingFile = buildFileWithRegion('active_wu', 'WU 112 — in progress.\n');
    const report = checkArticleDrift({
      file: existingFile,
      sentinelConfig: htmlSentinelConfig,
      expectedRegions: { active_wu: 'WU 113a — in progress.\n' },
    });
    assert.equal(report.clean, false);
    assert.equal(report.regions[0].status, 'drifted');
    assert.equal(report.regions[0].key, 'active_wu');
    assert.ok(report.regions[0].actualContent !== undefined, 'actualContent set on drift');
    assert.ok(report.regions[0].expectedContent !== undefined, 'expectedContent set on drift');
  });

  test('drifted when a region has been hand-edited (content differs from canonical)', () => {
    // Simulate: the generated region was hand-edited in the file.
    const existingFile = buildFileWithRegion('blockers', 'None.\n');
    const report = checkArticleDrift({
      file: existingFile,
      sentinelConfig: htmlSentinelConfig,
      // Canonical source says there IS a blocker; file says None.
      expectedRegions: { blockers: 'WU 114 blocked on missing adapter.\n' },
    });
    assert.equal(report.clean, false);
    assert.equal(report.regions[0].status, 'drifted');
    assert.ok(
      report.regions[0].actualContent?.includes('None.'),
      'actual (hand-edited) content reflected',
    );
    assert.ok(
      report.regions[0].expectedContent?.includes('WU 114'),
      'expected (canonical) content reflected',
    );
  });

  test('missing when sentinel not present in file', () => {
    const existingFile = '# File\n\nNo sentinels here.\n';
    const report = checkArticleDrift({
      file: existingFile,
      sentinelConfig: htmlSentinelConfig,
      expectedRegions: { missing_region: 'Some content.\n' },
    });
    assert.equal(report.clean, false);
    assert.equal(report.regions[0].status, 'missing');
    assert.equal(report.regions[0].key, 'missing_region');
  });

  test('multiple regions: mixed clean and drifted', () => {
    const open1 = '<!-- nuwiki:generated:r1:start -->';
    const close1 = '<!-- nuwiki:generated:r1:end -->';
    const open2 = '<!-- nuwiki:generated:r2:start -->';
    const close2 = '<!-- nuwiki:generated:r2:end -->';
    // r1 matches; r2 has been changed.
    const existingFile =
      `# Header\n\n${open1}\nCorrect content.\n${close1}\n\n${open2}\nStale content.\n${close2}\n`;
    const report = checkArticleDrift({
      file: existingFile,
      sentinelConfig: htmlSentinelConfig,
      expectedRegions: {
        r1: 'Correct content.\n',
        r2: 'Fresh content.\n',
      },
    });
    assert.equal(report.clean, false, 'not clean when any region drifted');
    const r1 = report.regions.find((r) => r.key === 'r1');
    const r2 = report.regions.find((r) => r.key === 'r2');
    assert.ok(r1, 'r1 in report');
    assert.ok(r2, 'r2 in report');
    assert.equal(r1.status, 'clean', 'r1 is clean');
    assert.equal(r2.status, 'drifted', 'r2 is drifted');
  });

  test('clean after a splice: drift is zero immediately after splicing', () => {
    const existingFile = buildFileWithRegion('phase', 'Phase 4.\n');
    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { phase: 'Phase 5a.\n' },
      sentinelConfig: htmlSentinelConfig,
    });
    const report = checkArticleDrift({
      file: merged,
      sentinelConfig: htmlSentinelConfig,
      expectedRegions: { phase: 'Phase 5a.\n' },
    });
    assert.equal(report.clean, true, 'no drift immediately after splice');
  });
});
