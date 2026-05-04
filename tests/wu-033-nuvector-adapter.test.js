/**
 * WU 033 — NuWiki NuVectorAdapter wrapper acceptance test.
 *
 * Two layers:
 * 1. Mock-NuVector tests — verify each adapter method delegates correctly
 * 2. Real-NuVector test — open an in-memory NuVector, attach the adapter,
 *    drive an end-to-end retrieve → upsert → search round-trip
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { NuWikiNuVectorAdapter, createNuVectorAdapter } = await import(
  '../dist/src/nuvector-adapter.js'
);
const { NuVector } = await import('@nusoft/nuvector');
const { NuVectorGraph } = await import('@nusoft/nuvector/graph');

// ---------------------------------------------------------------------------
// § 1  Construction + factory
// ---------------------------------------------------------------------------

describe('§1 Construction + factory', () => {
  test('createNuVectorAdapter returns an adapter with a graph sub-adapter', async () => {
    const memory = await NuVector.open({
      storage: 'memory:',
      dimensions: 8,
      tenant: 'school_bridge',
    });
    const adapter = await createNuVectorAdapter(memory);
    assert.ok(adapter instanceof NuWikiNuVectorAdapter);
    assert.equal(typeof adapter.searchKnowledge, 'function');
    assert.equal(typeof adapter.retrieveContext, 'function');
    assert.equal(typeof adapter.upsertBatch, 'function');
    assert.equal(typeof adapter.markSuperseded, 'function');
    assert.equal(typeof adapter.remember, 'function');
    assert.equal(typeof adapter.delete, 'function');
    assert.equal(typeof adapter.subscribeToInvalidations, 'function');
    assert.ok(adapter.graph);
    assert.equal(typeof adapter.graph.upsertNodeWithEdges, 'function');
    assert.equal(typeof adapter.graph.archiveNode, 'function');
    assert.equal(typeof adapter.graph.removeNode, 'function');
    await memory.close();
  });

  test('explicit constructor accepts a pre-attached graph', async () => {
    const memory = await NuVector.open({
      storage: 'memory:',
      dimensions: 8,
      tenant: 't',
    });
    const graph = await NuVectorGraph.attach(memory);
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    assert.ok(adapter);
    await memory.close();
  });
});

// ---------------------------------------------------------------------------
// § 2  Direct delegation — verified via spy NuVector
// ---------------------------------------------------------------------------

describe('§2 Direct delegation', () => {
  function makeMockMemory() {
    const calls = {};
    const memory = {
      searchKnowledge: async (req) => {
        calls.searchKnowledge = req;
        return { items: [], retrievalId: 'r', retrievedAt: new Date().toISOString(), totalCandidates: 0 };
      },
      retrieveContext: async (q) => {
        calls.retrieveContext = q;
        return { items: [], retrievalId: 'r', retrievedAt: new Date().toISOString(), totalCandidates: 0 };
      },
      upsertBatch: async (records) => {
        calls.upsertBatch = records;
        return records.map((r) => ({ id: r.id, upserted: true }));
      },
      remember: async (record) => {
        calls.remember = record;
        return { id: 'prov_' + record.id, capturedAt: record.capturedAt };
      },
      delete: async (q) => {
        calls.delete = q;
        return { deletedCount: 0, affectedLayers: [] };
      },
      subscribeToInvalidations: (handler) => {
        calls.subscribeToInvalidations = handler;
        return () => { calls.unsubscribed = true; };
      },
    };
    const graph = {
      upsertNodeWithEdges: async (spec) => { calls.graphUpsert = spec; },
    };
    return { memory, graph, calls };
  }

  test('searchKnowledge → memory.searchKnowledge', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    const req = {
      query: 'test',
      embedding: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]),
      filters: { tenant: 'school_bridge' },
    };
    await adapter.searchKnowledge(req);
    assert.equal(calls.searchKnowledge, req);
  });

  test('retrieveContext → memory.retrieveContext', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    const q = { embedding: new Float32Array(8), tenant: 't' };
    await adapter.retrieveContext(q);
    assert.equal(calls.retrieveContext, q);
  });

  test('upsertBatch → memory.upsertBatch', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    const records = [
      { id: 'r1', kind: 'nuwiki_article_summary', tenant: 't', embedding: new Float32Array(8), text: 'x', metadata: {} },
    ];
    const refs = await adapter.upsertBatch(records);
    assert.equal(calls.upsertBatch, records);
    assert.equal(refs.length, 1);
  });

  test('remember maps ProvenanceRef → { ref }', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    const result = await adapter.remember({
      id: 'prov_001',
      kind: 'nuwiki_compile',
      capturedAt: new Date().toISOString(),
      evidence: [],
      outcome: 'compiled',
      metadata: {},
    });
    assert.equal(result.ref, 'prov_prov_001');
    assert.equal(calls.remember.id, 'prov_001');
  });

  test('delete → memory.delete', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    await adapter.delete({ tenant: 't', reason: 'gdpr_erasure' });
    assert.equal(calls.delete.reason, 'gdpr_erasure');
  });

  test('subscribeToInvalidations → memory.subscribeToInvalidations', async () => {
    const { memory, graph, calls } = makeMockMemory();
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    const handler = () => {};
    const unsub = adapter.subscribeToInvalidations(handler);
    assert.equal(calls.subscribeToInvalidations, handler);
    unsub();
    assert.equal(calls.unsubscribed, true);
  });
});

// ---------------------------------------------------------------------------
// § 3  Graph sub-adapter
// ---------------------------------------------------------------------------

describe('§3 Graph sub-adapter', () => {
  test('upsertNodeWithEdges delegates to NuVectorGraph', async () => {
    const calls = {};
    const memory = { delete: async (q) => { calls.delete = q; return { deletedCount: 0, affectedLayers: [] }; } };
    const graph = {
      upsertNodeWithEdges: async (spec) => { calls.upsert = spec; },
    };
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    await adapter.graph.upsertNodeWithEdges({
      nodeId: 'art_001',
      outboundEdges: [
        { to: 'art_002', type: 'mentions' },
        { to: 'art_003', type: 'supports_outcome', weight: 0.8 },
      ],
    });
    assert.equal(calls.upsert.nodeId, 'art_001');
    assert.equal(calls.upsert.outboundEdges.length, 2);
    assert.equal(calls.upsert.outboundEdges[1].weight, 0.8);
  });

  test('archiveNode invokes memory.delete with articleId', async () => {
    const calls = {};
    const memory = { delete: async (q) => { calls.delete = q; return { deletedCount: 0, affectedLayers: [] }; } };
    const graph = { upsertNodeWithEdges: async () => {} };
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    await adapter.graph.archiveNode('art_001');
    assert.equal(calls.delete.articleId, 'art_001');
    assert.equal(calls.delete.reason, 'cleanup');
  });

  test('removeNode invokes memory.delete with articleId', async () => {
    const calls = {};
    const memory = { delete: async (q) => { calls.delete = q; return { deletedCount: 0, affectedLayers: [] }; } };
    const graph = { upsertNodeWithEdges: async () => {} };
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    await adapter.graph.removeNode('art_002');
    assert.equal(calls.delete.articleId, 'art_002');
  });
});

// ---------------------------------------------------------------------------
// § 4  markSuperseded is a documented no-op at v0.1.0
// ---------------------------------------------------------------------------

describe('§4 markSuperseded no-op', () => {
  test('does not throw, does not call the underlying NuVector', async () => {
    const calls = {};
    const memory = {
      delete: async (q) => { calls.delete = q; return { deletedCount: 0, affectedLayers: [] }; },
    };
    const graph = { upsertNodeWithEdges: async () => {} };
    const adapter = new NuWikiNuVectorAdapter(memory, graph);
    await adapter.markSuperseded({ pattern: '*:art_001:v1*' });
    assert.equal(calls.delete, undefined);
  });
});

// ---------------------------------------------------------------------------
// § 5  End-to-end with real NuVector
// ---------------------------------------------------------------------------

describe('§5 End-to-end with real @nusoft/nuvector', () => {
  test('upsertBatch + retrieveContext round-trip via the adapter', async () => {
    const memory = await NuVector.open({
      storage: 'memory:',
      dimensions: 8,
      tenant: 'school_bridge',
    });
    const adapter = await createNuVectorAdapter(memory);

    const emb = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const records = [
      {
        id: 'summary:art_001:v1',
        kind: 'nuwiki_article_summary',
        embedding: emb,
        text: 'Pupil profile for James Smith',
        metadata: { articleId: 'art_001', documentType: 'pupil_profile', version: 'v1' },
        tenant: 'school_bridge',
      },
    ];

    const refs = await adapter.upsertBatch(records);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, 'summary:art_001:v1');
    assert.equal(refs[0].upserted, true);

    const pack = await adapter.retrieveContext({
      embedding: emb,
      tenant: 'school_bridge',
      topK: 5,
    });
    assert.ok(pack.items.length >= 1);
    assert.equal(pack.items[0].ref, 'summary:art_001:v1');

    await memory.close();
  });

  test('graph.upsertNodeWithEdges round-trips through the real graph', async () => {
    const memory = await NuVector.open({ storage: 'memory:', dimensions: 8, tenant: 't' });
    const adapter = await createNuVectorAdapter(memory);
    await adapter.graph.upsertNodeWithEdges({
      nodeId: 'art_001',
      outboundEdges: [{ to: 'art_002', type: 'mentions' }],
    });
    // No assertion on internal graph state — just verify no throw and the call resolves.
    await memory.close();
  });

  test('remember writes provenance and returns a ref', async () => {
    const memory = await NuVector.open({ storage: 'memory:', dimensions: 8, tenant: 't' });
    const adapter = await createNuVectorAdapter(memory);
    const result = await adapter.remember({
      id: 'prov_compile_001',
      kind: 'nuwiki_compile',
      capturedAt: new Date().toISOString(),
      evidence: [],
      outcome: 'compiled',
      metadata: { articleId: 'art_001' },
    });
    assert.equal(result.ref, 'prov_compile_001');
    await memory.close();
  });
});

console.log('\nWU 033 — NuVectorAdapter acceptance complete\n');
