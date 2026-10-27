import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import OpenAI from "openai";
import { sendInviteEmail } from "@/lib/invites/sendInviteEmail";
import { isEmailFormatValid } from "@/lib/screening/contact";
import { formatPersonName } from "@/lib/screening/name";
import { detectCvFile, extractCvText } from "@/lib/screening/parse";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_OWN_QUESTIONS = 8;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Candidate-specific questions typed on the Invites tab (JSON array of strings). */
function parseOwnQuestions(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter((q) => {
      const k = q.toLowerCase();
      if (q.length < 5 || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_OWN_QUESTIONS);
}

// POST → manual invite. Rule shared with CV screening invites: an interview is never created
// without questions — the job's common questions + this candidate's own questions (typed here,
// or generated from an uploaded CV in resume mode) must total at least 1.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobResult = await pool.query(
    `SELECT j.id, j.title, j.description, j.status, j.question_mode, r.company_name
     FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );
  if (!jobResult.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  const job = jobResult.rows[0];

  // Parse body — support both JSON and multipart/form-data (for CV upload)
  let candidate_name: string | null = null;
  let candidate_email: string | null = null;
  let resumeBuffer: Buffer | null = null;
  let ownQuestions: string[] = [];
  let questionOrder: string | null = null;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    candidate_name = fd.get("candidate_name") as string | null;
    candidate_email = fd.get("candidate_email") as string | null;
    ownQuestions = parseOwnQuestions(fd.get("questions"));
    questionOrder = fd.get("question_order") as string | null;
    const file = fd.get("resume");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const ab = await (file as File).arrayBuffer();
      resumeBuffer = Buffer.from(ab);
    }
  } else {
    const body = await request.json().catch(() => ({}));
    candidate_name = body.candidate_name ?? null;
    candidate_email = body.candidate_email ?? null;
    ownQuestions = parseOwnQuestions(body.questions);
    questionOrder = typeof body.question_order === "string" ? body.question_order : null;
  }

  const name = formatPersonName(candidate_name ?? "");
  const email = (candidate_email ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Candidate name is required" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "Candidate email is required" }, { status: 400 });
  }
  if (!isEmailFormatValid(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const common = await pool.query(
    `SELECT COUNT(*)::int AS n FROM questions WHERE job_id = $1 AND session_id IS NULL`,
    [job.id]
  );
  const commonCount: number = common.rows[0].n;
  const willGenerateFromCv = job.question_mode === "resume" && !!resumeBuffer;
  if (commonCount + ownQuestions.length === 0 && !willGenerateFromCv) {
    return NextResponse.json(
      {
        error: "This job has no interview questions yet. Add questions for this candidate below, or add common questions on the Interview questions tab.",
        code: "no_questions",
      },
      { status: 409 }
    );
  }

  const client = await pool.connect();
  let invite: { id: string; token: string; expires_at: string };
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query(
      `INSERT INTO interview_sessions (job_id, candidate_name, candidate_email, question_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, token, expires_at`,
      [job.id, name, email, questionOrder === "common_first" ? "common_first" : "own_first"]
    );
    invite = sessionResult.rows[0];
    // HR's own questions for this candidate: asked before the job's common questions.
    for (let i = 0; i < ownQuestions.length; i++) {
      await client.query(
        `INSERT INTO questions (job_id, session_id, text, category, difficulty, expected_hint, order_index, source)
         VALUES ($1, $2, $3, 'technical', 2, NULL, $4, 'custom')`,
        [job.id, invite.id, ownQuestions[i], i + 1]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[invites] create failed:", (err as { code?: string })?.code);
    return NextResponse.json({ error: "Could not create the invite" }, { status: 500 });
  } finally {
    client.release();
  }

  // Resume mode: generate personalised questions from the uploaded CV.
  let generated = 0;
  if (willGenerateFromCv && resumeBuffer) {
    try {
      const check = detectCvFile(resumeBuffer, MAX_RESUME_BYTES);
      if (!check.ok) throw new Error(check.code);
      const parsed = await extractCvText(resumeBuffer, check.mime);
      if (!parsed.ok) throw new Error(parsed.code);
      const resumeText = parsed.value.text.slice(0, 6000); // cap at 6k chars

      // Store resume text on the session
      await pool.query(
        `UPDATE interview_sessions SET resume_text = $1 WHERE id = $2`,
        [resumeText, invite.id]
      );

      // Generate 5 personalised questions
      const prompt = `You are an expert technical recruiter. A candidate has applied for the role: "${job.title}".

Job description:
${(job.description ?? "").slice(0, 1000)}

Candidate's CV/Resume:
${resumeText}

Generate exactly 5 interview questions that are SPECIFIC to this candidate's background. Target:
- Technologies/skills they listed
- Gaps or areas they haven't mentioned
- Specific projects or achievements in their CV
- Career progression and decision-making
- How their background fits this role

Respond with a JSON array of exactly 5 objects:
[{"text": "...", "category": "technical|behavioral|situational|culture", "difficulty": 1|2|3, "expected_hint": "..."}]

Do not include any explanation — only the JSON array.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a JSON API. Only output valid JSON." },
          { role: "user", content: prompt },
        ],
      });

      const raw = completion.choices[0].message.content ?? "{}";
      const parsed2 = JSON.parse(raw);
      const validCats = ["technical", "behavioral", "situational", "culture"];
      const questions: Array<{ text: string; category: string; difficulty: number; expected_hint?: string }> =
        (Array.isArray(parsed2) ? parsed2 : (parsed2.questions ?? [])).filter(
          (q: { text?: unknown }) => typeof q?.text === "string" && q.text.trim().length > 5
        );

      if (questions.length > 0) {
        const offset = ownQuestions.length;
        const values = questions.map((_, i) => `($1, $2, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6}, $${i * 5 + 7})`).join(", ");
        const flat: unknown[] = [job.id, invite.id];
        questions.forEach((q, i) => {
          flat.push(q.text.trim(), validCats.includes(q.category) ? q.category : "behavioral", Math.min(3, Math.max(1, q.difficulty ?? 1)), q.expected_hint ?? "", offset + i + 1);
        });
        await pool.query(
          `INSERT INTO questions (job_id, session_id, text, category, difficulty, expected_hint, order_index, source)
           SELECT j, s, t, c, d, h, o, 'resume'
           FROM (VALUES ${values}) AS v(j, s, t, c, d, h, o)`,
          flat
        );
        generated = questions.length;
      }
    } catch (err) {
      console.error("Resume question generation failed:", (err as Error)?.message);
    }

    // Never leave an interview with no questions: undo the invite before any email is sent.
    if (commonCount + ownQuestions.length + generated === 0) {
      await pool.query(`DELETE FROM interview_sessions WHERE id = $1 AND status = 'pending' AND started_at IS NULL`, [invite.id]);
      return NextResponse.json(
        { error: "Couldn't create questions from this CV. Add questions for this candidate below and send again.", code: "no_questions" },
        { status: 422 }
      );
    }
  }

  const { interviewUrl, emailSent, emailError } = await sendInviteEmail({
    token: invite.token,
    expiresAt: invite.expires_at,
    candidateName: name,
    candidateEmail: email,
    jobTitle: job.title,
    companyName: job.company_name,
  });

  if (!emailSent) {
    return NextResponse.json(
      { invite, interviewUrl, emailSent: false, emailError },
      { status: 207 }
    );
  }

  return NextResponse.json({ invite, interviewUrl, emailSent: true }, { status: 201 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ownerCheck = await pool.query(
    `SELECT j.id FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );
  if (!ownerCheck.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const result = await pool.query(
    `SELECT s.id, s.candidate_name, s.candidate_email, s.status, s.created_at, s.expires_at, s.token,
            s.started_at, (s.cv_document_id IS NOT NULL) AS from_screening,
            (SELECT COUNT(*)::int FROM questions q WHERE q.session_id = s.id) AS own_questions
     FROM interview_sessions s
     WHERE s.job_id = $1
     ORDER BY s.created_at DESC`,
    [params.id]
  );
  return NextResponse.json(result.rows);
}
