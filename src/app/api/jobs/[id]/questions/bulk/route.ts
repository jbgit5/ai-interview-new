import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// POST /api/jobs/[id]/questions/bulk
// Body: { questions: Array<{ text, category, difficulty, expected_hint? }> }
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobResult = await pool.query(
    `SELECT j.id FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );
  if (!jobResult.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await request.json();
  const rows: Array<{ text: string; category: string; difficulty: number; expected_hint?: string }> =
    body.questions ?? [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No questions provided" }, { status: 400 });
  }

  const validCategories = ["technical", "behavioral", "situational", "culture"];
  const valid = rows.filter(
    (q) => q.text?.trim() && validCategories.includes(q.category)
  );

  if (valid.length === 0) {
    return NextResponse.json({ error: "No valid questions found" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const maxIdxResult = await client.query(
      `SELECT COALESCE(MAX(order_index), -1) AS max FROM questions WHERE job_id = $1`,
      [params.id]
    );
    let orderStart = (maxIdxResult.rows[0].max as number) + 1;

    const inserted = [];
    for (const q of valid) {
      const diff = [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 1;
      const res = await client.query(
        `INSERT INTO questions (job_id, text, category, difficulty, expected_hint, order_index, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'custom')
         RETURNING *`,
        [params.id, q.text.trim(), q.category, diff, q.expected_hint?.trim() || null, orderStart++]
      );
      inserted.push(res.rows[0]);
    }

    await client.query("COMMIT");
    return NextResponse.json(inserted, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[bulk] Failed:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  } finally {
    client.release();
  }
}
