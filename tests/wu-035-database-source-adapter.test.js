/**
 * WU 035 — NuWiki DatabaseSourceAdapter acceptance test.
 *
 * Three implementations: createDatabaseSourceAdapter (handler-map),
 * InMemoryDatabaseSourceAdapter (fixture-backed), and
 * createStubDatabaseSourceAdapter (deterministic scripted responses).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  createDatabaseSourceAdapter,
  InMemoryDatabaseSourceAdapter,
  createInMemoryDatabaseSourceAdapter,
  createStubDatabaseSourceAdapter,
  DatabaseSourceUnknownKindError,
  DatabaseSourceStubExhaustedError,
} = await import('../dist/src/database-source.js');

// ---------------------------------------------------------------------------
// § 1  createDatabaseSourceAdapter — handler dispatch
// ---------------------------------------------------------------------------

describe('§1 createDatabaseSourceAdapter', () => {
  test('dispatches to the registered handler for the requested kind', async () => {
    const calls = [];
    const adapter = createDatabaseSourceAdapter({
      handlers: {
        pupil_recent_incidents: async (payload) => {
          calls.push({ kind: 'pupil_recent_incidents', payload });
          return { rows: [{ id: 'inc_1', summary: 'classroom dispute' }] };
        },
        class_attendance_window: async () => ({ rows: [] }),
      },
    });
    const result = await adapter.query({
      kind: 'pupil_recent_incidents',
      payload: { pupilId: 'pup_001', windowDays: 14 },
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'inc_1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.pupilId, 'pup_001');
    assert.equal(calls[0].payload.windowDays, 14);
  });

  test('passes payload through verbatim to the handler', async () => {
    let received;
    const adapter = createDatabaseSourceAdapter({
      handlers: {
        intervention_history: async (payload) => {
          received = payload;
          return { rows: [] };
        },
      },
    });
    const payload = { pupilId: 'pup_002', from: '2026-01-01', to: '2026-05-01', tags: ['SEN', 'EHCP'] };
    await adapter.query({ kind: 'intervention_history', payload });
    assert.deepEqual(received, payload);
  });

  test('handler can return rows and metadata', async () => {
    const adapter = createDatabaseSourceAdapter({
      handlers: {
        peer_conflict_recent: async () => ({
          rows: [{ id: 'pc_1' }, { id: 'pc_2' }],
          metadata: { totalCount: 2, queriedAt: '2026-05-04T09:00:00Z' },
        }),
      },
    });
    const result = await adapter.query({ kind: 'peer_conflict_recent', payload: {} });
    assert.equal(result.rows.length, 2);
    assert.equal(result.metadata.totalCount, 2);
    assert.equal(result.metadata.queriedAt, '2026-05-04T09:00:00Z');
  });

  test('unknown kind throws DatabaseSourceUnknownKindError with available kinds', async () => {
    const adapter = createDatabaseSourceAdapter({
      handlers: {
        kind_a: async () => ({ rows: [] }),
        kind_b: async () => ({ rows: [] }),
      },
    });
    await assert.rejects(
      () => adapter.query({ kind: 'kind_c', payload: {} }),
      (err) => {
        assert.ok(err instanceof DatabaseSourceUnknownKindError);
        assert.equal(err.kind, 'kind_c');
        assert.deepEqual(err.availableKinds.sort(), ['kind_a', 'kind_b']);
        assert.match(err.message, /no handler registered for kind 'kind_c'/);
        assert.match(err.message, /kind_a/);
        assert.match(err.message, /kind_b/);
        return true;
      },
    );
  });

  test('unknown kind in an empty handler set names "(none)"', async () => {
    const adapter = createDatabaseSourceAdapter({ handlers: {} });
    await assert.rejects(
      () => adapter.query({ kind: 'whatever', payload: {} }),
      /\(none\)/,
    );
  });

  test('subsequent mutations to the input handlers map do not affect the adapter', async () => {
    const handlers = { kind_a: async () => ({ rows: [{ id: 'a' }] }) };
    const adapter = createDatabaseSourceAdapter({ handlers });
    delete handlers.kind_a; // adapter should not see this
    const result = await adapter.query({ kind: 'kind_a', payload: {} });
    assert.equal(result.rows[0].id, 'a');
  });
});

// ---------------------------------------------------------------------------
// § 2  InMemoryDatabaseSourceAdapter — fixture-backed
// ---------------------------------------------------------------------------

describe('§2 InMemoryDatabaseSourceAdapter', () => {
  test('returns pre-loaded rows by kind', async () => {
    const adapter = createInMemoryDatabaseSourceAdapter({
      data: {
        pupils: [{ id: 'p1', name: 'James' }, { id: 'p2', name: 'Anya' }],
        incidents: [{ id: 'i1', severity: 'low' }],
      },
    });
    const pupils = await adapter.query({ kind: 'pupils', payload: {} });
    assert.equal(pupils.rows.length, 2);
    assert.equal(pupils.rows[0].name, 'James');

    const incidents = await adapter.query({ kind: 'incidents', payload: {} });
    assert.equal(incidents.rows.length, 1);
    assert.equal(incidents.rows[0].severity, 'low');
  });

  test('missing kind returns an empty rows array (not an error)', async () => {
    const adapter = createInMemoryDatabaseSourceAdapter({ data: { pupils: [{ id: 'p1' }] } });
    const result = await adapter.query({ kind: 'classes', payload: {} });
    assert.deepEqual(result.rows, []);
  });

  test('setData replaces the fixture for a kind (live re-bind)', async () => {
    const adapter = new InMemoryDatabaseSourceAdapter({ pupils: [{ id: 'old' }] });
    let result = await adapter.query({ kind: 'pupils', payload: {} });
    assert.equal(result.rows[0].id, 'old');
    adapter.setData('pupils', [{ id: 'new_a' }, { id: 'new_b' }]);
    result = await adapter.query({ kind: 'pupils', payload: {} });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].id, 'new_a');
  });

  test('default constructor returns an adapter with no fixture data', async () => {
    const adapter = createInMemoryDatabaseSourceAdapter();
    const result = await adapter.query({ kind: 'anything', payload: {} });
    assert.deepEqual(result.rows, []);
  });

  test('mutations to the input data object after construction do not bleed in', async () => {
    const data = { pupils: [{ id: 'p1' }] };
    const adapter = createInMemoryDatabaseSourceAdapter({ data });
    delete data.pupils;
    const result = await adapter.query({ kind: 'pupils', payload: {} });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'p1');
  });
});

// ---------------------------------------------------------------------------
// § 3  createStubDatabaseSourceAdapter — scripted responses
// ---------------------------------------------------------------------------

describe('§3 createStubDatabaseSourceAdapter', () => {
  test('returns scripted responses in order', async () => {
    const adapter = createStubDatabaseSourceAdapter([
      { rows: [{ id: 'r1' }] },
      { rows: [{ id: 'r2' }, { id: 'r3' }] },
      { rows: [], metadata: { final: true } },
    ]);
    const a = await adapter.query({ kind: 'k1', payload: {} });
    const b = await adapter.query({ kind: 'k2', payload: {} });
    const c = await adapter.query({ kind: 'k3', payload: {} });
    assert.equal(a.rows[0].id, 'r1');
    assert.equal(b.rows.length, 2);
    assert.deepEqual(c.rows, []);
    assert.equal(c.metadata.final, true);
  });

  test('records every call for assertion', async () => {
    const adapter = createStubDatabaseSourceAdapter([{ rows: [] }, { rows: [] }]);
    await adapter.query({ kind: 'k1', payload: { a: 1 } });
    await adapter.query({ kind: 'k2', payload: { b: 2 } });
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls[0].kind, 'k1');
    assert.equal(adapter.calls[0].payload.a, 1);
    assert.equal(adapter.calls[1].kind, 'k2');
    assert.equal(adapter.calls[1].payload.b, 2);
  });

  test('throws DatabaseSourceStubExhaustedError when scripted responses run out', async () => {
    const adapter = createStubDatabaseSourceAdapter([{ rows: [] }]);
    await adapter.query({ kind: 'k1', payload: {} });
    await assert.rejects(
      () => adapter.query({ kind: 'k2', payload: {} }),
      (err) => err instanceof DatabaseSourceStubExhaustedError,
    );
  });
});

// ---------------------------------------------------------------------------
// § 4  Interface conformance
// ---------------------------------------------------------------------------

describe('§4 DatabaseSourceAdapter conformance', () => {
  test('all three implementations expose query()', () => {
    const adapters = [
      createDatabaseSourceAdapter({ handlers: {} }),
      createInMemoryDatabaseSourceAdapter(),
      createStubDatabaseSourceAdapter([]),
    ];
    for (const a of adapters) {
      assert.equal(typeof a.query, 'function');
    }
  });
});

console.log('\nWU 035 — DatabaseSourceAdapter acceptance complete\n');
