import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { isEmailFormatValid } from "./contact";
import { formatPersonName } from "./name";

// The interview plan for a screened candidate = the job's COMMON questions (same for everyone,
// optional) + this candidate's OWN questions (CV-based suggestions HR kept/edited, plus HR's
// own). Rule enforced on every invite path: common + own ≥ 1 — an interview is never sent
// without questions. HR confirms the full list before sending; after sending it is fixed.

export const MAX_CANDIDATE_QUESTIONS = 8;
export const MAX_SUGGESTED_DEFAULT = 4;

export const PlanQuestionSchema = z.object({
  text: z.string().trim().min(5, "Each question needs at least a few words").max(500),
  source: z.enum(["cv", "hr"]),
});
export const PlanQuestionsSchema = z.array(PlanQuestionSchema).max(MAX_CANDIDATE_QUESTIONS, `At most ${MAX_CANDIDATE_QUESTIONS} questions per candidate`);
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

type Db = Pool | PoolClient;

/** Trim, drop blanks and exact duplicates (case-insensitive), keep order. */
export function cleanPlanQuestions(list: PlanQuestion[]): PlanQuestion[] {
  const seen = new Set<string>();
  const out: PlanQuestion[] = [];
  for (const q of list) {
    const text = q.text.replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (text.length < 5 || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, source: q.source });
  }
  return out.slice(0, MAX_CANDIDATE_QUESTIONS);
}

/** Starting point before HR has edited anything: the screening's suggested questions. */
export function defaultCandidateQuestions(suggestions: unknown): PlanQuestion[] {
  if (!Array.isArray(suggestions)) return [];
  return cleanPlanQuestions(
    suggestions
      .filter((s): s is string => typeof s === "string")
      .slice(0, MAX_SUGGESTED_DEFAULT)
      .map((text) => ({ text, source: "cv" as const }))
  );
}

export function planTotal(commonCount: number, candidateCount: number): number {
  return commonCount + candidateCount;
}

export async function loadCommonQuestions(db: Db, jobId: string): Promise<{ id: string; text: string }[]> {
  const r = await db.query(
    `SELECT id, text FROM questions WHERE job_id = $1 AND session_id IS NULL ORDER BY order_index, created_at`,
    [jobId]
  );
  return r.rows;
}

export interface CandidatePlan {
  screening_id: string;
  document_id: string;
  name: string;
  email: string;
  decision: string | null;
  /** Active (not cancelled/expired) interview for this CV, if any. */
  session: { id: string; status: string } | null;
  questions: PlanQuestion[];
  /** The screening's suggested questions, so HR can add back ones they removed. */
  suggestions: string[];
  prepared: boolean;
}

export async function loadCandidatePlans(db: Db, jobId: string, screeningIds: string[]): Promise<CandidatePlan[]> {
  if (!screeningIds.length) return [];
  const r = await db.query(
    `SELECT s.id AS screening_id, d.id AS document_id, d.original_filename,
            COALESCE(NULLIF(s.corrections->'candidate'->>'name', ''), s.result->'candidate'->>'name', d.extraction->'candidate'->>'name') AS name,
            s.result->'candidate'->'emails' AS emails,
            s.result->'follow_up_questions' AS suggestions,
            d.interview_questions,
            (SELECT sd.decision FROM screening_decisions sd JOIN cv_screenings s2 ON s2.id = sd.screening_id
              WHERE s2.cv_document_id = d.id AND sd.job_id = d.job_id ORDER BY sd.created_at DESC LIMIT 1) AS decision,
            (SELECT json_build_object('id', i.id, 'status', i.status) FROM interview_sessions i
              WHERE i.cv_document_id = d.id AND i.job_id = d.job_id AND i.status <> 'expired'
              ORDER BY i.created_at DESC LIMIT 1) AS session
       FROM cv_screenings s
       JOIN cv_documents d ON d.id = s.cv_document_id AND d.job_id = s.job_id
      WHERE s.job_id = $1 AND s.id = ANY($2::uuid[])`,
    [jobId, screeningIds]
  );
  const byId = new Map(r.rows.map((row) => [row.screening_id as string, row]));
  return screeningIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((row) => {
      const emails = Array.isArray(row.emails) ? (row.emails as { value: string; format_valid: boolean }[]) : [];
      const saved = PlanQuestionsSchema.safeParse(row.interview_questions);
      const suggestions = Array.isArray(row.suggestions) ? (row.suggestions as unknown[]).filter((s): s is string => typeof s === "string") : [];
      return {
        screening_id: row.screening_id,
        document_id: row.document_id,
        name: formatPersonName(row.name || ""),
        email: emails.find((e) => e.format_valid)?.value ?? "",
        decision: row.decision,
        session: row.session,
        questions: row.interview_questions != null && saved.success ? saved.data : defaultCandidateQuestions(suggestions),
        suggestions,
        prepared: row.interview_questions != null,
      };
    });
}

export async function saveCandidateQuestions(db: Db, jobId: string, documentId: string, questions: PlanQuestion[]): Promise<boolean> {
  const r = await db.query(
    `UPDATE cv_documents SET interview_questions = $3, updated_at = now() WHERE id = $1 AND job_id = $2`,
    [documentId, jobId, JSON.stringify(cleanPlanQuestions(questions))]
  );
  return (r.rowCount ?? 0) > 0;
}

// ── Creating the interview ──

