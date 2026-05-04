/**
 * WU 038 — NuWiki section embedding with article-summary prefix invariant.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, buildSectionEmbeddingText } = await import('../dist/src/index.js');
const { createStubLLMAdapter } = await import('../dist/src/llm.js');

// ---------------------------------------------------------------------------
// § 1  buildSectionEmbeddingText pure function
// ---------------------------------------------------------------------------

describe('§1 buildSectionEmbeddingText', () => {
  test('default behaviour prefixes with [Article: <summary>]', () => {
    const out = buildSectionEmbeddingText(
      'Tight summary about the subject.',
      { heading: 'Overview', text: 'Subject background.' },
    );
    assert.equal(out, '[Article: Tight summary about the subject.]\nOverview: Subject background.');
  });

  test('withPrefix: true is the same as default', () => {
    const a = buildSectionEmbeddingText('S', { heading: 'H', text: 'T' });
    const b = buildSectionEmbeddingText('S', { heading: 'H', text: 'T' }, { withPrefix: true });
    assert.equal(a, b);
  });

  test('withPrefix: false drops the prefix and uses heading\\ntext', () => {
    const out = buildSectionEmbeddingText(
      'S',
      { heading: 'Overview', text: 'Body.' },
      { withPrefix: false },
    );
    assert.equal(out, 'Overview\nBody.');
  });

  test('multiline summary is included verbatim in the prefix', () => {
    const out = buildSectionEmbeddingText(
      'Line one.\nLine two.',
      { heading: 'H', text: 'T' },
    );
    assert.match(out, /^\[Article: Line one\.\nLine two\.\]\nH: T$/);
  });
});

// ---------------------------------------------------------------------------
// § 2  Engine end-to-end
// ---------------------------------------------------------------------------

const docTypeWithPrefix = {
  type: 'pupil_profile',
  version: 'v1',
  subjectKind: 'pupil',
  description: 'Pupil profile.',
  sections: [
    { key: 'overview', heading: 'Overview', required: true },
    { key: 'recent', heading: 'Recent activity', required: false },
  ],
  sourceQueries: [],
  refreshTriggers: [],
  visibility: { defaultRoles: ['teacher'] },
  retentionPolicy: { archiveOnSubjectExit: true, legalHoldHonoured: true },
  precisionIndexable: false,
  retrievalHints: {
    summaryTokenBudget: 200,
    primaryQueryUseCases: ['pupil overview'],
    sectionsPriorityForSummary: ['overview'],
    embedSectionsWithSummaryPrefix: true,
  },
};

const docTypeOptOut = {
  ...docTypeWithPrefix,
  type: 'public_policy',
  retrievalHints: { ...docTypeWithPrefix.retrievalHints, embedSectionsWithSummaryPrefix: false },
};

function fakeMetadata() {
  const a = new Map(), v = new Map();
  return {
    async upsertArticle(r) { a.set(r.id, r); }, async getArticle(id) { return a.get(id); },
    async findArticle() { return undefined; }, async listArticles() { return [...a.values()]; },
    async upsertVersion(r) { v.set(r.id, r); }, async getVersion(id) { return v.get(id); },
    async listVersions(aid) { return [...v.values()].filter((x) => x.articleId === aid); },
    async recordBacklink() {}, async removeBacklinksFor() {},
  };
}
function fakeBodies() {
  return { async put(ref, body) { return { ...ref, bytes: body.length }; }, async get() { return ''; }, async delete() {}, async exists() { return false; } };
}
function fakeMemory() {
  const calls = { upsertBatch: [] };
  return {
    calls,
    async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
    async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
    async upsertBatch(records) { calls.upsertBatch.push(records); return records.map((r) => ({ id: r.id, upserted: true })); },
    async remember(r) { return { id: r.id, capturedAt: r.capturedAt }; },
    async delete() { return { deletedCount: 0, affectedLayers: [] }; },
    async markSuperseded() {},
    subscribeToInvalidations() { return () => {}; },
    graph: { async upsertNodeWithEdges() {}, async archiveNode() {}, async removeNode() {} },
  };
}

function llmOutput(summary = 'Crisp summary about p_1.') {
  return JSON.stringify({
    summary,
    sections: [
      { key: 'overview', heading: 'Overview', text: 'Background.', citationIds: [], position: 0 },
      { key: 'recent', heading: 'Recent activity', text: 'Latest events.', citationIds: [], position: 1 },
    ],
    citations: [],
    outboundLinks: [],
  });
}

function script(content) {
  return [
    { content },
    { embedding: new Float32Array(8) }, // summary
    { embedding: new Float32Array(8) }, // section 1
    { embedding: new Float32Array(8) }, // section 2
  ];
}

describe('§2 Engine — section embeds use the prefix', () => {
  test('default DocumentType (embedSectionsWithSummaryPrefix: true) → embeds use [Article: ...] prefix', async () => {
    const llm = createStubLLMAdapter(script(llmOutput('Crisp summary about p_1.')));
    const wiki = await NuWiki.open({
      metadata: fakeMetadata(), bodies: fakeBodies(), memoryAdapter: fakeMemory(), llmAdapter: llm,
      tenant: 't', documentTypes: [docTypeWithPrefix],
    });
    const result = await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    const embeds = llm.calls.filter((c) => c.kind === 'embed');
    // 1 summary + 2 sections = 3 embed calls
    assert.equal(embeds.length, 3);
    // section 1 + section 2 carry the prefix
    assert.match(embeds[1].text, /^\[Article: Crisp summary about p_1\.\]\nOverview: Background\.$/);
    assert.match(embeds[2].text, /^\[Article: Crisp summary about p_1\.\]\nRecent activity: Latest events\.$/);
  });

  test('opt-out DocumentType (embedSectionsWithSummaryPrefix: false) → embeds use heading\\ntext', async () => {
    const llm = createStubLLMAdapter(script(llmOutput('Policy summary.')));
    const wiki = await NuWiki.open({
      metadata: fakeMetadata(), bodies: fakeBodies(), memoryAdapter: fakeMemory(), llmAdapter: llm,
      tenant: 't', documentTypes: [docTypeOptOut],
    });
    const result = await wiki.compile({
      documentType: 'public_policy',
      subject: { kind: 'institution', id: 'school_bridge' },
      trigger: { kind: 'scheduled_refresh' },
    });
    assert.equal(result.status, 'published');
    const embeds = llm.calls.filter((c) => c.kind === 'embed');
    assert.equal(embeds[1].text, 'Overview\nBackground.');
    assert.equal(embeds[2].text, 'Recent activity\nLatest events.');
  });

  test('layer-2 metadata.parentArticleSummary still carries the summary regardless of opt-out', async () => {
    const memory = fakeMemory();
    const llm = createStubLLMAdapter(script(llmOutput('Policy summary.')));
    const wiki = await NuWiki.open({
      metadata: fakeMetadata(), bodies: fakeBodies(), memoryAdapter: memory, llmAdapter: llm,
      tenant: 't', documentTypes: [docTypeOptOut],
    });
    await wiki.compile({
      documentType: 'public_policy',
      subject: { kind: 'institution', id: 'school_bridge' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const sectionRecords = memory.calls.upsertBatch[0].filter((r) => r.kind === 'nuwiki_section');
    for (const s of sectionRecords) {
      assert.equal(s.metadata.parentArticleSummary, 'Policy summary.');
    }
  });

  test('summary embed text is the bare summary (never prefixed)', async () => {
    const llm = createStubLLMAdapter(script(llmOutput('Tight summary.')));
    const wiki = await NuWiki.open({
      metadata: fakeMetadata(), bodies: fakeBodies(), memoryAdapter: fakeMemory(), llmAdapter: llm,
      tenant: 't', documentTypes: [docTypeWithPrefix],
    });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const embeds = llm.calls.filter((c) => c.kind === 'embed');
    assert.equal(embeds[0].text, 'Tight summary.');
  });
});

console.log('\nWU 038 — Section-summary-prefix invariant acceptance complete\n');
