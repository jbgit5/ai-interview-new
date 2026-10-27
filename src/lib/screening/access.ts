import { NextResponse } from "next/server";
import type { Pool, PoolClient } from "pg";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { findRecruiterJob, type RecruiterJob } from "./service";

// Authorization for every CV-screening API route. Middleware only guards /dashboard pages, so
// each route handler calls requireRecruiterJob() first. The recruiter is derived from the
// better-auth session (never from client input) and must own the job. Child resources
// (batches, documents, screenings) are then always queried with `AND job_id = $job`, so an id
// from another recruiter's job simply isn't found (404, no existence leak).

export { UUID_RE } from "./service";
export type { RecruiterJob } from "./service";

export type AccessResult = ({ ok: true } & RecruiterJob) | { ok: false; response: NextResponse };

export const notFound = (what = "Not found") => NextResponse.json({ error: what }, { status: 404 });
export const badRequest = (error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status: 400 });

export async function requireRecruiterJob(request: Request, jobId: string): Promise<AccessResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const found = await findRecruiterJob(pool, session.user.id, jobId);
  if (!found) return { ok: false, response: notFound("Job not found") };
  return { ok: true, ...found };
}

export async function audit(
  db: Pool | PoolClient,
  e: { jobId: string; recruiterId: string; action: string; entityType: string; entityId: string | null; meta?: Record<string, unknown> }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO screening_audit_log (job_id, recruiter_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.jobId, e.recruiterId, e.action, e.entityType, e.entityId, JSON.stringify(e.meta ?? {})]
    );
  } catch (err) {
    // Audit failures are logged (ids only) but never break the user's action.
    console.error("[screening] audit insert failed", { action: e.action, entityId: e.entityId, code: (err as { code?: string })?.code });
  }
}
