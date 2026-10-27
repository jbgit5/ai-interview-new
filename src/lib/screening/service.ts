import type { Pool, PoolClient } from "pg";
import type { LlmUsage } from "../llm/types";
import { CriteriaSchema, DEFAULT_CRITERIA, RUBRIC_VERSION, normalizeCriteria, type Criteria } from "./criteria";
import { splitPages } from "./citations";
import { findContacts, maskContacts, type ContactInfo } from "./contact";
import { resilientResolver, runContactChecks, type DnsLike } from "./contactChecks";
import type { CrossChecks } from "./hrChecklist";
import { formatPersonName } from "./name";
import { SIMILAR_THRESHOLD, signatureSimilarity, textSignature } from "./similarity";
import { CorrectionsSchema, type Corrections } from "./corrections";
import { evaluateScreening, type ScreeningEvaluation } from "./evaluate";
import { DOCX_MIME } from "./parse";
import { AssessmentSchema, parseStoredExtraction, type Assessment, type Extraction } from "./schemas";

// Database operations for CV screening. Every function that touches a child resource takes the
// jobId and filters on it — callers have already verified the recruiter owns that job.

type Db = Pool | PoolClient;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecruiterJob {
  recruiterId: string;
  job: { id: string; title: string; description: string | null; companyName: string | null };
}

/** Pure ownership lookup (also used by tests against a real DB). */
export async function findRecruiterJob(db: Pool | PoolClient, authUserId: string, jobId: string): Promise<RecruiterJob | null> {
  if (!UUID_RE.test(jobId)) return null;
  const r = await db.query(
    `SELECT j.id, j.title, j.description, r.id AS recruiter_id, r.company_name
       FROM jobs j
       JOIN recruiters r ON r.id = j.recruiter_id
      WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [jobId, authUserId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { recruiterId: row.recruiter_id, job: { id: row.id, title: row.title, description: row.description, companyName: row.company_name } };
}

export interface ConfigRow {
  id: string;
  version: number;
  criteria: Criteria;
  rubric_version: string;
  created_at: string;
}

export async function getLatestConfig(db: Db, jobId: string): Promise<ConfigRow | null> {
  const r = await db.query(
    `SELECT id, version, criteria, rubric_version, created_at
       FROM screening_configs WHERE job_id = $1 ORDER BY version DESC LIMIT 1`,
    [jobId]
  );
  return r.rows[0] ?? null;
}

export async function getConfig(db: Db, jobId: string, configId: string): Promise<ConfigRow | null> {
  const r = await db.query(
    `SELECT id, version, criteria, rubric_version, created_at FROM screening_configs WHERE id = $1 AND job_id = $2`,
    [configId, jobId]
  );
  return r.rows[0] ?? null;
}

/** Insert a new immutable version (serialised per job so versions never collide). */
export async function createConfigVersion(pool: Pool, jobId: string, recruiterId: string, criteria: Criteria): Promise<ConfigRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('screening_configs:' || $1))", [jobId]);
    const r = await client.query(
      `INSERT INTO screening_configs (job_id, version, criteria, rubric_version, created_by)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4 FROM screening_configs WHERE job_id = $1
       RETURNING id, version, criteria, rubric_version, created_at`,
      [jobId, JSON.stringify(normalizeCriteria(criteria)), RUBRIC_VERSION, recruiterId]
    );
    await client.query("COMMIT");
    return r.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function parseCriteria(raw: unknown): Criteria {
  const parsed = CriteriaSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CRITERIA;
}

export async function recordUsage(
  db: Db,
  e: { jobId: string | null; documentId: string | null; kind: "extraction" | "assessment" | "criteria_suggestion"; usage: LlmUsage; ok: boolean; errorCode?: string | null }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO screening_llm_usage (job_id, cv_document_id, kind, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, ok, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.jobId, e.documentId, e.kind, e.usage.model, e.usage.prompt_tokens, e.usage.completion_tokens, e.usage.cost_usd, e.usage.latency_ms, e.ok, e.errorCode ?? null]
    );
  } catch (err) {
    console.error("[screening] usage insert failed", { code: (err as { code?: string })?.code });
  }
}

export async function spentTodayUsd(db: Db): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd FROM screening_llm_usage WHERE created_at >= date_trunc('day', now())`
  );
  return Number(r.rows[0]?.usd ?? 0);
}

