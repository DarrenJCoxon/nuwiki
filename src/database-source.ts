/**
 * `@nusoft/nuwiki/database-source` — `DatabaseSourceAdapter` reference implementations.
 *
 * Unlike the other NuWiki adapters, `DatabaseSourceAdapter` sits over the
 * consumer's own domain database — NuOS cannot know its schema in advance.
 * The contract is therefore a named-query dispatch surface:
 *
 *   query({ kind, payload }) → Promise<DatabaseSourceQueryResult>
 *
 * `kind` is a domain query name like `pupil_recent_incidents` or
 * `class_attendance_window`, declared on a `DocumentType.sourceQueries[]`
 * entry. The consumer wires whichever data-access stack they already use
 * (Prisma, Drizzle, raw pg, an ORM, a GraphQL resolver, a REST client)
 * inside a handler and exposes it by `kind`.
 *
 * Three implementations:
 *
 * - `createDatabaseSourceAdapter({ handlers })` — the principal reference;
 *   the consumer registers a handler per named query.
 * - `InMemoryDatabaseSourceAdapter` / `createInMemoryDatabaseSourceAdapter` —
 *   fixture-backed adapter for tests and DocumentType-authoring workflows.
 * - `createStubDatabaseSourceAdapter` — deterministic scripted-response
 *   adapter; mirrors the WU 034 `createStubLLMAdapter` shape.
 */

import type { DatabaseSourceAdapter, DatabaseSourceQueryResult } from './adapters.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DatabaseSourceUnknownKindError extends Error {
  readonly kind: string;
  readonly availableKinds: string[];
  constructor(kind: string, availableKinds: string[]) {
    super(
      `DatabaseSourceAdapter: no handler registered for kind '${kind}'. ` +
        `Available kinds: ${availableKinds.length ? availableKinds.join(', ') : '(none)'}`,
    );
    this.kind = kind;
    this.availableKinds = availableKinds;
    this.name = 'DatabaseSourceUnknownKindError';
  }
}

export class DatabaseSourceStubExhaustedError extends Error {
  constructor() {
    super('DatabaseSourceAdapter stub: scripted responses exhausted');
    this.name = 'DatabaseSourceStubExhaustedError';
  }
}

// ---------------------------------------------------------------------------
// Composable handler-map adapter (the principal reference)
// ---------------------------------------------------------------------------

export type DatabaseSourceHandler = (
  payload: Record<string, unknown>,
) => Promise<DatabaseSourceQueryResult>;

export interface DatabaseSourceAdapterConfig {
  handlers: Record<string, DatabaseSourceHandler>;
}

export function createDatabaseSourceAdapter(
  config: DatabaseSourceAdapterConfig,
): DatabaseSourceAdapter {
  const handlers = { ...config.handlers };
  return {
    async query(req: { kind: string; payload: Record<string, unknown> }) {
      const handler = handlers[req.kind];
      if (!handler) {
        throw new DatabaseSourceUnknownKindError(req.kind, Object.keys(handlers));
      }
      return handler(req.payload);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture-backed in-memory adapter
// ---------------------------------------------------------------------------

export interface InMemoryDatabaseSourceData {
  [kind: string]: Array<Record<string, unknown>>;
}

export class InMemoryDatabaseSourceAdapter implements DatabaseSourceAdapter {
  readonly #data: InMemoryDatabaseSourceData;

  constructor(data: InMemoryDatabaseSourceData = {}) {
    this.#data = { ...data };
  }

  async query(req: { kind: string; payload: Record<string, unknown> }): Promise<DatabaseSourceQueryResult> {
    return { rows: this.#data[req.kind] ?? [] };
  }

  /** Replace the fixture data for a given kind (test convenience). */
  setData(kind: string, rows: Array<Record<string, unknown>>): void {
    this.#data[kind] = rows;
  }
}

export function createInMemoryDatabaseSourceAdapter(config: {
  data?: InMemoryDatabaseSourceData;
} = {}): InMemoryDatabaseSourceAdapter {
  return new InMemoryDatabaseSourceAdapter(config.data);
}

// ---------------------------------------------------------------------------
// Deterministic stub for tests
// ---------------------------------------------------------------------------

export interface StubDatabaseSourceAdapter extends DatabaseSourceAdapter {
  readonly calls: Array<{ kind: string; payload: Record<string, unknown> }>;
}

export function createStubDatabaseSourceAdapter(
  scripted: DatabaseSourceQueryResult[],
): StubDatabaseSourceAdapter {
  let i = 0;
  const calls: StubDatabaseSourceAdapter['calls'] = [];
  return {
    calls,
    async query(req: { kind: string; payload: Record<string, unknown> }) {
      calls.push({ kind: req.kind, payload: req.payload });
      if (i >= scripted.length) throw new DatabaseSourceStubExhaustedError();
      return scripted[i++];
    },
  };
}
