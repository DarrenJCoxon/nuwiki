/**
 * WU 032 — NuWiki ObjectStorageAdapter acceptance test.
 *
 * Covers all four reference adapters: in-memory, SharePoint, Google Drive,
 * and Supabase Storage. Cloud adapters use a mocked HTTP client; no live
 * provider calls.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const {
  InMemoryObjectStorageAdapter,
  SharePointObjectStorageAdapter,
  GoogleDriveObjectStorageAdapter,
  SupabaseObjectStorageAdapter,
} = await import('../dist/src/storage.js');

// ---------------------------------------------------------------------------
// HTTP client mock
// ---------------------------------------------------------------------------

function mockHttp(responses) {
  const calls = [];
  const queue = [...responses];
  const http = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { ok: true, status: 200, body: '', json: {} };
    return {
      ok: next.ok,
      status: next.status,
      statusText: next.statusText ?? '',
      text: async () => next.body ?? '',
      json: async () => next.json ?? {},
    };
  };
  return { http, calls };
}

// ---------------------------------------------------------------------------
// § 1  InMemoryObjectStorageAdapter — round-trip
// ---------------------------------------------------------------------------

describe('§1 InMemoryObjectStorageAdapter', () => {
  test('put → get round-trips the body', async () => {
    const a = new InMemoryObjectStorageAdapter();
    const ref = { key: 'pupils/p_001/profile/v1.md', contentType: 'text/markdown' };
    const stored = await a.put(ref, '# Profile\n\nContent.');
    assert.equal(stored.key, ref.key);
    assert.equal(stored.bytes, new TextEncoder().encode('# Profile\n\nContent.').byteLength);
    const body = await a.get(ref);
    assert.equal(body, '# Profile\n\nContent.');
  });

  test('exists reflects presence, delete removes', async () => {
    const a = new InMemoryObjectStorageAdapter();
    const ref = { key: 'k' };
    assert.equal(await a.exists(ref), false);
    await a.put(ref, 'x');
    assert.equal(await a.exists(ref), true);
    await a.delete(ref);
    assert.equal(await a.exists(ref), false);
  });

  test('get on missing throws', async () => {
    const a = new InMemoryObjectStorageAdapter();
    await assert.rejects(() => a.get({ key: 'missing' }), /not found/);
  });
});

// ---------------------------------------------------------------------------
// § 2  SharePoint — HTTP verbs and URL shape
// ---------------------------------------------------------------------------

describe('§2 SharePointObjectStorageAdapter', () => {
  let calls, tokenCalls;
  function adapter(responses) {
    const m = mockHttp(responses);
    calls = m.calls;
    tokenCalls = 0;
    return new SharePointObjectStorageAdapter({
      siteId: 'site_abc',
      driveId: 'drive_xyz',
      getAuthToken: async () => {
        tokenCalls++;
        return 'token_' + tokenCalls;
      },
      http: m.http,
    });
  }

  test('put issues PUT to .../root:/<key>:/content with bearer auth', async () => {
    const a = adapter([{ ok: true, status: 200 }]);
    const ref = { key: 'pupils/p_001/profile/v1.md', contentType: 'text/markdown' };
    const stored = await a.put(ref, '# Profile');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sites\/site_abc\/drives\/drive_xyz\/root:\//);
    assert.match(calls[0].url, /:\/content$/);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token_1');
    assert.equal(calls[0].init.headers['Content-Type'], 'text/markdown');
    assert.equal(stored.bytes, new TextEncoder().encode('# Profile').byteLength);
  });

  test('get issues GET to .../root:/<key>:/content', async () => {
    const a = adapter([{ ok: true, status: 200, body: '# Body' }]);
    const body = await a.get({ key: 'k.md' });
    assert.equal(body, '# Body');
    assert.equal(calls[0].init.method, 'GET');
  });

  test('delete tolerates 404', async () => {
    const a = adapter([{ ok: false, status: 404, statusText: 'Not Found' }]);
    await a.delete({ key: 'k.md' });
    assert.equal(calls[0].init.method, 'DELETE');
  });

  test('exists returns true for ok, false for 404', async () => {
    const a1 = adapter([{ ok: true, status: 200 }]);
    assert.equal(await a1.exists({ key: 'k' }), true);
    const a2 = adapter([{ ok: false, status: 404 }]);
    assert.equal(await a2.exists({ key: 'k' }), false);
  });

  test('auth token is requested per call (rotatable)', async () => {
    const a = adapter([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    await a.put({ key: 'k1' }, 'x');
    await a.get({ key: 'k1' });
    await a.exists({ key: 'k1' });
    assert.equal(tokenCalls, 3);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token_1');
    assert.equal(calls[2].init.headers.Authorization, 'Bearer token_3');
  });

  test('put error throws with status', async () => {
    const a = adapter([{ ok: false, status: 403, statusText: 'Forbidden' }]);
    await assert.rejects(() => a.put({ key: 'k' }, 'x'), /403/);
  });
});

// ---------------------------------------------------------------------------
// § 3  Google Drive — file IDs vs paths
// ---------------------------------------------------------------------------

describe('§3 GoogleDriveObjectStorageAdapter', () => {
  let calls;
  function adapter(responses, opts = {}) {
    const m = mockHttp(responses);
    calls = m.calls;
    return new GoogleDriveObjectStorageAdapter({
      ...opts,
      getAuthToken: async () => 'gtoken',
      http: m.http,
    });
  }

  test('put without drive_id: prefix issues multipart upload, returns drive_id key', async () => {
    const a = adapter([{ ok: true, status: 200, json: { id: 'file_abc' } }]);
    const stored = await a.put({ key: 'profile.md' }, 'body');
    assert.match(calls[0].url, /upload\/drive\/v3\/files\?uploadType=multipart/);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(stored.key, 'drive_id:file_abc');
  });

  test('put with drive_id: prefix issues PATCH against the file ID', async () => {
    const a = adapter([{ ok: true, status: 200 }]);
    await a.put({ key: 'drive_id:file_abc' }, 'updated');
    assert.match(calls[0].url, /\/files\/file_abc\?uploadType=media$/);
    assert.equal(calls[0].init.method, 'PATCH');
  });

  test('get extracts ID from drive_id: prefix', async () => {
    const a = adapter([{ ok: true, status: 200, body: 'content' }]);
    const body = await a.get({ key: 'drive_id:file_abc' });
    assert.equal(body, 'content');
    assert.match(calls[0].url, /\/files\/file_abc\?alt=media/);
  });

  test('shared drive sets supportsAllDrives flag', async () => {
    const a = adapter([{ ok: true, status: 200, body: 'x' }], { driveId: 'shared_drive_id' });
    await a.get({ key: 'drive_id:f1' });
    assert.match(calls[0].url, /supportsAllDrives=true/);
  });
});

// ---------------------------------------------------------------------------
// § 4  Supabase Storage
// ---------------------------------------------------------------------------

describe('§4 SupabaseObjectStorageAdapter', () => {
  let calls;
  function adapter(responses) {
    const m = mockHttp(responses);
    calls = m.calls;
    return new SupabaseObjectStorageAdapter({
      url: 'https://xyz.supabase.co',
      bucket: 'nuwiki',
      getAuthToken: async () => 'sbkey',
      http: m.http,
    });
  }

  test('put POSTs with x-upsert header', async () => {
    const a = adapter([{ ok: true, status: 200 }]);
    await a.put({ key: 'pupils/p1/profile/v1.md', contentType: 'text/markdown' }, 'body');
    assert.match(calls[0].url, /\/storage\/v1\/object\/nuwiki\/pupils\/p1\/profile\/v1\.md$/);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-upsert'], 'true');
    assert.equal(calls[0].init.headers['Content-Type'], 'text/markdown');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sbkey');
    assert.equal(calls[0].init.headers.apikey, 'sbkey');
  });

  test('exists uses HEAD', async () => {
    const a = adapter([{ ok: true, status: 200 }]);
    assert.equal(await a.exists({ key: 'k.md' }), true);
    assert.equal(calls[0].init.method, 'HEAD');
  });

  test('delete tolerates 404', async () => {
    const a = adapter([{ ok: false, status: 404 }]);
    await a.delete({ key: 'gone.md' });
    assert.equal(calls[0].init.method, 'DELETE');
  });
});

// ---------------------------------------------------------------------------
// § 5  All adapters implement the ObjectStorageAdapter shape
// ---------------------------------------------------------------------------

describe('§5 Adapter conformance', () => {
  test('all four adapters expose the 4 ObjectStorageAdapter methods', () => {
    const adapters = [
      new InMemoryObjectStorageAdapter(),
      new SharePointObjectStorageAdapter({
        siteId: 's', driveId: 'd', getAuthToken: async () => 't',
      }),
      new GoogleDriveObjectStorageAdapter({ getAuthToken: async () => 't' }),
      new SupabaseObjectStorageAdapter({
        url: 'https://x', bucket: 'b', getAuthToken: async () => 't',
      }),
    ];
    const expected = ['put', 'get', 'delete', 'exists'];
    for (const a of adapters) {
      for (const m of expected) {
        assert.equal(typeof a[m], 'function', `missing method ${m} on ${a.constructor.name}`);
      }
    }
  });
});

console.log('\nWU 032 — ObjectStorageAdapter acceptance complete\n');
