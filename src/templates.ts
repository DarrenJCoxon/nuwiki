/**
 * `@nusoft/nuwiki/templates` — pre-built DocumentType definitions.
 *
 * Skeleton only. Concrete templates land in WU 044 (Starter education
 * DocumentTypes).
 */

import { NotImplementedError } from './errors.js';
import type { DocumentType } from './types.js';

export const NuWikiTemplates = {
  get education(): DocumentType[] {
    throw new NotImplementedError('NuWikiTemplates.education', 'WU 044 (starter education DocumentTypes)');
  },
};
