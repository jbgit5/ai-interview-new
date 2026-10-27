import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requireRecruiterJob } from "@/lib/screening/access";
import { CV_ERROR_MESSAGES } from "@/lib/screening/parse";
import { getLatestConfig, listResults } from "@/lib/screening/service";
import { isBudgetPaused, kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → one row per uploaded CV for this job (filtering/sorting happens client-side).
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const [rows, config] = await Promise.all([listResults(pool, access.job.id), getLatestConfig(pool, access.job.id)]);
  if (rows.some((r) => r.status === "queued" || r.status === "processing")) kickWorker();
  return NextResponse.json({
    current_config_version: config?.version ?? null,
    budget_paused: isBudgetPaused(),
    results: rows.map((r) => ({
      ...r,
      outdated: config ? r.config_version < config.version : false,
      error_message: r.error_code ? CV_ERROR_MESSAGES[r.error_code] ?? CV_ERROR_MESSAGES.internal_error : null,
    })),
  });
}
