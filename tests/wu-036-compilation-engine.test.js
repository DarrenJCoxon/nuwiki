/**
 * WU 036 — NuWiki compilation engine acceptance test.
 *
 * Drives the engine end-to-end against composed stub adapters. Verifies:
 *   §1 First compile (no predecessor): adapter call sequence + atomic publish
 *   §2 Recompile with predecessor: markSuperseded fires; version increments
 *   §3 Layer-3 citations only when documentType.precisionIndexable
 *   §4 LLM output parse failure → blocked; no NuVector publish
 *   §5 NuVector publish failure → blocked; status flipped on metadata
 *   §6 Unknown documentType → blocked, with no adapter calls beyond metadata read
 *   §7 wiki.refresh() delegates to compile with workflow_commit trigger
 *   §8 wiki.list / archive / delete flows
 *   §9 wiki.affectedDocuments matches refreshTriggers
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, parseLLMCompilationOutput, LLMOutputParseError } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMetadataAdapter() {
  const articles = new Map();
  const versions = new Map();
  const calls = { upsertArticle: [], upsertVersion: [], listArticles: [], getArticle: [] };
  return {
    calls,
    _articles: articles,
    _versions: versions,
    async upsertArticle(record) {
      calls.upsertArticle.push(record);
      articles.set(record.id, { ...record, freshness: { lastCompiledAt: record.updatedAt, isFresh: true }, backlinks: { inboundCount: 0, outboundCount: 0 }, visibility: { defaultRoles: [] } });
    },
    async getArticle(id) {
      calls.getArticle.push(id);
      return articles.get(id);
    },
    async findArticle() { return undefined; },
    async listArticles(filters) {
      calls.listArticles.push(filters);
      return [...articles.values()].filter((a) =>
        (!filters.documentType || a.documentType === filters.documentType) &&
        (!filters.tenant || a.tenant === filters.tenant) &&
        (!filters.status || a.status === filters.status),
      );
    },
    async upsertVersion(record) {
      calls.upsertVersion.push(record);
      versions.set(record.id, record);
    },
    async getVersion(versionId) { return versions.get(versionId); },
    async listVersions(articleId) {
      return [...versions.values()].filter((v) => v.articleId === articleId);
    },
    async recordBacklink() {},
    async removeBacklinksFor() {},
  };
}

function fakeStorageAdapter() {
  const store = new Map();
  const calls = { put: [], get: [], delete: [] };
  return {
    calls,
    _store: store,
    async put(ref, body) {
      calls.put.push({ ref, body });
      store.set(ref.key, body);
      return { ...ref, bytes: body.length };
    },
    async get(ref) {
      calls.get.push(ref);
      return store.get(ref.key);
    },
    async delete(ref) {
      calls.delete.push(ref);
      store.delete(ref.key);
    },
    async exists(ref) { return store.has(ref.key); },
  };
}

function fakeMemoryAdapter({ failOn } = {}) {
  const calls = {
    searchKnowledge: [],
    retrieveContext: [],
    upsertBatch: [],
    remember: [],
    delete: [],
    markSuperseded: [],
    graphUpsert: [],
    graphArchive: [],
    graphRemove: [],
  };
  return {
    calls,
    async searchKnowledge(req) {
      calls.searchKnowledge.push(req);
      if (failOn === 'searchKnowledge') throw new Error('boom');
      return { items: [], retrievalId: 'r1', retrievedAt: '2026-05-04T09:00:00Z', totalCandidates: 0 };
    },
    async retrieveContext(req) {
      calls.retrieveContext.push(req);
      return { items: [], retrievalId: 'r1', retrievedAt: '2026-05-04T09:00:00Z', totalCandidates: 0 };
    },
    async upsertBatch(records) {
      calls.upsertBatch.push(records);
      if (failOn === 'upsertBatch') throw new Error('upsert exploded');
      return records.map((r) => ({ id: r.id, upserted: true }));
    },
    async remember(record) {
      calls.remember.push(record);
      if (failOn === 'remember') throw new Error('remember exploded');
      return { id: record.id, capturedAt: record.capturedAt };
    },
    async delete(q) {
      calls.delete.push(q);
      return { deletedCount: 3, affectedLayers: ['summary', 'sections', 'graph'] };
    },
    async markSuperseded(q) {
      calls.markSuperseded.push(q);
    },
    subscribeToInvalidations() { return () => {}; },
    graph: {
      async upsertNodeWithEdges(spec) {
        calls.graphUpsert.push(spec);
        if (failOn === 'graphUpsert') throw new Error('graph exploded');
      },
      async archiveNode(nodeId) {
        calls.graphArchive.push(nodeId);
      },
      async removeNode(nodeId) {
        calls.graphRemove.push(nodeId);
      },
    },
  };
}

function fakeDatabaseSourceAdapter() {
  const calls = [];
  return {
    calls,
    async query(req) {
      calls.push(req);
      return { rows: [{ id: 'src_1', detail: 'fixture data' }] };
    },
  };
}

function buildLLMOutput(overrides = {}) {
  return {
    summary: 'Summary about the subject. Densely informative.',
    sections: [
      { key: 'overview', heading: 'Overview', text: 'Subject background.', citationIds: ['c1'], position: 0 },
      { key: 'recent', heading: 'Recent activity', text: 'Recent events.', citationIds: ['c1'], position: 1 },
    ],
    citations: [
      {
        id: 'c1',
        claim: 'A factual claim',
        source: { kind: 'database_event', ref: 'src_1' },
        confidence: 0.9,
        position: { start: 0, end: 20 },
      },
    ],
    outboundLinks: [
      { toArticleId: 'pupil_profile:pupil:p_other', linkType: 'mentions', context: 'mentioned', position: { start: 0, end: 10 } },
    ],
    ...overrides,
  };
}

const docTypePrecision = {
  type: 'pupil_profile',
  version: 'v1',
  subjectKind: 'pupil',
  description: 'Pupil profile article.',
  sections: [
    { key: 'overview', heading: 'Overview', required: true },
    { key: 'recent', heading: 'Recent activity', required: false },
  ],
  sourceQueries: [{ kind: 'database', query: { kind: 'pupil_recent', payload: {} }, description: '' }],
  refreshTriggers: [{ kind: 'workflow_commit', intentType: 'incident.peer_conflict.record' }],
  visibility: { defaultRoles: ['teacher'] },
  retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
  precisionIndexable: true,
  retrievalHints: {
    summaryTokenBudget: 200,
    primaryQueryUseCases: ['pupil overview'],
    sectionsPriorityForSummary: ['overview'],
    embedSectionsWithSummaryPrefix: true,
  },
};

const docTypeNonPrecision = { ...docTypePrecision, type: 'class_briefing', subjectKind: 'class', precisionIndexable: false };

async function buildWiki({ scriptedLLM, failMemoryOn, includeDocTypes = [docTypePrecision] } = {}) {
  const metadata = fakeMetadataAdapter();
  const bodies = fakeStorageAdapter();
  const memoryAdapter = fakeMemoryAdapter({ failOn: failMemoryOn });
  const databaseSource = fakeDatabaseSourceAdapter();
  const llmAdapter = createStubLLMAdapter(scriptedLLM ?? defaultLLMScript());
  const wiki = await NuWiki.open({
    metadata,
    bodies,
    memoryAdapter,
    llmAdapter,
    databaseSource,
    tenant: 'school_bridge',
    documentTypes: includeDocTypes,
    now: () => '2026-05-04T09:00:00Z',
  });
  return { wiki, metadata, bodies, memoryAdapter, databaseSource, llmAdapter };
}

function defaultLLMScript() {
  const out = JSON.stringify(buildLLMOutput());
  // generate + 1 summary embed + 2 section embeds + 1 citation embed = 5 calls
  return [
    { content: out },
    { embedding: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) },
    { embedding: new Float32Array([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) },
    { embedding: new Float32Array([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) },
    { embedding: new Float32Array([0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1]) },
  ];
}

// ---------------------------------------------------------------------------
// § 1  First compile — adapter call sequence + atomic publish
// ---------------------------------------------------------------------------

describe('§1 First compile — adapter call sequence + atomic publish', () => {
  test('compile() returns published, exercises all five adapters in correct order', async () => {
    const { wiki, metadata, bodies, memoryAdapter, databaseSource, llmAdapter } = await buildWiki();

    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'workflow_commit', workflowId: 'wf_001', intentType: 'incident.peer_conflict.record' },
    });

    assert.equal(result.status, 'published');
    // WU 040 reports broken_backlink warnings for unseeded targets; the
    // §1 fixture's outbound link to p_other isn't seeded, so a single
    // broken_backlink warning is expected here. Other warning kinds
    // remain forbidden.
    const nonBrokenWarnings = result.warnings.filter((w) => w.kind !== 'broken_backlink');
    assert.equal(nonBrokenWarnings.length, 0);
    assert.equal(result.articleId, 'pupil_profile:pupil:p_456');
    assert.match(result.versionId, /pupil_profile\/p_456\/v1/);

    // database source resolved
    assert.equal(databaseSource.calls.length, 1);
    assert.equal(databaseSource.calls[0].kind, 'pupil_recent');

    // llm.generate + 4 embeds (1 summary, 2 sections, 1 citation)
    assert.equal(llmAdapter.calls.length, 5);
    assert.equal(llmAdapter.calls[0].kind, 'generate');
    assert.equal(llmAdapter.calls[1].kind, 'embed');

    // body persisted (WU 041 adds a .json structured-form write alongside .md)
    assert.equal(bodies.calls.put.length, 2);
    assert.match(bodies.calls.put[0].ref.key, /^nuwiki\/school_bridge\/pupil_profile:pupil:p_456\/.+\.md$/);
    assert.match(bodies.calls.put[1].ref.key, /^nuwiki\/school_bridge\/pupil_profile:pupil:p_456\/.+\.json$/);

    // metadata writes: at least 1 article upsert (compiling) → 1 article upsert (published) + 1 version upsert
    assert.equal(metadata.calls.upsertVersion.length, 1);
    assert.ok(metadata.calls.upsertArticle.length >= 2);
    assert.equal(metadata.calls.upsertArticle.at(-1).status, 'published');

    // NuVector four-layer publish
    assert.equal(memoryAdapter.calls.upsertBatch.length, 1);
    const batch = memoryAdapter.calls.upsertBatch[0];
    // 1 summary + 2 sections + 1 citation (precisionIndexable)
    assert.equal(batch.length, 4);
    assert.equal(batch[0].kind, 'nuwiki_article_summary');
    assert.equal(batch[1].kind, 'nuwiki_section');
    assert.equal(batch[2].kind, 'nuwiki_section');
    assert.equal(batch[3].kind, 'nuwiki_citation');

    // graph upsert
    assert.equal(memoryAdapter.calls.graphUpsert.length, 1);
    assert.equal(memoryAdapter.calls.graphUpsert[0].nodeId, 'pupil_profile:pupil:p_456');
    assert.equal(memoryAdapter.calls.graphUpsert[0].outboundEdges.length, 1);

    // provenance
    assert.equal(memoryAdapter.calls.remember.length, 1);
    assert.equal(memoryAdapter.calls.remember[0].kind, 'nuwiki_compile');
    assert.equal(memoryAdapter.calls.remember[0].outcome, 'compiled');

    // no markSuperseded on first compile (no predecessor)
    assert.equal(memoryAdapter.calls.markSuperseded.length, 0);
  });

  test('summary record carries documentType-level metadata', async () => {
    const { wiki, memoryAdapter } = await buildWiki();
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const summary = memoryAdapter.calls.upsertBatch[0][0];
    assert.equal(summary.metadata.articleId, 'pupil_profile:pupil:p_456');
    assert.equal(summary.metadata.documentType, 'pupil_profile');
    assert.equal(summary.metadata.sectionCount, 2);
    assert.equal(summary.metadata.isFresh, true);
  });

  test('section records carry parentArticleSummary metadata', async () => {
    const { wiki, memoryAdapter } = await buildWiki();
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const batch = memoryAdapter.calls.upsertBatch[0];
    const sections = batch.filter((r) => r.kind === 'nuwiki_section');
    for (const s of sections) {
      assert.match(s.metadata.parentArticleSummary, /Densely informative/);
    }
  });
});

// ---------------------------------------------------------------------------
// § 2  Recompile with predecessor — markSuperseded fires; version increments
// ---------------------------------------------------------------------------

describe('§2 Recompile with predecessor', () => {
  test('second compile increments version and calls markSuperseded with predecessor pattern', async () => {
    const script = [...defaultLLMScript(), ...defaultLLMScript()];
    const { wiki, memoryAdapter } = await buildWiki({ scriptedLLM: script });

    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const second = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });

    assert.equal(second.status, 'published');
    assert.match(second.versionId, /v2/);
    assert.equal(memoryAdapter.calls.markSuperseded.length, 1);
    assert.match(memoryAdapter.calls.markSuperseded[0].pattern, /:pupil_profile:pupil:p_456:v1\*/);
  });
});

