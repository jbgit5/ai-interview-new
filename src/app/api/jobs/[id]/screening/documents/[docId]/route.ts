import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE, audit, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { deleteCvFile } from "@/lib/screening/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE → permanently remove a CV: the file, its extracted text/data, its screenings and
// decisions. Interview history is NOT deleted: any interview_sessions row created from this CV
// stays, with its cv_document_id set to NULL. An audit row (ids only) is kept.
export async function DELETE(request: NextRequest, { params }: { params: { id: string; docId: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.docId)) return notFound("Document not found");

  const r = await pool.query(
    `DELETE FROM cv_documents WHERE id = $1 AND job_id = $2 RETURNING storage_path`,
    [params.docId, access.job.id]
  );
  if (!r.rows[0]) return notFound("Document not found");

  let fileDeleted = true;
  try {
    await deleteCvFile(r.rows[0].storage_path);
  } catch (err) {
    fileDeleted = false;
    console.error("[screening] CV file delete failed", { documentId: params.docId, code: (err as NodeJS.ErrnoException)?.code });
  }
  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "delete", entityType: "cv_document", entityId: params.docId, meta: { file_deleted: fileDeleted } });
  return NextResponse.json({ ok: true, file_deleted: fileDeleted });
}
