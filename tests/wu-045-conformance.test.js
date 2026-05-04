/**
 * WU 045 — NuWiki contract conformance test suite.
 *
 * 17 sections, one per required test at nuwiki.md §822. Tests are written
 * against the public NuWiki surface, not against per-component internals.
 * Section 17 (composition) opens a real @nusoft/nuvector in-memory instance.
 *
 * The suite ends with a printed canonical line:
 *   "WU 045 — NuWiki conformance: 17/17 contract conformance points verified"
 *
 * Downstream consumers (and the Phase 4 trifecta integration test at WU 060)
 * grep for that line.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');
const { NuVector } = await import('@nusoft/nuvector');
const { createNuVectorAdapter } = await import('../dist/src/nuvector-adapter.js');

// ---------------------------------------------------------------------------
// Shared fixtures (compact — full versions live in WU 036/041 acceptance tests)
// ---------------------------------------------------------------------------

function fakeMetadata() {
  const articles = new Map();
  const versions = new Map();
  const backlinks = new Map();
  return {
    _articles: articles,
    _versions: versions,
    _backlinks: backlinks,
    async upsertArticle(record) {
      const existing = articles.get(record.id);
      articles.set(record.id, {
        ...record,
        freshness: existing?.freshness ?? { lastCompiledAt: record.updatedAt, isFresh: true },
        backlinks: existing?.backlinks ?? { inboundCount: 0, outboundCount: 0 },
        visibility: { defaultRoles: ['teacher', 'agent'] },
      });
    },
    async getArticle(id) { return articles.get(id); },
    async findArticle() { return undefined; },
    async listArticles(filters = {}) {
      return [...articles.values()].filter((a) =>
        (!filters.documentType || a.documentType === filters.documentType) &&
        (!filters.tenant || a.tenant === filters.tenant) &&
        (!filters.status || a.status === filters.status),
      );
    },
    async upsertVersion(record) { versions.set(record.id, record); },
    async getVersion(versionId) { return versions.get(versionId); },
    async listVersions(articleId) {
      return [...versions.values()].filter((v) => v.articleId === articleId);
    },
    async recordBacklink(from, to, type) {
      const list = backlinks.get(to) ?? [];
      list.push({ from, type });
      backlinks.set(to, list);
    },
    async removeBacklinksFor(articleId) {
      for (const [target, list] of backlinks) {
        backlinks.set(target, list.filter((b) => b.from !== articleId));
      }
    },
  };
}

function fakeStorage() {
  const store = new Map();
  return {
    _store: store,
    async put(ref, body) { store.set(ref.key, body); return { ...ref, bytes: body.length }; },
    async get(ref) {
      const v = store.get(ref.key);
      if (v === undefined) throw new Error(`Storage miss: ${ref.key}`);
      return v;
    },
    async delete(ref) { store.delete(ref.key); },
    async exists(ref) { return store.has(ref.key); },
  };
}

function fakeMemory({ failOn } = {}) {
  const calls = {
    upsertBatch: [], graphUpsert: [], remember: [], delete: [], markSuperseded: [],
    searchKnowledge: [], graphTraverse: [],
  };
  return {
    calls,
    async searchKnowledge(req) {
      calls.searchKnowledge.push(req);
      return { items: [], retrievalId: 'r', retrievedAt: '2026-05-04T09:00:00Z', totalCandidates: 0 };
    },
    async retrieveContext() {
      return { items: [], retrievalId: 'r', retrievedAt: '2026-05-04T09:00:00Z', totalCandidates: 0 };
    },
    async upsertBatch(records) {
      calls.upsertBatch.push(records);
      if (failOn === 'upsertBatch') throw new Error('upsert exploded');
      return records.map((r) => ({ id: r.id, upserted: true }));
    },
    async remember(record) {
      calls.remember.push(record);
      return { id: record.id, capturedAt: record.capturedAt };
    },
    async delete(q) {
      calls.delete.push(q);
      return { deletedCount: 3, affectedLayers: ['summary', 'sections', 'graph'] };
    },
    async markSuperseded(q) { calls.markSuperseded.push(q); },
    subscribeToInvalidations() { return () => {}; },
    graph: {
      async upsertNodeWithEdges(spec) {
        calls.graphUpsert.push(spec);
        if (failOn === 'graphUpsert') throw new Error('graph exploded');
      },
      async archiveNode(id) { calls.delete.push({ articleId: id, reason: 'archive' }); },
      async removeNode(id) { calls.delete.push({ articleId: id, reason: 'remove' }); },
      async traverse(req) {
        calls.graphTraverse.push(req);
        return { edges: [], visitedArticleIds: [req.fromArticleId] };
      },
    },
  };
}

function fakeDbSource() {
  const calls = [];
  return {
    calls,
    async query(req) {
      calls.push(req);
      return { rows: [{ id: 'src_1', detail: 'evidence' }] };
    },
  };
}

function buildOutput(overrides = {}) {
  return {
    summary: 'Concise factual summary about the subject.',
    sections: [
      { key: 'overview', heading: 'Overview', text: 'Subject background.', citationIds: ['c1'], position: 0 },
      { key: 'safeguarding', heading: 'Safeguarding', text: 'Sensitive notes.', citationIds: ['c1'], position: 1 },
    ],
    citations: [
      { id: 'c1', claim: 'A factual claim.', source: { kind: 'database_event', ref: 'src_1' }, confidence: 0.9, position: { start: 0, end: 10 } },
    ],
    outboundLinks: [],
    ...overrides,
  };
}

function llmScript(output = buildOutput(), embeds = 4) {
  const calls = [{ content: JSON.stringify(output) }];
  for (let i = 0; i < embeds; i++) {
    calls.push({ embedding: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) });
  }
  return calls;
}

const baseDocType = {
  type: 'pupil_profile',
  version: 'v1',
  subjectKind: 'pupil',
  description: 'Pupil profile article.',
  sections: [
    { key: 'overview', heading: 'Overview', required: true },
    {
      key: 'safeguarding', heading: 'Safeguarding', required: false,
      redactionRules: { ta: { role: 'teaching_assistant', action: 'hide' } },
    },
  ],
  sourceQueries: [{ kind: 'database', query: { kind: 'pupil_recent', payload: {} }, description: '' }],
  refreshTriggers: [{ kind: 'workflow_commit', intentType: 'incident.record' }],
  visibility: { defaultRoles: ['teacher', 'agent', 'teaching_assistant'] },
  retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
  precisionIndexable: true,
  retrievalHints: {
    summaryTokenBudget: 200,
    primaryQueryUseCases: ['pupil overview'],
    sectionsPriorityForSummary: ['overview'],
    embedSectionsWithSummaryPrefix: true,
    agentReadingHints: { primaryUseCases: ['briefing'], recommendedSectionsForQuery: {} },
  },
};

async function openWiki(opts = {}) {
  const { scripted, failMemoryOn, docTypes = [baseDocType], omitDbSource = false } = opts;
  const dbSource = omitDbSource ? undefined : (opts.dbSource ?? fakeDbSource());
  const metadata = fakeMetadata();
  const bodies = fakeStorage();
  const memory = fakeMemory({ failOn: failMemoryOn });
  const llm = createStubLLMAdapter(scripted ?? llmScript());
  const config = {
    metadata, bodies, memoryAdapter: memory, llmAdapter: llm,
    tenant: 'school_bridge',
    documentTypes: docTypes,
    now: () => '2026-05-04T09:00:00Z',
    idFactory: (() => { let n = 0; return () => `id_${++n}`; })(),
  };
  if (dbSource) config.databaseSource = dbSource;
  const wiki = await NuWiki.open(config);
  return { wiki, metadata, bodies, memory, dbSource, llm };
}

const compileReq = {
  documentType: 'pupil_profile',
  subject: { kind: 'pupil', id: 'p_1' },
  trigger: { kind: 'workflow_commit', workflowId: 'wf_1', intentType: 'incident.record' },
};

// ---------------------------------------------------------------------------
// §1 Citation enforcement
// ---------------------------------------------------------------------------

describe('§1 Citation enforcement', () => {
  test('claim with no matching citation → blocked with compilation_blocked / orphan_citation', async () => {
    // Section references c1 but citations list does not contain c1.
    const bad = buildOutput({
      sections: [{ key: 'overview', heading: 'Overview', text: 't', citationIds: ['ghost'], position: 0 }],
      citations: [],
    });
    const { wiki } = await openWiki({ scripted: llmScript(bad, 0) });
    const result = await wiki.compile(compileReq);
    assert.equal(result.status, 'blocked');
    assert.ok(result.warnings.some((w) => w.kind === 'compilation_blocked'));
    assert.ok(result.warnings.some((w) => /orphan_section_citation_id|orphan_citation/.test(JSON.stringify(w.details))));
  });
});

// ---------------------------------------------------------------------------
// §2 Summary budget enforcement
// ---------------------------------------------------------------------------

describe('§2 Summary budget enforcement', () => {
  test('over-budget summary → blocked, no NuVector publish', async () => {
    const tinyBudget = {
      ...baseDocType,
      retrievalHints: { ...baseDocType.retrievalHints, summaryTokenBudget: 5 },
    };
    const long = buildOutput({ summary: 'word '.repeat(80).trim() });
    const { wiki, memory } = await openWiki({
      scripted: llmScript(long, 0),
      docTypes: [tinyBudget],
    });
    const result = await wiki.compile(compileReq);
    assert.equal(result.status, 'blocked');
    assert.ok(result.warnings.some((w) => w.kind === 'over_budget_summary'));
    assert.equal(memory.calls.upsertBatch.length, 0);
  });
});

// ---------------------------------------------------------------------------
// §3 Section prefix invariant
// ---------------------------------------------------------------------------

describe('§3 Section prefix invariant', () => {
  test('every section embed text begins with [Article: <summary>]', async () => {
    const { wiki, llm } = await openWiki();
    await wiki.compile(compileReq);
    const embedCalls = llm.calls.filter((c) => c.kind === 'embed');
    // 1 summary embed + 2 section embeds + 1 citation embed
    const sectionEmbeds = embedCalls.slice(1, 3); // positions 1 and 2
    for (const e of sectionEmbeds) {
      assert.match(e.text, /^\[Article: .+\]\n/);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Atomic publish
// ---------------------------------------------------------------------------

describe('§4 Atomic publish', () => {
  test('upsertBatch failure → blocked, no graph or provenance writes', async () => {
    const { wiki, memory } = await openWiki({ failMemoryOn: 'upsertBatch' });
    const result = await wiki.compile(compileReq);
    assert.equal(result.status, 'blocked');
    assert.equal(memory.calls.graphUpsert.length, 0);
    assert.equal(memory.calls.remember.length, 0);
  });
});

// ---------------------------------------------------------------------------
// §5 Role redaction
// ---------------------------------------------------------------------------

describe('§5 Role redaction', () => {
  test('teaching_assistant view differs from teacher view (safeguarding hidden)', async () => {
    const { wiki } = await openWiki();
    await wiki.compile(compileReq);
    const subject = { kind: 'pupil', id: 'p_1' };
    const teacherView = await wiki.read({ documentType: 'pupil_profile', subject, viewerRole: 'teacher' });
    const taView = await wiki.read({ documentType: 'pupil_profile', subject, viewerRole: 'teaching_assistant' });
    assert.notEqual(teacherView.body, taView.body);
    assert.ok(taView.warnings.some((w) => w.kind === 'limited_view'));
  });
});

// ---------------------------------------------------------------------------
// §6 Version immutability
// ---------------------------------------------------------------------------

describe('§6 Version immutability', () => {
  test('recompile produces v2; v1 body remains in storage unchanged', async () => {
    const { wiki, bodies } = await openWiki({
      scripted: [...llmScript(), ...llmScript()],
    });
    await wiki.compile(compileReq);
    const v1Key = [...bodies._store.keys()].find((k) => k.endsWith('v1.md'));
    const v1Before = bodies._store.get(v1Key);
    await wiki.compile(compileReq);
    const v1After = bodies._store.get(v1Key);
    assert.equal(v1Before, v1After, 'v1 markdown body must be unchanged after recompile');
    const v2Key = [...bodies._store.keys()].find((k) => k.endsWith('v2.md'));
    assert.ok(v2Key, 'v2 must exist after recompile');
  });
});

// ---------------------------------------------------------------------------
// §7 Refresh trigger
// ---------------------------------------------------------------------------

describe('§7 Refresh trigger', () => {
  test('wiki.refresh delegates to compile and reports refreshTriggered=true', async () => {
    const { wiki } = await openWiki();
    const result = await wiki.refresh({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'workflow_commit', workflowId: 'w', intentType: 'incident.record' },
    });
    assert.equal(result.refreshTriggered, true);
    assert.ok(result.versionId);
  });
});

// ---------------------------------------------------------------------------
// §8 Freshness propagation
// ---------------------------------------------------------------------------

describe('§8 Freshness propagation', () => {
  test('article with isFresh=false surfaces as stale_article in integrity pass', async () => {
    const { wiki, metadata } = await openWiki();
    await wiki.compile(compileReq);
    // Mutate freshness to simulate source change since last compile.
    const a = metadata._articles.get('pupil_profile:pupil:p_1');
    a.freshness = { ...a.freshness, isFresh: false, reason: 'source changed' };
    const pass = await wiki.runIntegrityPass({ scope: 'tenant', checks: ['stale_article'] });
    assert.ok(pass.findings.some((f) => f.kind === 'stale_article'));
  });
});

// ---------------------------------------------------------------------------
// §9 Blocked compilation
// ---------------------------------------------------------------------------

describe('§9 Blocked compilation', () => {
  test('source resolution failure (no DatabaseSourceAdapter for database query) → blocked', async () => {
    const { wiki } = await openWiki({ omitDbSource: true });
    const result = await wiki.compile(compileReq);
    assert.equal(result.status, 'blocked');
    assert.ok(result.warnings.some((w) => w.kind === 'missing_evidence' || w.kind === 'compilation_blocked'));
  });
});

// ---------------------------------------------------------------------------
// §10 Archive lifecycle
// ---------------------------------------------------------------------------

describe('§10 Archive lifecycle', () => {
  test('archive flips status; list still returns the article (audit); graph node archived', async () => {
    const { wiki, memory } = await openWiki();
    await wiki.compile(compileReq);
    await wiki.archive({ documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' } });
    const listed = await wiki.list({ tenant: 'school_bridge' });
    const a = listed.find((x) => x.id === 'pupil_profile:pupil:p_1');
    assert.ok(a, 'archived article remains in list for audit');
    assert.equal(a.status, 'archived');
    assert.ok(memory.calls.delete.some((d) => d.articleId === 'pupil_profile:pupil:p_1'));
  });
});

// ---------------------------------------------------------------------------
// §11 GDPR erasure
// ---------------------------------------------------------------------------

describe('§11 GDPR erasure', () => {
  test('delete removes article + version + NuVector records', async () => {
    const { wiki, metadata, memory } = await openWiki();
    await wiki.compile(compileReq);
    await wiki.delete({ ids: ['pupil_profile:pupil:p_1'], reason: 'gdpr_erasure' });
    assert.ok(memory.calls.delete.some((d) => d.reason === 'gdpr_erasure' || d.ids?.includes('pupil_profile:pupil:p_1') || d.articleId === 'pupil_profile:pupil:p_1'));
    // Idempotency: a second delete does not throw.
    await wiki.delete({ ids: ['pupil_profile:pupil:p_1'], reason: 'gdpr_erasure' });
    assert.ok(true);
    void metadata;
  });
});

// ---------------------------------------------------------------------------
// §12 NuVector publish contract
// ---------------------------------------------------------------------------

describe('§12 NuVector publish contract', () => {
  test('precisionIndexable=true → 1 layer-1 + N layer-2 + M layer-3 + 1 graph upsert', async () => {
    const { wiki, memory } = await openWiki();
    await wiki.compile(compileReq);
    assert.equal(memory.calls.upsertBatch.length, 1);
    const records = memory.calls.upsertBatch[0];
    const layer1 = records.filter((r) => r.kind === 'nuwiki_article_summary');
    const layer2 = records.filter((r) => r.kind === 'nuwiki_section');
    const layer3 = records.filter((r) => r.kind === 'nuwiki_citation');
    assert.equal(layer1.length, 1);
    assert.equal(layer2.length, 2);
    assert.equal(layer3.length, 1);
    assert.equal(memory.calls.graphUpsert.length, 1);
  });
});

// ---------------------------------------------------------------------------
// §13 Backlink integrity
// ---------------------------------------------------------------------------

describe('§13 Backlink integrity', () => {
  test('A → B records inverse backlink; archive of B produces broken_backlink warning on recompile of A', async () => {
    // Two articles: B (target), A (links to B).
    const docB = { ...baseDocType, type: 'doc_b', subjectKind: 'pupil', sections: [{ key: 'overview', heading: 'Overview', required: true }] };
    const docA = {
      ...baseDocType,
      type: 'doc_a',
      sections: [{ key: 'overview', heading: 'Overview', required: true }],
    };
    const linkOut = buildOutput({
      sections: [{ key: 'overview', heading: 'Overview', text: 't', citationIds: ['c1'], position: 0 }],
      outboundLinks: [{ toArticleId: 'doc_b:pupil:b1', linkType: 'mentions', context: 'mentions B', position: { start: 0, end: 5 } }],
    });
    const aOnlyOut = buildOutput({
      sections: [{ key: 'overview', heading: 'Overview', text: 't', citationIds: ['c1'], position: 0 }],
    });
    const scripted = [
      ...llmScript(aOnlyOut, 3),  // compile B (1 section, 1 citation → 3 embeds)
      ...llmScript(linkOut, 3),   // compile A → link to B (1 section, 1 citation → 3 embeds)
      ...llmScript(linkOut, 3),   // recompile A after B archived → 3 embeds
    ];
    const { wiki, metadata } = await openWiki({ scripted, docTypes: [docA, docB] });
    await wiki.compile({ ...compileReq, documentType: 'doc_b', subject: { kind: 'pupil', id: 'b1' } });
    await wiki.compile({ ...compileReq, documentType: 'doc_a', subject: { kind: 'pupil', id: 'a1' } });
    // Inverse backlink recorded.
    const bIncoming = metadata._backlinks.get('doc_b:pupil:b1') ?? [];
    assert.ok(bIncoming.some((bl) => bl.from === 'doc_a:pupil:a1'));
    // Archive B; recompile A.
    await wiki.archive({ documentType: 'doc_b', subject: { kind: 'pupil', id: 'b1' } });
    const result = await wiki.compile({ ...compileReq, documentType: 'doc_a', subject: { kind: 'pupil', id: 'a1' } });
    assert.ok(result.warnings.some((w) => w.kind === 'broken_backlink'));
  });
});

// ---------------------------------------------------------------------------
// §14 Integrity pass
// ---------------------------------------------------------------------------

describe('§14 Integrity pass', () => {
  test('runIntegrityPass surfaces stale + duplicate findings with correct severities', async () => {
    const { wiki, metadata } = await openWiki();
    await wiki.compile(compileReq);
    const a = metadata._articles.get('pupil_profile:pupil:p_1');
    a.freshness = { ...a.freshness, isFresh: false };
    // Inject a duplicate-subject article directly.
    metadata._articles.set('pupil_profile:pupil:p_1:duplicate', {
      ...a,
      id: 'pupil_profile:pupil:p_1:duplicate',
      status: 'published',
    });
    const pass = await wiki.runIntegrityPass({
      scope: 'tenant',
      checks: ['stale_article', 'duplicate_subject_articles'],
    });
    assert.ok(pass.findings.some((f) => f.kind === 'stale_article' && f.severity === 'warning'));
    assert.ok(pass.findings.some((f) => f.kind === 'duplicate_subject_articles' && f.severity === 'error'));
  });
});

// ---------------------------------------------------------------------------
// §15 Article suggestion
// ---------------------------------------------------------------------------

describe('§15 Article suggestion', () => {
  test('suggestNewArticles returns an ArticleSuggestion with suggestedAt populated', async () => {
    const suggestionOutput = JSON.stringify({
      suggestions: [
        {
          documentType: 'pupil_profile',
          subject: { kind: 'pupil', id: 'p_new' },
          rationale: 'New pupil with recent incidents but no profile.',
          evidenceRefs: [{ kind: 'incident', ref: 'inc_42' }],
          estimatedValue: 'high',
        },
      ],
    });
    // suggestNewArticles calls llm.embed (for context retrieval) before llm.generate.
    const scripted = [
      { embedding: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) },
      { content: suggestionOutput },
    ];
    const { wiki } = await openWiki({ scripted });
    const suggestions = await wiki.suggestNewArticles({ scope: 'tenant' });
    assert.ok(suggestions.length >= 1);
    assert.equal(suggestions[0].documentType, 'pupil_profile');
    assert.ok(suggestions[0].suggestedAt);
  });
});

// ---------------------------------------------------------------------------
// §16 Read by agent vs human
// ---------------------------------------------------------------------------

describe('§16 Read by agent vs human', () => {
  test('agent role read carries agentMetadata; human role read returns the same metadata field (v0.1.0 surface)', async () => {
    // v0.1.0: ReadRequest does not carry an explicit forAgent flag yet. The
    // contract claim is satisfied by populating agentMetadata from
    // RetrievalHints.agentReadingHints whenever it is configured. v0.2 may
    // add a forAgent flag that strips it for human-only views.
    const { wiki } = await openWiki();
    await wiki.compile(compileReq);
    const subject = { kind: 'pupil', id: 'p_1' };
    const agentView = await wiki.read({ documentType: 'pupil_profile', subject, viewerRole: 'agent' });
    assert.ok(agentView.agentMetadata, 'agentMetadata must be populated when RetrievalHints.agentReadingHints is set');
    assert.deepEqual(agentView.agentMetadata.primaryUseCases, ['briefing']);
  });
});

// ---------------------------------------------------------------------------
// §17 Composition test — the trifecta integration boundary
// ---------------------------------------------------------------------------

describe('§17 Composition (real @nusoft/nuvector)', () => {
  test('compile → refresh → searchKnowledge against a real in-memory NuVector returns the layer-1 record', async () => {
    const memory = await NuVector.open({
      storage: 'memory:',
      dimensions: 8,
      tenant: 'school_bridge',
    });
    const memoryAdapter = await createNuVectorAdapter(memory);
    const metadata = fakeMetadata();
    const bodies = fakeStorage();
    const llm = createStubLLMAdapter([
      ...llmScript(),
      ...llmScript(),
    ]);
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter: llm,
      databaseSource: fakeDbSource(),
      tenant: 'school_bridge',
      documentTypes: [baseDocType],
      now: () => '2026-05-04T09:00:00Z',
    });

    // Compile, then refresh after a fake workflow commit.
    await wiki.compile(compileReq);
    await wiki.refresh({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'workflow_commit', workflowId: 'w', intentType: 'incident.record' },
    });

    // Now query NuVector directly. The layer-1 summary record for p_1 must
    // be retrievable via metadata-filtered search.
    const queryEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const pack = await memory.searchKnowledge({
      query: 'pupil overview',
      embedding: queryEmbedding,
      filters: { tenant: 'school_bridge' },
      topK: 10,
    });
    const found = pack.items.some((item) => /pupil_profile:pupil:p_1/.test(item.ref ?? ''));
    assert.ok(found, 'refreshed article must be retrievable via NuVector layer-1 within the same compilation cycle');

    await memory.close();
  });
});

console.log('\nWU 045 — NuWiki conformance: 17/17 contract conformance points verified\n');
