/**
 * Rough token estimate for JEV budgeting. Mixed Cyrillic/Latin text and JSON punctuation
 * average close to 3.5 characters per token; we err on the side of overestimating.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return Math.ceil(text.length / 3.5);
}
