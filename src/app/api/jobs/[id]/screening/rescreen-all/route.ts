import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { audit, requireRecruiterJob } from "@/lib/screening/access";
import { getLatestConfig } from "@/lib/screening/service";
import { kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  → how many readable CVs have no result for the CURRENT requirements version
// POST → queue them. Cached extractions are reused, so only the assessment call is paid per CV.
async function pending(jobId: string, configId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cv_documents d
      WHERE d.job_id = $1 AND d.extraction_status NOT IN ('failed', 'needs_ocr')
        AND NOT EXISTS (SELECT 1 FROM cv_screenings s WHERE s.cv_document_id = d.id AND s.config_id = $2)`,
    [jobId, configId]
  );
  return r.rows[0].n;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  const config = await getLatestConfig(pool, access.job.id);
  return NextResponse.json({ outdated: config ? await pending(access.job.id, config.id) : 0, version: config?.version ?? null });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  const config = await getLatestConfig(pool, access.job.id);
  if (!config) return NextResponse.json({ error: "No requirements saved yet." }, { status: 409 });

  const r = await pool.query(
    `INSERT INTO cv_screenings (job_id, cv_document_id, config_id)
     SELECT d.job_id, d.id, $2 FROM cv_documents d
      WHERE d.job_id = $1 AND d.extraction_status NOT IN ('failed', 'needs_ocr')
     ON CONFLICT (cv_document_id, config_id) DO NOTHING`,
    [access.job.id, config.id]
  );
  const queued = r.rowCount ?? 0;
  if (queued) {
    await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "rescreen_all", entityType: "job", entityId: access.job.id, meta: { config_version: config.version, queued } });
    kickWorker();
  }
  return NextResponse.json({ queued, version: config.version });
}
