import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { UUID_RE, audit, badRequest, notFound, requireRecruiterJob } from "@/lib/screening/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DecisionSchema = z
  .object({
    decision: z.enum(["shortlisted", "rejected", "hold", "needs_review"]),
    rationale: z.string().trim().max(2000).optional().default(""),
  })
  .refine((d) => !["shortlisted", "rejected"].includes(d.decision) || d.rationale.length >= 3, {
    message: "A rationale is required for shortlist and reject decisions.",
    path: ["rationale"],
  });

// POST → record the recruiter's decision (append-only; the AI never writes decisions).
export async function POST(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  const parsed = DecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid decision");

  const s = await pool.query(`SELECT id, status FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  if (!s.rows[0]) return notFound("Screening not found");

  const r = await pool.query(
    `INSERT INTO screening_decisions (screening_id, job_id, recruiter_id, decision, rationale)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, decision, rationale, created_at`,
    [params.sid, access.job.id, access.recruiterId, parsed.data.decision, parsed.data.rationale || null]
  );
  await audit(pool, {
    jobId: access.job.id, recruiterId: access.recruiterId, action: "decide", entityType: "cv_screening", entityId: params.sid,
    meta: { decision: parsed.data.decision, screening_status: s.rows[0].status },
  });
  return NextResponse.json(r.rows[0], { status: 201 });
}
