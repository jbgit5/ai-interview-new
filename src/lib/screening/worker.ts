import type { Pool } from "pg";
import { openAiJsonCall } from "../llm/openai";
import { LlmCallError, type LlmJsonCall, type LlmUsage } from "../llm/types";
import { SCREENING_PROMPT_VERSION } from "../prompts";
import { getScreeningConfig } from "./config";
import { extractCvText, type CvMime } from "./parse";
import { assessCv, extractCv } from "./pipeline";
import { RUBRIC_VERSION } from "./criteria";
import { buildDocContext, ensureDocChecks, evaluateFromRows, parseCriteria, recordUsage, saveEvaluation, spentTodayUsd } from "./service";
import { readCvFile } from "./storage";

// In-process screening queue, backed by Postgres (cv_screenings doubles as the queue).
//
// - kickWorker() starts up to CV_SCREENING_CONCURRENCY drain loops in this Node process.
//   Upload routes call it, and so does the batch-status GET that the progress page polls,
//   which restarts processing after a PM2 reload. No separate worker process is needed.
// - Rows are claimed with FOR UPDATE SKIP LOCKED and a lease. A crashed/reloaded process
//   leaves an expired lease, and the row is reclaimed (counted as an attempt).
// - Each step's output is cached (parsed text and extraction on cv_documents), so a retry never
//   pays again for a step that already succeeded.
// - Logs contain ids, error codes, tokens and timings only — never CV text or prompts.

const PERMANENT_CODES = new Set(["password_protected", "malformed", "empty", "needs_ocr", "parse_timeout", "file_missing", "config_missing", "unsupported_type"]);

interface WorkerState {
  running: number;
  budgetPausedUntil: number;
}
const g = globalThis as unknown as { __cvScreeningWorker?: WorkerState };
const state: WorkerState = (g.__cvScreeningWorker ??= { running: 0, budgetPausedUntil: 0 });

export function isBudgetPaused(): boolean {
  return Date.now() < state.budgetPausedUntil;
}

export function kickWorker(opts: { pool?: Pool; llm?: LlmJsonCall } = {}): void {
  const cfg = getScreeningConfig();
  if (isBudgetPaused()) return;
  while (state.running < cfg.concurrency) {
    state.running++;
    void (async () => {
      // Lazy import: lib/db throws at import time without DATABASE_URL (keeps tests DB-optional).
      const p = opts.pool ?? (await import("../db")).pool;
      await drain(p, opts.llm ?? openAiJsonCall);
    })().catch((err) => console.error("[screening] worker loop crashed", { name: (err as Error)?.name })).finally(() => {
      state.running--;
    });
  }
}

export interface ClaimedRow {
  id: string;
  job_id: string;
  cv_document_id: string;
  config_id: string;
  attempts: number;
  as_of_date: Date | string | null;
}

export async function claim(pool: Pool): Promise<ClaimedRow | null> {
  const cfg = getScreeningConfig();
  const r = await pool.query(
    `UPDATE cv_screenings s
        SET status = 'processing', attempts = s.attempts + 1,
            lease_until = now() + make_interval(secs => $1), updated_at = now(),
            as_of_date = COALESCE(s.as_of_date, CURRENT_DATE)
      WHERE s.id = (
        SELECT id FROM cv_screenings
         WHERE (status = 'queued' AND (lease_until IS NULL OR lease_until < now()))
            OR (status = 'processing' AND lease_until < now())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING s.id, s.job_id, s.cv_document_id, s.config_id, s.attempts, s.as_of_date`,
    [cfg.leaseSeconds]
  );
  return r.rows[0] ?? null;
}

async function drain(pool: Pool, llm: LlmJsonCall): Promise<void> {
  for (;;) {
    let row: ClaimedRow | null;
    try {
      row = await claim(pool);
    } catch (err) {
      console.error("[screening] claim failed", { code: (err as { code?: string })?.code });
      return;
    }
    if (!row) return;
    const stop = await processOne(pool, llm, row);
    if (stop) return;
  }
}

