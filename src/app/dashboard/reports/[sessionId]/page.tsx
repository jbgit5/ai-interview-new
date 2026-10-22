import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import CompetencyRadar from "@/components/reports/CompetencyRadar";
import ReportActions from "@/components/reports/ActionButtons";
import RecordingPlayer from "@/components/reports/RecordingPlayer";

const RECOMMENDATION_META: Record<string, { label: string; color: string; bg: string }> = {
  strong_yes: { label: "Strong Yes", color: "text-emerald-700", bg: "bg-emerald-100" },
  yes: { label: "Yes", color: "text-green-700", bg: "bg-green-100" },
  no: { label: "No", color: "text-amber-700", bg: "bg-amber-100" },
  strong_no: { label: "Strong No", color: "text-red-700", bg: "bg-red-100" },
};

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Invited", color: "text-yellow-700", bg: "bg-yellow-100" },
  in_progress: { label: "In Progress", color: "text-blue-700", bg: "bg-blue-100" },
  completed: { label: "Completed", color: "text-green-700", bg: "bg-green-100" },
  shortlisted: { label: "Shortlisted", color: "text-emerald-700", bg: "bg-emerald-100" },
  rejected: { label: "Rejected", color: "text-red-700", bg: "bg-red-100" },
  expired: { label: "Expired", color: "text-gray-600", bg: "bg-gray-100" },
};