export interface InviteEmailSender {
  (opts: { token: string; expiresAt: string | Date; candidateName: string; candidateEmail: string; jobTitle: string; companyName: string | null }): Promise<{
    interviewUrl: string;
    emailSent: boolean;
    emailError?: string;
  }>;
}

export interface ScreeningInviteArgs {
  job: { id: string; title: string; companyName: string | null };
  recruiterId: string;
  screeningId: string;
  candidateName: string;
  candidateEmail: string;
  questions: PlanQuestion[];
  /** Ask the candidate's own questions before (default) or after the job's common questions. */
  questionOrder?: QuestionOrder;
}

export const QUESTION_ORDERS = ["own_first", "common_first"] as const;
export type QuestionOrder = (typeof QUESTION_ORDERS)[number];

export type ScreeningInviteResult =
  | { ok: true; existing: boolean; session_id: string; interviewUrl?: string; emailSent?: boolean; emailError?: string; question_count?: number }
  | { ok: false; status: number; code: string; error: string };

const fail = (status: number, code: string, error: string): ScreeningInviteResult => ({ ok: false, status, code, error });

/**
 * One shortlisted ("ready for interview") candidate → one interview. Used by the single and the
 * bulk invite routes so the rules can't drift apart:
 *  - the latest HR decision must be "shortlisted";
 *  - name/email are validated (name formatted, it is read aloud by the interviewer);
 *  - common + candidate questions must be ≥ 1;
 *  - idempotent per CV: an active interview is returned, never duplicated.
 * The confirmed candidate questions are stored on the session (asked before the common ones)
 * and also saved back as the CV's prepared questions.
 */
export async function createScreeningInvite(pool: Pool, args: ScreeningInviteArgs, sendEmail: InviteEmailSender): Promise<ScreeningInviteResult> {
  const name = formatPersonName(args.candidateName);
  const email = args.candidateEmail.trim();
  if (!name) return fail(400, "name_required", "Candidate name is required.");
  if (!isEmailFormatValid(email)) return fail(400, "email_invalid", "Enter a valid email address.");
  const parsed = PlanQuestionsSchema.safeParse(args.questions);
  if (!parsed.success) return fail(400, "questions_invalid", parsed.error.issues[0]?.message ?? "Invalid questions");
  const own = cleanPlanQuestions(parsed.data);

  const s = await pool.query(`SELECT cv_document_id FROM cv_screenings WHERE id = $1 AND job_id = $2`, [args.screeningId, args.job.id]);
  if (!s.rows[0]) return fail(404, "not_found", "Screening not found.");
  const documentId: string = s.rows[0].cv_document_id;

  const decision = await pool.query(
    `SELECT sd.decision FROM screening_decisions sd JOIN cv_screenings s ON s.id = sd.screening_id
      WHERE s.cv_document_id = $1 AND sd.job_id = $2 ORDER BY sd.created_at DESC LIMIT 1`,
    [documentId, args.job.id]
  );
  if (decision.rows[0]?.decision !== "shortlisted") return fail(409, "not_ready", "Mark this candidate as Ready for interview first.");

  const common = await loadCommonQuestions(pool, args.job.id);
  if (planTotal(common.length, own.length) === 0) {
    return fail(409, "no_questions", "This interview would have no questions. Add questions for this candidate, or add common questions on the Interview questions tab.");
  }

  const client = await pool.connect();
  let invite: { id: string; token: string; expires_at: string };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cv_invite:' || $1))", [documentId]);
    const existing = await client.query(
      `SELECT id FROM interview_sessions WHERE cv_document_id = $1 AND job_id = $2 AND status <> 'expired' ORDER BY created_at DESC LIMIT 1`,
      [documentId, args.job.id]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { ok: true, existing: true, session_id: existing.rows[0].id };
    }
    const ins = await client.query(
      `INSERT INTO interview_sessions (job_id, candidate_name, candidate_email, cv_document_id, question_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, token, expires_at`,
      [args.job.id, name, email, documentId, args.questionOrder === "common_first" ? "common_first" : "own_first"]
    );
    invite = ins.rows[0];
    for (let i = 0; i < own.length; i++) {
      await client.query(
        `INSERT INTO questions (job_id, session_id, text, category, difficulty, expected_hint, order_index, source)
         VALUES ($1, $2, $3, 'technical', 2, NULL, $4, $5)`,
        [args.job.id, invite.id, own[i].text, i + 1, own[i].source === "cv" ? "resume" : "custom"]
      );
    }
    await client.query(`UPDATE cv_documents SET interview_questions = $3, updated_at = now() WHERE id = $1 AND job_id = $2`, [documentId, args.job.id, JSON.stringify(own)]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[screening] invite failed", { screeningId: args.screeningId, code: (err as { code?: string })?.code });
    return fail(500, "internal_error", "Could not create the interview invite.");
  } finally {
    client.release();
  }

  const mail = await sendEmail({ token: invite.token, expiresAt: invite.expires_at, candidateName: name, candidateEmail: email, jobTitle: args.job.title, companyName: args.job.companyName });
  await pool
    .query(
      `INSERT INTO screening_audit_log (job_id, recruiter_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'invite', 'cv_document', $3, $4)`,
      [args.job.id, args.recruiterId, documentId, JSON.stringify({ session_id: invite.id, email_sent: mail.emailSent, common: common.length, own: own.length })]
    )
    .catch(() => {});
  return { ok: true, existing: false, session_id: invite.id, interviewUrl: mail.interviewUrl, emailSent: mail.emailSent, emailError: mail.emailError, question_count: common.length + own.length };
}
