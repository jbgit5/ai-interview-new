import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { estimateCostUsd } from "./pricing";
import { LlmCallError, type LlmJsonCall, type LlmUsage } from "./types";

export { LlmCallError };
export type { LlmJsonCall, LlmUsage };

// Shared OpenAI client for server-side batch work (CV screening). One client so keep-alive
// connections are reused (same reasoning as getOpenAI() in sessions/[token]/turn/route.ts).
// Existing interview routes keep their own clients; only new code uses this module.
let openaiSingleton: OpenAI | null = null;
export function getOpenAI(): OpenAI {
  if (!openaiSingleton) openaiSingleton = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiSingleton;
}

export const openAiJsonCall: LlmJsonCall = async (req) => {
  const started = Date.now();
  let completion;
  try {
    completion = await getOpenAI().chat.completions.create(
      {
        model: req.model,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens,
        response_format: zodResponseFormat(req.schema, req.schemaName),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
      { timeout: req.timeoutMs, maxRetries: 1 }
    );
  } catch (err) {
    // Never include the prompt (it contains CV text) in the error.
    const status = (err as { status?: number })?.status;
    throw new LlmCallError(status === 429 ? "provider_rate_limited" : "provider_error", `OpenAI call failed${status ? ` (${status})` : ""}`);
  }
  const choice = completion.choices[0];
  const usage: LlmUsage = {
    model: req.model,
    prompt_tokens: completion.usage?.prompt_tokens ?? 0,
    completion_tokens: completion.usage?.completion_tokens ?? 0,
    cost_usd: 0,
    latency_ms: Date.now() - started,
  };
  usage.cost_usd = estimateCostUsd(req.model, usage.prompt_tokens, usage.completion_tokens);

  if (choice?.message?.refusal) throw new LlmCallError("model_refused", "Model refused the request", usage);
  if (choice?.finish_reason === "length") throw new LlmCallError("output_truncated", "Model output hit the token limit", usage);
  const content = choice?.message?.content;
  if (!content) throw new LlmCallError("empty_output", "Model returned no content", usage);
  try {
    return { data: JSON.parse(content), usage };
  } catch {
    throw new LlmCallError("malformed_output", "Model returned invalid JSON", usage);
  }
};