// ---------------------------------------------------------------------------
// § 3  precisionIndexable controls layer-3 citation publishing
// ---------------------------------------------------------------------------

describe('§3 precisionIndexable controls layer-3', () => {
  test('precisionIndexable=false → no citation records, no citation embed calls', async () => {
    const { wiki, memoryAdapter, llmAdapter } = await buildWiki({
      includeDocTypes: [docTypeNonPrecision],
      // 1 generate + 1 summary embed + 2 section embeds, no citation embed
      scriptedLLM: [
        { content: JSON.stringify(buildLLMOutput()) },
        { embedding: new Float32Array(8) },
        { embedding: new Float32Array(8) },
        { embedding: new Float32Array(8) },
      ],
    });

    const result = await wiki.compile({
      documentType: 'class_briefing',
      subject: { kind: 'class', id: 'c_001' },
      trigger: { kind: 'scheduled_refresh' },
    });

    assert.equal(result.status, 'published');
    const batch = memoryAdapter.calls.upsertBatch[0];
    const citations = batch.filter((r) => r.kind === 'nuwiki_citation');
    assert.equal(citations.length, 0);
    assert.equal(llmAdapter.calls.length, 4); // generate + summary + 2 sections
  });
});

// ---------------------------------------------------------------------------
// § 4  LLM output parse failure → blocked; no NuVector publish
// ---------------------------------------------------------------------------

