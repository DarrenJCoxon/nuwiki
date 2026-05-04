/**
 * `@nusoft/nuwiki/export` — render compiled articles as PDF, slides, role-aware HTML.
 *
 * Skeleton only. Concrete exporters are post-v0.1.0.
 */

import { NotImplementedError } from './errors.js';

export const NuWikiExport = {
  toPdf: (): never => {
    throw new NotImplementedError('NuWikiExport.toPdf', 'post-v0.1.0');
  },
  toSlides: (): never => {
    throw new NotImplementedError('NuWikiExport.toSlides', 'post-v0.1.0');
  },
  toHtml: (): never => {
    throw new NotImplementedError('NuWikiExport.toHtml', 'post-v0.1.0');
  },
};
