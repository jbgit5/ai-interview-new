import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// ─── GET /api/analysis/[sessionId] ────────────────────────────────────────────
// Returns full report data: session, analysis, transcript, scores, proctoring.
// Only accessible by the recruiter who owns the job.
export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { sessionId } = params;
  const client = await pool.connect();
  try {
    // Validate ownership
    const sessionRow = await client.query(
      `SELECT
         s.id, s.candidate_name, s.candidate_email, s.status,
         s.started_at, s.completed_at, s.integrity_score, s.created_at,
         j.id AS job_id, j.title AS job_title,
         r.company_name,
         a.overall_score, a.recommendation, a.ai_summary,
         a.competency_scores, a.strengths, a.concerns,
         a.created_at AS analyzed_at
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
       LEFT JOIN analysis_results a ON a.session_id = s.id
       WHERE s.id = $1 AND r.better_auth_user_id = $2`,
      [sessionId, session.user.id]
    );

    if (sessionRow.rows.length === 0) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const row = sessionRow.rows[0];

    const [turnsResult, scoresResult, proctoringResult] = await Promise.all([
      client.query(
        `SELECT turn_index, role, content, question_id, timestamp_ms
           FROM transcript_turns
          WHERE session_id = $1
          ORDER BY turn_index, CASE WHEN role = 'interviewer' THEN 0 ELSE 1 END`,
        [sessionId]
      ),
      client.query(
        `SELECT qs.turn_index, qs.score, qs.reasoning, qs.competencies,
                q.text AS question_text
           FROM question_scores qs
           LEFT JOIN questions q ON q.id = qs.question_id
          WHERE qs.session_id = $1
          ORDER BY qs.turn_index`,
        [sessionId]
      ),
      client.query(
        `SELECT event_type, timestamp_ms, severity, metadata
           FROM proctoring_events
          WHERE session_id = $1
          ORDER BY timestamp_ms`,
        [sessionId]
      ),
    ]);

    return Response.json({
      session: {
        id: row.id,
        candidate_name: row.candidate_name,
        candidate_email: row.candidate_email,
        status: row.status,
        started_at: row.started_at,
        completed_at: row.completed_at,
        integrity_score: row.integrity_score,
        created_at: row.created_at,
        job_id: row.job_id,
        job_title: row.job_title,
        company_name: row.company_name,
      },
      analysis:
        row.overall_score !== null
          ? {
              overall_score: row.overall_score,
              recommendation: row.recommendation,
              ai_summary: row.ai_summary,
              competency_scores: row.competency_scores ?? {},
              strengths: row.strengths ?? [],
              concerns: row.concerns ?? [],
              analyzed_at: row.analyzed_at,
            }
          : null,
      turns: turnsResult.rows,
      question_scores: scoresResult.rows,
      proctoring_events: proctoringResult.rows,
    });
  } finally {
    client.release();
  }
}

// ─── PATCH /api/analysis/[sessionId] ──────────────────────────────────────────
// Update session status — shortlist or reject.
// Body: { status: "shortlisted" | "rejected" }
export async function PATCH(
  req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { sessionId } = params;
  const body = await req.json().catch(() => ({}));
  const newStatus: string = body.status;

  if (!["shortlisted", "rejected", "completed"].includes(newStatus)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE interview_sessions s
          SET status = $1, updated_at = now()
         FROM jobs j
         JOIN recruiters r ON r.id = j.recruiter_id
        WHERE s.id = $2
          AND s.job_id = j.id
          AND r.better_auth_user_id = $3
        RETURNING s.id`,
      [newStatus, sessionId, session.user.id]
    );

    if (result.rows.length === 0) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({ success: true, status: newStatus });
  } finally {
    client.release();
  }
}
