/**
 * `@nusoft/nuwiki/scaleway-config` — semantic-tier mapping per D070.
 *
 * Call sites do not import model IDs from string literals; they import from
 * this module. A model swap is a one-line PR against this file.
 *
 * Dimension is exposed as a constant rather than an env var per D070's
 * principle: changes are version-controlled, attributed PRs, not silent
 * deploy-config tweaks.
 *
 * @see D068 — Scaleway as the backend LLM provider
 * @see D069 — default model assignments by tier
 * @see D070 — semantic-tier abstraction (call sites import tier names, not model IDs)
 * @see D071 — 1024-dim Matryoshka embedding default (drain-and-refill migration path)
 */

export const SCALEWAY_MODELS = {
  reasoning: 'qwen3.5-397b-a17b',
  // worker tier exported for completeness per D070; NuWiki library uses
  // reasoning tier only — no worker-tier surfaces in seed() or compile() today.
  worker: 'qwen3.6-35b-a3b',
  embedding: 'qwen3-embedding-8b',
} as const;

export type ScalewayTier = keyof typeof SCALEWAY_MODELS;

/**
 * Matryoshka embedding dimension. Set to 1024 per D071 — the quality-per-byte
 * optimum for Qwen3-Embedding-8B (within 1–2% of full 4096, at 1/4 the
 * storage). Changing this constant is a breaking change: all existing vectors
 * must be drained and refilled (D071 drain-and-refill strategy).
 */
export const SCALEWAY_EMBEDDING_DIMENSIONS = 1024 as const;

export const SCALEWAY_BASE_URL = 'https://api.scaleway.ai' as const;

export interface ScalewayCredentials {
  projectId: string;
  secretKey: string;
}

/**
 * Parse SCW_* env vars into a credentials object. Throws if either required
 * variable is missing or empty. Returns the canonical shape the
 * ScalewayLLMAdapter constructor consumes.
 *
 * Expected env vars:
 * - `SCW_SECRET_KEY` — Bearer token for Scaleway Generative APIs
 * - `SCW_DEFAULT_PROJECT_ID` — project UUID; appears in the API base URL path
 *
 * @throws Error with a message naming the specific missing variable.
 */
export function parseScalewayCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ScalewayCredentials {
  const secretKey = env['SCW_SECRET_KEY'];
  if (!secretKey || secretKey.trim() === '') {
    throw new Error(
      'Scaleway credentials: SCW_SECRET_KEY is required but was not set or is empty',
    );
  }
  const projectId = env['SCW_DEFAULT_PROJECT_ID'];
  if (!projectId || projectId.trim() === '') {
    throw new Error(
      'Scaleway credentials: SCW_DEFAULT_PROJECT_ID is required but was not set or is empty',
    );
  }
  return { secretKey, projectId };
}
