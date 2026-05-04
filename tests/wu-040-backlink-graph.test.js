/**
 * WU 040 — NuWiki backlink graph + followLinks acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  NuWiki,
  diffOutboundLinks,
  BrokenLinkChecker,
} = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// § 1  diffOutboundLinks
// ---------------------------------------------------------------------------

describe('§1 diffOutboundLinks', () => {
  test('empty previous + non-empty next → all added', () => {
    const r = diffOutboundLinks([], [
      { toArticleId: 'a', linkType: 'mentions' },
      { toArticleId: 'b', linkType: 'supports_outcome' },
    ]);
    assert.equal(r.added.length, 2);
    assert.equal(r.removed.length, 0);
    assert.equal(r.unchanged.length, 0);
  });

  test('non-empty previous + empty next → all removed', () => {
    const r = diffOutboundLinks(
      [{ toArticleId: 'a', linkType: 'mentions' }],
      [],
    );
    assert.equal(r.removed.length, 1);
    assert.equal(r.added.length, 0);
  });

  test('same ids different linkTypes → both kept independently', () => {
    const r = diffOutboundLinks(
      [{ toArticleId: 'a', linkType: 'mentions' }],
      [{ toArticleId: 'a', linkType: 'supports_outcome' }],
    );
    assert.equal(r.added.length, 1);
    assert.equal(r.removed.length, 1);
    assert.equal(r.unchanged.length, 0);
  });

  test('overlap produces unchanged set', () => {
    const r = diffOutboundLinks(
      [{ toArticleId: 'a', linkType: 'mentions' }, { toArticleId: 'b', linkType: 'mentions' }],
      [{ toArticleId: 'a', linkType: 'mentions' }, { toArticleId: 'c', linkType: 'mentions' }],
    );
    assert.equal(r.unchanged.length, 1);
    assert.equal(r.unchanged[0].toArticleId, 'a');
    assert.equal(r.added[0].toArticleId, 'c');
    assert.equal(r.removed[0].toArticleId, 'b');
  });
});

// ---------------------------------------------------------------------------
// § 2  BrokenLinkChecker
// ---------------------------------------------------------------------------

describe('§2 BrokenLinkChecker', () => {
  function fakeMetadata(articles) {
    const map = new Map(Object.entries(articles));
    return {
      async upsertArticle() {}, async getArticle(id) { return map.get(id); },
      async findArticle() { return undefined; }, async listArticles() { return [...map.values()]; },
      async upsertVersion() {}, async getVersion() { return undefined; }, async listVersions() { return []; },
      async recordBacklink() {}, async removeBacklinksFor() {},
    };
  }

  test('reports missing target as broken', async () => {
    const checker = new BrokenLinkChecker(fakeMetadata({}));
    const r = await checker.check([{ toArticleId: 'art_1', linkType: 'mentions' }]);
    assert.equal(r.brokenLinks.length, 1);
    assert.equal(r.brokenLinks[0].reason, 'missing');
  });

  test('reports archived target as broken', async () => {
    const checker = new BrokenLinkChecker(fakeMetadata({
      art_1: { id: 'art_1', status: 'archived' },
    }));
    const r = await checker.check([{ toArticleId: 'art_1', linkType: 'mentions' }]);
    assert.equal(r.brokenLinks.length, 1);
    assert.equal(r.brokenLinks[0].reason, 'archived');
  });

  test('published target is not flagged', async () => {
    const checker = new BrokenLinkChecker(fakeMetadata({
      art_1: { id: 'art_1', status: 'published' },
    }));
    const r = await checker.check([{ toArticleId: 'art_1', linkType: 'mentions' }]);
    assert.equal(r.brokenLinks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// § 3  Engine — backlink maintenance
// ---------------------------------------------------------------------------

const docType = {
  type: 'pupil_profile',
  version: 'v1',
  subjectKind: 'pupil',
  description: 'Pupil profile.',
  sections: [{ key: 'overview', heading: 'Overview', required: true }],
  sourceQueries: [],
  refreshTriggers: [],
  visibility: { defaultRoles: ['teacher'] },
  retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
  precisionIndexable: false,
  retrievalHints: {
    summaryTokenBudget: 200,
    primaryQueryUseCases: [],
    sectionsPriorityForSummary: [],
    embedSectionsWithSummaryPrefix: true,
  },
};

function fakes() {
  const articles = new Map();
  const versions = new Map();
  const backlinks = []; // [{ from, to, type }]
  const removedFor = [];
  const calls = { upsertBatch: [], graphUpsert: [] };
  return {
    articles, versions, backlinks, removedFor, calls,
    metadata: {
      async upsertArticle(r) { articles.set(r.id, r); }, async getArticle(id) { return articles.get(id); },
      async findArticle() { return undefined; }, async listArticles() { return [...articles.values()]; },
      async upsertVersion(r) { versions.set(r.id, r); }, async getVersion(id) { return versions.get(id); },
      async listVersions(aid) { return [...versions.values()].filter((x) => x.articleId === aid); },
      async recordBacklink(from, to, type) { backlinks.push({ from, to, type }); },
      async removeBacklinksFor(id) { removedFor.push(id); },
    },
    bodies: {
      async put(ref, body) { return { ...ref, bytes: body.length }; }, async get() { return ''; }, async delete() {}, async exists() { return false; },
    },
    memoryAdapter: {
      async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async upsertBatch(records) { calls.upsertBatch.push(records); return records.map((r) => ({ id: r.id, upserted: true })); },
      async remember(r) { return { id: r.id, capturedAt: r.capturedAt }; },
      async delete() { return { deletedCount: 0, affectedLayers: [] }; },
      async markSuperseded() {},
      subscribeToInvalidations() { return () => {}; },
      graph: {
        async upsertNodeWithEdges(s) { calls.graphUpsert.push(s); }, async archiveNode() {}, async removeNode() {},
        async traverse(req) {
          const edges = (this._edges ?? []).filter(
            (e) => e.from === req.fromArticleId && (!req.linkTypes || req.linkTypes.includes(e.type)),
          );
          const visited = new Set([req.fromArticleId]);
          for (const e of edges) { visited.add(e.to); }
          return { edges, visitedArticleIds: [...visited] };
        },
        _edges: [],
      },
    },
  };
}

function llmOutput(outboundLinks = []) {
  return JSON.stringify({
    summary: 'Summary.',
    sections: [{ key: 'overview', heading: 'Overview', text: 'Body.', citationIds: [], position: 0 }],
    citations: [],
    outboundLinks,
  });
}

function script(content) {
  return [
    { content },
    { embedding: new Float32Array(8) },
    { embedding: new Float32Array(8) },
  ];
}

describe('§3 Engine — backlink maintenance', () => {
  test('first compile records backlinks for each outbound link; no removeBacklinksFor', async () => {
    const f = fakes();
    const out = llmOutput([
      { toArticleId: 'pupil_profile:pupil:p_other', linkType: 'mentions', context: 'x', position: { start: 0, end: 5 } },
      { toArticleId: 'class_briefing:class:c_001', linkType: 'supports_outcome', context: 'y', position: { start: 0, end: 5 } },
    ]);
    const llm = createStubLLMAdapter(script(out));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    assert.equal(f.removedFor.length, 0);
    assert.equal(f.backlinks.length, 2);
    assert.equal(f.backlinks[0].from, 'pupil_profile:pupil:p_1');
    assert.equal(f.backlinks[0].to, 'pupil_profile:pupil:p_other');
    assert.equal(f.backlinks[0].type, 'mentions');
    assert.equal(f.backlinks[1].type, 'supports_outcome');
  });

  test('recompile removes predecessor backlinks before recording new ones', async () => {
    const f = fakes();
    const firstOut = llmOutput([
      { toArticleId: 'pupil_profile:pupil:p_other', linkType: 'mentions', context: '', position: { start: 0, end: 1 } },
    ]);
    const secondOut = llmOutput([
      { toArticleId: 'class_briefing:class:c_001', linkType: 'supports_outcome', context: '', position: { start: 0, end: 1 } },
    ]);
    const llm = createStubLLMAdapter([...script(firstOut), ...script(secondOut)]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    // First compile recorded 1, second compile cleared then recorded 1 — total backlinks == 2 events
    assert.equal(f.removedFor.length, 1);
    assert.equal(f.removedFor[0], 'pupil_profile:pupil:p_1');
    assert.equal(f.backlinks.length, 2);
  });

  test('outbound link to non-existent target → broken_backlink warning, article still publishes', async () => {
    const f = fakes();
    const out = llmOutput([
      { toArticleId: 'totally_missing', linkType: 'mentions', context: '', position: { start: 0, end: 1 } },
    ]);
    const llm = createStubLLMAdapter(script(out));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published'); // non-fatal
    const broken = result.warnings.filter((w) => w.kind === 'broken_backlink');
    assert.equal(broken.length, 1);
    assert.equal(broken[0].details.toArticleId, 'totally_missing');
    assert.equal(broken[0].details.reason, 'missing');
  });

  test('outbound link to archived target → broken_backlink warning with reason: archived', async () => {
    const f = fakes();
    // pre-seed an archived article
    f.articles.set('archived_id', { id: 'archived_id', status: 'archived' });
    const out = llmOutput([
      { toArticleId: 'archived_id', linkType: 'mentions', context: '', position: { start: 0, end: 1 } },
    ]);
    const llm = createStubLLMAdapter(script(out));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const broken = result.warnings.filter((w) => w.kind === 'broken_backlink');
    assert.equal(broken.length, 1);
    assert.equal(broken[0].details.reason, 'archived');
  });
});

// ---------------------------------------------------------------------------
// § 4  followLinks
// ---------------------------------------------------------------------------

describe('§4 followLinks', () => {
  test('returns linked articles up to maxDepth=1 by default', async () => {
    const f = fakes();
    f.articles.set('art_1', { id: 'art_1', documentType: 'x', subject: { kind: 'pupil', id: 'p_1' }, currentVersion: 'v1', status: 'published', freshness: { lastCompiledAt: '', isFresh: true }, metadata: {} });
    f.articles.set('art_2', { id: 'art_2', documentType: 'x', subject: { kind: 'pupil', id: 'p_2' }, currentVersion: 'v1', status: 'published', freshness: { lastCompiledAt: '', isFresh: true }, metadata: {} });
    f.memoryAdapter.graph._edges = [
      { from: 'art_1', to: 'art_2', type: 'mentions' },
    ];
    const llm = createStubLLMAdapter([]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const linked = await wiki.followLinks({
      fromArticleId: 'art_1',
      viewerRole: 'teacher',
    });
    assert.equal(linked.length, 1);
    assert.equal(linked[0].articleId, 'art_2');
    assert.equal(linked[0].viewerRole, 'teacher');
  });

  test('honours linkTypes filter', async () => {
    const f = fakes();
    f.articles.set('art_2', { id: 'art_2', documentType: 'x', subject: { kind: 'pupil', id: 'p_2' }, currentVersion: 'v1', status: 'published', freshness: { lastCompiledAt: '', isFresh: true }, metadata: {} });
    f.articles.set('art_3', { id: 'art_3', documentType: 'x', subject: { kind: 'pupil', id: 'p_3' }, currentVersion: 'v1', status: 'published', freshness: { lastCompiledAt: '', isFresh: true }, metadata: {} });
    f.memoryAdapter.graph._edges = [
      { from: 'art_1', to: 'art_2', type: 'mentions' },
      { from: 'art_1', to: 'art_3', type: 'supports_outcome' },
    ];
    const llm = createStubLLMAdapter([]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const linked = await wiki.followLinks({
      fromArticleId: 'art_1',
      linkTypes: ['supports_outcome'],
      viewerRole: 'teacher',
    });
    assert.equal(linked.length, 1);
    assert.equal(linked[0].articleId, 'art_3');
  });

  test('skips articles whose metadata is missing', async () => {
    const f = fakes();
    // art_2 referenced but not stored in metadata
    f.memoryAdapter.graph._edges = [{ from: 'art_1', to: 'art_2', type: 'mentions' }];
    const llm = createStubLLMAdapter([]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [docType] });
    const linked = await wiki.followLinks({
      fromArticleId: 'art_1',
      viewerRole: 'teacher',
    });
    assert.equal(linked.length, 0);
  });
});

console.log('\nWU 040 — Backlink graph + followLinks acceptance complete\n');
