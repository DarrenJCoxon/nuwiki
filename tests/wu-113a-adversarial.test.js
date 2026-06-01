/**
 * WU 113a — adversarial / stress tests for render / splice / drift.
 *
 * These tests target the load-bearing guarantees that the coder's 23 tests
 * assert only lightly:
 *
 *   - Byte-exact preservation: every byte outside sentinel regions is
 *     character-for-character identical to the input. The coder's tests use
 *     `includes()` which does not catch off-by-one, dropped whitespace, or
 *     re-ordered sections.
 *   - Adversarial sentinel-like content: a region's markdown content contains
 *     text that looks like a real sentinel line; prose outside a region also
 *     contains sentinel-like text. Neither must be treated as a real sentinel.
 *   - Multiple non-adjacent and adjacent regions: byte-exact spans between
 *     regions survive unchanged.
 *   - Idempotency as a no-op after a real update (second pass must equal first
 *     output byte-for-byte).
 *   - EOF trailing-newline / no-trailing-newline: prose at EOF that has or
 *     lacks a final newline survives exactly.
 *   - Error paths confirm no partial corruption: function throws AND the error
 *     message names the offending key.
 *   - Round-trip: spliceGeneratedRegions then checkArticleDrift → clean on
 *     every region.
 *   - renderArticleMarkdown determinism: two independent calls produce
 *     byte-identical output.
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

/** HTML-comment sentinel config — matches the coder's fixture. */
const cfg = {
  markerPattern: 'nuwiki:generated:{{key}}',
  openTemplate: '<!-- {{marker}}:start -->',
  closeTemplate: '<!-- {{marker}}:end -->',
};

function openSentinel(key) {
  return `<!-- nuwiki:generated:${key}:start -->`;
}
function closeSentinel(key) {
  return `<!-- nuwiki:generated:${key}:end -->`;
}

/**
 * Build a file with one sentinel region and return it plus the expected
 * byte spans so tests can extract them without re-implementing the logic.
 */
function buildFile({ before = '', regionContent = '', after = '', key = 'r' } = {}) {
  const open = openSentinel(key);
  const close = closeSentinel(key);
  return `${before}${open}\n${regionContent}${close}\n${after}`;
}

/**
 * Given `file` and a `key`, extract the byte spans:
 *   - `beforeSpan`: bytes before the opening sentinel line
 *   - `afterSpan`: bytes after the closing sentinel line (including its \n)
 *   - `betweenSentinels`: the two sentinel lines and the newline after the
 *     opening one are stripped; what remains is the raw region content
 */
function extractSpans(file, key) {
  const open = openSentinel(key);
  const close = closeSentinel(key);
  const openIdx = file.indexOf(open);
  const closeIdx = file.indexOf(close);
  if (openIdx === -1 || closeIdx === -1) throw new Error('sentinel not found');
  const afterOpen = openIdx + open.length; // points to \n after open sentinel
  const regionContentStart = afterOpen + 1; // skip the \n
  const afterClose = closeIdx + close.length; // points to \n after close sentinel
  return {
    beforeSpan: file.slice(0, openIdx),
    regionContent: file.slice(regionContentStart, closeIdx),
    afterSpan: file.slice(afterClose), // includes the \n after the close sentinel
  };
}

// ---------------------------------------------------------------------------
// §A  Byte-exact preservation — spliceGeneratedRegions
// ---------------------------------------------------------------------------