describe('§4 LLM parse failure', () => {
  test('non-JSON LLM output → blocked status, compilation_blocked warning, no upsertBatch', async () => {
    const { wiki, memoryAdapter } = await buildWiki({
      scriptedLLM: [{ content: 'not actually json' }],
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.warnings[0].kind, 'compilation_blocked');
    assert.match(result.warnings[0].message, /LLM compilation failed/);
    assert.equal(memoryAdapter.calls.upsertBatch.length, 0);
    assert.equal(memoryAdapter.calls.graphUpsert.length, 0);
  });

  test('parseLLMCompilationOutput throws LLMOutputParseError for malformed object', () => {
    assert.throws(
      () => parseLLMCompilationOutput('{"summary": "ok"}'),
      (err) => err instanceof LLMOutputParseError,
    );
  });
});

// ---------------------------------------------------------------------------
// § 5  NuVector publish failure → blocked; status flipped on metadata
// ---------------------------------------------------------------------------

describe('§5 NuVector publish failure', () => {
  test('upsertBatch failure → article flipped to blocked; no graph or provenance side effects after the failure', async () => {
    const { wiki, metadata, memoryAdapter } = await buildWiki({ failMemoryOn: 'upsertBatch' });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.warnings[0].message, /NuVector publish failed/);
    // graph never called because upsertBatch failed first
    assert.equal(memoryAdapter.calls.graphUpsert.length, 0);
    assert.equal(memoryAdapter.calls.remember.length, 0);
    // status flipped to blocked on metadata
    assert.equal(metadata.calls.upsertArticle.at(-1).status, 'blocked');
  });

  test('graph upsert failure → blocked; provenance not written; metadata flipped', async () => {
    const { wiki, metadata, memoryAdapter } = await buildWiki({ failMemoryOn: 'graphUpsert' });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(memoryAdapter.calls.remember.length, 0);
    assert.equal(metadata.calls.upsertArticle.at(-1).status, 'blocked');
  });
});

