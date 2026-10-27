import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { CV_ERROR_MESSAGES } from "@/lib/screening/parse";
import { isBudgetPaused, kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → progress for one batch. Polled by the upload panel; also (re)starts the in-process
// worker, so queued work resumes after a server restart.
export async function GET(request: NextRequest, { params }: { params: { id: string; batchId: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.batchId)) return notFound("Batch not found");

  const b = await pool.query(
    `SELECT b.id, b.created_at, c.version AS config_version
       FROM screening_batches b JOIN screening_configs c ON c.id = b.config_id
      WHERE b.id = $1 AND b.job_id = $2`,
    [params.batchId, access.job.id]
  );
  if (!b.rows[0]) return notFound("Batch not found");

  const items = await pool.query(
    `SELECT s.id AS screening_id, s.status, s.error_code, s.attempts, s.job_fit_score, s.fit_category,
            d.id AS document_id, d.original_filename
       FROM cv_screenings s JOIN cv_documents d ON d.id = s.cv_document_id AND d.job_id = s.job_id
      WHERE s.batch_id = $1 AND s.job_id = $2
      ORDER BY s.created_at`,
    [params.batchId, access.job.id]
  );
  const counts = { total: items.rows.length, queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const r of items.rows) counts[r.status as "queued" | "processing" | "completed" | "failed"]++;
  if (counts.queued + counts.processing > 0) kickWorker();

  return NextResponse.json({
    batch: b.rows[0],
    counts,
    budget_paused: isBudgetPaused(),
    items: items.rows.map((r) => ({ ...r, error_message: r.error_code ? CV_ERROR_MESSAGES[r.error_code] ?? CV_ERROR_MESSAGES.internal_error : null })),
  });
}
