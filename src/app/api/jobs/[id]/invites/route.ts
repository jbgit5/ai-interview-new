import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { Resend } from "resend";
import { render } from "@react-email/components";
import { InviteEmail } from "@emails/InviteEmail";
import { format } from "date-fns";
import OpenAI from "openai";

const resend = new Resend(process.env.RESEND_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    candidate_name = fd.get("candidate_name") as string | null;
    candidate_email = fd.get("candidate_email") as string | null;
    const file = fd.get("resume") as File | null;
    if (file) {
      const ab = await file.arrayBuffer();
      resumeBuffer = Buffer.from(ab);
    }
  } else {
    const body = await request.json();
    candidate_name = body.candidate_name ?? null;
    candidate_email = body.candidate_email ?? null;
  }

  if (!candidate_name?.trim()) {
    return NextResponse.json({ error: "Candidate name is required" }, { status: 400 });
  }
  if (!candidate_email?.trim()) {
    return NextResponse.json({ error: "Candidate email is required" }, { status: 400 });
  }

  const sessionResult = await pool.query(
    `INSERT INTO interview_sessions (job_id, candidate_name, candidate_email)
     VALUES ($1, $2, $3)
     RETURNING id, token, expires_at`,
    [job.id, candidate_name.trim(), candidate_email.trim()]
  );
  const invite = sessionResult.rows[0];

  // If resume-based mode and a CV was uploaded, generate personalised questions
  if (job.question_mode === "resume" && resumeBuffer) {
    try {
      // Use require to get CJS version of pdf-parse
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const parsed = await pdfParse(resumeBuffer);
      const resumeText = parsed.text.slice(0, 6000); // cap at 6k chars

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
      const questions: Array<{ text: string; category: string; difficulty: number; expected_hint?: string }> =
        Array.isArray(parsed2) ? parsed2 : (parsed2.questions ?? []);

      if (questions.length > 0) {
        const values = questions.map((_, i) => `($1, $2, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6}, $${i * 5 + 7})`).join(", ");
        const flat: unknown[] = [job.id, invite.id];
        questions.forEach((q, i) => {
          flat.push(q.text ?? "", q.category ?? "behavioral", Math.min(3, Math.max(1, q.difficulty ?? 1)), q.expected_hint ?? "", i + 1);
        });
        await pool.query(
          `INSERT INTO questions (job_id, session_id, text, category, difficulty, expected_hint, order_index, source)
           SELECT j, s, t, c, d, h, o, 'resume'
           FROM (VALUES ${values}) AS v(j, s, t, c, d, h, o)`,
          flat
        );
      }
    } catch (err) {
      // Non-fatal — interview proceeds without personalised questions
      console.error("Resume question generation failed:", err);
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const interviewUrl = `${appUrl}/interview/${invite.token}`;
  const expiresAt = format(new Date(invite.expires_at), "MMMM d, yyyy");
  const companyName = job.company_name || "the company";

  const html = await render(
    InviteEmail({ candidateName: candidate_name.trim(), jobTitle: job.title, companyName, interviewUrl, expiresAt })
  );

  const { error: emailError } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
    to: candidate_email.trim(),
    subject: `Your interview invitation for ${job.title}`,
    html,
  });

  if (emailError) {
    console.error("Resend error:", emailError);
    return NextResponse.json(
      { invite, interviewUrl, emailSent: false, emailError: emailError.message },
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
    `SELECT id, candidate_name, candidate_email, status, created_at, expires_at, token
     FROM interview_sessions
     WHERE job_id = $1
     ORDER BY created_at DESC`,
    [params.id]
  );
  return NextResponse.json(result.rows);
}
