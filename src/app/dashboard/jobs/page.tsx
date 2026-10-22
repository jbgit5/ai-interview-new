import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Briefcase, PlusCircle, Users, HelpCircle, Calendar, ArrowRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { format } from "date-fns";
import type { JobStatus } from "@/types";

const STATUS_CONFIG: Record<JobStatus, { label: string; color: string; bg: string }> = {
  draft:  { label: "Draft",  color: "#374151", bg: "#f3f4f6" },
  active: { label: "Active", color: "#059669", bg: "#d1fae5"  },
  closed: { label: "Closed", color: "#dc2626", bg: "#fee2e2"  },
};

export default async function JobsPage() {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const recruiter = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );

  const jobs =
    recruiter.rows[0]
      ? await pool.query(
          `SELECT j.*,
                  COUNT(DISTINCT q.id)::int AS question_count,
                  COUNT(DISTINCT s.id)::int AS candidate_count
           FROM jobs j
           LEFT JOIN questions q ON q.job_id = j.id
           LEFT JOIN interview_sessions s ON s.job_id = j.id
           WHERE j.recruiter_id = $1
           GROUP BY j.id
           ORDER BY j.created_at DESC`,
          [recruiter.rows[0].id]
        )
      : { rows: [] };

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* ── Header ── */}
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-1">Openings</p>
          <h1 className="text-3xl font-bold text-gray-900">Jobs</h1>
          <p className="mt-1 text-sm text-gray-500">Manage openings and interview pipelines.</p>
        </div>
        <Link href="/dashboard/jobs/new" className="sc-btn-primary">
          <PlusCircle className="h-4 w-4" />
          Create job
        </Link>
      </div>

      {jobs.rows.length === 0 ? (
        <div className="sc-card p-14 text-center">
          <div
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{ background: "#ede9fe", border: "1px solid rgba(124,58,237,0.06)" }}
          >
            <Briefcase className="h-8 w-8 text-violet-600" />
          </div>
          <h2 className="text-xl font-bold text-gray-900">No jobs yet</h2>
          <p className="mx-auto mt-2 mb-7 max-w-md text-sm text-gray-500">
            Create your first job to start building question banks and inviting candidates.
          </p>
          <Link href="/dashboard/jobs/new" className="sc-btn-primary">
            <PlusCircle className="h-4 w-4" />
            Create your first job
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {jobs.rows.map(
            (job: {
              id: string;
              title: string;
              department: string | null;
              status: JobStatus;
              question_count: number;
              candidate_count: number;
              created_at: string;
            }) => {
              const sc = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.draft;
              return (
                <div
                  key={job.id}
                  className="sc-card p-5 flex flex-col gap-4 transition-all duration-200 hover:-translate-y-0.5"
                  style={{ boxShadow: "0 0 0 1px #e2e4ec" }}
                >
                  {/* Top */}
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                      style={{ background: "#ede9fe", border: "1px solid rgba(124,58,237,0.06)" }}
                    >
                      <Briefcase className="h-5 w-5 text-violet-600" />
                    </div>
                    <span
                      className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
                      style={{ color: sc.color, background: sc.bg }}
                    >
                      {sc.label}
                    </span>
                  </div>

                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2">
                      {job.title}
                    </h3>
                    {job.department && (
                      <p className="mt-1 text-xs text-gray-500">{job.department}</p>
                    )}
                  </div>

                  {/* Meta */}
                  <div className="flex gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1.5">
                      <HelpCircle className="h-3.5 w-3.5 text-gray-400" />
                      {job.question_count}q
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-gray-400" />
                      {job.candidate_count}
                    </span>
                    <span className="flex items-center gap-1.5 ml-auto">
                      <Calendar className="h-3.5 w-3.5 text-gray-400" />
                      {format(new Date(job.created_at), "MMM d")}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-1" style={{ borderTop: "1px solid #f0f0f4" }}>
                    <Link
                      href={`/dashboard/jobs/${job.id}/questions`}
                      className="sc-btn-secondary flex-1 justify-center !py-1.5 !text-xs"
                    >
                      Questions
                    </Link>
                    <Link
                      href={`/dashboard/jobs/${job.id}/invite`}
                      className="sc-btn-primary flex-1 justify-center !py-1.5 !text-xs"
                    >
                      Invite
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>
              );
            }
          )}
        </div>
      )}
    </div>
  );
}
