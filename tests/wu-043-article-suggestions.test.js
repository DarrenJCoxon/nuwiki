/**
 * WU 043 — NuWiki article-suggestion engine acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, parseLLMSuggestionOutput, LLMSuggestionParseError } = await import('../dist/src/index.js');
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

function fakes() {
  const articles = new Map();
  const store = new Map();
  return {
    articles,
    store,
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
      async upsertVersion(r) { store.set(r.id, r); },
      async getVersion(id) { return store.get(id); },
      async listVersions(aid) { return [...store.values()].filter((x) => x.articleId === aid); },
      async recordBacklink() {},
      async removeBacklinksFor() {},
    },
    bodies: {
      async put(ref, body) { store.set(ref.key, body); return { ...ref, bytes: body.length }; },
      async get(ref) { return store.get(ref.key) ?? ''; },
      async delete(ref) { store.delete(ref.key); },
      async exists(ref) { return store.has(ref.key); },
    },
    memoryAdapter: {
      async upsertBatch() { return []; },
      async searchKnowledge() { return { items: [], retrievalId: 'r1' }; },
      async retrieveContext() {
        return {
          items: [
            { ref: 'inc_001', kind: 'incident_history', summary: 'Pupil A was involved in a playground incident.', text: 'Details...', metadata: {} },
            { ref: 'inc_002', kind: 'incident_history', summary: 'Pupil B had a safeguarding concern raised.', text: 'Details...', metadata: {} },
          ],
          retrievalId: 'r2',
        };
      },
      graph: {
        async upsertNodeWithEdges() {},
        async archiveNode() {},
        async removeNode() {},
        async traverse() { return { edges: [], visitedArticleIds: [] }; },
      },
      remember: async () => ({ ref: 'p1' }),
      markSuperseded: async () => {},
      delete: async () => ({ deletedCount: 0 }),
      subscribeToInvalidations: () => () => {},
    },
    databaseSource: { async query() { return { rows: [] }; } },
  };
}

function makeWiki(fakes, opts = {}) {
  return NuWiki.open({
    metadata: fakes.metadata,
    bodies: fakes.bodies,
    memoryAdapter: fakes.memoryAdapter,
    llmAdapter: opts.llmAdapter ?? createStubLLMAdapter(),
    databaseSource: fakes.databaseSource,
    tenant: 'test_school',
    documentTypes: [makeDocType()],
  });
}

// ---------------------------------------------------------------------------
// § 1  parseLLMSuggestionOutput
// ---------------------------------------------------------------------------

describe('§1 parseLLMSuggestionOutput', () => {
  test('valid JSON with suggestions → parsed array', () => {
    const content = JSON.stringify({
      suggestions: [
        {
          documentType: 'pupil_profile',
          subject: { kind: 'pupil', id: 'p_new', label: 'New Pupil' },
          rationale: 'Incident history shows a safeguarding concern.',
          evidenceRefs: [{ kind: 'incident_history', ref: 'inc_002' }],
          estimatedValue: 'high',
        },
      ],
    });
    const result = parseLLMSuggestionOutput(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].documentType, 'pupil_profile');
    assert.equal(result[0].subject.id, 'p_new');
    assert.equal(result[0].rationale, 'Incident history shows a safeguarding concern.');
    assert.equal(result[0].estimatedValue, 'high');
    assert.equal(result[0].evidenceRefs.length, 1);
    assert.equal(result[0].evidenceRefs[0].ref, 'inc_002');
  });

  test('empty suggestions array → empty result', () => {
    const content = JSON.stringify({ suggestions: [] });
    const result = parseLLMSuggestionOutput(content);
    assert.equal(result.length, 0);
  });

  test('missing suggestions field → throws LLMSuggestionParseError', () => {
    assert.throws(() => parseLLMSuggestionOutput('{}'), LLMSuggestionParseError);
  });

  test('invalid JSON → throws LLMSuggestionParseError', () => {
    assert.throws(() => parseLLMSuggestionOutput('not json'), LLMSuggestionParseError);
  });

  test('suggestion missing required field → throws LLMSuggestionParseError', () => {
    const content = JSON.stringify({
      suggestions: [{ documentType: 'pupil_profile' }],
    });
    assert.throws(() => parseLLMSuggestionOutput(content), LLMSuggestionParseError);
  });

  test('invalid estimatedValue → throws LLMSuggestionParseError', () => {
    const content = JSON.stringify({
      suggestions: [{
        documentType: 'pupil_profile',
        subject: { kind: 'pupil', id: 'p1' },
        rationale: 'Reason',
        estimatedValue: 'invalid',
      }],
    });
    assert.throws(() => parseLLMSuggestionOutput(content), LLMSuggestionParseError);
  });

  test('optional evidenceRefs omitted → empty array', () => {
    const content = JSON.stringify({
      suggestions: [{
        documentType: 'pupil_profile',
        subject: { kind: 'pupil', id: 'p1' },
        rationale: 'Reason',
        estimatedValue: 'medium',
      }],
    });
    const result = parseLLMSuggestionOutput(content);
    assert.equal(result[0].evidenceRefs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// § 2  suggestNewArticles end-to-end
// ---------------------------------------------------------------------------

describe('§2 suggestNewArticles end-to-end', () => {
  test('no existing articles, sources present → suggestions returned', async () => {
    const f = fakes();
    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: JSON.stringify({
          suggestions: [
            {
              documentType: 'pupil_profile',
              subject: { kind: 'pupil', id: 'p_new', label: 'New Pupil' },
              rationale: 'Incident history indicates a profile should exist.',
              evidenceRefs: [{ kind: 'incident_history', ref: 'inc_002' }],
              estimatedValue: 'high',
            },
          ],
        }),
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    const result = await wiki.suggestNewArticles({ scope: 'tenant' });
    assert.equal(result.length, 1);
    assert.equal(result[0].documentType, 'pupil_profile');
    assert.equal(result[0].subject.id, 'p_new');
    assert.ok(result[0].suggestedAt, 'suggestion should carry suggestedAt');
    assert.match(result[0].suggestedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('existing article covers subject → suggestion filtered out', async () => {
    const f = fakes();
    await f.metadata.upsertArticle({
      id: 'pupil_profile:pupil:p_existing',
      tenant: 'test_school',
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_existing', label: 'Existing Pupil' },
      path: 'pupil_profile/pupil/p_existing',
      currentVersion: 'v1',
      status: 'published',
      metadata: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: JSON.stringify({
          suggestions: [
            {
              documentType: 'pupil_profile',
              subject: { kind: 'pupil', id: 'p_existing', label: 'Existing Pupil' },
              rationale: 'Already exists.',
              estimatedValue: 'medium',
            },
          ],
        }),
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    const result = await wiki.suggestNewArticles({ scope: 'tenant' });
    assert.equal(result.length, 0);
  });

  test('scope: documentType filters to a single type', async () => {
    const f = fakes();
    await f.metadata.upsertArticle({
      id: 'pupil_profile:pupil:p1',
      tenant: 'test_school',
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p1' },
      path: 'pupil_profile/pupil/p1',
      currentVersion: 'v1',
      status: 'published',
      metadata: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: JSON.stringify({ suggestions: [] }),
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    const result = await wiki.suggestNewArticles({ scope: 'documentType', documentType: 'pupil_profile' });
    assert.equal(result.length, 0);
  });

  test('scope: subject filters to a single subject', async () => {
    const f = fakes();
    await f.metadata.upsertArticle({
      id: 'pupil_profile:pupil:p1',
      tenant: 'test_school',
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p1' },
      path: 'pupil_profile/pupil/p1',
      currentVersion: 'v1',
      status: 'published',
      metadata: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: JSON.stringify({
          suggestions: [
            {
              documentType: 'pupil_profile',
              subject: { kind: 'pupil', id: 'p1' },
              rationale: 'Already exists.',
              estimatedValue: 'low',
            },
          ],
        }),
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    const result = await wiki.suggestNewArticles({ scope: 'subject', subject: { kind: 'pupil', id: 'p1' } });
    assert.equal(result.length, 0); // filtered because article exists for this subject
  });

  test('LLM returns empty suggestions → empty result', async () => {
    const f = fakes();
    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: JSON.stringify({ suggestions: [] }),
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    const result = await wiki.suggestNewArticles({ scope: 'tenant' });
    assert.equal(result.length, 0);
  });

  test('LLM parse failure propagates LLMSuggestionParseError', async () => {
    const f = fakes();
    const llm = createStubLLMAdapter([
      { embedding: [0.1, 0.2, 0.3] },
      {
        content: 'not valid json',
        finishReason: 'stop',
        model: 'test',
      },
    ]);

    const wiki = await makeWiki(f, { llmAdapter: llm });
    await assert.rejects(
      () => wiki.suggestNewArticles({ scope: 'tenant' }),
      LLMSuggestionParseError,
    );
  });
});

console.log('\nWU 043 — Article suggestion engine acceptance complete\n');