async function fail(pool: Pool, row: ClaimedRow, code: string, retryable: boolean): Promise<void> {
  const cfg = getScreeningConfig();
  if (retryable && row.attempts < cfg.maxAttempts) {
    // Back off: 30s × attempt number before the row can be claimed again.
    await pool.query(
      `UPDATE cv_screenings SET status = 'queued', error_code = $2,
              lease_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1`,
      [row.id, code, 30 * row.attempts]
    );
  } else {
    await pool.query(
      `UPDATE cv_screenings SET status = 'failed', error_code = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
      [row.id, code]
    );
  }
  console.warn("[screening] screening not completed", { screeningId: row.id, code, attempt: row.attempts, retryable });
}

/** Put the row back without consuming an attempt (used when the daily budget is reached). */
async function release(pool: Pool, row: ClaimedRow, code: string): Promise<void> {
  await pool.query(
    `UPDATE cv_screenings SET status = 'queued', attempts = GREATEST(attempts - 1, 0), error_code = $2,
            lease_until = now() + interval '10 minutes', updated_at = now()
      WHERE id = $1`,
    [row.id, code]
  );
}

async function budgetOk(pool: Pool): Promise<boolean> {
  const cfg = getScreeningConfig();
  try {
    return (await spentTodayUsd(pool)) < cfg.dailyBudgetUsd;
  } catch {
    return false; // fail closed
  }
}

/** Returns true when the drain loop should stop (budget reached). */
export async function processOne(pool: Pool, llm: LlmJsonCall, row: ClaimedRow): Promise<boolean> {
  const cfg = getScreeningConfig();
  const t0 = Date.now();
  const usage: { extraction: LlmUsage | null; assessment: LlmUsage | null } = { extraction: null, assessment: null };
  try {
    const dr = await pool.query(
      `SELECT d.id, d.job_id, d.mime, d.storage_path, d.extracted_text, d.page_offsets, d.text_truncated,
              d.extraction_status, d.error_code, d.extraction, d.extraction_prompt_version, j.title AS job_title
         FROM cv_documents d JOIN jobs j ON j.id = d.job_id
        WHERE d.id = $1 AND d.job_id = $2`,
      [row.cv_document_id, row.job_id]
    );
    const doc = dr.rows[0];
    if (!doc) {
      await fail(pool, row, "file_missing", false);
      return false;
    }
    const cr = await pool.query(`SELECT criteria FROM screening_configs WHERE id = $1 AND job_id = $2`, [row.config_id, row.job_id]);
    if (!cr.rows[0]) {
      await fail(pool, row, "config_missing", false);
      return false;
    }
    const criteria = parseCriteria(cr.rows[0].criteria);

    // 1. Text (cached on the document).
    if (doc.extraction_status === "failed" || doc.extraction_status === "needs_ocr") {
      await fail(pool, row, doc.error_code ?? "malformed", false);
      return false;
    }
    if (doc.extraction_status === "pending" || doc.extracted_text == null) {
      let buf: Buffer;
      try {
        buf = await readCvFile(doc.storage_path);
      } catch {
        await fail(pool, row, "file_missing", false);
        return false;
      }
      const res = await extractCvText(buf, doc.mime as CvMime);
      if (!res.ok) {
        await pool.query(
          `UPDATE cv_documents SET extraction_status = $2, error_code = $3, updated_at = now() WHERE id = $1`,
          [doc.id, res.code === "needs_ocr" ? "needs_ocr" : "failed", res.code]
        );
        await fail(pool, row, res.code, false);
        return false;
      }
      await pool.query(
        `UPDATE cv_documents SET extracted_text = $2, page_offsets = $3, page_count = $4, text_truncated = $5,
                extraction_status = 'extracted', error_code = NULL, updated_at = now()
          WHERE id = $1`,
        [doc.id, res.value.text, JSON.stringify(res.value.pageOffsets), res.value.pageCount, res.value.truncated]
      );
      Object.assign(doc, { extracted_text: res.value.text, page_offsets: res.value.pageOffsets, text_truncated: res.value.truncated });
    }
    const ctx = buildDocContext(doc);
    // Free checks (email domain DNS lookup, text fingerprint). Never blocks the screening.
    await ensureDocChecks(pool, row.job_id, doc.id).catch(() => {});

    // 2. Job-independent extraction (cached per document + prompt version).
    if (!doc.extraction || doc.extraction_prompt_version !== SCREENING_PROMPT_VERSION) {
      if (!(await budgetOk(pool))) {
        state.budgetPausedUntil = Date.now() + 5 * 60_000;
        await release(pool, row, "daily_budget");
        return true;
      }
      try {
        const out = await extractCv({ llm, model: cfg.model, timeoutMs: cfg.timeoutMs, maskedText: ctx.maskedText });
        usage.extraction = out.usage;
        await recordUsage(pool, { jobId: row.job_id, documentId: doc.id, kind: "extraction", usage: out.usage, ok: true });
        await pool.query(
          `UPDATE cv_documents SET extraction = $2, extraction_prompt_version = $3, extraction_model = $4,
                  extraction_usage = $5, updated_at = now()
            WHERE id = $1`,
          [doc.id, JSON.stringify(out.extraction), SCREENING_PROMPT_VERSION, cfg.model, JSON.stringify(out.usage)]
        );
        doc.extraction = out.extraction;
      } catch (err) {
        if (err instanceof LlmCallError && err.usage) {
          await recordUsage(pool, { jobId: row.job_id, documentId: doc.id, kind: "extraction", usage: err.usage, ok: false, errorCode: err.code });
        }
        throw err;
      }
    }

    // 3. Criterion assessment for this config version.
    if (!(await budgetOk(pool))) {
      state.budgetPausedUntil = Date.now() + 5 * 60_000;
      await release(pool, row, "daily_budget");
      return true;
    }
    let assessment;
    try {
      const out = await assessCv({ llm, model: cfg.model, timeoutMs: cfg.timeoutMs, extraction: doc.extraction, criteria, jobTitle: doc.job_title });
      assessment = out.assessment;
      usage.assessment = out.usage;
      if (out.usage) await recordUsage(pool, { jobId: row.job_id, documentId: doc.id, kind: "assessment", usage: out.usage, ok: true });
    } catch (err) {
      if (err instanceof LlmCallError && err.usage) {
        await recordUsage(pool, { jobId: row.job_id, documentId: doc.id, kind: "assessment", usage: err.usage, ok: false, errorCode: err.code });
      }
      throw err;
    }

    // 4. Deterministic evaluation + persist.
    const asOf = row.as_of_date ?? new Date().toISOString().slice(0, 10);
    const sr = await pool.query(`SELECT corrections FROM cv_screenings WHERE id = $1`, [row.id]);
    const ev = evaluateFromRows({ doc, assessment, criteria, corrections: sr.rows[0]?.corrections ?? {}, asOfDate: asOf });
    if (!ev) {
      await fail(pool, row, "invalid_output", true);
      return false;
    }
    await pool.query(
      `UPDATE cv_screenings
          SET status = 'completed', error_code = NULL, lease_until = NULL, assessment = $2,
              model = $3, prompt_version = $4, rubric_version = $5, usage = $6,
              completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        row.id, JSON.stringify(assessment), cfg.model, SCREENING_PROMPT_VERSION, RUBRIC_VERSION,
        JSON.stringify({ ...usage, total_cost_usd: (usage.extraction?.cost_usd ?? 0) + (usage.assessment?.cost_usd ?? 0), total_ms: Date.now() - t0 }),
      ]
    );
    await saveEvaluation(pool, row.id, row.job_id, ev);
    console.info("[screening] completed", {
      screeningId: row.id,
      ms: Date.now() - t0,
      extractionTokens: usage.extraction ? usage.extraction.prompt_tokens + usage.extraction.completion_tokens : 0,
      assessmentTokens: usage.assessment ? usage.assessment.prompt_tokens + usage.assessment.completion_tokens : 0,
    });
    return false;
  } catch (err) {
    const code = err instanceof LlmCallError ? err.code : "internal_error";
    if (!(err instanceof LlmCallError)) console.error("[screening] unexpected error", { screeningId: row.id, name: (err as Error)?.name });
    await fail(pool, row, code, !PERMANENT_CODES.has(code)).catch(() => {});
    return false;
  }
}