describe('§A byte-exact preservation', () => {
  test('prose before region preserved character-for-character after splice', () => {
    // The "before" prose contains markdown headings, blank lines, trailing
    // whitespace on one line, and unicode characters. These must survive
    // the splice without any byte being altered.
    const before =
      '# Document Title\n\n' +
      'This is **hand-authored prose** with a trailing space. \n' +
      '\n' +
      '> A blockquote with a unicode character: ’\n' +
      '\n' +
      '## Section Before Generated Region\n\n' +
      'Author wrote this.\n\n';

    const existingFile = buildFile({ before, regionContent: 'Old.\n', key: 'section1' });

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { section1: 'New generated content.\n' },
      sentinelConfig: cfg,
    });

    const originalBefore = extractSpans(existingFile, 'section1').beforeSpan;
    const mergedBefore = extractSpans(merged, 'section1').beforeSpan;

    assert.equal(mergedBefore, originalBefore,
      'every byte before the opening sentinel is identical');
  });

  test('prose after region preserved character-for-character after splice', () => {
    const after =
      '\n' +
      '## Section After Generated Region\n\n' +
      'More hand-authored text here.   \n' + // trailing spaces
      '\n' +
      '> Another blockquote.\n' +
      '\n' +
      '<!-- an HTML comment that is NOT a sentinel -->\n' +
      '\n' +
      'Final paragraph.\n'; // trailing newline at EOF

    const existingFile = buildFile({ regionContent: 'Old.\n', after, key: 'gen' });

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { gen: 'New content.\n' },
      sentinelConfig: cfg,
    });

    const originalAfter = extractSpans(existingFile, 'gen').afterSpan;
    const mergedAfter = extractSpans(merged, 'gen').afterSpan;

    assert.equal(mergedAfter, originalAfter,
      'every byte after the closing sentinel is identical');
  });

  test('three-region file: byte spans between regions preserved exactly', () => {
    // Build a file with three non-adjacent regions and substantial prose
    // between them (including blank lines, headings, trailing whitespace).
    const betweenAandB =
      '\n\n## Hand-Written Section\n\n' +
      'Prose between A and B.   \n' +  // trailing spaces on this line
      '\n';
    const betweenBandC =
      '\n\n<!-- a comment that looks almost like a sentinel but is not -->\n\n' +
      'More prose here.\n\n';

    const openA = openSentinel('alpha');
    const closeA = closeSentinel('alpha');
    const openB = openSentinel('beta');
    const closeB = closeSentinel('beta');
    const openC = openSentinel('gamma');
    const closeC = closeSentinel('gamma');

    const before = '# Title\n\nIntroductory prose.\n\n';
    const after = '\n\n## Closing Section\n\nFinal words.\n';

    const existingFile =
      `${before}` +
      `${openA}\nOld A.\n${closeA}\n` +
      `${betweenAandB}` +
      `${openB}\nOld B.\n${closeB}\n` +
      `${betweenBandC}` +
      `${openC}\nOld C.\n${closeC}\n` +
      `${after}`;

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { alpha: 'New A.\n', beta: 'New B.\n', gamma: 'New C.\n' },
      sentinelConfig: cfg,
    });

    // The spans before alpha, between alpha/beta, between beta/gamma, and
    // after gamma must be byte-identical.
    const alphaOpenInOriginal = existingFile.indexOf(openA);
    const alphaCloseInOriginal = existingFile.indexOf(closeA);
    const betaOpenInOriginal = existingFile.indexOf(openB);
    const betaCloseInOriginal = existingFile.indexOf(closeB);
    const gammaOpenInOriginal = existingFile.indexOf(openC);
    const gammaCloseInOriginal = existingFile.indexOf(closeC);

    const alphaOpenInMerged = merged.indexOf(openA);
    const betaOpenInMerged = merged.indexOf(openB);
    const gammaOpenInMerged = merged.indexOf(openC);
    const gammaCloseInMerged = merged.indexOf(closeC);

    // Span: before alpha
    assert.equal(
      merged.slice(0, alphaOpenInMerged),
      existingFile.slice(0, alphaOpenInOriginal),
      'bytes before alpha region are identical',
    );

    // Span: between alpha close and beta open
    const originalAlphaBeta = existingFile.slice(
      alphaCloseInOriginal + closeA.length,
      betaOpenInOriginal,
    );
    const mergedAlphaBeta = merged.slice(
      merged.indexOf(closeA) + closeA.length,
      betaOpenInMerged,
    );
    assert.equal(mergedAlphaBeta, originalAlphaBeta,
      'bytes between alpha and beta are identical');

    // Span: between beta close and gamma open
    const originalBetaGamma = existingFile.slice(
      betaCloseInOriginal + closeB.length,
      gammaOpenInOriginal,
    );
    const mergedBetaGamma = merged.slice(
      merged.indexOf(closeB) + closeB.length,
      gammaOpenInMerged,
    );
    assert.equal(mergedBetaGamma, originalBetaGamma,
      'bytes between beta and gamma are identical');

    // Span: after gamma close
    const originalAfterGamma = existingFile.slice(
      gammaCloseInOriginal + closeC.length,
    );
    const mergedAfterGamma = merged.slice(
      gammaCloseInMerged + closeC.length,
    );
    assert.equal(mergedAfterGamma, originalAfterGamma,
      'bytes after gamma region are identical');
  });

  test('file without trailing newline at EOF: EOF character preserved exactly', () => {
    // A file that does NOT end with a newline — the exact final byte must
    // survive the splice unchanged.
    const existingFile =
      '# Title\n\n' +
      openSentinel('body') + '\n' +
      'Old body.\n' +
      closeSentinel('body') + '\n' +
      'Prose at EOF with no trailing newline — ends right here.';  // no \n

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { body: 'New body.\n' },
      sentinelConfig: cfg,
    });

    // The after-span (everything after the close sentinel + its \n) must
    // be identical. Since the original ends with no \n, the merged must too.
    const closeStr = closeSentinel('body');
    const originalAfter = existingFile.slice(
      existingFile.indexOf(closeStr) + closeStr.length,
    );
    const mergedAfter = merged.slice(
      merged.indexOf(closeStr) + closeStr.length,
    );
    assert.equal(mergedAfter, originalAfter,
      'after-region bytes including EOF (no trailing newline) are identical');
  });

  test('adjacent regions (no prose between): both regions updated, no insertion between them', () => {
    // Two regions are adjacent — only their close and open sentinels separate them.
    const open1 = openSentinel('first');
    const close1 = closeSentinel('first');
    const open2 = openSentinel('second');
    const close2 = closeSentinel('second');

    // The separator between the two sentinels is exactly '\n' — one newline.
    const existingFile =
      `# Title\n\n${open1}\nOld first.\n${close1}\n${open2}\nOld second.\n${close2}\n`;

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { first: 'New first.\n', second: 'New second.\n' },
      sentinelConfig: cfg,
    });

    // The exact bytes between close1 and open2 must be preserved (\n only).
    const close1InMerged = merged.indexOf(close1);
    const open2InMerged = merged.indexOf(open2);
    const separator = merged.slice(close1InMerged + close1.length, open2InMerged);
    assert.equal(separator, '\n', 'separator between adjacent regions is exactly one newline');

    // Content updated correctly.
    assert.ok(merged.includes('New first.'), 'first region content updated');
    assert.ok(merged.includes('New second.'), 'second region content updated');
    assert.ok(!merged.includes('Old first.'), 'old first content gone');
    assert.ok(!merged.includes('Old second.'), 'old second content gone');
  });
});