// ---------------------------------------------------------------------------
// § 6  Unknown documentType
// ---------------------------------------------------------------------------

describe('§6 Unknown documentType', () => {
  test('compile against unregistered type → blocked, with no LLM / NuVector calls', async () => {
    const { wiki, memoryAdapter, llmAdapter } = await buildWiki();
    const result = await wiki.compile({
      documentType: 'totally_made_up',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.match(result.warnings[0].message, /Unknown documentType/);
    assert.equal(llmAdapter.calls.length, 0);
    assert.equal(memoryAdapter.calls.upsertBatch.length, 0);
  });
});

// ---------------------------------------------------------------------------
// § 7  refresh() delegates to compile
// ---------------------------------------------------------------------------

describe('§7 refresh()', () => {
  test('refresh triggers a compile and reports refreshTriggered=true on success', async () => {
    const { wiki } = await buildWiki();
    const result = await wiki.refresh({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'workflow_commit', workflowId: 'wf_x', intentType: 'incident.peer_conflict.record' },
    });
    assert.equal(result.refreshTriggered, true);
    assert.equal(result.articleId, 'pupil_profile:pupil:p_456');
  });

  test('refresh of unknown documentType → refreshTriggered=false', async () => {
    const { wiki } = await buildWiki();
    const result = await wiki.refresh({
      documentType: 'unknown_type',
      subject: { kind: 'pupil', id: 'p_456' },
    });
    assert.equal(result.refreshTriggered, false);
    assert.match(result.reason, /Unknown documentType/);
  });
});

// ---------------------------------------------------------------------------
// § 8  list / archive / delete
// ---------------------------------------------------------------------------

describe('§8 list / archive / delete', () => {
  test('list delegates to metadata.listArticles with tenant defaulted to the wiki tenant', async () => {
    const { wiki, metadata } = await buildWiki();
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const list = await wiki.list({ documentType: 'pupil_profile' });
    assert.equal(list.length, 1);
    assert.equal(metadata.calls.listArticles.at(-1).tenant, 'school_bridge');
  });

  test('archive flips status, archives graph node', async () => {
    const { wiki, metadata, memoryAdapter } = await buildWiki();
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    await wiki.archive({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      reason: 'pupil_left',
    });
    assert.equal(metadata.calls.upsertArticle.at(-1).status, 'archived');
    assert.equal(metadata.calls.upsertArticle.at(-1).metadata.archiveReason, 'pupil_left');
    assert.equal(memoryAdapter.calls.graphArchive.length, 1);
  });

  test('delete removes through storage, NuVector layers, and graph', async () => {
    const { wiki, bodies, memoryAdapter } = await buildWiki();
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_456' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const result = await wiki.delete({
      subject: { kind: 'pupil', id: 'p_456' },
      reason: 'gdpr_erasure',
    });
    assert.equal(result.deletedCount, 1);
    assert.equal(result.affectedArticles[0], 'pupil_profile:pupil:p_456');
    assert.equal(bodies.calls.delete.length, 1);
    assert.equal(memoryAdapter.calls.delete.length, 1);
    assert.equal(memoryAdapter.calls.delete[0].reason, 'gdpr_erasure');
    assert.equal(memoryAdapter.calls.graphRemove.length, 1);
  });
});

