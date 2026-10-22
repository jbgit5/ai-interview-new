import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const result = await pool.query(
    `SELECT
       s.id,
       s.candidate_name,
       s.status,
       s.expires_at,
       s.resume_state,
       j.title AS job_title,
       r.company_name
     FROM interview_sessions s
     JOIN jobs j ON j.id = s.job_id
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE s.token = $1`,
    [params.token]
  );

  const row = result.rows[0];

  if (!row) {
    return NextResponse.json({ valid: false, reason: "not_found" }, { status: 404 });
  }

  if (row.status === "expired" || new Date(row.expires_at) < new Date()) {
    return NextResponse.json({ valid: false, reason: "expired" });
  }

  if (row.status === "completed") {
    return NextResponse.json({ valid: false, reason: "completed" });
  }

  return NextResponse.json({
    valid: true,
    session_id: row.id,
    status: row.status,
    candidate_name: row.candidate_name,
    job: {
      title: row.job_title,
      company: row.company_name || "the company",
    },
    expires_at: row.expires_at,
  });
}
