import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { CV_ERROR_MESSAGES } from "@/lib/screening/parse";
import { kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_PROBLEMS = new Set(["password_protected", "malformed", "empty", "needs_ocr", "parse_timeout", "unsupported_type"]);

// POST → re-queue a failed screening. Cached steps (text, extraction) are reused.
export async function POST(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  const cur = await pool.query(`SELECT status, error_code FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  const row = cur.rows[0];
  if (!row) return notFound("Screening not found");
  if (row.status !== "failed") return NextResponse.json({ error: "Only failed screenings can be retried." }, { status: 409 });
  if (FILE_PROBLEMS.has(row.error_code)) {
    return NextResponse.json({ error: `${CV_ERROR_MESSAGES[row.error_code]} Retrying the same file won't help — upload a corrected file instead.` }, { status: 409 });
  }

  // Conditional update: a double click can only re-queue once.
  const upd = await pool.query(
    `UPDATE cv_screenings SET status = 'queued', attempts = 0, error_code = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1 AND job_id = $2 AND status = 'failed'`,
    [params.sid, access.job.id]
  );
  if (upd.rowCount) {
    await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "retry", entityType: "cv_screening", entityId: params.sid });
    kickWorker();
  }
  return NextResponse.json({ ok: true });
}
