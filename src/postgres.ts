/**
 * `@nusoft/nuwiki/postgres` — Postgres reference implementation of `MetadataAdapter`.
 *
 * Mirrors the pattern from `@nusoft/nuvector/postgres` (WU 006 of NuVector):
 * dynamic `require('pg')` so consumers who don't use the postgres path pay
 * zero dependency cost; schema install/status helpers; the adapter class
 * implements `MetadataAdapter` against three tables (`nuwiki_articles`,
 * `nuwiki_article_versions`, `nuwiki_backlinks`).
 */

import type {
  ArticleMetadataRecord,
  MetadataAdapter,
  VersionMetadataRecord,
} from './adapters.js';
import type {
  ArticleStatus,
  ISODateString,
  NuWikiArticle,
  NuWikiArticleVersion,
  SubjectRef,
} from './types.js';

// ---------------------------------------------------------------------------
// Minimal pg interface — loaded dynamically. Consumers must `npm install pg`.
// ---------------------------------------------------------------------------

interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgClientLike {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

import { createRequire } from 'node:module';
const requirePg = createRequire(import.meta.url);

function loadPgClient(connectionString: string): PgClientLike {
  let pg: { Client: new (cfg: { connectionString: string }) => PgClientLike };
  try {
    pg = requirePg('pg') as typeof pg;
  } catch {
    throw new Error(
      'The `pg` package is required for @nusoft/nuwiki/postgres. Install it: npm install pg',
    );
  }
  return new pg.Client({ connectionString });
}

// ---------------------------------------------------------------------------
// Schema SQL
// ---------------------------------------------------------------------------

export function buildSchemaSql(schema = 'public'): string {
  const s = schema === 'public' ? '' : `"${schema}".`;
  return `
CREATE TABLE IF NOT EXISTS ${s}nuwiki_articles (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  document_type   TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  subject_label   TEXT,
  path            TEXT NOT NULL,
  current_version TEXT NOT NULL,
  status          TEXT NOT NULL,
  freshness       JSONB NOT NULL DEFAULT '{}',
  visibility      JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant, document_type, subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS ${s}nuwiki_article_versions (
  id                   TEXT PRIMARY KEY,
  article_id           TEXT NOT NULL REFERENCES ${s}nuwiki_articles(id) ON DELETE CASCADE,
  version              TEXT NOT NULL,
  body_ref             JSONB NOT NULL,
  body_hash            TEXT NOT NULL,
  published_at         TIMESTAMPTZ,
  archived_at          TIMESTAMPTZ,
  predecessor_version  TEXT,
  generated_by         JSONB NOT NULL DEFAULT '{}',
  UNIQUE (article_id, version)
);

CREATE TABLE IF NOT EXISTS ${s}nuwiki_backlinks (
  from_article_id  TEXT NOT NULL REFERENCES ${s}nuwiki_articles(id) ON DELETE CASCADE,
  to_article_id    TEXT NOT NULL REFERENCES ${s}nuwiki_articles(id) ON DELETE CASCADE,
  link_type        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_article_id, to_article_id, link_type)
);

CREATE INDEX IF NOT EXISTS nuwiki_articles_tenant_kind  ON ${s}nuwiki_articles (tenant, document_type);
CREATE INDEX IF NOT EXISTS nuwiki_articles_subject      ON ${s}nuwiki_articles (tenant, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS nuwiki_articles_status       ON ${s}nuwiki_articles (tenant, status);
CREATE INDEX IF NOT EXISTS nuwiki_versions_article      ON ${s}nuwiki_article_versions (article_id);
CREATE INDEX IF NOT EXISTS nuwiki_backlinks_to          ON ${s}nuwiki_backlinks (to_article_id);
`.trim();
}

// ---------------------------------------------------------------------------
// Install / status helpers
// ---------------------------------------------------------------------------

export interface PostgresInstallOptions {
  connectionString: string;
  schema?: string;
}

export interface PostgresInstallReport {
  installed: boolean;
  schema: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToArticle(row: Record<string, unknown>): NuWikiArticle {
  const subject: SubjectRef = {
    kind: row.subject_kind as string,
    id: row.subject_id as string,
    label: (row.subject_label as string | null) ?? undefined,
  };
  return {
    id: row.id as string,
    tenant: row.tenant as string,
    documentType: row.document_type as string,
    subject,
    path: row.path as string,
    currentVersion: row.current_version as string,
    status: row.status as ArticleStatus,
    freshness: (row.freshness as NuWikiArticle['freshness']) ?? {
      lastCompiledAt: new Date().toISOString(),
      isFresh: false,
    },
    backlinks: { inboundCount: 0, outboundCount: 0 },
    visibility: (row.visibility as NuWikiArticle['visibility']) ?? { defaultRoles: [] },
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToVersion(row: Record<string, unknown>): NuWikiArticleVersion {
  return {
    id: row.id as string,
    articleId: row.article_id as string,
    version: row.version as string,
    bodyRef: row.body_ref as NuWikiArticleVersion['bodyRef'],
    bodyHash: row.body_hash as string,
    publishedAt: row.published_at ? toIso(row.published_at) : undefined,
    archivedAt: row.archived_at ? toIso(row.archived_at) : undefined,
    predecessorVersion: (row.predecessor_version as string | null) ?? undefined,
    summary: '',
    sections: [],
    citations: [],
    outboundLinks: [],
    generatedBy: (row.generated_by as NuWikiArticleVersion['generatedBy']) ?? {
      triggeredBy: { kind: 'scheduled_refresh' },
      sourceCount: 0,
      retrievalIds: [],
      generationDurationMs: 0,
    },
  };
}

function toIso(value: unknown): ISODateString {
  if (value instanceof Date) return value.toISOString() as ISODateString;
  if (typeof value === 'string') return new Date(value).toISOString() as ISODateString;
  return new Date().toISOString() as ISODateString;
}

// ---------------------------------------------------------------------------
// NuWikiMetadataPostgresAdapter — implements MetadataAdapter
// ---------------------------------------------------------------------------

export class NuWikiMetadataPostgresAdapter implements MetadataAdapter {
  readonly #client: PgClientLike;
  readonly #schema: string;

  constructor(client: PgClientLike, schema: string) {
    this.#client = client;
    this.#schema = schema;
  }

  get #articles(): string {
    return this.#schema === 'public' ? 'nuwiki_articles' : `"${this.#schema}".nuwiki_articles`;
  }
  get #versions(): string {
    return this.#schema === 'public'
      ? 'nuwiki_article_versions'
      : `"${this.#schema}".nuwiki_article_versions`;
  }
  get #backlinks(): string {
    return this.#schema === 'public' ? 'nuwiki_backlinks' : `"${this.#schema}".nuwiki_backlinks`;
  }

  async upsertArticle(record: ArticleMetadataRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${this.#articles}
         (id, tenant, document_type, subject_kind, subject_id, subject_label,
          path, current_version, status, visibility, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         document_type = EXCLUDED.document_type,
         subject_label = EXCLUDED.subject_label,
         path = EXCLUDED.path,
         current_version = EXCLUDED.current_version,
         status = EXCLUDED.status,
         visibility = EXCLUDED.visibility,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.tenant,
        record.documentType,
        record.subject.kind,
        record.subject.id,
        record.subject.label ?? null,
        record.path,
        record.currentVersion,
        record.status,
        JSON.stringify({ defaultRoles: [] }),
        JSON.stringify(record.metadata ?? {}),
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async getArticle(id: string): Promise<NuWikiArticle | undefined> {
    const result = await this.#client.query(
      `SELECT * FROM ${this.#articles} WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return this.#withBacklinkCounts(rowToArticle(result.rows[0]));
  }

  async findArticle(documentType: string, subject: SubjectRef): Promise<NuWikiArticle | undefined> {
    const result = await this.#client.query(
      `SELECT * FROM ${this.#articles}
       WHERE document_type = $1 AND subject_kind = $2 AND subject_id = $3
       LIMIT 1`,
      [documentType, subject.kind, subject.id],
    );
    if (result.rows.length === 0) return undefined;
    return this.#withBacklinkCounts(rowToArticle(result.rows[0]));
  }

  async listArticles(filters: {
    tenant?: string;
    documentType?: string;
    status?: ArticleStatus;
    limit?: number;
  }): Promise<NuWikiArticle[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (filters.tenant) {
      conditions.push(`tenant = $${p++}`);
      params.push(filters.tenant);
    }
    if (filters.documentType) {
      conditions.push(`document_type = $${p++}`);
      params.push(filters.documentType);
    }
    if (filters.status) {
      conditions.push(`status = $${p++}`);
      params.push(filters.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    params.push(limit);
    const limitParam = `$${p}`;
    const result = await this.#client.query(
      `SELECT * FROM ${this.#articles} ${where} ORDER BY updated_at DESC LIMIT ${limitParam}`,
      params,
    );
    const articles = result.rows.map(rowToArticle);
    return Promise.all(articles.map((a) => this.#withBacklinkCounts(a)));
  }

  async upsertVersion(record: VersionMetadataRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${this.#versions}
         (id, article_id, version, body_ref, body_hash, published_at, archived_at, predecessor_version)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         body_ref = EXCLUDED.body_ref,
         body_hash = EXCLUDED.body_hash,
         published_at = EXCLUDED.published_at,
         archived_at = EXCLUDED.archived_at,
         predecessor_version = EXCLUDED.predecessor_version`,
      [
        record.id,
        record.articleId,
        record.version,
        JSON.stringify(record.bodyRef),
        record.bodyHash,
        record.publishedAt ?? null,
        record.archivedAt ?? null,
        record.predecessorVersion ?? null,
      ],
    );
  }

  async getVersion(versionId: string): Promise<NuWikiArticleVersion | undefined> {
    const result = await this.#client.query(
      `SELECT * FROM ${this.#versions} WHERE id = $1`,
      [versionId],
    );
    if (result.rows.length === 0) return undefined;
    return rowToVersion(result.rows[0]);
  }

  async listVersions(articleId: string): Promise<NuWikiArticleVersion[]> {
    const result = await this.#client.query(
      `SELECT * FROM ${this.#versions} WHERE article_id = $1 ORDER BY published_at DESC NULLS LAST`,
      [articleId],
    );
    return result.rows.map(rowToVersion);
  }

  async recordBacklink(fromArticleId: string, toArticleId: string, linkType: string): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${this.#backlinks} (from_article_id, to_article_id, link_type)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [fromArticleId, toArticleId, linkType],
    );
  }

  async removeBacklinksFor(articleId: string): Promise<void> {
    await this.#client.query(
      `DELETE FROM ${this.#backlinks} WHERE from_article_id = $1 OR to_article_id = $1`,
      [articleId],
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────

  async #withBacklinkCounts(article: NuWikiArticle): Promise<NuWikiArticle> {
    const result = await this.#client.query(
      `SELECT
         (SELECT COUNT(*) FROM ${this.#backlinks} WHERE to_article_id = $1) AS inbound_count,
         (SELECT COUNT(*) FROM ${this.#backlinks} WHERE from_article_id = $1) AS outbound_count`,
      [article.id],
    );
    const row = result.rows[0] ?? {};
    return {
      ...article,
      backlinks: {
        inboundCount: Number(row.inbound_count ?? 0),
        outboundCount: Number(row.outbound_count ?? 0),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// NuWikiMetadataPostgres — public factory and install helpers
// ---------------------------------------------------------------------------

export class NuWikiMetadataPostgres {
  /**
   * Install the NuWiki metadata schema into the target Postgres instance.
   *
   * @example
   * ```ts
   * const report = await NuWikiMetadataPostgres.install({
   *   connectionString: process.env.DATABASE_URL!,
   *   schema: "nuwiki",
   * });
   * ```
   */
  static async install(options: PostgresInstallOptions): Promise<PostgresInstallReport> {
    const schema = options.schema ?? 'public';
    const client = loadPgClient(options.connectionString);
    await client.connect();
    const notes: string[] = [];

    try {
      const sql = buildSchemaSql(schema);
      await client.query(sql);
      notes.push(`NuWiki metadata schema installed in "${schema}"`);
      return { installed: true, schema, notes };
    } finally {
      await client.end();
    }
  }

  /**
   * Check whether the NuWiki metadata schema is installed.
   */
  static async status(connectionString: string): Promise<PostgresInstallReport> {
    const client = loadPgClient(connectionString);
    await client.connect();
    const notes: string[] = [];

    try {
      const tableRes = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('nuwiki_articles', 'nuwiki_article_versions', 'nuwiki_backlinks')`,
      );
      const installed = tableRes.rows.length === 3;
      if (!installed) {
        notes.push(`Missing tables: expected 3, found ${tableRes.rows.length}`);
      }
      return { installed, schema: 'public', notes };
    } finally {
      await client.end();
    }
  }

  /**
   * Open a Postgres-backed NuWiki MetadataAdapter.
   */
  static async open(
    connectionString: string,
    schema = 'public',
  ): Promise<NuWikiMetadataPostgresAdapter> {
    const client = loadPgClient(connectionString);
    await client.connect();
    return new NuWikiMetadataPostgresAdapter(client, schema);
  }
}
