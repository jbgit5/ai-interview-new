import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { requireRecruiterJob } from "@/lib/screening/access";
import { getScreeningConfig } from "@/lib/screening/config";
import { getLatestConfig } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST → start an upload batch bound to the job's CURRENT criteria version.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const config = await getLatestConfig(pool, access.job.id);
  if (!config) return NextResponse.json({ error: "Set up the screening criteria for this job first." }, { status: 409 });

  const r = await pool.query(
    `INSERT INTO screening_batches (job_id, config_id, created_by) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [access.job.id, config.id, access.recruiterId]
  );
  const cfg = getScreeningConfig();
  return NextResponse.json(
    {
      batch_id: r.rows[0].id,
      config_version: config.version,
      limits: { max_file_bytes: cfg.maxFileBytes, max_files_per_batch: cfg.maxFilesPerBatch },
    },
    { status: 201 }
  );
}
