import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { PDF_MIME } from "@/lib/screening/parse";
import { readCvFile } from "@/lib/screening/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → the original CV file, for the recruiter who owns the job only. Never cached by shared
// caches; every access is written to the audit log. ?download=1 forces a download.
export async function GET(request: NextRequest, { params }: { params: { id: string; docId: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.docId)) return notFound("Document not found");

  const r = await pool.query(
    `SELECT storage_path, mime, original_filename FROM cv_documents WHERE id = $1 AND job_id = $2`,
    [params.docId, access.job.id]
  );
  const doc = r.rows[0];
  if (!doc) return notFound("Document not found");

  let buf: Buffer;
  try {
    buf = await readCvFile(doc.storage_path);
  } catch {
    return notFound("Document not found");
  }

  const download = request.nextUrl.searchParams.get("download") === "1" || doc.mime !== PDF_MIME;
  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: download ? "download_cv" : "view_cv", entityType: "cv_document", entityId: params.docId });

  const ascii = String(doc.original_filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
