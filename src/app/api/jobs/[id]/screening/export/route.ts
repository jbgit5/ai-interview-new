import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { audit, requireRecruiterJob } from "@/lib/screening/access";
import { listResults } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY: Record<string, string> = {
  strong_fit: "Strong evidence of fit",
  potential_fit: "Potential fit; review required",
  insufficient_info: "Insufficient information",
  potential_mismatch: "Potential mismatch",
};

/** CSV cell: quoted, and neutralised against spreadsheet formula injection. */
function cell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// GET → CSV summary of the results table (no CV text). Same access rules as the dashboard.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;

  const rows = await listResults(pool, access.job.id);
  const header = ["Candidate", "File", "Uploaded", "Processing status", "Job-fit score", "Evidence completeness", "Eligibility", "Advisory category", "Recruiter decision", "Decided at", "Criteria version"];
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    lines.push([
      r.candidate_name ?? "", r.original_filename, new Date(r.uploaded_at).toISOString(), r.status,
      r.job_fit_score ?? "", r.evidence_completeness == null ? "" : `${Math.round(r.evidence_completeness * 100)}%`,
      r.eligibility_status ?? "", r.fit_category ? CATEGORY[r.fit_category] ?? r.fit_category : "",
      r.decision ?? "", r.decided_at ? new Date(r.decided_at).toISOString() : "", r.config_version,
    ].map(cell).join(","));
  }
  await audit(pool, { jobId: access.job.id, recruiterId: access.recruiterId, action: "export", entityType: "job", entityId: access.job.id, meta: { rows: rows.length } });

  const safeTitle = access.job.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "job";
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="screening-${safeTitle}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
