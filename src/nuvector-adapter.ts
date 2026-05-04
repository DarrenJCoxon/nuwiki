/**
 * `@nusoft/nuwiki/nuvector` — `NuVectorAdapter` reference implementation.
 *
 * Thin wrapper around the published `@nusoft/nuvector` runtime that exposes
 * the methods NuWiki's compilation engine calls. Most methods are direct
 * delegations; three (`markSuperseded`, `graph.archiveNode`, `graph.removeNode`)
 * are pragmatic adaptations because NuVector v0.1.0 doesn't expose them
 * directly. See WU 033 spec and inline comments.
 */

import type { NuVector } from '@nusoft/nuvector';
import type { NuVectorGraph } from '@nusoft/nuvector/graph';
import type {
  ContextPack,
  DeletionQuery,
  DeletionResult,
  InvalidationHandler,
  MemoryRecord,
  ProvenanceRecord,
  RetrievalQuery,
  SearchKnowledgeRequest,
  Unsubscribe,
  UpsertRef,
} from '@nusoft/nuvector';
import type {
  BacklinkTraversalRequest,
  BacklinkTraversalResult,
  GraphNodeUpsert,
  NuVectorAdapter,
  NuVectorGraphAdapter,
  SupersedeQuery,
} from './adapters.js';

// ---------------------------------------------------------------------------
// Graph sub-adapter
// ---------------------------------------------------------------------------

class NuWikiNuVectorGraphAdapter implements NuVectorGraphAdapter {
  readonly #memory: NuVector;
  readonly #graph: NuVectorGraph;

  constructor(memory: NuVector, graph: NuVectorGraph) {
    this.#memory = memory;
    this.#graph = graph;
  }

  async upsertNodeWithEdges(spec: GraphNodeUpsert): Promise<void> {
    await this.#graph.upsertNodeWithEdges({
      nodeId: spec.nodeId,
      outboundEdges: spec.outboundEdges.map((e) => ({
        to: e.to,
        type: e.type,
        weight: e.weight,
      })),
    });
  }

  /**
   * Archive a graph node by removing its associated NuVector records.
   *
   * NuVector v0.1.0's graph does not expose an explicit "archive" operation
   * separate from removal. The architectural intent is honoured by removing
   * the four-layer records; NuWiki's metadata layer (Postgres) keeps the
   * article in `status: 'archived'` for audit. Archived articles do not
   * appear in agent retrievals, which is the desired effect.
   */
  async archiveNode(nodeId: string): Promise<void> {
    await this.#removeForArticle(nodeId);
  }

  /**
   * Hard-delete a graph node and its records.
   *
   * v0.1.0 uses the same path as `archiveNode`. Sharper semantics may be
   * introduced in a later WU (likely WU 042 — integrity-pass loop) if the
   * difference becomes operationally meaningful.
   */
  async removeNode(nodeId: string): Promise<void> {
    await this.#removeForArticle(nodeId);
  }

  async #removeForArticle(articleId: string): Promise<void> {
    // Use NuVector's deletion path; targets all records whose articleId metadata matches.
    await this.#memory.delete({
      articleId,
      reason: 'cleanup',
    } as DeletionQuery);
  }

  async traverse(request: BacklinkTraversalRequest): Promise<BacklinkTraversalResult> {
    const result = await this.#graph.traverse({
      startArticleId: request.fromArticleId,
      edgeTypes: request.linkTypes,
      maxDepth: request.maxDepth ?? 1,
    });
    const visited = new Set<string>();
    visited.add(request.fromArticleId);
    for (const e of result.edges) {
      visited.add(e.from);
      visited.add(e.to);
    }
    return {
      edges: result.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, weight: e.weight })),
      visitedArticleIds: [...visited],
    };
  }
}

// ---------------------------------------------------------------------------
// NuVectorAdapter implementation
// ---------------------------------------------------------------------------

export class NuWikiNuVectorAdapter implements NuVectorAdapter {
  readonly #memory: NuVector;
  readonly graph: NuVectorGraphAdapter;

  constructor(memory: NuVector, graph: NuVectorGraph) {
    this.#memory = memory;
    this.graph = new NuWikiNuVectorGraphAdapter(memory, graph);
  }

  async searchKnowledge(request: SearchKnowledgeRequest): Promise<ContextPack> {
    return this.#memory.searchKnowledge(request);
  }

  async retrieveContext(query: RetrievalQuery): Promise<ContextPack> {
    return this.#memory.retrieveContext(query);
  }

  async upsertBatch(records: MemoryRecord[]): Promise<UpsertRef[]> {
    return this.#memory.upsertBatch(records);
  }

  /**
   * Pattern-based supersession.
   *
   * v0.1.0 is a documented no-op. NuVector handles supersession automatically
   * when records are upserted with `supersedesId` set — the compilation engine
   * (WU 036) sets this on every new version's records, which triggers
   * NuVector's automatic supersession path. Explicit pattern-based supersession
   * is not part of NuVector v0.1.0's public surface; the compilation engine
   * does not need it provided it correctly populates `supersedesId`.
   *
   * The method exists for shape conformance with the NuWiki contract.
   */
  async markSuperseded(_query: SupersedeQuery): Promise<void> {
    // No-op by design at v0.1.0. See WU 033 spec for the rationale.
  }

  async remember(record: ProvenanceRecord): Promise<{ ref: string }> {
    const result = await this.#memory.remember(record);
    return { ref: result.id };
  }

  async delete(query: DeletionQuery): Promise<DeletionResult> {
    return this.#memory.delete(query);
  }

  subscribeToInvalidations(handler: InvalidationHandler): Unsubscribe {
    return this.#memory.subscribeToInvalidations(handler);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a NuVectorAdapter from a NuVector instance.
 *
 * @example
 * ```ts
 * import { NuVector } from "@nusoft/nuvector";
 * import { NuVectorGraph } from "@nusoft/nuvector/graph";
 * import { createNuVectorAdapter } from "@nusoft/nuwiki/nuvector";
 *
 * const memory = await NuVector.open({ ... });
 * const adapter = await createNuVectorAdapter(memory);
 * // pass to NuWiki.open({ memoryAdapter: adapter, ... })
 * ```
 */
export async function createNuVectorAdapter(
  memory: NuVector,
  graph?: NuVectorGraph
): Promise<NuWikiNuVectorAdapter> {
  let attached = graph;
  if (!attached) {
    const { NuVectorGraph: GraphClass } = await import('@nusoft/nuvector/graph');
    attached = await GraphClass.attach(memory);
  }
  return new NuWikiNuVectorAdapter(memory, attached);
}
