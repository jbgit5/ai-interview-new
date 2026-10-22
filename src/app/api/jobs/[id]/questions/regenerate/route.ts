import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import OpenAI from "openai";
import { buildQuestionGenerationPrompt, type GeneratedQuestion } from "@/lib/prompts";

// POST /api/jobs/[id]/questions/regenerate
// Deletes all ai_generated questions for this job and regenerates from JD.
// Custom questions are preserved.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobResult = await pool.query(
    `SELECT j.id, j.title, j.description
       FROM jobs j
       JOIN recruiters r ON r.id = j.recruiter_id
      WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );

  if (!jobResult.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const job = jobResult.rows[0];

  if (!job.description?.trim()) {
    return NextResponse.json(
      { error: "Job description is required to generate questions" },
      { status: 400 }
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const aiRes = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: buildQuestionGenerationPrompt({
          jobTitle: job.title,
          jobDescription: job.description,
          count: 7,
        }),
      },
    ],
    temperature: 0.6,
    max_tokens: 1500,
  });

  const raw = aiRes.choices[0].message.content ?? "[]";
  const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
  let generated: GeneratedQuestion[];
  try {
    generated = JSON.parse(jsonStr);
  } catch {
    return NextResponse.json({ error: "AI returned invalid JSON" }, { status: 500 });
  }

  if (!Array.isArray(generated) || generated.length === 0) {
    return NextResponse.json({ error: "AI returned no questions" }, { status: 500 });
  }

  const validCategories = ["technical", "behavioral", "situational", "culture"];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Unlink transcript_turns references before deleting (preserve history, remove FK link)
    await client.query(
      `UPDATE transcript_turns SET question_id = NULL
         WHERE question_id IN (
           SELECT id FROM questions WHERE job_id = $1 AND source = 'ai_generated'
         )`,
      [params.id]
    );

    // Delete only AI-generated questions (preserve custom ones)
    await client.query(
      `DELETE FROM questions WHERE job_id = $1 AND source = 'ai_generated'`,
      [params.id]
    );

    // Get current max order_index so new questions append after custom ones
    const maxIdx = await client.query(
      `SELECT COALESCE(MAX(order_index), -1) AS max FROM questions WHERE job_id = $1`,
      [params.id]
    );
    let orderStart = (maxIdx.rows[0].max as number) + 1;

    for (const q of generated) {
      if (!q.text?.trim() || !validCategories.includes(q.category)) continue;
      const diff = [1, 2, 3].includes(q.difficulty) ? q.difficulty : 1;
      await client.query(
        `INSERT INTO questions (job_id, text, category, difficulty, expected_hint, order_index, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai_generated')`,
        [params.id, q.text.trim(), q.category, diff, q.expected_hint?.trim() || null, orderStart++]
      );
    }

    await client.query("COMMIT");

    const updated = await client.query(
      `SELECT * FROM questions WHERE job_id = $1 ORDER BY order_index, created_at`,
      [params.id]
    );

    return NextResponse.json(updated.rows);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[regenerate] Failed:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  } finally {
    client.release();
  }
}
