/**
 * WU 094 — NuWiki.seed() unit tests.
 *
 * Three scenarios per the WU acceptance criteria:
 *   §1 Success path — seed writes metadata, body, NuVector records, provenance
 *   §2 Rejection when subjectKind is not in NuWiki's registered allow-set
 *      (unregistered documentType → clear error; D062 guard covers subjectKind
 *       enforcement at registerDocumentType time)
 *   §3 Idempotent re-seed — same article ID → updates not duplicates
 *      (predecessor version is superseded in NuVector; version increments)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// One embed call for summary + 2 for sections + 1 for citation (precisionIndexable=true)
// = 4 embed calls per seed() invocation on the fixture body.
const EMBED_STUB = { embedding: new Float32Array(4).fill(0.1) };

function makeEmbedStubs(count = 1) {
  // count = number of seed() calls; each needs 4 embeds
  return Array.from({ length: count * 4 }, () => EMBED_STUB);
}

// ---------------------------------------------------------------------------
// Stub adapters (same pattern as wu-036)
// ---------------------------------------------------------------------------

function fakeMetadataAdapter() {
  const articles = new Map();
  const versions = new Map();
  const calls = { upsertArticle: [], upsertVersion: [], getArticle: [] };
  return {
    calls,
    _articles: articles,
    async upsertArticle(record) {
      calls.upsertArticle.push(record);
      articles.set(record.id, {
        ...record,
        freshness: { lastCompiledAt: record.updatedAt, isFresh: true },
        backlinks: { inboundCount: 0, outboundCount: 0 },
        visibility: { defaultRoles: [] },
      });
    },
    async getArticle(id) {
      calls.getArticle.push(id);
      return articles.get(id);
    },
    async findArticle() { return undefined; },
    async listArticles(filters) {
      return [...articles.values()].filter((a) =>
        (!filters.documentType || a.documentType === filters.documentType) &&
        (!filters.tenant || a.tenant === filters.tenant),
      );
    },
    async upsertVersion(record) {
      calls.upsertVersion.push(record);
      versions.set(record.id, record);
    },
    async getVersion(id) { return versions.get(id); },
    async listVersions(articleId) {
      return [...versions.values()].filter((v) => v.articleId === articleId);
    },
    async recordBacklink() {},
    async removeBacklinksFor() {},
  };
}

function fakeStorageAdapter() {
  const store = new Map();
  const calls = { put: [] };
  return {
    calls,
    _store: store,
    async put(ref, body) {
      calls.put.push({ ref, body });
      store.set(ref.key, body);
      return { ...ref, bytes: body.length };
    },
    async get(ref) { return store.get(ref.key); },
    async delete(ref) { store.delete(ref.key); },
    async exists(ref) { return store.has(ref.key); },
  };
}

function fakeMemoryAdapter() {
  const calls = { upsertBatch: [], remember: [], markSuperseded: [], graphUpsert: [] };
  return {
    calls,
    async upsertBatch(records) {
      calls.upsertBatch.push(records);
      return records.map((r) => ({ id: r.id, upserted: true }));
    },
    async remember(record) {
      calls.remember.push(record);
      return { ref: `prov_${record.id}` };
    },
    async markSuperseded(q) { calls.markSuperseded.push(q); },
    async searchKnowledge() { return { items: [], retrievalId: 'r1', retrievedAt: new Date().toISOString(), totalCandidates: 0 }; },
    async retrieveContext() { return { items: [], retrievalId: 'r1', retrievedAt: new Date().toISOString(), totalCandidates: 0 }; },
    async delete() { return { deletedCount: 0, affectedLayers: [] }; },
    subscribeToInvalidations() { return () => {}; },
    graph: {
      async upsertNodeWithEdges(spec) { calls.graphUpsert.push(spec); },
      async archiveNode() {},
      async removeNode() {},
      async traverse() { return { edges: [], visitedArticleIds: [] }; },
    },
  };
}

// A minimal DocumentType with subjectKind: 'institution' (D062 compliant).
const statutoryTestDocType = {
  type: 'kcsie-dsl-role',
  version: '0.1.0',
  subjectKind: 'institution',
  description: 'Test statutory doc type',
  sections: [
    { key: 'obligation', heading: 'The obligation', required: true },
    { key: 'timescales', heading: 'Timescales and deadlines', required: true },
  ],
  sourceQueries: [],
  refreshTriggers: [{ kind: 'manual' }],
  visibility: { defaultRoles: ['*'] },
  retentionPolicy: { archiveOnSubjectExit: false, legalHoldHonoured: false },
  precisionIndexable: true,
  retrievalHints: {
    summaryTokenBudget: 400,
    primaryQueryUseCases: ['test'],
    sectionsPriorityForSummary: ['obligation'],
    embedSectionsWithSummaryPrefix: true,
    agentReadingHints: { primaryUseCases: ['test'], recommendedSectionsForQuery: {} },
  },
};

// Minimal pre-parsed LLMCompilationOutput (what the pack's parser produces).
function makeStructuredBody(overrides = {}) {
  return {
    summary: 'The DSL is the single point of safeguarding expertise in the school.',
    sections: [
      {
        key: 'obligation',
        heading: 'The obligation',
        text: 'The DSL must act as the single point of expertise for safeguarding.',
        citationIds: ['kcsie-2025-annex-c'],
        position: 0,
      },
      {
        key: 'timescales',
        heading: 'Timescales and deadlines',
        text: 'The DSL role is always active. No fixed deadline applies.',
        citationIds: [],
        position: 1,
      },
    ],
    citations: [
      {
        id: 'kcsie-2025-annex-c',
        claim: 'The DSL has the lead responsibility for safeguarding.',
        source: { kind: 'document', id: 'kcsie-2025-annex-c', label: 'KCSIE 2025 Annex C' },
        confidence: 1.0,
        position: { start: 0, end: 1 },
      },
    ],
    outboundLinks: [],
    ...overrides,
  };
}

const INSTITUTION_ID = 'inst-test-001';
const SUBJECT = { kind: 'institution', id: INSTITUTION_ID };
const GENERATION_RECORD = {
  triggeredBy: { kind: 'human_request', actor: { kind: 'operator', id: 'operator' }, reason: 'initial seed' },
  promptVersion: '0.1.0',
  sourceCount: 1,
  retrievalIds: [],
  generationDurationMs: 0,
};

// ---------------------------------------------------------------------------
// §1  Success path
// ---------------------------------------------------------------------------

describe('§1 seed() — success path', () => {
  test('returns articleId and versionId', async () => {
    const llm = createStubLLMAdapter(makeEmbedStubs(1));
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memory = fakeMemoryAdapter();

    const wiki = await NuWiki.open({
      metadata,
      bodies,
      memoryAdapter: memory,
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    const result = await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    assert.ok(result.articleId, 'articleId should be returned');
    assert.ok(result.versionId, 'versionId should be returned');
    assert.equal(result.articleId, 'kcsie-dsl-role:institution:inst-test-001');
    assert.match(result.versionId, /kcsie-dsl-role\/inst-test-001\/v1/);
  });

  test('writes article metadata with status=published', async () => {
    const llm = createStubLLMAdapter(makeEmbedStubs(1));
    const metadata = fakeMetadataAdapter();
    const wiki = await NuWiki.open({
      metadata,
      bodies: fakeStorageAdapter(),
      memoryAdapter: fakeMemoryAdapter(),
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    const upserted = metadata.calls.upsertArticle.find((r) => r.status === 'published');
    assert.ok(upserted, 'article upserted with status=published');
    assert.equal(upserted.documentType, 'kcsie-dsl-role');
    assert.equal(upserted.subject.kind, 'institution');
    assert.equal(upserted.subject.id, INSTITUTION_ID);
  });

  test('writes body to object storage', async () => {
    const llm = createStubLLMAdapter(makeEmbedStubs(1));
    const bodies = fakeStorageAdapter();
    const wiki = await NuWiki.open({
      metadata: fakeMetadataAdapter(),
      bodies,
      memoryAdapter: fakeMemoryAdapter(),
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    assert.ok(bodies.calls.put.length >= 1, 'at least one put call made');
    const stored = [...bodies._store.entries()];
    assert.ok(stored.length >= 1, 'body stored');
  });

  test('publishes summary + section + citation records to NuVector', async () => {
    const llm = createStubLLMAdapter(makeEmbedStubs(1));
    const memory = fakeMemoryAdapter();
    const wiki = await NuWiki.open({
      metadata: fakeMetadataAdapter(),
      bodies: fakeStorageAdapter(),
      memoryAdapter: memory,
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    assert.ok(memory.calls.upsertBatch.length >= 1, 'upsertBatch called');
    const allRecords = memory.calls.upsertBatch.flat();
    const summaryRecord = allRecords.find((r) => r.kind === 'nuwiki_article_summary');
    const sectionRecords = allRecords.filter((r) => r.kind === 'nuwiki_section');
    const citationRecords = allRecords.filter((r) => r.kind === 'nuwiki_citation');

    assert.ok(summaryRecord, 'summary record published');
    assert.equal(sectionRecords.length, 2, '2 sections published (one per section in fixture)');
    assert.ok(citationRecords.length >= 1, 'citation record published (precisionIndexable=true)');
  });

  test('writes a provenance record of kind nuwiki_seed', async () => {
    const llm = createStubLLMAdapter(makeEmbedStubs(1));
    const memory = fakeMemoryAdapter();
    const wiki = await NuWiki.open({
      metadata: fakeMetadataAdapter(),
      bodies: fakeStorageAdapter(),
      memoryAdapter: memory,
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    const provRecord = memory.calls.remember.find((r) => r.metadata?.seededBy === 'nuwiki_seed');
    assert.ok(provRecord, 'provenance record with seededBy=nuwiki_seed written');
    assert.equal(provRecord.metadata.documentType, 'kcsie-dsl-role');
  });
});

// ---------------------------------------------------------------------------
// §2  Rejection when documentType is not registered
// ---------------------------------------------------------------------------

describe('§2 seed() — rejection on unknown documentType', () => {
  test('throws a clear error when documentType is not registered', async () => {
    const wiki = await NuWiki.open({
      metadata: fakeMetadataAdapter(),
      bodies: fakeStorageAdapter(),
      memoryAdapter: fakeMemoryAdapter(),
      llmAdapter: createStubLLMAdapter([]),
      tenant: INSTITUTION_ID,
      documentTypes: [],  // no types registered
    });

    await assert.rejects(
      () =>
        wiki.seed({
          documentType: 'not-registered',
          subject: SUBJECT,
          structuredBody: makeStructuredBody(),
          generatedBy: GENERATION_RECORD,
        }),
      /documentType 'not-registered' is not registered/,
    );
  });
});

// ---------------------------------------------------------------------------
// §3  Idempotent re-seed
// ---------------------------------------------------------------------------

describe('§3 seed() — idempotent re-seed', () => {
  test('re-seeding the same article increments version and supersedes predecessor', async () => {
    // Two seed calls → 2 * 4 embed calls = 8 stubs.
    const llm = createStubLLMAdapter(makeEmbedStubs(2));
    const metadata = fakeMetadataAdapter();
    const memory = fakeMemoryAdapter();

    const wiki = await NuWiki.open({
      metadata,
      bodies: fakeStorageAdapter(),
      memoryAdapter: memory,
      llmAdapter: llm,
      tenant: INSTITUTION_ID,
      documentTypes: [statutoryTestDocType],
    });

    // First seed.
    const first = await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody(),
      generatedBy: GENERATION_RECORD,
    });

    // Second seed (re-seed).
    const second = await wiki.seed({
      documentType: 'kcsie-dsl-role',
      subject: SUBJECT,
      structuredBody: makeStructuredBody({ summary: 'Updated summary after operator revision.' }),
      generatedBy: { ...GENERATION_RECORD, promptVersion: '0.1.1' },
    });

    // Version increments.
    assert.match(first.versionId, /\/v1$/);
    assert.match(second.versionId, /\/v2$/);

    // markSuperseded called on re-seed.
    assert.ok(
      memory.calls.markSuperseded.length >= 1,
      'markSuperseded called on re-seed',
    );

    // Article still has a single logical ID (same articleId both times).
    assert.equal(first.articleId, second.articleId);

    // Article upserted twice (once per seed).
    const publishedUpserts = metadata.calls.upsertArticle.filter((r) => r.status === 'published');
    assert.ok(publishedUpserts.length >= 2, 'article upserted on each seed call');
  });
});
