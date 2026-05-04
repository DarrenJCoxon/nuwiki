/**
 * NuWiki errors.
 */

export class NotImplementedError extends Error {
  constructor(method: string, deferredTo?: string) {
    const tail = deferredTo ? ` — deferred to ${deferredTo}` : '';
    super(`${method} is not implemented${tail}`);
    this.name = 'NotImplementedError';
  }
}
