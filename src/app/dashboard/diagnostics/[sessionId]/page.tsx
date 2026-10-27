import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { loadDiagnoses } from "@/lib/diagnostics/loadDiagnosis";
import type { Severity, TimelineKind, Tone } from "@/lib/diagnostics/diagnoseSession";

const TONE: Record<Tone, { box: string; icon: JSX.Element }> = {
  ok: { box: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: <CheckCircle className="h-5 w-5" /> },
  warn: { box: "border-amber-200 bg-amber-50 text-amber-800", icon: <AlertTriangle className="h-5 w-5" /> },
  bad: { box: "border-red-200 bg-red-50 text-red-800", icon: <XCircle className="h-5 w-5" /> },
};

const SEVERITY: Record<Severity, { label: string; chip: string; bar: string }> = {
  high: { label: "Serious", chip: "bg-red-100 text-red-700", bar: "border-l-red-500" },
  medium: { label: "Medium", chip: "bg-amber-100 text-amber-700", bar: "border-l-amber-400" },
  low: { label: "Minor", chip: "bg-gray-100 text-gray-600", bar: "border-l-gray-300" },
};

const KIND: Record<TimelineKind, { dot: string; text: string }> = {
  maya: { dot: "bg-violet-500", text: "text-violet-700" },
  maya_said: { dot: "bg-fuchsia-500", text: "text-fuchsia-700" },
  candidate: { dot: "bg-sky-500", text: "text-sky-700" },
  system: { dot: "bg-gray-400", text: "text-gray-500" },
  latency: { dot: "bg-amber-400", text: "text-amber-700" },
  proctor: { dot: "bg-orange-500", text: "text-orange-700" },
  error: { dot: "bg-red-500", text: "text-red-700" },
};

function mmss(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default async function DiagnosticsSessionPage({ params }: { params: { sessionId: string } }) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  // Ownership check: a recruiter can only diagnose their own interviews.
  const owner = await pool.query(
    `SELECT s.id, s.candidate_name, s.candidate_email, s.started_at, j.title AS job_title
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
      WHERE s.id = $1 AND r.better_auth_user_id = $2`,
    [params.sessionId, session.user.id]
  );
  if (owner.rows.length === 0) notFound();
  const row = owner.rows[0];

  const diagnosis = (await loadDiagnoses(pool, [row.id])).get(row.id);
  if (!diagnosis) notFound();
  const { verdict, issues, timeline, stats, engine } = diagnosis;
  const tone = TONE[verdict.tone];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <Link
        href="/dashboard/diagnostics"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" /> All interviews
      </Link>

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{row.candidate_name ?? row.candidate_email}</h1>
          <p className="text-sm text-gray-500">
            {row.job_title} · {row.started_at ? format(new Date(row.started_at), "MMM d, yyyy HH:mm") : "not started"} ·{" "}
            <span className="font-medium">{engine === "live" ? "GPT-Live voice" : engine === "pipeline" ? "Pipeline voice (Deepgram + Aura)" : "Standard voice"}</span>
          </p>
        </div>
        <Link href={`/dashboard/reports/${row.id}`} className="text-sm font-semibold text-violet-600 hover:text-violet-700">
          Open scored report →
        </Link>
      </div>

      {/* Verdict */}
      <div className={`mb-6 flex items-start gap-3 rounded-xl border p-4 ${tone.box}`}>
        <div className="mt-0.5">{tone.icon}</div>
        <div className="flex-1">
          <p className="font-bold">{verdict.title}</p>
          <p className="mt-0.5 text-sm opacity-90">{verdict.detail}</p>
          <p className="mt-2 text-xs opacity-75">
            {stats.durationMin != null && <>Duration {stats.durationMin.toFixed(1)} min · </>}
            {stats.answers} answer{stats.answers === 1 ? "" : "s"}
            {stats.spendUsd != null && <> · voice cost ≈ ${stats.spendUsd.toFixed(2)}</>}
          </p>
        </div>
      </div>

      {/* Issues */}
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">
        What went wrong ({issues.length})
      </h2>
      {issues.length === 0 ? (
        <p className="mb-8 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
          Nothing unusual detected in this interview.
        </p>
      ) : (
        <div className="mb-8 space-y-3">
          {issues.map((i, idx) => (
            <div key={idx} className={`rounded-xl border border-gray-200 border-l-4 bg-white p-4 ${SEVERITY[i.severity].bar}`}>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${SEVERITY[i.severity].chip}`}>
                  {SEVERITY[i.severity].label}
                </span>
                <p className="text-sm font-semibold text-gray-900">{i.title}</p>
                {i.atMs != null && <span className="ml-auto text-xs text-gray-400">at {mmss(i.atMs)}</span>}
              </div>
              <p className="mt-1.5 text-sm text-gray-700">{i.detail}</p>
              <p className="mt-1.5 text-xs text-gray-500">
                <strong className="text-gray-600">What to do:</strong> {i.fix}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-gray-500">Full timeline</h2>
      <p className="mb-3 text-xs text-gray-400">
        Time is from the start of the interview. <span className="text-violet-600">Purple</span> = what our server told Maya to
        say, <span className="text-fuchsia-600">pink</span> = what Maya actually said (GPT-Live only),{" "}
        <span className="text-sky-600">blue</span> = candidate, <span className="text-amber-600">amber</span> = how long
        someone waited, <span className="text-red-600">red</span> = problems.
      </p>
      <ol className="rounded-xl border border-gray-200 bg-white p-2">
        {timeline.map((it, idx) => (
          <li key={idx} className="flex gap-3 rounded-lg px-3 py-2 hover:bg-gray-50">
            <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-gray-400">{mmss(it.atMs)}</span>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND[it.kind].dot}`} />
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-semibold ${KIND[it.kind].text}`}>{it.label}</p>
              {it.text && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-800">{it.text}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
