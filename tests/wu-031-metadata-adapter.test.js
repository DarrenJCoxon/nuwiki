/**
 * WU 031 — NuWiki MetadataAdapter Postgres reference impl acceptance test.
 *
 * Mirrors NuVector WU 006's mocked-pg-Client pattern. No live Postgres
 * required.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// ---------------------------------------------------------------------------
// Mock pg.Client
// ---------------------------------------------------------------------------

const mockQueries = [];
let connectCount = 0;
let disconnectCount = 0;

function resetMock() {
  mockQueries.length = 0;
  connectCount = 0;
  disconnectCount = 0;
}

class MockPgClient {
  constructor(_cfg) {}
  async connect() { connectCount++; }
  async end() { disconnectCount++; }
  async query(text, values) {
    mockQueries.push({ text, values });

    // Simulate information_schema.tables for the status check
    if (text.includes('information_schema.tables')) {
      return {
        rows: [
          { table_name: 'nuwiki_articles' },
          { table_name: 'nuwiki_article_versions' },
          { table_name: 'nuwiki_backlinks' },
        ],
        rowCount: 3,
      };
    }

    // Simulate getArticle by id
    if (text.includes('FROM nuwiki_articles WHERE id =')) {
      const id = values?.[0];
      if (id === 'art_missing') return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id,
          tenant: 'school_bridge',
          document_type: 'pupil_profile',
          subject_kind: 'pupil',
          subject_id: 'p_001',
          subject_label: 'James',
          path: 'pupils/p_001/profile.md',
          current_version: 'v1',
          status: 'published',
          freshness: { lastCompiledAt: new Date().toISOString(), isFresh: true },
          visibility: { defaultRoles: ['teacher'] },
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
      };
    }

    // findArticle by documentType + subject
    if (text.includes('FROM nuwiki_articles') && text.includes('document_type = $1')) {
      const [, kind, id] = values ?? [];
      return {
        rows: [{
          id: 'art_found_' + id,
          tenant: 'school_bridge',
          document_type: values[0],
          subject_kind: kind,
          subject_id: id,
          subject_label: null,
          path: 'p',
          current_version: 'v1',
          status: 'published',
          freshness: { lastCompiledAt: new Date().toISOString(), isFresh: true },
          visibility: { defaultRoles: [] },
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
      };
    }

    // listArticles
    if (text.includes('ORDER BY updated_at DESC')) {
      return {
        rows: [
          {
            id: 'art_a',
            tenant: 'school_bridge',
            document_type: 'pupil_profile',
            subject_kind: 'pupil',
            subject_id: 'p1',
            subject_label: 'A',
            path: 'p',
            current_version: 'v1',
            status: 'published',
            freshness: { lastCompiledAt: new Date().toISOString(), isFresh: true },
            visibility: { defaultRoles: [] },
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }

    // getVersion by versionId
    if (text.includes('FROM nuwiki_article_versions WHERE id =')) {
      const id = values?.[0];
      if (id === 'ver_missing') return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id,
          article_id: 'art_001',
          version: 'v1',
          body_ref: { key: 'pupils/p_001/profile/v1.md' },
          body_hash: 'sha256-abc',
          published_at: new Date(),
          archived_at: null,
          predecessor_version: null,
          generated_by: { triggeredBy: { kind: 'scheduled_refresh' }, sourceCount: 0, retrievalIds: [], generationDurationMs: 0 },
        }],
        rowCount: 1,
      };
    }

    // listVersions
    if (text.includes('FROM nuwiki_article_versions WHERE article_id =')) {
      return {
        rows: [{
          id: 'ver_001',
          article_id: values[0],
          version: 'v1',
          body_ref: { key: 'b' },
          body_hash: 'h',
          published_at: new Date(),
          archived_at: null,
          predecessor_version: null,
          generated_by: { triggeredBy: { kind: 'scheduled_refresh' }, sourceCount: 0, retrievalIds: [], generationDurationMs: 0 },
        }],
        rowCount: 1,
      };
    }

    // backlink count subquery
    if (text.includes('inbound_count') && text.includes('outbound_count')) {
      return { rows: [{ inbound_count: 2, outbound_count: 3 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Client: MockPgClient };
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Load module under test
// ---------------------------------------------------------------------------

const {
  NuWikiMetadataPostgres,
  NuWikiMetadataPostgresAdapter,
  buildSchemaSql,
} = await import('../dist/src/postgres.js');

// ---------------------------------------------------------------------------
// § 1  buildSchemaSql
// ---------------------------------------------------------------------------

describe('§1 buildSchemaSql', () => {
  test('contains required tables', () => {
    const sql = buildSchemaSql();
    assert.ok(sql.includes('nuwiki_articles'));
    assert.ok(sql.includes('nuwiki_article_versions'));
    assert.ok(sql.includes('nuwiki_backlinks'));
  });

  test('uses tenant + document_type + subject_kind + subject_id uniqueness', () => {
    const sql = buildSchemaSql();
    assert.ok(sql.includes('UNIQUE (tenant, document_type, subject_kind, subject_id)'));
  });

  test('declares ON DELETE CASCADE on version + backlink foreign keys', () => {
    const sql = buildSchemaSql();
    const cascadeCount = (sql.match(/ON DELETE CASCADE/g) ?? []).length;
    assert.equal(cascadeCount, 3, 'expected ON DELETE CASCADE on three FKs');
  });

  test('custom schema prefixes table names', () => {
    const sql = buildSchemaSql('nuwiki');
    assert.ok(sql.includes('"nuwiki".nuwiki_articles'));
  });
});

// ---------------------------------------------------------------------------
// § 2  Install / status
// ---------------------------------------------------------------------------

describe('§2 NuWikiMetadataPostgres.install', () => {
  before(() => resetMock());

  test('runs schema SQL and returns a report', async () => {
    const report = await NuWikiMetadataPostgres.install({
      connectionString: 'postgres://localhost/test',
    });
    assert.equal(report.installed, true);
    assert.equal(report.schema, 'public');
    assert.equal(connectCount, 1);
    assert.equal(disconnectCount, 1);
    const schemaQuery = mockQueries.find((q) => q.text.includes('CREATE TABLE'));
    assert.ok(schemaQuery, 'schema SQL should have been issued');
  });
});

describe('§3 NuWikiMetadataPostgres.status', () => {
  before(() => resetMock());

  test('reports installed when all 3 tables present', async () => {
    const report = await NuWikiMetadataPostgres.status('postgres://localhost/test');
    assert.equal(report.installed, true);
    assert.equal(connectCount, 1);
    assert.equal(disconnectCount, 1);
  });
});

// ---------------------------------------------------------------------------
// § 4  upsertArticle / getArticle / findArticle
// ---------------------------------------------------------------------------

describe('§4 Article upsert / read', () => {
  let adapter;
  before(async () => {
    resetMock();
    adapter = await NuWikiMetadataPostgres.open('postgres://localhost/test');
  });

  test('upsertArticle issues an INSERT ... ON CONFLICT', async () => {
    await adapter.upsertArticle({
      id: 'art_001',
      tenant: 'school_bridge',
      documentType: 'pupil_profile',
      subject: { kind: 'pupil', id: 'p_001', label: 'James' },
      path: 'pupils/p_001/profile.md',
      currentVersion: 'v1',
      status: 'published',
      metadata: { sectionCount: 5 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const upsert = mockQueries.find((q) => q.text.includes('ON CONFLICT (id) DO UPDATE'));
    assert.ok(upsert, 'expected upsert query');
  });

  test('getArticle returns mapped article with backlink counts', async () => {
    const article = await adapter.getArticle('art_001');
    assert.ok(article);
    assert.equal(article.id, 'art_001');
    assert.equal(article.documentType, 'pupil_profile');
    assert.equal(article.subject.kind, 'pupil');
    assert.equal(article.subject.id, 'p_001');
    assert.equal(article.subject.label, 'James');
    assert.equal(article.backlinks.inboundCount, 2);
    assert.equal(article.backlinks.outboundCount, 3);
  });

  test('getArticle returns undefined for missing id', async () => {
    const article = await adapter.getArticle('art_missing');
    assert.equal(article, undefined);
  });

  test('findArticle by documentType + subject returns mapped article', async () => {
    const article = await adapter.findArticle('pupil_profile', { kind: 'pupil', id: 'p_001' });
    assert.ok(article);
    assert.equal(article.subject.id, 'p_001');
  });
});

// ---------------------------------------------------------------------------
// § 5  listArticles
// ---------------------------------------------------------------------------

describe('§5 listArticles with filters', () => {
  let adapter;
  before(async () => {
    resetMock();
    adapter = await NuWikiMetadataPostgres.open('postgres://localhost/test');
  });

  test('applies tenant + documentType + status filters and a limit', async () => {
    await adapter.listArticles({
      tenant: 'school_bridge',
      documentType: 'pupil_profile',
      status: 'published',
      limit: 50,
    });
    const select = mockQueries.find((q) =>
      q.text.includes('FROM ') && q.text.includes('ORDER BY updated_at DESC'),
    );
    assert.ok(select);
    assert.ok(select.text.includes('tenant = $1'));
    assert.ok(select.text.includes('document_type = $2'));
    assert.ok(select.text.includes('status = $3'));
    assert.ok(select.text.includes('LIMIT'));
  });

  test('returns mapped articles with backlink counts', async () => {
    const articles = await adapter.listArticles({ tenant: 'school_bridge' });
    assert.ok(Array.isArray(articles));
    assert.equal(articles.length, 1);
    assert.equal(articles[0].id, 'art_a');
    assert.equal(articles[0].backlinks.inboundCount, 2);
  });
});

// ---------------------------------------------------------------------------
// § 6  Versions
// ---------------------------------------------------------------------------

describe('§6 Versions', () => {
  let adapter;
  before(async () => {
    resetMock();
    adapter = await NuWikiMetadataPostgres.open('postgres://localhost/test');
  });

  test('upsertVersion issues an INSERT ... ON CONFLICT', async () => {
    await adapter.upsertVersion({
      id: 'ver_001',
      articleId: 'art_001',
      version: 'v1',
      bodyRef: { key: 'pupils/p_001/profile/v1.md', contentType: 'text/markdown' },
      bodyHash: 'sha256-abc',
      publishedAt: new Date().toISOString(),
    });
    const upsert = mockQueries.find(
      (q) => q.text.includes('nuwiki_article_versions') && q.text.includes('ON CONFLICT'),
    );
    assert.ok(upsert);
  });

  test('getVersion returns mapped version', async () => {
    const v = await adapter.getVersion('ver_001');
    assert.ok(v);
    assert.equal(v.id, 'ver_001');
    assert.equal(v.articleId, 'art_001');
    assert.equal(v.version, 'v1');
  });

  test('getVersion returns undefined for missing id', async () => {
    const v = await adapter.getVersion('ver_missing');
    assert.equal(v, undefined);
  });

  test('listVersions returns mapped versions', async () => {
    const versions = await adapter.listVersions('art_001');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].articleId, 'art_001');
  });
});

// ---------------------------------------------------------------------------
// § 7  Backlinks
// ---------------------------------------------------------------------------

describe('§7 Backlinks', () => {
  let adapter;
  before(async () => {
    resetMock();
    adapter = await NuWikiMetadataPostgres.open('postgres://localhost/test');
  });

  test('recordBacklink inserts with ON CONFLICT DO NOTHING (idempotent)', async () => {
    await adapter.recordBacklink('art_a', 'art_b', 'mentions');
    const insert = mockQueries.find(
      (q) => q.text.includes('nuwiki_backlinks') && q.text.includes('ON CONFLICT DO NOTHING'),
    );
    assert.ok(insert);
  });

  test('removeBacklinksFor deletes both inbound and outbound', async () => {
    await adapter.removeBacklinksFor('art_a');
    const del = mockQueries.find(
      (q) => q.text.includes('DELETE FROM') &&
             q.text.includes('from_article_id = $1') &&
             q.text.includes('to_article_id = $1'),
    );
    assert.ok(del);
  });
});

// ---------------------------------------------------------------------------
// § 8  Adapter conforms to MetadataAdapter interface (structural check)
// ---------------------------------------------------------------------------

describe('§8 MetadataAdapter conformance', () => {
  test('adapter has all 9 methods', async () => {
    resetMock();
    const adapter = await NuWikiMetadataPostgres.open('postgres://localhost/test');
    assert.ok(adapter instanceof NuWikiMetadataPostgresAdapter);
    const expected = [
      'upsertArticle',
      'getArticle',
      'findArticle',
      'listArticles',
      'upsertVersion',
      'getVersion',
      'listVersions',
      'recordBacklink',
      'removeBacklinksFor',
    ];
    for (const m of expected) {
      assert.equal(typeof adapter[m], 'function', `missing method: ${m}`);
    }
  });
});

console.log('\nWU 031 — NuWiki MetadataAdapter (Postgres) acceptance complete\n');
