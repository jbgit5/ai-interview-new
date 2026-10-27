import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { openAiJsonCall } from "@/lib/llm/openai";
import { LlmCallError } from "@/lib/llm/types";
import { requireRecruiterJob } from "@/lib/screening/access";
import { getScreeningConfig } from "@/lib/screening/config";
import { DEFAULT_CRITERIA } from "@/lib/screening/criteria";
import { CV_ERROR_MESSAGES } from "@/lib/screening/parse";
import { suggestCriteria, suggestionToCriteria } from "@/lib/screening/pipeline";
import { recordUsage, spentTodayUsd } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST → draft criteria from the job description. Returned for the recruiter to review;
// nothing is saved and nothing is marked as a hard requirement.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const jd = access.job.description?.trim();
  if (!jd) return NextResponse.json({ error: "This job has no description to read criteria from." }, { status: 409 });

  const cfg = getScreeningConfig();
  const spent = await spentTodayUsd(pool).catch(() => Number.POSITIVE_INFINITY);
  if (spent >= cfg.dailyBudgetUsd) return NextResponse.json({ error: CV_ERROR_MESSAGES.daily_budget }, { status: 429 });

  try {
    const { suggestion, usage } = await suggestCriteria({
      llm: openAiJsonCall, model: cfg.criteriaModel, timeoutMs: 30_000, jobTitle: access.job.title, jobDescription: jd,
    });
    await recordUsage(pool, { jobId: access.job.id, documentId: null, kind: "criteria_suggestion", usage, ok: true });
    return NextResponse.json({ criteria: suggestionToCriteria(suggestion, DEFAULT_CRITERIA), sources: suggestion });
  } catch (err) {
    const code = err instanceof LlmCallError ? err.code : "internal_error";
    if (err instanceof LlmCallError && err.usage) {
      await recordUsage(pool, { jobId: access.job.id, documentId: null, kind: "criteria_suggestion", usage: err.usage, ok: false, errorCode: code });
    }
    console.error("[screening] criteria suggestion failed", { jobId: access.job.id, code });
    return NextResponse.json({ error: CV_ERROR_MESSAGES[code] ?? CV_ERROR_MESSAGES.internal_error }, { status: 502 });
  }
}