export default async function ReportPage({
  params,
}: {
  params: { sessionId: string };
}) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) redirect("/sign-in");

  const { sessionId } = params;
  const client = await pool.connect();

  try {
    const sessionRow = await client.query(
      `SELECT
         s.id, s.candidate_name, s.candidate_email, s.status,
         s.started_at, s.completed_at, s.integrity_score, s.created_at,
         j.id AS job_id, j.title AS job_title,
         r.company_name,
         a.overall_score, a.recommendation, a.ai_summary,
         a.competency_scores, a.strengths, a.concerns,
         a.created_at AS analyzed_at,
         a.total_brain_prompt_tokens, a.total_brain_completion_tokens,
         a.total_scoring_tokens, a.total_tts_chars, a.estimated_cost_usd
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
       LEFT JOIN analysis_results a ON a.session_id = s.id
       WHERE s.id = $1 AND r.better_auth_user_id = $2`,
      [sessionId, session.user.id]
    );

    if (sessionRow.rows.length === 0) notFound();

    const row = sessionRow.rows[0];

    const [turnsResult, scoresResult, proctoringResult, latencyResult] = await Promise.all([
      client.query(
        `SELECT turn_index, role, content
           FROM transcript_turns
          WHERE session_id = $1
          ORDER BY turn_index, CASE WHEN role = 'interviewer' THEN 0 ELSE 1 END`,
        [sessionId]
      ),
      client.query(
        `SELECT q.text AS question_text,
                ROUND(AVG(qs.score)) AS score,
                (array_agg(qs.reasoning ORDER BY qs.turn_index DESC))[1] AS reasoning
           FROM question_scores qs
           LEFT JOIN questions q ON q.id = qs.question_id
          WHERE qs.session_id = $1
            AND qs.question_id IS NOT NULL
          GROUP BY q.id, q.text, q.order_index
          ORDER BY q.order_index`,
        [sessionId]
      ),
      client.query(
        `SELECT event_type, timestamp_ms, severity
           FROM proctoring_events
          WHERE session_id = $1
          ORDER BY timestamp_ms`,
        [sessionId]
      ),
      // Per-turn latency stats — used for the Cost & Performance card
      client.query(
        `SELECT
           COUNT(*)::int                                          AS turn_count,
           ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms)) AS p50_ms,
           ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)) AS p95_ms,
           ROUND(AVG(total_ms))                                  AS avg_ms,
           MAX(total_ms)                                         AS max_ms
         FROM turn_metrics
        WHERE session_id = $1
          AND action != 'opening'`,
        [sessionId]
      ),
    ]);

    const candidateName = row.candidate_name ?? row.candidate_email;
    const hasAnalysis = row.overall_score !== null;
    const statusMeta = STATUS_META[row.status] ?? STATUS_META.completed;
    const recMeta = row.recommendation
      ? RECOMMENDATION_META[row.recommendation]
      : null;
    const competencies: Record<string, number> = row.competency_scores ?? {};
    const strengths: string[] = row.strengths ?? [];
    const concerns: string[] = row.concerns ?? [];
    const turns = turnsResult.rows;
    const scores = scoresResult.rows;
    const proctoringEvents = proctoringResult.rows;

    // Cost + latency from analysis_results and turn_metrics
    const estimatedCostUsd: number = Number(row.estimated_cost_usd) || 0;
    const totalBrainPromptTokens: number = Number(row.total_brain_prompt_tokens) || 0;
    const totalBrainCompletionTokens: number = Number(row.total_brain_completion_tokens) || 0;
    const totalScoringTokens: number = Number(row.total_scoring_tokens) || 0;
    const totalTtsChars: number = Number(row.total_tts_chars) || 0;
    const latStats = latencyResult.rows[0] ?? {};
    const turnCount: number = Number(latStats.turn_count) || 0;
    const p50Ms: number = Number(latStats.p50_ms) || 0;
    const p95Ms: number = Number(latStats.p95_ms) || 0;
    const avgMs: number = Number(latStats.avg_ms) || 0;

    const highViolations = proctoringEvents.filter((e) => e.severity === "high").length;
    const mediumViolations = proctoringEvents.filter((e) => e.severity === "medium").length;

    return (
      <div className="min-h-screen bg-[#f4f5f9]">
        {/* Top bar */}
        <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-6 py-3">
          <div className="flex items-center justify-between">
            <Link
              href="/dashboard/candidates"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-violet-600 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Candidates
            </Link>
            <ReportActions
              sessionId={sessionId}
              currentStatus={row.status}
              candidateName={candidateName}
            />
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-6 py-6">

          {/* ── Header card ── */}
          <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              {/* Left: candidate info */}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-bold text-gray-900">{candidateName}</h1>
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusMeta.bg} ${statusMeta.color}`}>
                    {statusMeta.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500">{row.candidate_email}</p>
                <p className="mt-0.5 text-sm text-gray-500">
                  {row.job_title}{row.company_name ? ` · ${row.company_name}` : ""}
                </p>
                {row.completed_at && (
                  <p className="mt-2 text-xs text-gray-400">
                    Completed on {format(new Date(row.completed_at), "PPP")}
                  </p>
                )}
              </div>

              {/* Right: score pills */}
              {hasAnalysis && (
                <div className="flex shrink-0 items-center gap-4">
                  <div className="text-center">
                    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Score</p>
                    <p className={`mt-1 text-3xl font-bold leading-none ${
                      Number(row.overall_score) >= 65 ? "text-emerald-600"
                        : Number(row.overall_score) >= 50 ? "text-amber-500"
                        : "text-red-500"
                    }`}>
                      {Math.round(Number(row.overall_score))}
                      <span className="text-sm font-normal text-gray-400">/100</span>
                    </p>
                  </div>
                  {recMeta && (
                    <div className="text-center">
                      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Decision</p>
                      <span className={`mt-1 inline-block rounded-full px-3 py-1 text-xs font-bold ${recMeta.bg} ${recMeta.color}`}>
                        {recMeta.label}
                      </span>
                    </div>
                  )}
                  <div className="text-center">
                    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Integrity</p>
                    <p className={`mt-1 text-2xl font-bold leading-none ${
                      (row.integrity_score ?? 100) >= 70 ? "text-emerald-600" : "text-red-500"
                    }`}>
                      {row.integrity_score ?? 100}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {!hasAnalysis && (
            <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Analysis not yet available — it generates automatically once the interview completes.
            </div>
          )}

          {/* ── Main 2-col grid ── */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">

            {/* ── LEFT: AI summary + strengths/concerns + questions + transcript ── */}
            <div className="flex flex-col gap-5 lg:col-span-2">

              {/* AI Summary */}
              {hasAnalysis && row.ai_summary && (
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h2 className="mb-2 text-sm font-bold text-gray-900">AI Summary</h2>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-gray-600">
                    {row.ai_summary}
                  </p>
                </div>
              )}

              {/* Strengths & Concerns */}
              {hasAnalysis && (strengths.length > 0 || concerns.length > 0) && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {strengths.length > 0 && (
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                      <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-emerald-700">
                        Strengths
                      </h3>
                      <ul className="space-y-2">
                        {strengths.map((s, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-emerald-900">
                            <span className="mt-0.5 font-bold text-emerald-500">✓</span>
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {concerns.length > 0 && (
                    <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
                      <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-red-700">
                        Concerns
                      </h3>
                      <ul className="space-y-2">
                        {concerns.map((c, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-red-900">
                            <span className="mt-0.5 font-bold text-red-400">!</span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Per-question scores */}
              {scores.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-100 px-5 py-3.5">
                    <h2 className="text-sm font-bold text-gray-900">Question Scores</h2>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {scores.map((qs, i) => (
                      <div key={i} className="px-5 py-4">
                        <div className="flex items-start justify-between gap-4">
                          <p className="text-sm text-gray-800">
                            <span className="mr-2 font-semibold text-gray-400">Q{i + 1}.</span>
                            {qs.question_text ?? `Question ${i + 1}`}
                          </p>
                          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${
                            Number(qs.score) >= 7 ? "bg-emerald-100 text-emerald-700"
                              : Number(qs.score) >= 5 ? "bg-amber-100 text-amber-700"
                              : "bg-red-100 text-red-700"
                          }`}>
                            {qs.score}/10
                          </span>
                        </div>
                        {qs.reasoning && (
                          <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{qs.reasoning}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Transcript */}
              {turns.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-100 px-5 py-3.5">
                    <h2 className="text-sm font-bold text-gray-900">Full Transcript</h2>
                  </div>
                  <div className="max-h-[420px] divide-y divide-gray-100 overflow-y-auto">
                    {turns.map((turn, i) => (
                      <div key={i} className={`px-5 py-3.5 ${turn.role === "interviewer" ? "bg-white" : "bg-gray-50"}`}>
                        <p className={`mb-1.5 text-xs font-bold uppercase tracking-widest ${
                          turn.role === "interviewer" ? "text-violet-600" : "text-gray-400"
                        }`}>
                          {turn.role === "interviewer" ? "AI Interviewer" : "Candidate"}
                        </p>
                        <p className="text-sm leading-relaxed text-gray-700">{turn.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── RIGHT: recording + competency + proctoring ── */}
            <div className="flex flex-col gap-5">

              {/* Recording */}
              <RecordingPlayer sessionId={sessionId} />

              {/* Cost & Performance card */}
              {(hasAnalysis || turnCount > 0) && (
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h2 className="mb-4 text-sm font-bold text-gray-900">Cost &amp; Performance</h2>

                  {/* Estimated cost */}
                  {estimatedCostUsd > 0 && (
                    <div className="mb-4 rounded-xl bg-violet-50 border border-violet-100 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-widest text-violet-400 mb-0.5">Estimated Cost</p>
                      <p className="text-2xl font-bold text-violet-700">
                        ${estimatedCostUsd < 0.01 ? estimatedCostUsd.toFixed(4) : estimatedCostUsd.toFixed(3)}
                        <span className="text-sm font-normal text-violet-400 ml-1">USD</span>
                      </p>
                      <p className="mt-1 text-[11px] text-violet-400">GPT-4o + mini + TTS-1 nova</p>
                    </div>
                  )}

                  {/* Token breakdown */}
                  {(totalBrainPromptTokens + totalBrainCompletionTokens + totalScoringTokens) > 0 && (
                    <div className="mb-4 space-y-1.5 text-xs">
                      <p className="font-semibold text-gray-500 uppercase tracking-widest text-[10px] mb-2">Token Usage</p>
                      <div className="flex justify-between text-gray-700">
                        <span>GPT-4o input</span>
                        <span className="font-mono tabular-nums font-semibold">{totalBrainPromptTokens.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-gray-700">
                        <span>GPT-4o output</span>
                        <span className="font-mono tabular-nums font-semibold">{totalBrainCompletionTokens.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-gray-700">
                        <span>GPT-4o-mini (scoring)</span>
                        <span className="font-mono tabular-nums font-semibold">{totalScoringTokens.toLocaleString()}</span>
                      </div>
                      {totalTtsChars > 0 && (
                        <div className="flex justify-between text-gray-700">
                          <span>TTS characters</span>
                          <span className="font-mono tabular-nums font-semibold">{totalTtsChars.toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Latency stats */}
                  {turnCount > 0 && (
                    <div className="space-y-1.5 text-xs border-t border-gray-100 pt-4">
                      <p className="font-semibold text-gray-500 uppercase tracking-widest text-[10px] mb-2">Turn Latency ({turnCount} turns)</p>
                      {[
                        { label: "p50 (median)", value: p50Ms, warn: 1500, danger: 2500 },
                        { label: "p95",          value: p95Ms, warn: 2500, danger: 4000 },
                        { label: "Average",      value: avgMs, warn: 1500, danger: 2500 },
                      ].map(({ label, value, warn, danger }) => (
                        <div key={label} className="flex justify-between items-center">
                          <span className="text-gray-600">{label}</span>
                          <span className={`font-mono tabular-nums font-semibold ${
                            value >= danger ? "text-red-600" :
                            value >= warn   ? "text-amber-600" : "text-emerald-600"
                          }`}>
                            {value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {estimatedCostUsd === 0 && turnCount === 0 && (
                    <p className="text-xs text-gray-400">Metrics recorded for interviews completed after the Phase 2 upgrade.</p>
                  )}
                </div>
              )}

              {/* Competency scores */}
              {hasAnalysis && Object.keys(competencies).length > 0 && (
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h2 className="mb-4 text-sm font-bold text-gray-900">Competency Scores</h2>
                  <CompetencyRadar competencyScores={competencies} />
                  <div className="mt-5 space-y-3">
                    {Object.entries(competencies).map(([comp, avg]) => (
                      <div key={comp}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-gray-600 capitalize">{comp}</span>
                          <span className="font-bold text-gray-800">{Number(avg).toFixed(1)}<span className="font-normal text-gray-400">/10</span></span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-violet-500"
                            style={{ width: `${(Number(avg) / 10) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Proctoring */}
              {(() => {
                // Group events by type
                const grouped = proctoringEvents.reduce<Record<string, {
                  count: number; severity: string; first: number; last: number;
                }>>((acc, e) => {
                  const key = e.event_type;
                  if (!acc[key]) acc[key] = { count: 0, severity: e.severity, first: e.timestamp_ms, last: e.timestamp_ms };
                  acc[key].count++;
                  acc[key].last = e.timestamp_ms;
                  return acc;
                }, {});

                const integrityScore = Math.max(0, 100 - proctoringEvents.reduce((sum, e) => {
                  const penalties: Record<string, number> = {
                    tab_switch: 10, window_blur: 5, multi_face: 15, no_face: 8,
                    gaze_away: 3, paste_detected: 5, devtools_open: 20,
                    fullscreen_exit: 5, phone_detected: 20, right_click: 2,
                  };
                  return sum + (penalties[e.event_type] ?? 5);
                }, 0));

                const scoreColor = integrityScore >= 80 ? "text-emerald-600" : integrityScore >= 60 ? "text-amber-500" : "text-red-500";
                const scoreBg = integrityScore >= 80 ? "bg-emerald-50 border-emerald-100" : integrityScore >= 60 ? "bg-amber-50 border-amber-100" : "bg-red-50 border-red-100";

                const LABELS: Record<string, string> = {
                  tab_switch: "Tab Switch", window_blur: "Window Blur", multi_face: "Multiple Faces",
                  no_face: "Not in Frame", gaze_away: "Looking Away", paste_detected: "Paste Attempt",
                  right_click: "Right Click", devtools_open: "DevTools Open",
                  fullscreen_exit: "Fullscreen Exit", phone_detected: "Phone Detected",
                };

                return (
                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-sm font-bold text-gray-900">Proctoring</h2>
                        <p className="mt-0.5 text-xs text-gray-500">
                          {proctoringEvents.length === 0 ? "No violations detected" : `${proctoringEvents.length} event${proctoringEvents.length !== 1 ? "s" : ""} across ${Object.keys(grouped).length} type${Object.keys(grouped).length !== 1 ? "s" : ""}`}
                        </p>
                      </div>
                      {/* Integrity score pill */}
                      <div className={`shrink-0 rounded-xl border px-3 py-2 text-center ${scoreBg}`}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Integrity</p>
                        <p className={`text-2xl font-bold leading-none mt-0.5 ${scoreColor}`}>{integrityScore}</p>
                      </div>
                    </div>

                    {proctoringEvents.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        All clear — no integrity issues recorded
                      </div>
                    ) : (
                      <>
                        {/* Summary severity badges */}
                        <div className="mb-4 flex flex-wrap gap-2">
                          {highViolations > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700">
                              <AlertTriangle className="h-3 w-3" />{highViolations} High Risk
                            </span>
                          )}
                          {mediumViolations > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">
                              <AlertTriangle className="h-3 w-3" />{mediumViolations} Medium
                            </span>
                          )}
                          {proctoringEvents.length - highViolations - mediumViolations > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
                              {proctoringEvents.length - highViolations - mediumViolations} Low
                            </span>
                          )}
                        </div>

                        {/* Grouped by type */}
                        <div className="space-y-2">
                          {Object.entries(grouped)
                            .sort((a, b) => {
                              const order = { high: 0, medium: 1, low: 2 };
                              return (order[a[1].severity as keyof typeof order] ?? 2) - (order[b[1].severity as keyof typeof order] ?? 2);
                            })
                            .map(([type, info]) => (
                              <div key={type} className={`rounded-xl px-4 py-3 ${
                                info.severity === "high" ? "bg-red-50 border border-red-100"
                                  : info.severity === "medium" ? "bg-amber-50 border border-amber-100"
                                  : "bg-gray-50 border border-gray-100"
                              }`}>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${
                                      info.severity === "high" ? "text-red-500"
                                        : info.severity === "medium" ? "text-amber-500"
                                        : "text-gray-400"
                                    }`} />
                                    <span className={`text-sm font-semibold ${
                                      info.severity === "high" ? "text-red-800"
                                        : info.severity === "medium" ? "text-amber-800"
                                        : "text-gray-700"
                                    }`}>
                                      {LABELS[type] ?? type}
                                    </span>
                                    {info.count > 1 && (
                                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                        info.severity === "high" ? "bg-red-200 text-red-700"
                                          : info.severity === "medium" ? "bg-amber-200 text-amber-700"
                                          : "bg-gray-200 text-gray-600"
                                      }`}>
                                        ×{info.count}
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-xs text-gray-400 tabular-nums">
                                    {Math.round(info.first / 1000)}s
                                    {info.count > 1 ? ` – ${Math.round(info.last / 1000)}s` : ""}
                                  </span>
                                </div>
                              </div>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

            </div>
          </div>
        </div>
      </div>
    );
  } finally {
    client.release();
  }
}
