/**
 * WU 039 — NuWiki citation validation acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, validateCitations, CitationValidationError } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// § 1  validateCitations pure function
// ---------------------------------------------------------------------------

function goodOutput() {
  return {
    summary: 'Tight summary.',
    sections: [
      { key: 'overview', heading: 'Overview', text: 'Body.', citationIds: ['c1'], position: 0 },
      { key: 'recent', heading: 'Recent', text: 'More.', citationIds: ['c1', 'c2'], position: 1 },
    ],
    citations: [
      { id: 'c1', claim: 'Claim one.', source: { kind: 'database_event', ref: 'src_1' }, confidence: 0.9, position: { start: 0, end: 10 } },
      { id: 'c2', claim: 'Claim two.', source: { kind: 'database_event', ref: 'src_2' }, confidence: 0.8, position: { start: 0, end: 10 } },
    ],
    outboundLinks: [],
  };
}

const goodRetrieved = new Set(['src_1', 'src_2']);

describe('§1 validateCitations rules', () => {
  test('valid output → ok: true, empty issues', () => {
    const r = validateCitations(goodOutput(), goodRetrieved);
    assert.equal(r.ok, true);
    assert.equal(r.issues.length, 0);
  });

  test('rule 1 — section references citation id that does not exist', () => {
    const out = goodOutput();
    out.sections[0].citationIds = ['c1', 'c_missing'];
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const orphans = r.issues.filter((i) => i.kind === 'orphan_section_citation_id');
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].ref, 'c_missing');
    assert.match(orphans[0].message, /citation 'c_missing'/);
  });

  test('rule 2 — citation not referenced by any section', () => {
    const out = goodOutput();
    out.citations.push({ id: 'c_orphan', claim: 'unused', source: { kind: 'x', ref: 'src_1' }, confidence: 0.5, position: { start: 0, end: 1 } });
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const orphans = r.issues.filter((i) => i.kind === 'orphan_citation');
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].ref, 'c_orphan');
  });

  test('rule 3 — citation source ref not in retrieved sources', () => {
    const out = goodOutput();
    out.citations[0].source = { kind: 'database_event', ref: 'src_hallucinated' };
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const issues = r.issues.filter((i) => i.kind === 'source_not_retrieved');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].details.sourceRef, 'src_hallucinated');
  });

  test('rule 3 — soft check: source object without ref/id is skipped', () => {
    const out = goodOutput();
    out.citations[0].source = { kind: 'inferred' }; // no ref/id/recordId
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, true);
  });

  test('rule 3 — recordId field is honoured for soft matching', () => {
    const out = goodOutput();
    out.citations[0].source = { kind: 'database_event', recordId: 'src_1' };
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, true);
  });

  test('rule 4 — empty claim flagged', () => {
    const out = goodOutput();
    out.citations[0].claim = '   ';
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const issues = r.issues.filter((i) => i.kind === 'empty_claim');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ref, 'c1');
  });

  test('rule 5 — confidence outside [0, 1] flagged', () => {
    const out = goodOutput();
    out.citations[0].confidence = 1.5;
    out.citations[1].confidence = -0.1;
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const issues = r.issues.filter((i) => i.kind === 'invalid_confidence');
    assert.equal(issues.length, 2);
  });

  test('rule 5 — NaN / non-number confidence flagged', () => {
    const out = goodOutput();
    out.citations[0].confidence = NaN;
    out.citations[1].confidence = 'high';
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    const issues = r.issues.filter((i) => i.kind === 'invalid_confidence');
    assert.equal(issues.length, 2);
  });

  test('multiple rules fail simultaneously — every issue is reported', () => {
    const out = goodOutput();
    out.sections[0].citationIds.push('c_missing');
    out.citations[0].claim = '';
    out.citations[1].confidence = 5;
    const r = validateCitations(out, goodRetrieved);
    assert.equal(r.ok, false);
    assert.ok(r.issues.length >= 3);
    const kinds = new Set(r.issues.map((i) => i.kind));
    assert.ok(kinds.has('orphan_section_citation_id'));
    assert.ok(kinds.has('empty_claim'));
    assert.ok(kinds.has('invalid_confidence'));
  });

  test('purity — same input returns equivalent report', () => {
    const out = goodOutput();
    const a = validateCitations(out, goodRetrieved);
    const b = validateCitations(out, goodRetrieved);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// § 2  CitationValidationError
// ---------------------------------------------------------------------------

describe('§2 CitationValidationError', () => {
  test('wraps a report and renders kind:ref pairs in the message', () => {
    const report = {
      ok: false,
      issues: [
        { kind: 'empty_claim', ref: 'c1', message: 'x' },
        { kind: 'orphan_citation', ref: 'c2', message: 'y' },
      ],
    };
    const err = new CitationValidationError(report);
    assert.equal(err.report, report);
    assert.match(err.message, /empty_claim:c1/);
    assert.match(err.message, /orphan_citation:c2/);
  });
});

// ---------------------------------------------------------------------------
// § 3  Engine integration — failure path
// ---------------------------------------------------------------------------

const docType = {
  type: 'pupil_profile',
  version: 'v1',
  subjectKind: 'pupil',
  description: 'Pupil profile.',
  sections: [{ key: 'overview', heading: 'Overview', required: true }],
  sourceQueries: [{ kind: 'database', query: { kind: 'pupil_recent', payload: {} }, description: '' }],
  refreshTriggers: [],
  visibility: { defaultRoles: ['teacher'] },
  retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
  precisionIndexable: true,
  retrievalHints: {
    summaryTokenBudget: 200,
    primaryQueryUseCases: [],
    sectionsPriorityForSummary: [],
    embedSectionsWithSummaryPrefix: true,
  },
};

function fakes() {
  const articles = new Map(), versions = new Map();
  const memCalls = { upsertBatch: [], graphUpsert: [], remember: [] };
  const bodyCalls = { put: [] };
  const llmCalls = [];
  return {
    articles, versions, memCalls, bodyCalls, llmCalls,
    metadata: {
      async upsertArticle(r) { articles.set(r.id, r); }, async getArticle(id) { return articles.get(id); },
      async findArticle() { return undefined; }, async listArticles() { return [...articles.values()]; },
      async upsertVersion(r) { versions.set(r.id, r); }, async getVersion(id) { return versions.get(id); },
      async listVersions(aid) { return [...versions.values()].filter((x) => x.articleId === aid); },
      async recordBacklink() {}, async removeBacklinksFor() {},
    },
    bodies: {
      async put(ref, body) { bodyCalls.put.push({ ref, body }); return { ...ref, bytes: body.length }; },
      async get() { return ''; }, async delete() {}, async exists() { return false; },
    },
    memoryAdapter: {
      async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async upsertBatch(records) { memCalls.upsertBatch.push(records); return records.map((r) => ({ id: r.id, upserted: true })); },
      async remember(r) { memCalls.remember.push(r); return { id: r.id, capturedAt: r.capturedAt }; },
      async delete() { return { deletedCount: 0, affectedLayers: [] }; },
      async markSuperseded() {},
      subscribeToInvalidations() { return () => {}; },
      graph: {
        async upsertNodeWithEdges(s) { memCalls.graphUpsert.push(s); }, async archiveNode() {}, async removeNode() {},
      },
    },
    databaseSource: {
      async query() { return { rows: [{ id: 'src_1', detail: 'x' }, { id: 'src_2', detail: 'y' }] }; },
    },
  };
}

function llmScript(content) {
  return [
    { content },
    { embedding: new Float32Array(8) }, { embedding: new Float32Array(8) },
    { embedding: new Float32Array(8) }, { embedding: new Float32Array(8) },
  ];
}

describe('§3 Engine — citation validation gate', () => {
  test('citation referencing a hallucinated source ref → blocked, no body / metadata version / NuVector / embed calls', async () => {
    const f = fakes();
    const badOutput = JSON.stringify({
      summary: 'Summary.',
      sections: [{ key: 'overview', heading: 'Overview', text: 'Body.', citationIds: ['c1'], position: 0 }],
      citations: [{ id: 'c1', claim: 'Claim.', source: { kind: 'database_event', ref: 'src_hallucinated' }, confidence: 0.9, position: { start: 0, end: 1 } }],
      outboundLinks: [],
    });
    const llm = createStubLLMAdapter([{ content: badOutput }]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.ok(result.warnings.length >= 1);
    assert.equal(result.warnings[0].kind, 'compilation_blocked');
    assert.equal(result.warnings[0].details.issueKind, 'source_not_retrieved');

    // No downstream side effects
    assert.equal(f.memCalls.upsertBatch.length, 0);
    assert.equal(f.memCalls.graphUpsert.length, 0);
    assert.equal(f.memCalls.remember.length, 0);
    assert.equal(f.bodyCalls.put.length, 0);
    assert.equal(f.versions.size, 0);
    // Only the LLM generate call happened — no embeds
    assert.equal(llm.calls.filter((c) => c.kind === 'embed').length, 0);
  });

  test('section referencing a missing citation id → blocked', async () => {
    const f = fakes();
    const badOutput = JSON.stringify({
      summary: 'Summary.',
      sections: [{ key: 'overview', heading: 'Overview', text: 'Body.', citationIds: ['c_does_not_exist'], position: 0 }],
      citations: [],
      outboundLinks: [],
    });
    const llm = createStubLLMAdapter([{ content: badOutput }]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.warnings[0].details.issueKind, 'orphan_section_citation_id');
  });

  test('valid citations against retrieved database row ids → publishes (no false positives)', async () => {
    const f = fakes();
    const goodCompileOutput = JSON.stringify({
      summary: 'Summary.',
      sections: [{ key: 'overview', heading: 'Overview', text: 'Body.', citationIds: ['c1'], position: 0 }],
      citations: [{ id: 'c1', claim: 'Claim.', source: { kind: 'database_event', ref: 'src_1' }, confidence: 0.9, position: { start: 0, end: 1 } }],
      outboundLinks: [],
    });
    const llm = createStubLLMAdapter(llmScript(goodCompileOutput));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    assert.equal(f.memCalls.upsertBatch.length, 1);
  });
});

console.log('\nWU 039 — Citation validation acceptance complete\n');
