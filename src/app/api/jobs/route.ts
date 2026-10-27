import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import OpenAI from "openai";
import { buildQuestionGenerationPrompt, type GeneratedQuestion } from "@/lib/prompts";
import { CriteriaSchema } from "@/lib/screening/criteria";
import { createConfigVersion } from "@/lib/screening/service";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const recruiter = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );
  if (!recruiter.rows[0]) {
    return NextResponse.json({ error: "Recruiter not found" }, { status: 404 });
  }

  const result = await pool.query(
    `SELECT j.*,
            COUNT(DISTINCT q.id)::int AS question_count,
            COUNT(DISTINCT s.id)::int AS candidate_count
     FROM jobs j
     LEFT JOIN questions q ON q.job_id = j.id
     LEFT JOIN interview_sessions s ON s.job_id = j.id
     WHERE j.recruiter_id = $1
     GROUP BY j.id
     ORDER BY j.created_at DESC`,
    [recruiter.rows[0].id]
  );

  return NextResponse.json(result.rows);
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const recruiter = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );
  if (!recruiter.rows[0]) {
    return NextResponse.json({ error: "Recruiter not found" }, { status: 404 });
  }

  const body = await request.json();
  const {
    title,
    department,
    description,
    status = "draft",
    question_mode = "ai_only",
    allow_probes,
    criteria,
    generate_questions,
  } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const validStatuses = ["draft", "active", "closed"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const validModes = ["ai_only", "custom_only", "mixed", "resume"];
  if (!validModes.includes(question_mode)) {
    return NextResponse.json({ error: "Invalid question_mode" }, { status: 400 });
  }

  // Screening requirements reviewed on the create-job screen (optional). Saved as version 1.
  let parsedCriteria = null;
  if (criteria !== undefined && criteria !== null) {
    const parsed = CriteriaSchema.safeParse(criteria);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid requirements", issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
        { status: 400 }
      );
    }
    parsedCriteria = parsed.data;
  }
  // Questions are created later on the Interview questions tab. Legacy callers that don't send
  // generate_questions keep the old behaviour (auto-generate for ai_only/mixed).
  const shouldGenerate = typeof generate_questions === "boolean" ? generate_questions : true;

  // Default true if omitted — preserves legacy behavior (probes enabled).
  const allowProbes = typeof allow_probes === "boolean" ? allow_probes : true;

  const result = await pool.query(
    `INSERT INTO jobs (recruiter_id, title, department, description, status, question_mode, allow_probes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      recruiter.rows[0].id,
      title.trim(),
      department?.trim() || null,
      description?.trim() || null,
      status,
      question_mode,
      allowProbes,
    ]
  );

  const job = result.rows[0];

  if (parsedCriteria) {
    try {
      await createConfigVersion(pool, job.id, recruiter.rows[0].id, parsedCriteria);
    } catch (err) {
      // Non-fatal — requirements can be saved again from the Requirements tab.
      console.error("[jobs] saving screening requirements failed:", (err as { code?: string })?.code);
    }
  }

  // Auto-generate AI questions for ai_only and mixed modes only
  if (shouldGenerate && (question_mode === "ai_only" || question_mode === "mixed") && description?.trim()) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const aiRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: buildQuestionGenerationPrompt({
              jobTitle: title.trim(),
              jobDescription: description.trim(),
              count: 7,
            }),
          },
        ],
        temperature: 0.6,
        max_tokens: 1500,
      });

      const raw = aiRes.choices[0].message.content ?? "[]";
      // Strip markdown code fences if present
      const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
      const generated: GeneratedQuestion[] = JSON.parse(jsonStr);

      if (Array.isArray(generated) && generated.length > 0) {
        const validCategories = ["technical", "behavioral", "situational", "culture"];
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (let i = 0; i < generated.length; i++) {
            const q = generated[i];
            if (!q.text?.trim() || !validCategories.includes(q.category)) continue;
            const diff = [1, 2, 3].includes(q.difficulty) ? q.difficulty : 1;
            await client.query(
              `INSERT INTO questions (job_id, text, category, difficulty, expected_hint, order_index, source)
               VALUES ($1, $2, $3, $4, $5, $6, 'ai_generated')`,
              [job.id, q.text.trim(), q.category, diff, q.expected_hint?.trim() || null, i]
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          console.error("[jobs] Question generation insert failed:", err);
        } finally {
          client.release();
        }
      }
    } catch (err) {
      // Non-fatal — job was already created, questions can be added manually
      console.error("[jobs] AI question generation failed:", err);
    }
  }

  return NextResponse.json(job, { status: 201 });
}
