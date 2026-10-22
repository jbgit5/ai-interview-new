import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; qid: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership through the chain: question → job → recruiter → auth user
  const ownerCheck = await pool.query(
    `SELECT q.id FROM questions q
     JOIN jobs j ON j.id = q.job_id
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE q.id = $1 AND j.id = $2 AND r.better_auth_user_id = $3`,
    [params.qid, params.id, session.user.id]
  );

  if (!ownerCheck.rows[0]) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  await pool.query(
    "UPDATE transcript_turns SET question_id = NULL WHERE question_id = $1",
    [params.qid]
  );
  await pool.query(
    "UPDATE question_scores SET question_id = NULL WHERE question_id = $1",
    [params.qid]
  );
  await pool.query("DELETE FROM questions WHERE id = $1", [params.qid]);
  return NextResponse.json({ success: true });
}
