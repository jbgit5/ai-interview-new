import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, badRequest, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { PlanQuestionsSchema, loadCandidatePlans, loadCommonQuestions, saveCandidateQuestions } from "@/lib/screening/interviewPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → this candidate's interview questions (prepared list, or the screening's suggestions)
//        plus the job's common questions, so HR sees the whole interview.
// PUT → save the candidate's own questions (CV-based kept/edited + HR's own). Not sent anywhere
//        until HR invites the candidate and confirms.
export async function GET(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");
  const [plan] = await loadCandidatePlans(pool, access.job.id, [params.sid]);
  if (!plan) return notFound("Screening not found");
  const common = await loadCommonQuestions(pool, access.job.id);
  return NextResponse.json({ ...plan, common });
}

export async function PUT(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");
  const body = await request.json().catch(() => null);
  const parsed = PlanQuestionsSchema.safeParse(body?.questions);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid questions");

  const s = await pool.query(`SELECT cv_document_id FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  if (!s.rows[0]) return notFound("Screening not found");
  await saveCandidateQuestions(pool, access.job.id, s.rows[0].cv_document_id, parsed.data);
  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "questions_saved", entityType: "cv_document", entityId: s.rows[0].cv_document_id, meta: { count: parsed.data.length } });
  const [plan] = await loadCandidatePlans(pool, access.job.id, [params.sid]);
  return NextResponse.json(plan);
}
