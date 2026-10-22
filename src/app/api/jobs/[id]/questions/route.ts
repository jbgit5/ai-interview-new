import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

async function getOwnedJob(userId: string, jobId: string) {
  const result = await pool.query(
    `SELECT j.id FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [jobId, userId]
  );
  return result.rows[0] ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await getOwnedJob(session.user.id, params.id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const result = await pool.query(
    "SELECT * FROM questions WHERE job_id = $1 ORDER BY order_index, created_at",
    [params.id]
  );
  return NextResponse.json(result.rows);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await getOwnedJob(session.user.id, params.id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await request.json();
  const { text, category, difficulty = 1, expected_hint } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "Question text is required" }, { status: 400 });
  }

  const validCategories = ["technical", "behavioral", "situational", "culture"];
  if (!validCategories.includes(category)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  if (![1, 2, 3].includes(Number(difficulty))) {
    return NextResponse.json({ error: "Difficulty must be 1, 2, or 3" }, { status: 400 });
  }

  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM questions WHERE job_id = $1",
    [params.id]
  );
  const orderIndex = countResult.rows[0].cnt;

  const result = await pool.query(
    `INSERT INTO questions (job_id, text, category, difficulty, expected_hint, order_index, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'custom')
     RETURNING *`,
    [
      params.id,
      text.trim(),
      category,
      Number(difficulty),
      expected_hint?.trim() || null,
      orderIndex,
    ]
  );

  return NextResponse.json(result.rows[0], { status: 201 });
}
