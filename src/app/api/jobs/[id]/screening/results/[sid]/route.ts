import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, badRequest, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { CorrectionsSchema, applyCorrections, mergeCorrections } from "@/lib/screening/corrections";
import { buildHrChecklist } from "@/lib/screening/hrChecklist";
import { CV_ERROR_MESSAGES, DOCX_MIME } from "@/lib/screening/parse";
import { parseStoredExtraction } from "@/lib/screening/schemas";
import { ensureDocChecks, getLatestConfig, loadCrossChecks, reevaluateScreening } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET   → full screening report (evaluation, timeline, extraction, decisions, audit trail)
// PATCH → HR corrections to the extraction / criterion classifications; re-scored without AI
export async function GET(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  // Re-derive completed results from stored data (no AI cost) so fixes to deterministic steps,
  // such as the candidate name, apply to earlier screenings too.
  await reevaluateScreening(pool, access.job.id, params.sid).catch((err) =>
    console.error("[screening] re-evaluation on view failed", { code: (err as { code?: string })?.code })
  );

  // Free per-CV checks (email domain, text fingerprint) for CVs screened before they existed.
  const docOf = await pool.query(`SELECT cv_document_id FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  if (docOf.rows[0]) {
    await ensureDocChecks(pool, access.job.id, docOf.rows[0].cv_document_id).catch((err) =>
      console.error("[screening] doc checks failed", { code: (err as { code?: string })?.code })
    );
  }

  const r = await pool.query(
    `SELECT s.id, s.status, s.error_code, s.attempts, s.as_of_date, s.timeline, s.result, s.corrections,
            s.job_fit_score, s.evidence_completeness::float AS evidence_completeness, s.eligibility_status, s.fit_category,
            s.model, s.prompt_version, s.rubric_version, s.created_at, s.completed_at,
            c.id AS config_id, c.version AS config_version, c.criteria,
            d.id AS document_id, d.original_filename, d.mime, d.size_bytes, d.page_count, d.created_at AS uploaded_at,
            d.extraction_status, d.text_truncated, d.extraction, d.contact_checks,
            CASE WHEN d.mime = $3 THEN d.extracted_text ELSE NULL END AS docx_text
       FROM cv_screenings s
       JOIN cv_documents d ON d.id = s.cv_document_id AND d.job_id = s.job_id
       JOIN screening_configs c ON c.id = s.config_id
      WHERE s.id = $1 AND s.job_id = $2`,
    [params.sid, access.job.id, DOCX_MIME]
  );
  const row = r.rows[0];
  if (!row) return notFound("Screening not found");

  const [decisions, auditRows, session, others, latest] = await Promise.all([
    pool.query(
      `SELECT sd.id, sd.decision, sd.rationale, sd.created_at, rc.name AS recruiter_name, c.version AS config_version
         FROM screening_decisions sd
         JOIN cv_screenings s ON s.id = sd.screening_id
         JOIN screening_configs c ON c.id = s.config_id
         LEFT JOIN recruiters rc ON rc.id = sd.recruiter_id
        WHERE s.cv_document_id = $1 AND sd.job_id = $2
        ORDER BY sd.created_at DESC`,
      [row.document_id, access.job.id]
    ),
    pool.query(
      `SELECT a.action, a.created_at, a.meta, rc.name AS recruiter_name
         FROM screening_audit_log a LEFT JOIN recruiters rc ON rc.id = a.recruiter_id
        WHERE a.job_id = $1 AND (a.entity_id = $2 OR a.entity_id = $3)
        ORDER BY a.created_at DESC LIMIT 50`,
      [access.job.id, row.document_id, row.id]
    ),
    pool.query(
      `SELECT id, status, created_at, started_at FROM interview_sessions
        WHERE cv_document_id = $1 AND job_id = $2 AND status <> 'expired' ORDER BY created_at DESC LIMIT 1`,
      [row.document_id, access.job.id]
    ),
    pool.query(
      `SELECT s.id, s.status, c.version AS config_version FROM cv_screenings s JOIN screening_configs c ON c.id = s.config_id
        WHERE s.cv_document_id = $1 AND s.job_id = $2 ORDER BY c.version DESC`,
      [row.document_id, access.job.id]
    ),
    getLatestConfig(pool, access.job.id),
  ]);

  // The HR team's 13-point checklist, answered from the screening data (no AI call).
  const cross = await loadCrossChecks(pool, access.job.id, row.document_id).catch(() => ({ same_contact: [], similar_text: [] }));
  let hrChecklist = null;
  let extractionCurrent = false;
  if (row.status === "completed" && row.result && row.timeline) {
    const ex = parseStoredExtraction(row.extraction);
    const corr = CorrectionsSchema.safeParse(row.corrections ?? {});
    hrChecklist = buildHrChecklist({
      ev: row.result,
      timeline: row.timeline,
      extraction: ex.ok ? applyCorrections(ex.extraction, corr.success ? corr.data : {}) : null,
      extractionCurrent: ex.ok && ex.upgraded,
      contactChecks: row.contact_checks,
      cross,
    });
    extractionCurrent = ex.ok && ex.upgraded;
  }

  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "view_report", entityType: "cv_screening", entityId: row.id });
  const { docx_text, ...rest } = row;
  return NextResponse.json({
    ...rest,
    error_message: row.error_code ? CV_ERROR_MESSAGES[row.error_code] ?? CV_ERROR_MESSAGES.internal_error : null,
    docx_text,
    job: { id: access.job.id, title: access.job.title },
    current_config_version: latest?.version ?? null,
    other_screenings: others.rows,
    decisions: decisions.rows,
    audit: auditRows.rows,
    session: session.rows[0] ?? null,
    hr_checklist: hrChecklist,
    cross_checks: cross,
    /** false = read with an older prompt version; the newer checks need a refresh (re-read). */
    extraction_current: extractionCurrent,
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  const body = await request.json().catch(() => null);
  const parsed = CorrectionsSchema.safeParse(body?.corrections);
  if (!parsed.success) {
    return badRequest("Invalid correction", { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) });
  }

  const cur = await pool.query(`SELECT corrections, status FROM cv_screenings WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id]);
  if (!cur.rows[0]) return notFound("Screening not found");
  if (cur.rows[0].status !== "completed") return NextResponse.json({ error: "Only completed screenings can be corrected." }, { status: 409 });

  const merged = mergeCorrections(CorrectionsSchema.parse(cur.rows[0].corrections ?? {}), parsed.data);
  await pool.query(`UPDATE cv_screenings SET corrections = $3, updated_at = now() WHERE id = $1 AND job_id = $2`, [params.sid, access.job.id, JSON.stringify(merged)]);
  const ev = await reevaluateScreening(pool, access.job.id, params.sid);
  if (!ev) return NextResponse.json({ error: CV_ERROR_MESSAGES.internal_error }, { status: 500 });

  await audit(pool, {
    jobId: access.job.id, recruiterId: access.recruiterId, action: "correct", entityType: "cv_screening", entityId: params.sid,
    meta: {
      employment_refs: Object.keys(parsed.data.employment ?? {}),
      criteria: Object.keys(parsed.data.criteria ?? {}),
      candidate_fields: Object.keys(parsed.data.candidate ?? {}),
    },
  });
  return NextResponse.json({ ok: true, summary: ev.summary });
}
