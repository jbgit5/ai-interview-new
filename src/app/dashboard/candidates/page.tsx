import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { format } from "date-fns";
import { Users, FileText, ArrowUpRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: "Invited",     color: "#d97706", bg: "#fef3c7"   },
  in_progress: { label: "In Progress", color: "#7c3aed", bg: "#ede9fe"   },
  completed:   { label: "Completed",   color: "#059669", bg: "#d1fae5"   },
  shortlisted: { label: "Shortlisted", color: "#7c3aed", bg: "#ede9fe"  },
  rejected:    { label: "Rejected",    color: "#dc2626", bg: "#fee2e2"   },
  expired:     { label: "Expired",     color: "#6b7280", bg: "#f3f4f6"    },
};

const REC_STYLES: Record<string, string> = {
  strong_yes: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200",
  yes:        "bg-green-100 text-green-700 ring-1 ring-green-200",
  no:         "bg-amber-100 text-amber-700 ring-1 ring-amber-200",
  strong_no:  "bg-red-100 text-red-600 ring-1 ring-red-200",
};
const REC_LABELS: Record<string, string> = {
  strong_yes: "Strong Yes",
  yes: "Yes",
  no: "No",
  strong_no: "Strong No",
};

export default async function CandidatesPage() {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const recruiter = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );

  const candidates =
    recruiter.rows[0]
      ? await pool.query(
          `SELECT
             s.id AS session_id,
             s.candidate_name,
             s.candidate_email,
             s.status,
             s.created_at,
             s.completed_at,
             s.integrity_score,
             j.title AS job_title,
             a.overall_score,
             a.recommendation
           FROM interview_sessions s
           JOIN jobs j ON j.id = s.job_id
           LEFT JOIN analysis_results a ON a.session_id = s.id
           WHERE j.recruiter_id = $1
           ORDER BY s.created_at DESC`,
          [recruiter.rows[0].id]
        )
      : { rows: [] };

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* ── Header ── */}
      <div className="mb-7">
        <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-1">Pipeline</p>
        <h1 className="text-3xl font-bold text-gray-900">Candidates</h1>
        <p className="mt-1 text-sm text-gray-500">Track interview progress and outcomes.</p>
      </div>

      {candidates.rows.length === 0 ? (
        <div className="sc-card p-14 text-center">
          <div
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{ background: "#fef3c7", border: "1px solid rgba(245,166,35,0.2)" }}
          >
            <Users className="h-8 w-8 text-[#f5a623]" />
          </div>
          <h2 className="text-xl font-bold text-gray-900">No candidates yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Candidates will appear here after you create a job and send interview invites.
          </p>
        </div>
      ) : (
        <div className="sc-card overflow-hidden">
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: "1px solid #f0f0f4" }}
          >
            <p className="text-sm font-semibold text-gray-900">
              {candidates.rows.length} candidate{candidates.rows.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid #f0f0f4", background: "#f9fafb" }}>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Candidate</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Job</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Status</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Score</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Verdict</th>
                  <th className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-gray-400">Date</th>
                  <th className="px-5 py-3 w-20" />
                </tr>
              </thead>
              <tbody>
                {candidates.rows.map(
                  (c: {
                    session_id: string;
                    candidate_name: string | null;
                    candidate_email: string;
                    status: string;
                    created_at: string;
                    completed_at: string | null;
                    integrity_score: number;
                    job_title: string;
                    overall_score: number | null;
                    recommendation: string | null;
                  }) => {
                    const sc = STATUS_CONFIG[c.status] ?? { label: c.status, color: "#6b7280", bg: "#f3f4f6" };
                    return (
                      <tr
                        key={c.session_id}
                        className="transition-colors"
                        style={{ borderBottom: "1px solid #f0f0f0" }}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
                            >
                              {(c.candidate_name ?? c.candidate_email)[0]?.toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{c.candidate_name ?? "—"}</p>
                              <p className="text-xs text-gray-500">{c.candidate_email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-gray-600 text-sm">{c.job_title}</td>
                        <td className="px-5 py-3.5">
                          <span
                            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                            style={{ color: sc.color, background: sc.bg }}
                          >
                            {sc.label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          {c.overall_score !== null ? (
                            <div className="flex items-center gap-2.5">
                              <div className="h-1.5 w-16 rounded-full overflow-hidden" style={{ background: "#e2e4ec" }}>
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${Math.round(Number(c.overall_score))}%`,
                                    background: Number(c.overall_score) >= 65 ? "#059669" : Number(c.overall_score) >= 50 ? "#d97706" : "#dc2626",
                                  }}
                                />
                              </div>
                              <span
                                className="text-sm font-bold tabular-nums"
                                style={{ color: Number(c.overall_score) >= 65 ? "#059669" : Number(c.overall_score) >= 50 ? "#d97706" : "#dc2626" }}
                              >
                                {Math.round(Number(c.overall_score))}
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          {c.recommendation ? (
                            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${REC_STYLES[c.recommendation] ?? ""}`}>
                              {REC_LABELS[c.recommendation] ?? c.recommendation}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-xs text-gray-500 tabular-nums">
                          {c.created_at ? format(new Date(c.created_at), "MMM d, yyyy") : "—"}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {(c.status === "completed" || c.status === "shortlisted" || c.status === "rejected") ? (
                            <Link
                              href={`/dashboard/reports/${c.session_id}`}
                              className="sc-btn-secondary !px-3 !py-1.5 !text-xs"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Report
                              <ArrowUpRight className="h-3 w-3" />
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  }
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