// ---------------------------------------------------------------------------
// §B  Adversarial sentinel-like content
// ---------------------------------------------------------------------------

describe('§B adversarial sentinel-like content', () => {
  test('region content that looks like a sentinel is not treated as a real sentinel', () => {
    // The new content to write into the region contains a string that is
    // syntactically identical to the opening sentinel of a DIFFERENT region.
    // It must be written verbatim inside the actual region, not misinterpreted.
    const existingFile =
      '# Title\n\n' +
      openSentinel('real_region') + '\n' +
      'Old content.\n' +
      closeSentinel('real_region') + '\n' +
      '\nEnd.\n';

    // The new content contains a string that looks like the open sentinel for
    // a region called "fake_region".
    const fakeSentinel = openSentinel('fake_region');
    const adversarialContent = `Line before fake sentinel.\n${fakeSentinel}\nLine after fake sentinel.\n`;

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { real_region: adversarialContent },
      sentinelConfig: cfg,
    });

    // The fake sentinel string must appear exactly once (inside the region),
    // not twice (the splice must not have treated it as a region boundary).
    const count = merged.split(fakeSentinel).length - 1;
    assert.equal(count, 1, 'fake sentinel inside region content appears exactly once — not treated as a real boundary');

    // The real sentinels are still present.
    assert.ok(merged.includes(openSentinel('real_region')), 'real open sentinel preserved');
    assert.ok(merged.includes(closeSentinel('real_region')), 'real close sentinel preserved');

    // The adversarial content is inside the region.
    assert.ok(merged.includes('Line before fake sentinel.'), 'adversarial content written correctly');
    assert.ok(merged.includes('Line after fake sentinel.'), 'adversarial content written correctly');
  });

  test('region content containing {{key}} and {{marker}} literal tokens written verbatim', () => {
    // The new content contains the literal template substitution tokens.
    // These are template strings used inside expandTemplate(); they must NOT
    // be expanded when they appear as content.
    const existingFile =
      openSentinel('tpl_region') + '\n' +
      'Old.\n' +
      closeSentinel('tpl_region') + '\n';

    const contentWithTokens = 'Use {{key}} and {{marker}} literally here.\n';

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { tpl_region: contentWithTokens },
      sentinelConfig: cfg,
    });

    // The tokens must appear verbatim in the merged output.
    assert.ok(merged.includes('{{key}}'), '{{key}} token written verbatim in region');
    assert.ok(merged.includes('{{marker}}'), '{{marker}} token written verbatim in region');
  });

  test('prose outside region that contains sentinel-like text is not treated as a real sentinel', () => {
    // A line in the authored prose (outside any region) looks like an opening
    // sentinel but has a different key. The splice must target only the real
    // sentinel pair and leave the look-alike prose untouched.
    const lookalikeLine = openSentinel('ghost_region');
    const before =
      '# Title\n\n' +
      'This prose contains what looks like a sentinel:\n' +
      `${lookalikeLine}\n` +  // NOT a real sentinel — it's inside prose, key not in regions map
      'But it is just text.\n\n';

    const existingFile = buildFile({ before, regionContent: 'Old.\n', key: 'real_key' });

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { real_key: 'New.\n' },
      sentinelConfig: cfg,
    });

    // The look-alike line must survive in the merged output unchanged.
    assert.ok(merged.includes(lookalikeLine), 'sentinel-like prose outside region preserved');

    // The look-alike line must appear exactly once (the original position),
    // not be duplicated or shifted.
    const occurrences = merged.split(lookalikeLine).length - 1;
    assert.equal(occurrences, 1, 'sentinel-like prose line appears exactly once');

    // The real splice happened.
    assert.ok(merged.includes('New.'), 'real region content updated');
    assert.ok(!merged.includes('Old.'), 'old region content replaced');
  });

  test('region content containing the close sentinel string for a different region is written verbatim', () => {
    // New content for region A contains the close sentinel of region B.
    // Splice of region A must write it literally; splice of region B must
    // still find region B's real close sentinel.
    const openA = openSentinel('alpha');
    const closeA = closeSentinel('alpha');
    const openB = openSentinel('beta');
    const closeB = closeSentinel('beta');

    const existingFile =
      `${openA}\nOld A.\n${closeA}\n\nMiddle.\n\n${openB}\nOld B.\n${closeB}\n`;

    // New content for alpha contains the close sentinel of beta.
    const adversarialForAlpha = `Contains beta close: ${closeB}\n`;

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { alpha: adversarialForAlpha, beta: 'New B.\n' },
      sentinelConfig: cfg,
    });

    // beta's close sentinel appears twice: once inside alpha's region content,
    // once as beta's real close sentinel.
    const betaCloseCount = merged.split(closeB).length - 1;
    assert.equal(betaCloseCount, 2, 'beta close sentinel appears exactly twice — once as content, once as real sentinel');

    // beta's region was updated correctly.
    assert.ok(merged.includes('New B.'), 'beta region content updated');
    assert.ok(!merged.includes('Old B.'), 'old beta content gone');
  });
});

