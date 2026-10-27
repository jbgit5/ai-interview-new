// USD per 1M tokens (input, output). Update if OpenAI changes rates.
// Matches the rates hard-coded in sessions/[token]/end/route.ts.
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/** Estimated cost of one call. Unknown models are priced as gpt-4o (overestimate, never zero). */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`));
  const p = PRICES[key ?? "gpt-4o"];
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}
