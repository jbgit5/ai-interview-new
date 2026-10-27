import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { ArrowLeft, MessageCircleQuestion, MessageCircleOff } from "lucide-react";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import TabLink from "@/components/dashboard/TabLink";

// Hiring flow order: screen CVs → tune requirements → prepare interview questions → invite.
const TABS = [
  { label: "Candidates", href: (id: string) => `/dashboard/jobs/${id}/screening` },
  { label: "Requirements", href: (id: string) => `/dashboard/jobs/${id}/requirements` },
  { label: "Interview questions", href: (id: string) => `/dashboard/jobs/${id}/questions` },
  { label: "Invites", href: (id: string) => `/dashboard/jobs/${id}/invite` },
  { label: "Settings", href: (id: string) => `/dashboard/jobs/${id}/edit` },
];

export default async function JobDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { jobId: string };
}) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const jobResult = await pool.query(
    `SELECT j.id, j.title, j.department, j.status, j.description, j.allow_probes
     FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.jobId, session.user.id]
  );

  if (!jobResult.rows[0]) notFound();
  const job = jobResult.rows[0];

  return (
    <div className="flex flex-col h-full">
      {/* Job header */}
      <div className="border-b border-gray-100 bg-white">
        <div className="mx-auto max-w-7xl px-6 pb-0 pt-6">
          <Link
            href="/dashboard/jobs"
            className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-violet-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            All jobs
          </Link>

          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{job.title}</h1>
              {job.department && (
                <p className="mt-0.5 text-sm text-gray-500">{job.department}</p>
              )}
              {job.description && (
                <details className="mt-2 group">
                  <summary className="cursor-pointer list-none text-xs text-violet-600 hover:text-violet-700 select-none">
                    <span className="group-open:hidden">Show description ▾</span>
                    <span className="hidden group-open:inline">Hide description ▴</span>
                  </summary>
                  <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm text-gray-600 leading-relaxed">
                    {job.description}
                  </p>
                </details>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                title={
                  job.allow_probes
                    ? "Follow-up probes ON — Maya may ask up to 2 follow-up questions per bank question to dig deeper into shallow or unclear answers."
                    : "Follow-up probes OFF — Maya asks each bank question exactly once, then closes. Strict bank-only mode."
                }
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  job.allow_probes
                    ? "bg-violet-100 text-violet-700"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {job.allow_probes ? (
                  <MessageCircleQuestion className="h-3 w-3" />
                ) : (
                  <MessageCircleOff className="h-3 w-3" />
                )}
                {job.allow_probes ? "Probes" : "No probes"}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${
                  job.status === "active"
                    ? "bg-emerald-100 text-emerald-700"
                    : job.status === "closed"
                      ? "bg-red-100 text-red-600"
                      : "bg-gray-100 text-gray-500"
                }`}
              >
                {job.status}
              </span>
            </div>
          </div>

          {/* Tab nav */}
          <nav className="flex gap-1">
            {TABS.map((tab) => (
              <TabLink key={tab.label} href={tab.href(job.id)} label={tab.label} />
            ))}
          </nav>
        </div>
      </div>

      {/* Tab content — constrained to same max-width */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl">{children}</div>
      </div>
    </div>
  );
}
