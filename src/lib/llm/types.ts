import type { ZodType } from "zod";

export interface LlmUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export interface LlmJsonRequest {
  model: string;
  system: string;
  user: string;
  /** Zod schema used to build the strict json_schema response format. */
  schema: ZodType;
  schemaName: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
}

/**
 * The single seam between the screening pipeline and the provider. Returns the RAW parsed JSON
 * (unknown); callers always re-validate with zod, so a mocked implementation in tests goes
 * through exactly the same validation as production.
 */
export type LlmJsonCall = (req: LlmJsonRequest) => Promise<{ data: unknown; usage: LlmUsage }>;

export class LlmCallError extends Error {
  code: string;
  /** Present when the provider answered (tokens were billed) but the output was unusable. */
  usage: LlmUsage | null;
  constructor(code: string, message: string, usage: LlmUsage | null = null) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}
