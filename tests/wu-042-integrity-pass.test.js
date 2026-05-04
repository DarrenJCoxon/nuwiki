/**
 * WU 042 — NuWiki integrity pass acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, IntegrityCheckers } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeDocType(overrides = {}) {
  return {
    type: 'pupil_profile',
    version: 'v1',
    subjectKind: 'pupil',
    description: 'Pupil profile.',
    sections: [{ key: 'overview', heading: 'Overview', required: true }],
    sourceQueries: [{ kind: 'database', query: { kind: 'pupil_recent', payload: {} }, description: '' }],
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
    ...overrides,
  };
}

function defaultParsed() {
  return {
    summary: 'Profile summary.',
    sections: [{ key: 'overview', heading: 'Overview', text: 'Body text.', citationIds: ['c1'], position: 0 }],
    citations: [{
      id: 'c1', claim: 'Claim.', source: { kind: 'database_event', ref: 'src_1' },
      confidence: 0.9, position: { start: 0, end: 1 },
    }],
    outboundLinks: [],
  };
}

function fakes() {
  const articles = new Map();
  const versions = new Map();
  const store = new Map();
  return {
    articles, versions, store,
    databaseSource: { async query() { return { rows: [{ id: 'src_1' }] }; } },
    metadata: {
      async upsertArticle(r) {
        articles.set(r.id, {
          ...r,
          freshness: r.freshness ?? { lastCompiledAt: r.updatedAt, isFresh: true },
          backlinks: { inboundCount: 0, outboundCount: 0 },
          visibility: { defaultRoles: [] },
        });
      },
      async getArticle(id) { return articles.get(id); },
      async findArticle() { return undefined; },
      async listArticles(filters = {}) {
        return [...articles.values()].filter((a) =>
          (!filters.tenant || a.tenant === filters.tenant) &&
          (!filters.documentType || a.documentType === filters.documentType),
        );
      },
      async upsertVersion(r) { versions.set(r.id, r); },
      async getVersion(id) { return versions.get(id); },
      async listVersions(aid) { return [...versions.values()].filter((x) => x.articleId === aid); },
      async recordBacklink() {},
      async removeBacklinksFor() {},
    },
    bodies: {
      async put(ref, body) { store.set(ref.key, body); return { ...ref, bytes: body.length }; },
      async get(ref) {
        const v = store.get(ref.key);
        if (v === undefined) throw new Error('not found');
        return v;
      },
      async delete(ref) { store.delete(ref.key); },
      async exists(ref) { return store.has(ref.key); },
    },
    memoryAdapter: {
      async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async upsertBatch(records) { return records.map((r) => ({ id: r.id, upserted: true })); },
      async remember(r) { return { id: r.id, capturedAt: r.capturedAt }; },
      async delete() { return { deletedCount: 0, affectedLayers: [] }; },
      async markSuperseded() {},
      subscribeToInvalidations() { return () => {}; },
      graph: {
        _edges: [],
        async upsertNodeWithEdges() {}, async archiveNode() {}, async removeNode() {},
        async traverse() { return { edges: [], visitedArticleIds: [] }; },
      },
    },
  };
}

function llmScript(parsed) {
  return [
    { content: JSON.stringify(parsed) },
    { embedding: new Float32Array(8) }, { embedding: new Float32Array(8) },
  ];
}

async function compileOne(wiki, subjectId) {
  return wiki.compile({
    documentType: 'pupil_profile',
    subject: { kind: 'pupil', id: subjectId },
    trigger: { kind: 'scheduled_refresh' },
  });
}

// ---------------------------------------------------------------------------
// § 1  Per-kind checkers
// ---------------------------------------------------------------------------

describe('§1 Per-kind checkers', () => {
  test('missing_evidence — blocked article produces an error finding', async () => {
    const f = fakes();
    const article = {
      id: 'art_1', tenant: 't', documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' }, path: '', currentVersion: 'v1',
      status: 'blocked', freshness: { lastCompiledAt: '2026-05-01T00:00:00Z', isFresh: false },
      backlinks: { inboundCount: 0, outboundCount: 0 },
      visibility: { defaultRoles: [] }, metadata: {},
      createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    };
    const out = await IntegrityCheckers.missing_evidence(article, { ...f, tenant: 't' }, [article]);
    const blocked = out.filter((o) => o.severity === 'error');
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].description, /blocked/);
  });

  test('stale_article — produces a warning finding', () => {
    const article = {
      id: 'art_1', tenant: 't', documentType: 'x', subject: { kind: 'p', id: '1' },
      path: '', currentVersion: 'v1', status: 'published',
      freshness: { lastCompiledAt: '2026-05-01T00:00:00Z', isFresh: false, reason: 'sources changed' },
      backlinks: { inboundCount: 0, outboundCount: 0 },
      visibility: { defaultRoles: [] }, metadata: {},
      createdAt: '', updatedAt: '',
    };
    const out = IntegrityCheckers.stale_article(article);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'stale_article');
    assert.equal(out[0].severity, 'warning');
    assert.match(out[0].description, /sources changed/);
  });

  test('stale_article — fresh article produces no finding', () => {
    const article = {
      id: 'art_1', freshness: { lastCompiledAt: '', isFresh: true },
    };
    const out = IntegrityCheckers.stale_article(article);
    assert.equal(out.length, 0);
  });

  test('duplicate_subject_articles — flags two non-archived articles with the same subject', () => {
    const articles = [
      { id: 'art_1', documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' }, status: 'published' },
      { id: 'art_2', documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' }, status: 'published' },
      { id: 'art_3', documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_2' }, status: 'published' },
    ];
    const out = IntegrityCheckers.duplicate_subject_articles(null, {}, articles);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'duplicate_subject_articles');
    assert.equal(out[0].severity, 'error');
    assert.match(out[0].description, /art_1, art_2/);
  });

  test('duplicate_subject_articles — archived articles excluded from duplication check', () => {
    const articles = [
      { id: 'art_1', documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' }, status: 'archived' },
      { id: 'art_2', documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' }, status: 'published' },
    ];
    const out = IntegrityCheckers.duplicate_subject_articles(null, {}, articles);
    assert.equal(out.length, 0);
  });
});

// ---------------------------------------------------------------------------
// § 2  Engine end-to-end — runIntegrityPass
// ---------------------------------------------------------------------------

describe('§2 runIntegrityPass end-to-end', () => {
  async function setup() {
    const f = fakes();
    const llm = createStubLLMAdapter([
      ...llmScript(defaultParsed()),
      ...llmScript(defaultParsed()),
      ...llmScript(defaultParsed()),
      ...llmScript(defaultParsed()),
    ]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [makeDocType()] });
    return { wiki, f, llm };
  }

  test('clean tenant — no findings', async () => {
    const { wiki } = await setup();
    await compileOne(wiki, 'p_1');
    const result = await wiki.runIntegrityPass({
      scope: 'tenant',
      checks: ['missing_evidence', 'stale_article', 'broken_backlink', 'uncited_claim', 'orphan_article', 'duplicate_subject_articles'],
    });
    assert.ok(result.passId);
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
    assert.equal(result.findings.length, 0);
    assert.equal(result.resolved.length, 0);
  });

  test('scope: subject filters to a single subject', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    await compileOne(wiki, 'p_2');
    // Force one stale by direct mutation
    const article = f.articles.get('pupil_profile:pupil:p_1');
    article.freshness = { lastCompiledAt: article.updatedAt, isFresh: false, reason: 'forced' };
    const result = await wiki.runIntegrityPass({
      scope: 'subject',
      subject: { kind: 'pupil', id: 'p_2' },
      checks: ['stale_article'],
    });
    // Only p_2 in scope; not stale → no findings
    assert.equal(result.findings.length, 0);
  });

  test('scope: documentType filters to a single type', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    // Force stale
    const article = f.articles.get('pupil_profile:pupil:p_1');
    article.freshness = { lastCompiledAt: article.updatedAt, isFresh: false, reason: 'forced' };
    const inScope = await wiki.runIntegrityPass({
      scope: 'documentType', documentType: 'pupil_profile', checks: ['stale_article'],
    });
    assert.equal(inScope.findings.length, 1);
    const outOfScope = await wiki.runIntegrityPass({
      scope: 'documentType', documentType: 'something_else', checks: ['stale_article'],
    });
    assert.equal(outOfScope.findings.length, 0);
  });

  test('uncited_claim — surfaces validation issues from stored .json', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    // Tamper with the stored .json: introduce an empty claim
    const jsonKey = [...f.store.keys()].find((k) => k.endsWith('.json'));
    const corrupted = { ...defaultParsed() };
    corrupted.citations = [{ ...corrupted.citations[0], claim: '   ' }];
    f.store.set(jsonKey, JSON.stringify(corrupted));
    const result = await wiki.runIntegrityPass({
      scope: 'tenant', checks: ['uncited_claim'],
    });
    assert.ok(result.findings.length >= 1);
    assert.equal(result.findings[0].kind, 'uncited_claim');
    assert.equal(result.findings[0].severity, 'error');
  });

  test('missing_evidence — blocked article surfaces; auto-remediation re-runs compile and resolves', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    // Flip the article to blocked; integrity pass picks it up as missing_evidence
    const article = f.articles.get('pupil_profile:pupil:p_1');
    article.status = 'blocked';
    const result = await wiki.runIntegrityPass({
      scope: 'tenant',
      checks: ['missing_evidence'],
      autoApplyRemediations: ['stale_article', 'uncited_claim'], // missing_evidence is NOT auto-fixable
    });
    const blocked = result.findings.find((f) => f.severity === 'error');
    assert.ok(blocked);
    assert.equal(blocked.kind, 'missing_evidence');
    // Not auto-fixable
    assert.equal(result.resolved.length, 0);
  });

  test('stale_article + autoApplyRemediations → resolved findings', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    const article = f.articles.get('pupil_profile:pupil:p_1');
    article.freshness = { lastCompiledAt: article.updatedAt, isFresh: false, reason: 'sources changed' };
    const result = await wiki.runIntegrityPass({
      scope: 'tenant',
      checks: ['stale_article'],
      autoApplyRemediations: ['stale_article'],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].finding.kind, 'stale_article');
    assert.match(result.resolved[0].resolution, /Recompiled/);
    assert.ok(result.resolved[0].resolvedAt);
  });

  test('duplicate_subject_articles — produces one cross-article finding per duplicate group', async () => {
    const { wiki, f } = await setup();
    await compileOne(wiki, 'p_1');
    // Manually inject a duplicate published article for the same subject
    f.articles.set('dup_id', {
      id: 'dup_id', tenant: 't', documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' }, path: '', currentVersion: 'v1',
      status: 'published',
      freshness: { lastCompiledAt: '', isFresh: true },
      backlinks: { inboundCount: 0, outboundCount: 0 },
      visibility: { defaultRoles: [] }, metadata: {},
      createdAt: '', updatedAt: '',
    });
    const result = await wiki.runIntegrityPass({
      scope: 'tenant', checks: ['duplicate_subject_articles'],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].kind, 'duplicate_subject_articles');
  });
});

console.log('\nWU 042 — Integrity pass acceptance complete\n');
