/**
 * Backlink graph utilities (WU 040).
 *
 * Pure helpers for the engine's backlink maintenance phase plus a
 * checker that flags outbound links whose target doesn't resolve to a
 * published article.
 */

import type { MetadataAdapter } from './adapters.js';

export interface OutboundLinkRef {
  toArticleId: string;
  linkType: string;
}

/**
 * Diff two sets of outbound links by `(toArticleId, linkType)` identity.
 *
 * Used by the engine on recompile: backlinks for `removed` get cleared
 * (via `metadata.removeBacklinksFor` at the predecessor level — see the
 * engine for the actual call shape), backlinks for `added` get recorded
 * fresh, `unchanged` are left as-is.
 */
export function diffOutboundLinks(
  previous: ReadonlyArray<OutboundLinkRef>,
  next: ReadonlyArray<OutboundLinkRef>,
): { added: OutboundLinkRef[]; removed: OutboundLinkRef[]; unchanged: OutboundLinkRef[] } {
  const key = (l: OutboundLinkRef) => `${l.toArticleId}::${l.linkType}`;
  const prevMap = new Map(previous.map((l) => [key(l), l]));
  const nextMap = new Map(next.map((l) => [key(l), l]));
  const added: OutboundLinkRef[] = [];
  const removed: OutboundLinkRef[] = [];
  const unchanged: OutboundLinkRef[] = [];
  for (const [k, l] of nextMap) {
    if (prevMap.has(k)) unchanged.push(l);
    else added.push(l);
  }
  for (const [k, l] of prevMap) {
    if (!nextMap.has(k)) removed.push(l);
  }
  return { added, removed, unchanged };
}

// ---------------------------------------------------------------------------
// BrokenLinkChecker
// ---------------------------------------------------------------------------

export interface BrokenLinkReport {
  brokenLinks: Array<{
    toArticleId: string;
    linkType: string;
    reason: 'missing' | 'archived';
  }>;
}

export class BrokenLinkChecker {
  readonly #metadata: MetadataAdapter;
  constructor(metadata: MetadataAdapter) {
    this.#metadata = metadata;
  }

  /**
   * Check each outbound link's target. A target is broken when
   * `metadata.getArticle(toArticleId)` returns `undefined` (missing) or
   * an article whose `status` is `'archived'`.
   */
  async check(links: ReadonlyArray<OutboundLinkRef>): Promise<BrokenLinkReport> {
    const broken: BrokenLinkReport['brokenLinks'] = [];
    for (const link of links) {
      const target = await this.#metadata.getArticle(link.toArticleId);
      if (!target) {
        broken.push({ toArticleId: link.toArticleId, linkType: link.linkType, reason: 'missing' });
      } else if (target.status === 'archived') {
        broken.push({ toArticleId: link.toArticleId, linkType: link.linkType, reason: 'archived' });
      }
    }
    return { brokenLinks: broken };
  }
}
