import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, badRequest, requireRecruiterJob } from "@/lib/screening/access";
import { loadCandidatePlans, loadCommonQuestions } from "@/lib/screening/interviewPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX = 50;

// GET ?sids=a,b,c → everything the "Confirm interview plan" screen needs: the job's common
// questions, the follow-up setting, and per candidate name/email/own questions/status.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  const sids = (request.nextUrl.searchParams.get("sids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!sids.length || sids.length > MAX || !sids.every((s) => UUID_RE.test(s))) return badRequest(`Pick between 1 and ${MAX} candidates.`);

  const [common, candidates, job] = await Promise.all([
    loadCommonQuestions(pool, access.job.id),
    loadCandidatePlans(pool, access.job.id, sids),
    pool.query(`SELECT allow_probes FROM jobs WHERE id = $1`, [access.job.id]),
  ]);
  return NextResponse.json({
    job: { id: access.job.id, title: access.job.title },
    common,
    allow_probes: job.rows[0]?.allow_probes !== false,
    candidates,
  });
}