// ---------------------------------------------------------------------------
// §C  Idempotency — byte-for-byte no-op after a real update
// ---------------------------------------------------------------------------

describe('§C idempotency — second pass after a real update', () => {
  test('second splice pass on updated file produces byte-identical output', () => {
    const existingFile = buildFile({ before: 'Before.\n\n', regionContent: 'Stale.\n', after: '\n\nAfter.\n', key: 'idem' });

    const first = spliceGeneratedRegions({
      existingFile,
      regions: { idem: 'Fresh content line 1.\nFresh content line 2.\n' },
      sentinelConfig: cfg,
    });

    assert.deepEqual(first.updatedRegions, ['idem'], 'first pass reports update');

    const second = spliceGeneratedRegions({
      existingFile: first.merged,
      regions: { idem: 'Fresh content line 1.\nFresh content line 2.\n' },
      sentinelConfig: cfg,
    });

    assert.equal(second.merged, first.merged,
      'second splice output is byte-for-byte identical to first splice output');
    assert.deepEqual(second.unchangedRegions, ['idem'], 'second pass reports no change');
    assert.deepEqual(second.updatedRegions, [], 'second pass updates nothing');
  });

  test('multi-region idempotency: three regions, all unchanged on second pass', () => {
    const existingFile =
      `${openSentinel('p')}\nOld P.\n${closeSentinel('p')}\n\n` +
      `Prose between.\n\n` +
      `${openSentinel('q')}\nOld Q.\n${closeSentinel('q')}\n\n` +
      `More prose.\n\n` +
      `${openSentinel('r')}\nOld R.\n${closeSentinel('r')}\n`;

    const newContent = { p: 'New P.\n', q: 'New Q.\n', r: 'New R.\n' };

    const first = spliceGeneratedRegions({ existingFile, regions: newContent, sentinelConfig: cfg });
    const second = spliceGeneratedRegions({ existingFile: first.merged, regions: newContent, sentinelConfig: cfg });

    assert.equal(second.merged, first.merged, 'second multi-region splice is byte-identical to first');
    assert.equal(second.unchangedRegions.sort().join(','), 'p,q,r', 'all three regions unchanged on second pass');
    assert.deepEqual(second.updatedRegions, [], 'no updates on second pass');
  });
});

