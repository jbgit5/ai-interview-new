import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// GET /api/proctor/snapshot/[eventId] — the evidence image for one proctoring event.
// Recruiter-only, and only for interviews on the recruiter's own jobs.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: { eventId: string } }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!UUID_RE.test(params.eventId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const r = await pool.query(
    `SELECT pe.snapshot_path
       FROM proctoring_events pe
       JOIN interview_sessions s ON s.id = pe.session_id
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters rc ON rc.id = j.recruiter_id
      WHERE pe.id = $1 AND rc.better_auth_user_id = $2`,
    [params.eventId, session.user.id]
  );
  const rel: string | null = r.rows[0]?.snapshot_path ?? null;
  if (!rel) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Never serve anything outside recordings/ (defence in depth; paths are written by our own route).
  const base = path.resolve(process.cwd(), "recordings");
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep) || !file.endsWith(".jpg")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const buf = await readFile(file);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