// ── Building the deterministic evaluation from stored rows ──

export interface DocRow {
  id: string;
  job_id: string;
  mime: string;
  extracted_text: string | null;
  page_offsets: number[] | null;
  text_truncated: boolean;
  extraction: unknown;
}

export interface DocContext {
  pages: string[];
  paged: boolean;
  maskedText: string;
  contacts: ContactInfo;
}

/** Masked page texts — exactly what the model sees, and what citations are verified against. */
export function buildDocContext(doc: Pick<DocRow, "mime" | "extracted_text" | "page_offsets">): DocContext {
  const text = doc.extracted_text ?? "";
  const contacts = findContacts(text);
  const pages = splitPages(text, doc.page_offsets ?? [0]).map((p) => maskContacts(p, contacts));
  return { pages, paged: doc.mime !== DOCX_MIME, maskedText: pages.join("\n\n"), contacts };
}

export function asOfFromDate(d: Date | string): { year: number; month: number } {
  if (typeof d === "string") return { year: parseInt(d.slice(0, 4), 10), month: parseInt(d.slice(5, 7), 10) };
  // node-pg returns DATE columns as a Date at LOCAL midnight, so read local fields (UTC would
  // shift the 1st of a month back to the previous month on servers east of UTC).
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function evaluateFromRows(args: {
  doc: DocRow;
  assessment: unknown;
  criteria: Criteria;
  corrections: unknown;
  asOfDate: Date | string;
}): ScreeningEvaluation | null {
  // Accepts extractions from older prompt versions (new fields come back as "not read").
  const ex = parseStoredExtraction(args.doc.extraction);
  const as = AssessmentSchema.safeParse(args.assessment);
  if (!ex.ok || !as.success) return null;
  const corr = CorrectionsSchema.safeParse(args.corrections ?? {});
  const ctx = buildDocContext(args.doc);
  return evaluateScreening({
    extraction: ex.extraction as Extraction,
    assessment: as.data as Assessment,
    criteria: args.criteria,
    pages: ctx.pages,
    paged: ctx.paged,
    contacts: ctx.contacts,
    asOf: asOfFromDate(args.asOfDate),
    corrections: corr.success ? (corr.data as Corrections) : {},
    textTruncated: args.doc.text_truncated,
  });
}

/** Persist a (re-)evaluation onto a screening row. */
export async function saveEvaluation(db: Db, screeningId: string, jobId: string, ev: ScreeningEvaluation): Promise<void> {
  const { timeline, ...rest } = ev;
  await db.query(
    `UPDATE cv_screenings
        SET timeline = $3, result = $4, job_fit_score = $5, evidence_completeness = $6,
            eligibility_status = $7, fit_category = $8, updated_at = now()
      WHERE id = $1 AND job_id = $2`,
    [
      screeningId, jobId, JSON.stringify(timeline), JSON.stringify(rest),
      ev.summary.job_fit_score, ev.summary.evidence_completeness, ev.summary.eligibility_status, ev.summary.fit_category,
    ]
  );
}

/** Recompute a completed screening after HR corrections. No LLM call. */
export async function reevaluateScreening(db: Db, jobId: string, screeningId: string): Promise<ScreeningEvaluation | null> {
  const r = await db.query(
    `SELECT s.id, s.assessment, s.corrections, s.as_of_date, s.status,
            c.criteria,
            d.id AS doc_id, d.job_id, d.mime, d.extracted_text, d.page_offsets, d.text_truncated, d.extraction
       FROM cv_screenings s
       JOIN cv_documents d ON d.id = s.cv_document_id AND d.job_id = s.job_id
       JOIN screening_configs c ON c.id = s.config_id
      WHERE s.id = $1 AND s.job_id = $2`,
    [screeningId, jobId]
  );
  const row = r.rows[0];
  if (!row || row.status !== "completed") return null;
  const ev = evaluateFromRows({
    doc: { id: row.doc_id, job_id: row.job_id, mime: row.mime, extracted_text: row.extracted_text, page_offsets: row.page_offsets, text_truncated: row.text_truncated, extraction: row.extraction },
    assessment: row.assessment,
    criteria: parseCriteria(row.criteria),
    corrections: row.corrections,
    asOfDate: row.as_of_date,
  });
  if (ev) await saveEvaluation(db, screeningId, jobId, ev);
  return ev;
}

export interface ResultListRow {
  document_id: string;
  original_filename: string;
  uploaded_at: string;
  candidate_name: string | null;
  screening_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  error_code: string | null;
  job_fit_score: number | null;
  evidence_completeness: number | null;
  eligibility_status: string | null;
  fit_category: string | null;
  config_version: number;
  decision: string | null;
  decided_at: string | null;
  session_id: string | null;
  session_status: string | null;
  gap_count: number;
  review_count: number;
  must_open: number;
}

/** One row per CV: its screening against the newest config version it has been screened with. */
export async function listResults(db: Db, jobId: string): Promise<ResultListRow[]> {
  const r = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.id)
              d.id AS document_id, d.original_filename, d.created_at AS uploaded_at,
              COALESCE(NULLIF(s.corrections->'candidate'->>'name', ''), s.result->'candidate'->>'name', d.extraction->'candidate'->>'name') AS candidate_name,
              s.id AS screening_id, s.status, s.error_code, s.job_fit_score,
              s.evidence_completeness::float AS evidence_completeness, s.eligibility_status, s.fit_category,
              c.version AS config_version,
              dec.decision, dec.created_at AS decided_at,
              sess.id AS session_id, sess.status AS session_status,
              -- Attention counts for the list (facts HR shouldn't miss; never part of the score).
              CASE WHEN jsonb_typeof(s.timeline->'gaps') = 'array' THEN jsonb_array_length(s.timeline->'gaps') ELSE 0 END AS gap_count,
              (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'checklist') = 'array' THEN s.result->'checklist' ELSE '[]'::jsonb END) e
                WHERE e->>'severity' = 'review') AS review_count,
              (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'criteria') = 'array' THEN s.result->'criteria' ELSE '[]'::jsonb END) e
                WHERE (e->>'hard')::boolean AND e->>'hard_status' <> 'met') AS must_open
         FROM cv_documents d
         JOIN cv_screenings s ON s.cv_document_id = d.id AND s.job_id = d.job_id
         JOIN screening_configs c ON c.id = s.config_id
         LEFT JOIN LATERAL (
           SELECT sd.decision, sd.created_at
             FROM screening_decisions sd JOIN cv_screenings s2 ON s2.id = sd.screening_id
            WHERE s2.cv_document_id = d.id AND sd.job_id = d.job_id
            ORDER BY sd.created_at DESC LIMIT 1) dec ON true
         LEFT JOIN LATERAL (
           SELECT i.id, i.status FROM interview_sessions i
            WHERE i.cv_document_id = d.id AND i.job_id = d.job_id AND i.status <> 'expired'
            ORDER BY i.created_at DESC LIMIT 1) sess ON true
        WHERE d.job_id = $1
        ORDER BY d.id, c.version DESC
     ) x
     ORDER BY uploaded_at DESC`,
    [jobId]
  );
  return r.rows;
}

/** Latest HR decision for a document (across all its screenings). */
export async function latestDecision(db: Db, jobId: string, documentId: string): Promise<{ decision: string; rationale: string | null } | null> {
  const r = await db.query(
    `SELECT sd.decision, sd.rationale
       FROM screening_decisions sd JOIN cv_screenings s ON s.id = sd.screening_id
      WHERE s.cv_document_id = $1 AND sd.job_id = $2
      ORDER BY sd.created_at DESC LIMIT 1`,
    [documentId, jobId]
  );
  return r.rows[0] ?? null;
}

// ── Cached per-CV checks (email domain, text fingerprint) and cross-CV comparisons ──

/** Compute and cache the email-domain check and the text fingerprint for one CV, if missing. */
export async function ensureDocChecks(db: Db, jobId: string, documentId: string, dns?: DnsLike): Promise<void> {
  const r = await db.query(
    `SELECT extracted_text, contact_checks IS NULL AS need_contact, text_signature IS NULL AS need_sig
       FROM cv_documents WHERE id = $1 AND job_id = $2`,
    [documentId, jobId]
  );
  const row = r.rows[0];
  if (!row?.extracted_text || (!row.need_contact && !row.need_sig)) return;
  if (row.need_sig) {
    await db.query(`UPDATE cv_documents SET text_signature = $3 WHERE id = $1 AND job_id = $2`, [documentId, jobId, textSignature(row.extracted_text)]);
  }
  if (row.need_contact) {
    const emails = findContacts(row.extracted_text).emails.filter((e) => e.format_valid).map((e) => e.value);
    const resolver = dns ?? resilientResolver((await import("node:dns")).promises);
    const checks = await runContactChecks(emails, resolver);
    await db.query(`UPDATE cv_documents SET contact_checks = $3 WHERE id = $1 AND job_id = $2`, [documentId, jobId, JSON.stringify(checks)]);
  }
}

const digitsOnly = (s: string) => s.replace(/\D/g, "").slice(-10);

/** Other CVs in the same job with the same email/phone, or largely identical text. */
export async function loadCrossChecks(db: Db, jobId: string, documentId: string): Promise<CrossChecks> {
  const r = await db.query(
    `SELECT d.id, d.original_filename, d.text_signature, d.extracted_text IS NOT NULL AS has_text,
            ls.id AS screening_id,
            COALESCE(NULLIF(ls.corrections->'candidate'->>'name', ''), ls.result->'candidate'->>'name', d.original_filename) AS name,
            ls.result->'candidate'->'emails' AS emails, ls.result->'candidate'->'phones' AS phones
       FROM cv_documents d
       LEFT JOIN LATERAL (SELECT s.id, s.result, s.corrections FROM cv_screenings s
                           WHERE s.cv_document_id = d.id ORDER BY s.created_at DESC LIMIT 1) ls ON true
      WHERE d.job_id = $1
      LIMIT 500`,
    [jobId]
  );
  // Fingerprints for CVs screened before migration 022 (computed once, then cached).
  for (const row of r.rows) {
    if (row.text_signature == null && row.has_text) {
      const t = await db.query(`SELECT extracted_text FROM cv_documents WHERE id = $1`, [row.id]);
      row.text_signature = textSignature(t.rows[0]?.extracted_text ?? "");
      await db.query(`UPDATE cv_documents SET text_signature = $2 WHERE id = $1`, [row.id, row.text_signature]);
    }
  }
  const me = r.rows.find((x) => x.id === documentId);
  if (!me) return { same_contact: [], similar_text: [] };
  const vals = (j: unknown) => (Array.isArray(j) ? (j as { value: string }[]).map((x) => x.value) : []);
  const myEmails = new Set(vals(me.emails).map((e) => e.toLowerCase()));
  const myPhones = new Set(vals(me.phones).map(digitsOnly).filter((p) => p.length >= 8));

  const same_contact: CrossChecks["same_contact"] = [];
  const similar_text: CrossChecks["similar_text"] = [];
  for (const o of r.rows) {
    if (o.id === documentId) continue;
    const name = formatPersonName(o.name || o.original_filename);
    if (vals(o.emails).some((e) => myEmails.has(e.toLowerCase()))) same_contact.push({ name, screening_id: o.screening_id, via: "email" });
    else if (vals(o.phones).map(digitsOnly).some((p) => myPhones.has(p))) same_contact.push({ name, screening_id: o.screening_id, via: "phone" });
    const sim = signatureSimilarity(me.text_signature, o.text_signature);
    if (sim >= SIMILAR_THRESHOLD) similar_text.push({ name, screening_id: o.screening_id, similarity: sim });
  }
  similar_text.sort((a, b) => b.similarity - a.similarity);
  return { same_contact, similar_text: similar_text.slice(0, 5) };
}