// ---------------------------------------------------------------------------
// § 9  affectedDocuments
// ---------------------------------------------------------------------------

describe('§9 affectedDocuments', () => {
  test('returns refs for documentTypes whose refreshTriggers match the intent type', async () => {
    const { wiki } = await buildWiki();
    const refs = await wiki.affectedDocuments(
      { commitRef: 'c_1', recordType: 'incident', recordId: 'inc_1', committedAt: '2026-05-04T09:00:00Z' },
      { type: 'incident.peer_conflict.record', subjects: [{ kind: 'pupil', id: 'p_456' }] },
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0].documentType, 'pupil_profile');
    assert.equal(refs[0].subject.id, 'p_456');
  });

  test('returns empty when no documentType has a matching refresh trigger', async () => {
    const { wiki } = await buildWiki();
    const refs = await wiki.affectedDocuments(
      { commitRef: 'c_1', recordType: 'x', recordId: 'r_1', committedAt: '2026-05-04T09:00:00Z' },
      { type: 'unrelated.intent', subjects: [{ kind: 'pupil', id: 'p_456' }] },
    );
    assert.equal(refs.length, 0);
  });

  test('skips subjects whose kind does not match documentType.subjectKind', async () => {
    const { wiki } = await buildWiki();
    const refs = await wiki.affectedDocuments(
      { commitRef: 'c_1', recordType: 'x', recordId: 'r_1', committedAt: '2026-05-04T09:00:00Z' },
      { type: 'incident.peer_conflict.record', subjects: [{ kind: 'staff', id: 's_1' }] },
    );
    assert.equal(refs.length, 0);
  });
});

console.log('\nWU 036 — Compilation engine acceptance complete\n');
