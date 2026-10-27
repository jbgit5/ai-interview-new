import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { format } from "date-fns";
import { Stethoscope } from "lucide-react";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { loadDiagnoses } from "@/lib/diagnostics/loadDiagnosis";
import type { Diagnosis, Tone } from "@/lib/diagnostics/diagnoseSession";

const TONE_STYLE: Record<Tone, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  bad: "bg-red-100 text-red-700",
};

function count(d: Diagnosis, sev: "high" | "medium" | "low") {
  return d.issues.filter((i) => i.severity === sev).length;
}

export default async function DiagnosticsIndexPage() {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const rows = (
    await pool.query(
      `SELECT s.id, s.candidate_name, s.candidate_email, s.status, s.started_at, j.title AS job_title
         FROM interview_sessions s
         JOIN jobs j ON j.id = s.job_id
         JOIN recruiters r ON r.id = j.recruiter_id
        WHERE r.better_auth_user_id = $1 AND s.started_at IS NOT NULL
        ORDER BY s.started_at DESC
        LIMIT 30`,
      [session.user.id]
    )
  ).rows;

  const diagnoses = await loadDiagnoses(
    pool,
    rows.map((r) => r.id as string)
  );
  const withProblems = rows.filter((r) => diagnoses.get(r.id)?.verdict.tone === "bad").length;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-1 flex items-center gap-2">
        <Stethoscope className="h-5 w-5 text-violet-600" />
        <h1 className="text-xl font-bold text-gray-900">Interview Diagnostics</h1>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        Pick any interview to see, in plain words, what happened, what went wrong, and what to do
        about it. {rows.length > 0 && (
          <>
            <strong className="text-gray-700">{withProblems}</strong> of your last {rows.length}{" "}
            interviews had serious problems.
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No interviews have started yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Voice</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Issues</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const d = diagnoses.get(r.id);
                if (!d) return null;
                const hi = count(d, "high");
                const med = count(d, "medium");
                const lo = count(d, "low");
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{r.candidate_name ?? r.candidate_email}</p>
                      <p className="text-xs text-gray-500">{r.job_title}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {format(new Date(r.started_at), "MMM d, HH:mm")}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          d.engine === "live"
                            ? "bg-violet-100 text-violet-700"
                            : d.engine === "pipeline"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {d.engine === "live" ? "GPT-Live" : d.engine === "pipeline" ? "Pipeline" : "Standard"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_STYLE[d.verdict.tone]}`}>
                        {d.verdict.title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {hi > 0 && <span className="mr-2 font-semibold text-red-600">{hi} serious</span>}
                      {med > 0 && <span className="mr-2 font-semibold text-amber-600">{med} medium</span>}
                      {lo > 0 && <span className="text-gray-400">{lo} minor</span>}
                      {hi + med + lo === 0 && <span className="text-emerald-600">none</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/dashboard/diagnostics/${r.id}`}
                        className="font-semibold text-violet-600 hover:text-violet-700"
                      >
                        What happened →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
