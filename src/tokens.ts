/**
 * Token-count utilities (WU 037).
 *
 * Model-agnostic per D020 — no specific tokenizer is bundled and no model
 * name is pinned. The default heuristic is the long-standing
 * "~4 characters per token" approximation that holds well enough for
 * English prose across the major model families. Consumers who need
 * vendor-accurate counts inject their own counter via
 * `CompilationEngineConfig.tokenCounter`.
 */

export class TokenBudgetExceededError extends Error {
  readonly observed: number;
  readonly budget: number;
  constructor(observed: number, budget: number) {
    super(`Token budget exceeded: observed ${observed} tokens, budget ${budget}`);
    this.observed = observed;
    this.budget = budget;
    this.name = 'TokenBudgetExceededError';
  }
}

/**
 * Estimate the token count of `text`. Model-agnostic by design.
 *
 * The `model` argument is accepted for future-proofing — callers may pass
 * a model name and a future heuristic-selection layer may swap algorithms.
 * The current implementation ignores it; no specific model is hardcoded.
 */
export function estimateTokenCount(text: string, _model?: string): number {
  if (!text) return 0;
  const whitespaceTokens = text.trim() ? text.trim().split(/\s+/).length : 0;
  // ~4 characters per token, rounded up. Use Math.max with the whitespace
  // count so very short / single-word inputs land on a sensible floor.
  const charBased = Math.ceil(text.length / 4);
  return Math.max(whitespaceTokens, charBased);
}

/**
 * Throw `TokenBudgetExceededError` when `text` exceeds `budget` tokens.
 * Returns the observed count when within budget.
 */
export function assertWithinTokenBudget(
  text: string,
  budget: number,
  counter: (text: string) => number = estimateTokenCount,
): number {
  const observed = counter(text);
  if (observed > budget) throw new TokenBudgetExceededError(observed, budget);
  return observed;
}
