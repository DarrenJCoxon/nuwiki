/**
 * WU 037 — NuWiki summary token budget enforcement acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  NuWiki,
  estimateTokenCount,
  assertWithinTokenBudget,
  TokenBudgetExceededError,
} = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// § 1  Token estimator
// ---------------------------------------------------------------------------

describe('§1 estimateTokenCount', () => {
  test('returns 0 for empty input', () => {
    assert.equal(estimateTokenCount(''), 0);
  });

  test('returns sensible counts for short prose', () => {
    // "hello" — 1 word, 5 chars → ceil(5/4) = 2; max(1, 2) = 2
    assert.equal(estimateTokenCount('hello'), 2);
  });

  test('uses character-based estimate for prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    // length 44 → ceil(44/4) = 11; word count = 9; max(9, 11) = 11
    assert.equal(estimateTokenCount(text), 11);
  });

  test('accepts an optional model hint without changing behaviour (model-agnostic)', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    assert.equal(estimateTokenCount(text), estimateTokenCount(text, 'gemini-flash-3'));
    assert.equal(estimateTokenCount(text), estimateTokenCount(text, 'gpt-5'));
  });
});

// ---------------------------------------------------------------------------
// § 2  assertWithinTokenBudget
// ---------------------------------------------------------------------------

describe('§2 assertWithinTokenBudget', () => {
  test('returns observed count when within budget', () => {
    const observed = assertWithinTokenBudget('hello world', 100);
    assert.ok(observed > 0 && observed <= 100);
  });

  test('throws TokenBudgetExceededError when over budget', () => {
    const longText = 'x'.repeat(2000); // ~500 tokens by char heuristic
    try {
      assertWithinTokenBudget(longText, 50);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof TokenBudgetExceededError);
      assert.equal(err.budget, 50);
      assert.ok(err.observed > 50);
      assert.match(err.message, /Token budget exceeded/);
    }
  });

  test('honours an injected counter', () => {
    const fixedCounter = () => 42;
    assert.equal(assertWithinTokenBudget('anything', 100, fixedCounter), 42);
    assert.throws(() => assertWithinTokenBudget('anything', 10, fixedCounter), TokenBudgetExceededError);
  });
});

// ---------------------------------------------------------------------------
// § 3  Engine integration
// ---------------------------------------------------------------------------

const docTypeShortBudget = {
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
    summaryTokenBudget: 30, // intentionally tight
    primaryQueryUseCases: ['pupil overview', 'recent activity'],
    sectionsPriorityForSummary: ['overview'],
    embedSectionsWithSummaryPrefix: true,
  },
};

function fakeMetadataAdapter() {
  const articles = new Map();
  const versions = new Map();
  const calls = { upsertArticle: [], upsertVersion: [] };
  return {
    calls,
    async upsertArticle(r) { calls.upsertArticle.push(r); articles.set(r.id, r); },
    async getArticle(id) { return articles.get(id); },
    async findArticle() { return undefined; },
    async listArticles() { return [...articles.values()]; },
    async upsertVersion(v) { calls.upsertVersion.push(v); versions.set(v.id, v); },
    async getVersion(id) { return versions.get(id); },
    async listVersions(aid) { return [...versions.values()].filter((v) => v.articleId === aid); },
    async recordBacklink() {},
    async removeBacklinksFor() {},
  };
}
function fakeStorageAdapter() {
  const calls = { put: [] };
  return {
    calls,
    async put(ref, body) { calls.put.push({ ref, body }); return { ...ref, bytes: body.length }; },
    async get() { return ''; },
    async delete() {},
    async exists() { return false; },
  };
}
function fakeMemoryAdapter() {
  const calls = { upsertBatch: [], graphUpsert: [], remember: [], markSuperseded: [] };
  return {
    calls,
    async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
    async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
    async upsertBatch(records) { calls.upsertBatch.push(records); return records.map((r) => ({ id: r.id, upserted: true })); },
    async remember(r) { calls.remember.push(r); return { id: r.id, capturedAt: r.capturedAt }; },
    async delete() { return { deletedCount: 0, affectedLayers: [] }; },
    async markSuperseded(q) { calls.markSuperseded.push(q); },
    subscribeToInvalidations() { return () => {}; },
    graph: {
      async upsertNodeWithEdges(s) { calls.graphUpsert.push(s); },
      async archiveNode() {},
      async removeNode() {},
    },
  };
}

function shortSummaryOutput() {
  return JSON.stringify({
    summary: 'Tight summary.',
    sections: [{ key: 'overview', heading: 'Overview', text: 'A line.', citationIds: [], position: 0 }],
    citations: [],
    outboundLinks: [],
  });
}

function longSummaryOutput() {
  return JSON.stringify({
    summary: 'x'.repeat(1000), // ~250 tokens by char heuristic; well over 30
    sections: [{ key: 'overview', heading: 'Overview', text: 'A line.', citationIds: [], position: 0 }],
    citations: [],
    outboundLinks: [],
  });
}

function defaultScript(content) {
  return [
    { content },
    { embedding: new Float32Array(8) },
    { embedding: new Float32Array(8) },
  ];
}

describe('§3 Engine: budget enforcement', () => {
  test('within-budget summary publishes; layer-1 metadata.summaryTokenLength uses the counter', async () => {
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memoryAdapter = fakeMemoryAdapter();
    const llmAdapter = createStubLLMAdapter(defaultScript(shortSummaryOutput()));
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter,
      tenant: 't', documentTypes: [docTypeShortBudget],
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    const summaryRecord = memoryAdapter.calls.upsertBatch[0][0];
    assert.equal(typeof summaryRecord.metadata.summaryTokenLength, 'number');
    assert.ok(summaryRecord.metadata.summaryTokenLength > 0);
    assert.ok(summaryRecord.metadata.summaryTokenLength <= 30);
  });

  test('over-budget summary → blocked with over_budget_summary warning, no NuVector / body / metadata version writes', async () => {
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memoryAdapter = fakeMemoryAdapter();
    const llmAdapter = createStubLLMAdapter([{ content: longSummaryOutput() }]);
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter,
      tenant: 't', documentTypes: [docTypeShortBudget],
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.warnings[0].kind, 'over_budget_summary');
    assert.match(result.warnings[0].message, /budget 30/);
    assert.ok(result.warnings[0].details.observed > 30);

    // No publish, no body write, no version write
    assert.equal(memoryAdapter.calls.upsertBatch.length, 0);
    assert.equal(memoryAdapter.calls.graphUpsert.length, 0);
    assert.equal(memoryAdapter.calls.remember.length, 0);
    assert.equal(bodies.calls.put.length, 0);
    assert.equal(metadata.calls.upsertVersion.length, 0);
  });

  test('injected tokenCounter is used (not the default heuristic)', async () => {
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memoryAdapter = fakeMemoryAdapter();
    const llmAdapter = createStubLLMAdapter(defaultScript(shortSummaryOutput()));
    let counterCalls = 0;
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter,
      tenant: 't',
      documentTypes: [docTypeShortBudget],
      tokenCounter: (s) => { counterCalls++; return Math.min(s.length, 5); },
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    assert.ok(counterCalls >= 2); // budget check + summary length write
    const summaryRecord = memoryAdapter.calls.upsertBatch[0][0];
    assert.equal(summaryRecord.metadata.summaryTokenLength, 5);
  });

  test('injected tokenCounter that always exceeds budget → blocked', async () => {
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memoryAdapter = fakeMemoryAdapter();
    const llmAdapter = createStubLLMAdapter([{ content: shortSummaryOutput() }]);
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter,
      tenant: 't',
      documentTypes: [docTypeShortBudget],
      tokenCounter: () => 9999,
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.warnings[0].kind, 'over_budget_summary');
    assert.equal(result.warnings[0].details.observed, 9999);
  });
});

// ---------------------------------------------------------------------------
// § 4  System prompt enrichment
// ---------------------------------------------------------------------------

describe('§4 System prompt includes budget + retrieval hints', () => {
  test('prompt mentions token budget and retrieval-hint fields', async () => {
    const metadata = fakeMetadataAdapter();
    const bodies = fakeStorageAdapter();
    const memoryAdapter = fakeMemoryAdapter();
    const llmAdapter = createStubLLMAdapter(defaultScript(shortSummaryOutput()));
    const wiki = await NuWiki.open({
      metadata, bodies, memoryAdapter, llmAdapter,
      tenant: 't', documentTypes: [docTypeShortBudget],
    });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const generateCall = llmAdapter.calls.find((c) => c.kind === 'generate');
    const sys = generateCall.request.systemPrompt;
    assert.match(sys, /Maximum 30 tokens/);
    assert.match(sys, /pupil overview/);
    assert.match(sys, /recent activity/);
    assert.match(sys, /Sections to weight most: overview/);
    assert.match(sys, /Cite no specific claims/);
  });
});

console.log('\nWU 037 — Summary token budget acceptance complete\n');