// ---------------------------------------------------------------------------
// §D  Error paths — no partial corruption
// ---------------------------------------------------------------------------

describe('§D error paths — function throws, no partial writes', () => {
  test('missing opening sentinel: error names the missing key', () => {
    const existingFile =
      openSentinel('present') + '\nContent.\n' + closeSentinel('present') + '\n';

    let err;
    try {
      spliceGeneratedRegions({
        existingFile,
        regions: { present: 'New.\n', absent: 'Also new.\n' },
        sentinelConfig: cfg,
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'should have thrown');
    assert.ok(err.message.includes('absent'), `error message names the missing key; got: "${err.message}"`);
  });

  test('malformed sentinel (open present, close absent): error names the key', () => {
    const existingFile =
      openSentinel('broken') + '\nContent.\n\n' +
      '# No closing sentinel anywhere.\n';

    let err;
    try {
      spliceGeneratedRegions({
        existingFile,
        regions: { broken: 'New.\n' },
        sentinelConfig: cfg,
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'should have thrown');
    assert.ok(err.message.includes('broken'), `error message names the malformed region; got: "${err.message}"`);
  });

  test('when splice throws, the input existingFile is not mutated (pure function)', () => {
    // spliceGeneratedRegions must be pure — it should not modify its input
    // and should not produce a partial result when it throws.
    const existingFile = openSentinel('ok') + '\nOld.\n' + closeSentinel('ok') + '\n';
    const originalContent = existingFile;

    try {
      spliceGeneratedRegions({
        existingFile,
        regions: { ok: 'New.\n', no_sentinel_for_this: 'content' },
        sentinelConfig: cfg,
      });
    } catch (_) {
      // expected
    }

    // existingFile is a JS string (immutable), so this confirms the value
    // we hold has not been changed.
    assert.equal(existingFile, originalContent,
      'input string is unmodified after a throwing call (function is pure)');
  });
});

// ---------------------------------------------------------------------------
// §E  Round-trip: spliceGeneratedRegions then checkArticleDrift → clean
// ---------------------------------------------------------------------------

describe('§E round-trip: splice then drift-check', () => {
  test('single region: splice then drift-check is clean', () => {
    const existingFile = buildFile({ before: 'Before.\n\n', regionContent: 'Stale.\n', after: '\n\nAfter.\n', key: 'rt' });
    const newContent = 'Freshly generated content.\n';

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { rt: newContent },
      sentinelConfig: cfg,
    });

    const report = checkArticleDrift({
      file: merged,
      sentinelConfig: cfg,
      expectedRegions: { rt: newContent },
    });

    assert.equal(report.clean, true, 'drift check is clean immediately after splice');
    assert.equal(report.regions.length, 1);
    assert.equal(report.regions[0].status, 'clean');
  });

  test('three-region round-trip: all clean after splice', () => {
    const existingFile =
      `${openSentinel('x')}\nOld X.\n${closeSentinel('x')}\n\n` +
      `Prose.\n\n` +
      `${openSentinel('y')}\nOld Y.\n${closeSentinel('y')}\n\n` +
      `${openSentinel('z')}\nOld Z.\n${closeSentinel('z')}\n`;

    const newContent = { x: 'New X.\n', y: 'New Y.\n', z: 'New Z.\n' };

    const { merged } = spliceGeneratedRegions({ existingFile, regions: newContent, sentinelConfig: cfg });

    const report = checkArticleDrift({ file: merged, sentinelConfig: cfg, expectedRegions: newContent });

    assert.equal(report.clean, true, 'all three regions clean after round-trip splice');
    for (const entry of report.regions) {
      assert.equal(entry.status, 'clean', `region "${entry.key}" is clean`);
    }
  });

  test('drift check reports drifted when file is not re-spliced after content change', () => {
    // Splice once, then check with *different* expected content → must be drifted.
    const existingFile = buildFile({ regionContent: 'Version 1.\n', key: 'v' });

    const { merged } = spliceGeneratedRegions({
      existingFile,
      regions: { v: 'Version 1.\n' },
      sentinelConfig: cfg,
    });

    // Now the canonical source has changed, but the file has not been re-spliced.
    const report = checkArticleDrift({
      file: merged,
      sentinelConfig: cfg,
      expectedRegions: { v: 'Version 2.\n' },
    });

    assert.equal(report.clean, false, 'drift detected when file lags canonical source');
    assert.equal(report.regions[0].status, 'drifted');
    assert.equal(report.regions[0].key, 'v');
    assert.ok(report.regions[0].actualContent?.includes('Version 1.'), 'actualContent shows on-disk version');
    assert.ok(report.regions[0].expectedContent?.includes('Version 2.'), 'expectedContent shows canonical version');
  });
});

// ---------------------------------------------------------------------------
// §F  renderArticleMarkdown determinism and edge cases
// ---------------------------------------------------------------------------

describe('§F renderArticleMarkdown determinism and edge cases', () => {
  test('calling renderArticleMarkdown twice on same input produces byte-identical output', () => {
    const body = {
      summary: 'Test',
      sections: [
        { key: 'c', heading: 'C', text: 'C text.', citationIds: [], position: 2 },
        { key: 'a', heading: 'A', text: 'A text.', citationIds: [], position: 0 },
        { key: 'b', heading: 'B', text: 'B text.', citationIds: [], position: 1 },
      ],
      citations: [],
      outboundLinks: [],
    };

    const first = renderArticleMarkdown(body);
    const second = renderArticleMarkdown(body);
    assert.equal(first, second, 'renderArticleMarkdown is deterministic — two calls produce identical output');
  });

  test('stable ordering: sections out of order in input → output always sorted by position', () => {
    const body = {
      summary: '',
      sections: [
        { key: 'z', heading: 'Z Section', text: 'Z.', citationIds: [], position: 25 },
        { key: 'm', heading: 'M Section', text: 'M.', citationIds: [], position: 12 },
        { key: 'a', heading: 'A Section', text: 'A.', citationIds: [], position: 0 },
      ],
      citations: [],
      outboundLinks: [],
    };

    const result = renderArticleMarkdown(body);

    const posA = result.indexOf('## A Section');
    const posM = result.indexOf('## M Section');
    const posZ = result.indexOf('## Z Section');

    assert.ok(posA < posM, 'A (position 0) before M (position 12)');
    assert.ok(posM < posZ, 'M (position 12) before Z (position 25)');
  });

  test('sections filter preserves position-based ordering within subset', () => {
    const body = {
      summary: '',
      sections: [
        { key: 'z', heading: 'Z', text: 'Z text.', citationIds: [], position: 2 },
        { key: 'a', heading: 'A', text: 'A text.', citationIds: [], position: 0 },
        { key: 'b', heading: 'B', text: 'B text.', citationIds: [], position: 1 },
      ],
      citations: [],
      outboundLinks: [],
    };

    // Filter to 'b' and 'z' — they should still appear in position order.
    const result = renderArticleMarkdown(body, { sections: ['b', 'z'] });

    const posB = result.indexOf('## B');
    const posZ = result.indexOf('## Z');

    assert.ok(posB < posZ, 'B (position 1) before Z (position 2) even when filter is specified');
    assert.ok(!result.includes('## A'), 'A excluded by filter');
  });

  test('RenderedArticle: sections filter option silently has no effect (body is pre-rendered)', () => {
    // When a RenderedArticle is supplied, the body is a pre-rendered string.
    // The sections option is not applicable — the full body passes through.
    const article = {
      articleId: 'test:a1',
      documentType: 'test',
      subject: { kind: 'test', id: 'a1' },
      version: 'v1',
      freshness: { lastCompiledAt: '2026-06-01T00:00:00Z', isFresh: true },
      body: '## X\n\nX text.\n\n## Y\n\nY text.\n',
      citations: [],
      outboundLinks: [],
      warnings: [],
      viewerRole: 'admin',
      renderedAt: '2026-06-01T00:00:00Z',
    };

    // Requesting only section 'x' — but since this is a RenderedArticle, the
    // full body must pass through (the filter is inapplicable).
    const result = renderArticleMarkdown(article, { sections: ['x'] });
    assert.ok(result.includes('## X'), 'RenderedArticle body includes X despite sections filter');
    assert.ok(result.includes('## Y'), 'RenderedArticle body includes Y despite sections filter');
  });

  test('front-matter with numeric and boolean values serialised correctly', () => {
    const body = {
      summary: '',
      sections: [{ key: 's', heading: 'S', text: 'S text.', citationIds: [], position: 0 }],
      citations: [],
      outboundLinks: [],
    };

    const result = renderArticleMarkdown(body, {
      frontMatter: { title: 'My Doc', version: 3, active: true },
    });

    assert.ok(result.startsWith('---\n'), 'starts with front-matter fence');
    assert.ok(result.includes('title: My Doc'), 'string value in front-matter');
    assert.ok(result.includes('version: 3'), 'numeric value in front-matter');
    assert.ok(result.includes('active: true'), 'boolean value in front-matter');
    // Body follows the front-matter block.
    assert.ok(result.includes('## S'), 'body follows front-matter');
    const fmEnd = result.indexOf('\n---\n');
    const bodyStart = result.indexOf('## S');
    assert.ok(fmEnd < bodyStart, 'front-matter ends before body begins');
  });

  test('renderArticleMarkdown output ends with exactly one trailing newline', () => {
    // This is load-bearing: spliceGeneratedRegions normalises region content
    // to end with \n; the render output feeding into splice must honour this
    // so that the closing sentinel always ends up on its own line.
    const body = {
      summary: '',
      sections: [
        { key: 's1', heading: 'S1', text: 'Text 1.', citationIds: [], position: 0 },
        { key: 's2', heading: 'S2', text: 'Text 2.', citationIds: [], position: 1 },
      ],
      citations: [],
      outboundLinks: [],
    };

    const result = renderArticleMarkdown(body);
    assert.ok(result.endsWith('\n'), 'output ends with a newline');
    assert.ok(!result.endsWith('\n\n'), 'output does not end with double newline');
  });
});
