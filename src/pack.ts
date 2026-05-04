/**
 * `WikiPack` — the first-class extension surface for NuWiki.
 *
 * A wiki pack is a separately published artifact that contributes domain
 * content (DocumentType definitions) to a NuWiki runtime. Implements the
 * architectural commitment recorded in
 * `nuos/docs/build/decisions/D015-workflow-packs-as-extension-surface.md`.
 *
 * NuWiki core stays domain-neutral: it defines the pack interface but ships
 * no concrete packs. Concrete packs live in their own repositories, depend
 * on `@nusoft/nuwiki`, and are installed by consumers.
 */

import type { DocumentType } from './types.js';

/**
 * The shape every wiki pack conforms to.
 *
 * @example
 * ```ts
 * import { defineWikiPack } from "@nusoft/nuwiki/pack";
 *
 * export const educationPack = defineWikiPack({
 *   name: "education-sen",
 *   version: "0.1.0",
 *   description: "SEN school DocumentTypes",
 *   documentTypes: [pupilProfile, incidentReport, interventionLog],
 * });
 *
 * // In the consumer application:
 * const wiki = await NuWiki.open({
 *   ...adapters,
 *   documentTypes: educationPack.documentTypes,
 * });
 * ```
 */
export interface WikiPack {
  /** The pack's name, e.g. "education-sen". Should be unique across packs. */
  name: string;
  /** Semantic version. */
  version: string;
  /** One-line summary of what this pack contributes. */
  description?: string;
  /** DocumentType definitions the pack contributes. */
  documentTypes: DocumentType[];
}

/**
 * Helper for pack authors. Takes a pack specification and returns a
 * complete `WikiPack`.
 *
 * @example
 * ```ts
 * import { defineWikiPack } from "@nusoft/nuwiki/pack";
 *
 * export const educationSenPack = defineWikiPack({
 *   name: "education-sen",
 *   version: "0.1.0",
 *   description: "SEN school DocumentTypes",
 *   documentTypes: [pupilProfile, incidentReport, interventionLog],
 * });
 * ```
 */
export function defineWikiPack(spec: WikiPack): WikiPack {
  return spec;
}
