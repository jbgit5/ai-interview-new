import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { format } from "date-fns";
import { Briefcase, Users, CheckCircle, PlusCircle, FileText, TrendingUp, ArrowUpRight } from "lucide-react";
import { pool } from "@/lib/db";

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

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const firstName = session.user.name?.split(" ")[0] ?? session.user.email.split("@")[0];

  const recruiter = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );
  const recruiterId: string | null = recruiter.rows[0]?.id ?? null;

  const [statsResult, recentResult] = recruiterId
    ? await Promise.all([
        pool.query(
          `SELECT
             COUNT(DISTINCT j.id)::int AS total_jobs,
             COUNT(DISTINCT CASE WHEN s.status = 'in_progress' THEN s.id END)::int AS active_interviews,
             COUNT(DISTINCT CASE WHEN s.status IN ('completed','shortlisted','rejected') THEN s.id END)::int AS completed_interviews,
             COUNT(DISTINCT CASE WHEN s.status = 'shortlisted' THEN s.id END)::int AS shortlisted
           FROM jobs j
           LEFT JOIN interview_sessions s ON s.job_id = j.id
           WHERE j.recruiter_id = $1`,
          [recruiterId]
        ),
        pool.query(
          `SELECT
             s.id AS session_id,
             s.candidate_name,
             s.candidate_email,
             s.completed_at,
             s.status,
             j.title AS job_title,
             a.overall_score,
             a.recommendation
           FROM interview_sessions s
           JOIN jobs j ON j.id = s.job_id
           LEFT JOIN analysis_results a ON a.session_id = s.id
           WHERE j.recruiter_id = $1
             AND s.status IN ('completed', 'shortlisted', 'rejected')
           ORDER BY s.completed_at DESC
           LIMIT 8`,
          [recruiterId]
        ),
      ])
    : [{ rows: [{ total_jobs: 0, active_interviews: 0, completed_interviews: 0, shortlisted: 0 }] }, { rows: [] }];

  const stats = statsResult.rows[0];
  const recent = recentResult.rows;

  const statCards = [
    { label: "Total Jobs",    value: stats.total_jobs,           icon: Briefcase,   iconCls: "text-violet-600",  iconBg: "bg-violet-50",  borderCls: "border-t-violet-500" },
    { label: "In Progress",   value: stats.active_interviews,    icon: Users,       iconCls: "text-amber-600",   iconBg: "bg-amber-50",   borderCls: "border-t-amber-400"  },
    { label: "Completed",     value: stats.completed_interviews, icon: CheckCircle, iconCls: "text-sky-600",     iconBg: "bg-sky-50",     borderCls: "border-t-sky-500"    },
    { label: "Shortlisted",   value: stats.shortlisted,          icon: TrendingUp,  iconCls: "text-emerald-600", iconBg: "bg-emerald-50", borderCls: "border-t-emerald-500"},
  ];

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">

      {/* ── Header ── */}
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-violet-500 mb-1">Dashboard</p>
          <h1 className="text-2xl font-bold text-gray-900">
            Hello, <span className="sc-gradient-text">{firstName}</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500">Here&apos;s your interview pipeline overview.</p>
        </div>
        <Link href="/dashboard/jobs/new" className="sc-btn-primary">
          <PlusCircle className="h-4 w-4" />
          New Job
        </Link>
      </div>

      {/* ── Stat Cards ── */}
      <div className="mb-7 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {statCards.map(({ label, value, icon: Icon, iconCls, iconBg, borderCls }) => (
          <div key={label} className={`sc-card border-t-[3px] ${borderCls} p-5`}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}>
                <Icon className={`h-4 w-4 ${iconCls}`} />
              </div>
            </div>
            <p className="text-3xl font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>

      {/* ── Recent Interviews ── */}
      {recent.length > 0 ? (
        <div className="sc-card overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Recent Interviews</h2>
              <p className="text-xs text-gray-400 mt-0.5">Latest completed sessions</p>
            </div>
            <Link
              href="/dashboard/candidates"
              className="flex items-center gap-1 text-sm font-medium text-violet-600 hover:text-violet-700 transition-colors"
            >
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/70">
                  <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Candidate</th>
                  <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Job</th>
                  <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Score</th>
                  <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Verdict</th>
                  <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Date</th>
                  <th className="px-6 py-3 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recent.map(
                  (r: {
                    session_id: string;
                    candidate_name: string | null;
                    candidate_email: string;
                    completed_at: string | null;
                    status: string;
                    job_title: string;
                    overall_score: number | null;
                    recommendation: string | null;
                  }) => (
                    <tr key={r.session_id} className="hover:bg-violet-50/40 transition-colors">
                      <td className="px-6 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-purple-600 text-xs font-bold text-white">
                            {(r.candidate_name ?? r.candidate_email)[0]?.toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{r.candidate_name ?? "—"}</p>
                            <p className="text-xs text-gray-400">{r.candidate_email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-3.5 text-gray-600">{r.job_title}</td>
                      <td className="px-6 py-3.5">
                        {r.overall_score !== null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 rounded-full bg-gray-100 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${Number(r.overall_score) >= 65 ? "bg-emerald-500" : Number(r.overall_score) >= 50 ? "bg-amber-400" : "bg-red-400"}`}
                                style={{ width: `${Math.round(Number(r.overall_score))}%` }}
                              />
                            </div>
                            <span className={`font-bold ${Number(r.overall_score) >= 65 ? "text-emerald-600" : Number(r.overall_score) >= 50 ? "text-amber-600" : "text-red-500"}`}>
                              {Math.round(Number(r.overall_score))}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3.5">
                        {r.recommendation ? (
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${REC_STYLES[r.recommendation] ?? ""}`}>
                            {REC_LABELS[r.recommendation] ?? r.recommendation}
                          </span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-gray-400 tabular-nums">
                        {r.completed_at ? format(new Date(r.completed_at), "MMM d, yyyy") : "—"}
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        <Link href={`/dashboard/reports/${r.session_id}`} className="sc-btn-secondary !px-3 !py-1.5 !text-xs">
                          <FileText className="h-3.5 w-3.5" />
                          Report
                        </Link>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="sc-card p-14 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50">
            <Briefcase className="h-7 w-7 text-violet-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-900">Create your first job</h2>
          <p className="mx-auto mt-2 mb-6 max-w-sm text-sm text-gray-500">
            Add a job opening, build your question bank, and invite candidates to a Screeno AI interview.
          </p>
          <Link href="/dashboard/jobs/new" className="sc-btn-primary">
            <PlusCircle className="h-4 w-4" />
            Create a job
          </Link>
        </div>
      )}
    </div>
  );
}
