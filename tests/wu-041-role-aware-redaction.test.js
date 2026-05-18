/**
 * WU 041 — NuWiki role-aware redaction + read() acceptance test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWiki, redactArticle } = await import('../dist/src/index.js');
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
    sections: [
      { key: 'overview', heading: 'Overview', required: true },
      {
        key: 'safeguarding',
        heading: 'Safeguarding',
        required: false,
        redactionRules: {
          ta: { role: 'teaching_assistant', action: 'hide' },
          parent: { role: 'parent', action: 'summarise', replacement: '[Confidential]' },
        },
      },
    ],
    sourceQueries: [{ kind: 'database', query: { kind: 'pupil_recent', payload: {} }, description: '' }],
    refreshTriggers: [],
    visibility: {
      defaultRoles: ['teacher', 'senco', 'teaching_assistant', 'parent'],
      excludedRoles: ['external'],
    },
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

function makeParsed() {
  return {
    summary: 'Profile summary.',
    sections: [
      { key: 'overview', heading: 'Overview', text: 'Background facts.', citationIds: ['c1'], position: 0 },
      { key: 'safeguarding', heading: 'Safeguarding', text: 'Sensitive details about CP.', citationIds: ['c2'], position: 1 },
    ],
    citations: [
      { id: 'c1', claim: 'Background claim.', source: { kind: 'database_event', ref: 'src_1' }, confidence: 0.9, position: { start: 0, end: 1 } },
      { id: 'c2', claim: 'Safeguarding claim.', source: { kind: 'database_event', ref: 'src_2' }, confidence: 0.95, position: { start: 0, end: 1 } },
    ],
    outboundLinks: [
      { toArticleId: 'pupil_profile:pupil:p_other', linkType: 'mentions', context: 'mentioned', position: { start: 0, end: 5 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// § 1  redactArticle pure function
// ---------------------------------------------------------------------------

describe('§1 redactArticle', () => {
  test('default role (in defaultRoles, no rule) → all sections shown, no warning', () => {
    const r = redactArticle({
      documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'teacher',
    });
    assert.match(r.body, /## Overview/);
    assert.match(r.body, /## Safeguarding/);
    assert.match(r.body, /Sensitive details about CP/);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.citations.length, 2);
  });

  test('role with hide action → section omitted from body and citation list', () => {
    const r = redactArticle({
      documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'teaching_assistant',
    });
    assert.match(r.body, /## Overview/);
    assert.doesNotMatch(r.body, /Safeguarding/);
    assert.doesNotMatch(r.body, /Sensitive details/);
    // citation c2 was anchored to safeguarding section → stripped
    assert.equal(r.citations.length, 1);
    assert.equal(r.citations[0].citationId, 'c1');
    // limited_view warning emitted
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].kind, 'limited_view');
  });

  test('role with summarise action → heading kept, replacement text in body', () => {
    const r = redactArticle({
      documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'parent',
    });
    assert.match(r.body, /## Safeguarding/);
    assert.match(r.body, /\[Confidential\]/);
    assert.doesNotMatch(r.body, /Sensitive details about CP/);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].kind, 'limited_view');
  });

  test('role in excludedRoles → entire body replaced with hide placeholder', () => {
    const r = redactArticle({
      documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'external',
    });
    assert.match(r.body, /Article hidden for role: external/);
    assert.equal(r.citations.length, 0);
    assert.equal(r.outboundLinks.length, 0);
    assert.equal(r.warnings[0].details.reason, 'role_excluded');
  });

  test('role not in defaultRoles and not mentioned in any section rule → article hidden', () => {
    const docType = makeDocType({
      visibility: { defaultRoles: ['teacher'], excludedRoles: [] },
      sections: [{ key: 'overview', heading: 'Overview', required: true }],
    });
    const r = redactArticle({
      documentType: docType, parsed: makeParsed(), viewerRole: 'random_role',
    });
    assert.match(r.body, /Article hidden/);
    assert.equal(r.warnings[0].details.reason, 'role_not_in_default');
  });

  test('defaultRoles: ["*"] matches any viewer role (wildcard for universally-readable content)', () => {
    const docType = makeDocType({
      visibility: { defaultRoles: ['*'], excludedRoles: [] },
      sections: [{ key: 'overview', heading: 'Overview', required: true }],
    });
    for (const role of ['DSL', 'Head', 'SENCO', 'teaching_assistant', 'parent', 'arbitrary_role']) {
      const r = redactArticle({
        documentType: docType, parsed: makeParsed(), viewerRole: role,
      });
      assert.doesNotMatch(r.body, /Article hidden/, `role '${role}' should NOT be hidden under defaultRoles: ['*']`);
      assert.match(r.body, /## Overview/, `body should contain rendered section for role '${role}'`);
    }
  });

  test('redact action default replacement reads "[Section redacted: <heading>]"', () => {
    const docType = makeDocType({
      sections: [
        { key: 'overview', heading: 'Overview', required: true },
        { key: 'safeguarding', heading: 'Safeguarding', required: false,
          redactionRules: { x: { role: 'teaching_assistant', action: 'redact' } } },
      ],
    });
    const r = redactArticle({
      documentType: docType, parsed: makeParsed(), viewerRole: 'teaching_assistant',
    });
    assert.match(r.body, /\[Section redacted: Safeguarding\]/);
  });

  test('outbound links hydrate from linkTargets when provided', () => {
    const r = redactArticle({
      documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'teacher',
      linkTargets: {
        'pupil_profile:pupil:p_other': { subject: { kind: 'pupil', id: 'p_other' }, documentType: 'pupil_profile' },
      },
    });
    assert.equal(r.outboundLinks.length, 1);
    assert.equal(r.outboundLinks[0].toSubject.id, 'p_other');
    assert.equal(r.outboundLinks[0].toDocumentType, 'pupil_profile');
  });

  test('purity — same input returns equivalent output', () => {
    const a = redactArticle({ documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'teacher' });
    const b = redactArticle({ documentType: makeDocType(), parsed: makeParsed(), viewerRole: 'teacher' });
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// § 2  Engine writes structured JSON alongside markdown
// ---------------------------------------------------------------------------

function fakes() {
  const articles = new Map();
  const versions = new Map();
  const store = new Map();
  const memCalls = { upsertBatch: [], graphUpsert: [] };
  return {
    articles, versions, store, memCalls,
    databaseSource: {
      async query() { return { rows: [{ id: 'src_1', x: 1 }, { id: 'src_2', y: 2 }] }; },
    },
    metadata: {
      async upsertArticle(r) { articles.set(r.id, { ...r, freshness: { lastCompiledAt: r.updatedAt, isFresh: true }, backlinks: { inboundCount: 0, outboundCount: 0 }, visibility: { defaultRoles: [] } }); },
      async getArticle(id) { return articles.get(id); },
      async findArticle() { return undefined; },
      async listArticles() { return [...articles.values()]; },
      async upsertVersion(r) { versions.set(r.id, r); },
      async getVersion(id) { return versions.get(id); },
      async listVersions(aid) { return [...versions.values()].filter((x) => x.articleId === aid); },
      async recordBacklink() {},
      async removeBacklinksFor() {},
    },
    bodies: {
      async put(ref, body) { store.set(ref.key, { body, contentType: ref.contentType }); return { ...ref, bytes: body.length }; },
      async get(ref) { return store.get(ref.key)?.body; },
      async delete(ref) { store.delete(ref.key); },
      async exists(ref) { return store.has(ref.key); },
    },
    memoryAdapter: {
      async searchKnowledge() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async retrieveContext() { return { items: [], retrievalId: 'r', retrievedAt: '', totalCandidates: 0 }; },
      async upsertBatch(records) { memCalls.upsertBatch.push(records); return records.map((r) => ({ id: r.id, upserted: true })); },
      async remember(r) { return { id: r.id, capturedAt: r.capturedAt }; },
      async delete() { return { deletedCount: 0, affectedLayers: [] }; },
      async markSuperseded() {},
      subscribeToInvalidations() { return () => {}; },
      graph: {
        _edges: [],
        async upsertNodeWithEdges(s) { memCalls.graphUpsert.push(s); },
        async archiveNode() {}, async removeNode() {},
        async traverse(req) {
          const edges = (this._edges ?? []).filter((e) => e.from === req.fromArticleId && (!req.linkTypes || req.linkTypes.includes(e.type)));
          const visited = new Set([req.fromArticleId]);
          for (const e of edges) visited.add(e.to);
          return { edges, visitedArticleIds: [...visited] };
        },
      },
    },
  };
}

function llmScript(parsed) {
  return [
    { content: JSON.stringify(parsed) },
    { embedding: new Float32Array(8) }, { embedding: new Float32Array(8) }, { embedding: new Float32Array(8) },
  ];
}

describe('§2 Engine writes structured JSON alongside markdown', () => {
  test('compile produces both .md and .json keys in object storage', async () => {
    const f = fakes();
    const llm = createStubLLMAdapter(llmScript(makeParsed()));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [makeDocType()] });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const keys = [...f.store.keys()];
    assert.ok(keys.some((k) => k.endsWith('.md')));
    assert.ok(keys.some((k) => k.endsWith('.json')));
    const jsonKey = keys.find((k) => k.endsWith('.json'));
    const stored = JSON.parse(f.store.get(jsonKey).body);
    assert.equal(stored.summary, 'Profile summary.');
    assert.equal(stored.sections.length, 2);
  });
});

// ---------------------------------------------------------------------------
// § 3  wiki.read end-to-end
// ---------------------------------------------------------------------------

describe('§3 wiki.read', () => {
  async function setup(viewerRole) {
    const f = fakes();
    const llm = createStubLLMAdapter(llmScript(makeParsed()));
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [makeDocType()] });
    await wiki.compile({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      trigger: { kind: 'scheduled_refresh' },
    });
    const rendered = await wiki.read({
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_1' },
      viewerRole,
    });
    return { wiki, rendered, f };
  }

  test('default role (teacher) → full body, no limited_view warning', async () => {
    const { rendered } = await setup('teacher');
    assert.match(rendered.body, /## Overview/);
    assert.match(rendered.body, /## Safeguarding/);
    assert.equal(rendered.warnings.length, 0);
    assert.equal(rendered.viewerRole, 'teacher');
    assert.equal(rendered.articleId, 'pupil_profile:pupil:p_1');
  });

  test('teaching_assistant → safeguarding section hidden, limited_view warning', async () => {
    const { rendered } = await setup('teaching_assistant');
    assert.match(rendered.body, /## Overview/);
    assert.doesNotMatch(rendered.body, /Sensitive details/);
    assert.equal(rendered.citations.length, 1);
    assert.equal(rendered.warnings[0].kind, 'limited_view');
  });

  test('parent → safeguarding summarised with replacement', async () => {
    const { rendered } = await setup('parent');
    assert.match(rendered.body, /## Safeguarding/);
    assert.match(rendered.body, /\[Confidential\]/);
    assert.doesNotMatch(rendered.body, /Sensitive details/);
  });

  test('external (excludedRoles) → hide placeholder, body only', async () => {
    const { rendered } = await setup('external');
    assert.match(rendered.body, /Article hidden/);
    assert.equal(rendered.citations.length, 0);
  });

  test('throws when article not found', async () => {
    const f = fakes();
    const wiki = await NuWiki.open({ ...f, llmAdapter: createStubLLMAdapter([]), tenant: 't', documentTypes: [makeDocType()] });
    await assert.rejects(
      () => wiki.read({ documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'missing' }, viewerRole: 'teacher' }),
      /article not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// § 4  followLinks now uses the redactor
// ---------------------------------------------------------------------------

describe('§4 followLinks returns redacted bodies', () => {
  test('linked article carries redacted body for the viewer role', async () => {
    const f = fakes();
    const llm = createStubLLMAdapter([
      ...llmScript(makeParsed()),
      ...llmScript(makeParsed()),
    ]);
    const wiki = await NuWiki.open({ ...f, llmAdapter: llm, tenant: 't', documentTypes: [makeDocType()] });
    // Compile two articles
    await wiki.compile({ documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_1' }, trigger: { kind: 'scheduled_refresh' } });
    await wiki.compile({ documentType: 'pupil_profile', subject: { kind: 'pupil', id: 'p_2' }, trigger: { kind: 'scheduled_refresh' } });
    // Wire a graph edge
    f.memoryAdapter.graph._edges = [{ from: 'pupil_profile:pupil:p_1', to: 'pupil_profile:pupil:p_2', type: 'mentions' }];

    const linked = await wiki.followLinks({
      fromArticleId: 'pupil_profile:pupil:p_1',
      viewerRole: 'teaching_assistant',
    });
    assert.equal(linked.length, 1);
    assert.match(linked[0].body, /## Overview/);
    assert.doesNotMatch(linked[0].body, /Sensitive details/);
    assert.equal(linked[0].warnings[0].kind, 'limited_view');
  });
});

console.log('\nWU 041 — Role-aware redaction acceptance complete\n');
