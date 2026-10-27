import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { audit, badRequest, requireRecruiterJob } from "@/lib/screening/access";
import { CriteriaSchema, DEFAULT_CRITERIA, RUBRIC_VERSION } from "@/lib/screening/criteria";
import { createConfigVersion, getLatestConfig } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  → current criteria (or defaults) + version history
// POST → save a NEW immutable version (existing screenings keep pointing at their version)
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const latest = await getLatestConfig(pool, access.job.id);
  const versions = await pool.query(
    `SELECT c.id, c.version, c.created_at, c.rubric_version, r.name AS created_by_name
       FROM screening_configs c LEFT JOIN recruiters r ON r.id = c.created_by
      WHERE c.job_id = $1 ORDER BY c.version DESC LIMIT 50`,
    [access.job.id]
  );
  return NextResponse.json({
    job: { id: access.job.id, title: access.job.title, hasDescription: !!access.job.description?.trim() },
    current: latest ? { id: latest.id, version: latest.version, criteria: latest.criteria, created_at: latest.created_at } : null,
    defaults: DEFAULT_CRITERIA,
    rubric_version: RUBRIC_VERSION,
    versions: versions.rows,
  });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const body = await request.json().catch(() => null);
  const parsed = CriteriaSchema.safeParse(body?.criteria);
  if (!parsed.success) {
    return badRequest("Invalid screening criteria", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const saved = await createConfigVersion(pool, access.job.id, access.recruiterId, parsed.data);
  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "config_saved", entityType: "screening_config", entityId: saved.id, meta: { version: saved.version } });
  return NextResponse.json({ id: saved.id, version: saved.version, criteria: saved.criteria }, { status: 201 });
}
