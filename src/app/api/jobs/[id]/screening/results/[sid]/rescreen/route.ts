import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { getLatestConfig } from "@/lib/screening/service";
import { kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST → screen this CV against the job's CURRENT criteria version. The earlier result is kept.
// Idempotent (one screening per CV per version); the cached extraction is reused, so only the
// criterion assessment is paid for again.
export async function POST(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  const cur = await pool.query(`SELECT cv_document_id FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  if (!cur.rows[0]) return notFound("Screening not found");
  const config = await getLatestConfig(pool, access.job.id);
  if (!config) return NextResponse.json({ error: "No screening criteria configured." }, { status: 409 });

  const r = await pool.query(
    `INSERT INTO cv_screenings (job_id, cv_document_id, config_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (cv_document_id, config_id) DO UPDATE SET updated_at = cv_screenings.updated_at
     RETURNING id, status, (xmax = 0) AS created`,
    [access.job.id, cur.rows[0].cv_document_id, config.id]
  );
  const out = r.rows[0];
  if (out.created) {
    await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "rescreen", entityType: "cv_screening", entityId: out.id, meta: { config_version: config.version } });
  }
  kickWorker();
  return NextResponse.json({ screening_id: out.id, status: out.status, created: out.created }, { status: out.created ? 201 : 200 });
}
