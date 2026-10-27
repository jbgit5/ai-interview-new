import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, badRequest, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { getScreeningConfig } from "@/lib/screening/config";
import { CV_ERROR_MESSAGES, detectCvFile } from "@/lib/screening/parse";
import { deleteCvFile, saveCvFile, storagePathFor } from "@/lib/screening/storage";
import { kickWorker } from "@/lib/screening/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keep a display name only: no path, no control characters, bounded length. */
function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "cv").slice(0, 200);
}

// POST (multipart, field "file") → store ONE CV and queue its screening. Idempotent: the same
// file uploaded again to the same job returns the existing document/screening (no new AI cost).
export async function POST(request: NextRequest, { params }: { params: { id: string; batchId: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.batchId)) return notFound("Batch not found");

  const batch = await pool.query(`SELECT id, config_id FROM screening_batches WHERE id = $1 AND job_id = $2`, [params.batchId, access.job.id]);
  if (!batch.rows[0]) return notFound("Batch not found");
  const configId: string = batch.rows[0].config_id;

  const cfg = getScreeningConfig();
  const declared = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > cfg.maxFileBytes + 256 * 1024) {
    return NextResponse.json({ error: CV_ERROR_MESSAGES.too_large, code: "too_large" }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const fd = await request.formData();
    const f = fd.get("file");
    // Duck-typed: the File global only exists from Node 20.
    file = f && typeof f === "object" && "arrayBuffer" in f ? (f as File) : null;
  } catch {
    return badRequest("Expected a multipart upload with a 'file' field.");
  }
  if (!file) return badRequest("Expected a multipart upload with a 'file' field.");
  if (file.size > cfg.maxFileBytes) return NextResponse.json({ error: CV_ERROR_MESSAGES.too_large, code: "too_large" }, { status: 413 });

  const buf = new Uint8Array(await file.arrayBuffer());
  const check = detectCvFile(buf, cfg.maxFileBytes);
  if (!check.ok) {
    return NextResponse.json({ error: CV_ERROR_MESSAGES[check.code], code: check.code }, { status: check.code === "too_large" ? 413 : 415 });
  }
  const filename = safeFilename(file.name);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  // Duplicate? (same bytes already uploaded to this job) → reuse, never re-charge.
  const existing = await pool.query(`SELECT id FROM cv_documents WHERE job_id = $1 AND sha256 = $2`, [access.job.id, sha256]);
  if (existing.rows[0]) {
    const documentId: string = existing.rows[0].id;
    const s = await pool.query(
      `INSERT INTO cv_screenings (job_id, cv_document_id, config_id, batch_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cv_document_id, config_id) DO UPDATE SET updated_at = cv_screenings.updated_at
       RETURNING id, status`,
      [access.job.id, documentId, configId, params.batchId]
    );
    kickWorker();
    return NextResponse.json({ duplicate: true, document_id: documentId, screening_id: s.rows[0].id, status: s.rows[0].status, filename }, { status: 200 });
  }

  // Limits (counted in the DB, so they hold across reloads).
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM cv_documents WHERE batch_id = $1) AS in_batch,
       (SELECT COUNT(*)::int FROM cv_documents WHERE uploaded_by = $2 AND created_at >= date_trunc('day', now())) AS today`,
    [params.batchId, access.recruiterId]
  );
  if (counts.rows[0].in_batch >= cfg.maxFilesPerBatch) {
    return NextResponse.json({ error: `A batch can hold at most ${cfg.maxFilesPerBatch} files. Start a new batch.`, code: "batch_full" }, { status: 429 });
  }
  if (counts.rows[0].today >= cfg.maxUploadsPerDay) {
    return NextResponse.json({ error: "Daily upload limit reached. Try again tomorrow.", code: "daily_upload_limit" }, { status: 429 });
  }

  const documentId = randomUUID();
  const rel = storagePathFor(access.job.id, documentId, check.ext);
  const client = await pool.connect();
  let fileWritten = false;
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO cv_documents (id, job_id, batch_id, uploaded_by, original_filename, mime, size_bytes, sha256, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_id, sha256) DO NOTHING
       RETURNING id`,
      [documentId, access.job.id, params.batchId, access.recruiterId, filename, check.mime, buf.length, sha256, rel]
    );
    if (!ins.rows[0]) {
      // Lost a race with an identical concurrent upload — let the client retry into the duplicate path.
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This file is already being uploaded. Retry in a moment.", code: "duplicate_in_progress" }, { status: 409 });
    }
    await saveCvFile(rel, buf);
    fileWritten = true;
    const s = await client.query(
      `INSERT INTO cv_screenings (job_id, cv_document_id, config_id, batch_id) VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [access.job.id, documentId, configId, params.batchId]
    );
    await client.query("COMMIT");
    await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "upload", entityType: "cv_document", entityId: documentId, meta: { batch_id: params.batchId, size: buf.length, mime: check.mime } });
    kickWorker();
    return NextResponse.json({ duplicate: false, document_id: documentId, screening_id: s.rows[0].id, status: s.rows[0].status, filename }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (fileWritten) await deleteCvFile(rel).catch(() => {});
    console.error("[screening] upload failed", { jobId: access.job.id, code: (err as { code?: string })?.code, name: (err as Error)?.name });
    return NextResponse.json({ error: "Upload failed. Please retry.", code: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
