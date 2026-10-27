import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST → cancel an interview invite the candidate has NOT started yet. The link stops working
// immediately (status "expired", so candidate routes answer 410). Started or finished interviews
// can't be cancelled. Nothing is deleted.
export async function POST(request: NextRequest, { params }: { params: { id: string; sessionId: string } }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!UUID_RE.test(params.id) || !UUID_RE.test(params.sessionId)) return NextResponse.json({ error: "Invite not found" }, { status: 404 });

  const r = await pool.query(
    `UPDATE interview_sessions s
        SET status = 'expired', expires_at = LEAST(s.expires_at, now()), updated_at = now()
       FROM jobs j JOIN recruiters rc ON rc.id = j.recruiter_id
      WHERE s.id = $1 AND s.job_id = $2 AND j.id = s.job_id AND rc.better_auth_user_id = $3
        AND s.status = 'pending' AND s.started_at IS NULL
      RETURNING s.id`,
    [params.sessionId, params.id, session.user.id]
  );
  if (r.rowCount) return NextResponse.json({ ok: true });

  const exists = await pool.query(
    `SELECT s.status FROM interview_sessions s JOIN jobs j ON j.id = s.job_id JOIN recruiters rc ON rc.id = j.recruiter_id
      WHERE s.id = $1 AND s.job_id = $2 AND rc.better_auth_user_id = $3`,
    [params.sessionId, params.id, session.user.id]
  );
  if (!exists.rows[0]) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  return NextResponse.json({ error: "This interview has already started or ended, so it can't be cancelled." }, { status: 409 });
}
