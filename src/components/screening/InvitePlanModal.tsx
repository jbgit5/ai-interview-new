"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, X, XCircle } from "lucide-react";
import { estimateInterviewMinutes } from "@/lib/interviewDuration";
import CandidateQuestionsEditor, { type PlanQuestion } from "./CandidateQuestionsEditor";

// "Confirm interview plan" — shown before ANY screening invite (one candidate or many).
// HR sees exactly what each candidate will be asked: their own questions first, then the job's
// common questions, plus Maya's follow-up setting. Nothing is sent until HR clicks Send, and an
// interview with zero questions can't be sent.

interface Candidate {
  screening_id: string;
  name: string;
  email: string;
  decision: string | null;
  session: { id: string; status: string } | null;
  questions: PlanQuestion[];
  suggestions: string[];
}

interface Plan {
  job: { id: string; title: string };
  common: { id: string; text: string }[];
  allow_probes: boolean;
  candidates: Candidate[];
}

interface Row extends Candidate {
  include: boolean;
  open: boolean;
  result?: { ok: boolean; message: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

export default function InvitePlanModal({ jobId, screeningIds, onClose, onDone }: { jobId: string; screeningIds: string[]; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [showCommon, setShowCommon] = useState(true);
  const [order, setOrder] = useState<"own_first" | "common_first">("own_first");

  const idsKey = screeningIds.join(",");
  useEffect(() => {
    fetch(`/api/jobs/${jobId}/screening/invite-plan?sids=${idsKey}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Couldn't load the interview plan");
        setPlan(d);
        setRows(d.candidates.map((c: Candidate, i: number) => ({
          ...c,
          include: c.decision === "shortlisted" && !c.session,
          open: d.candidates.length === 1 || i === 0,
        })));
      })
      .catch((e) => setError(e.message));
  }, [jobId, idsKey]);

  const update = (id: string, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.screening_id === id ? { ...r, ...patch } : r)));
  const common = plan?.common.length ?? 0;
  const problems = (r: Row): string | null => {
    if (r.session) return "Already has an interview";
    if (r.decision !== "shortlisted") return "Not marked Ready for interview";
    if (!r.name.trim()) return "Name missing";
    if (!EMAIL_RE.test(r.email.trim())) return "Email missing or invalid";
    if (common + r.questions.filter((q) => q.text.trim().length >= 5).length === 0) return "No questions";
    if (r.questions.some((q) => q.text.trim().length > 0 && q.text.trim().length < 5)) return "A question is too short";
    return null;
  };
  const selected = rows.filter((r) => r.include);
  const blocked = selected.filter((r) => problems(r));
  const canSend = selected.length > 0 && blocked.length === 0 && !sending && !sent;

  async function send() {
    setSending(true);
    setError("");
    const payload = selected.map((r) => ({
      screening_id: r.screening_id,
      candidate_name: r.name,
      candidate_email: r.email,
      questions: r.questions.filter((q) => q.text.trim().length >= 5),
    }));
    try {
      const res = await fetch(`/api/jobs/${jobId}/screening/invite-bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invites: payload, question_order: order }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Sending failed");
      for (const r of d.results as { screening_id: string; ok: boolean; existing?: boolean; emailSent?: boolean; emailError?: string; error?: string }[]) {
        update(r.screening_id, {
          result: !r.ok
            ? { ok: false, message: r.error ?? "Failed" }
            : r.existing ? { ok: true, message: "Already invited" }
            : r.emailSent ? { ok: true, message: "Invite sent" }
            : { ok: false, message: `Interview created, email failed (${r.emailError ?? "unknown"}). Copy the link from the Invites tab.` },
        });
      }
      setSent(true);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Confirm interview plan">
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Confirm interview plan</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              {plan ? `${plan.job.title} · check exactly what each candidate will be asked. Once the candidate starts, the interview can't be changed or stopped.` : "Loading…"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
          {!plan && !error && <div className="flex items-center gap-2 py-10 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}

          {plan && (
            <>
              {/* Common questions */}
              <div className="rounded-xl border border-gray-200">
                <button type="button" onClick={() => setShowCommon(!showCommon)} className="flex w-full items-center justify-between px-4 py-3 text-left">
                  <span className="text-sm font-semibold text-gray-900">
                    Common questions for this job <span className="font-normal text-gray-500">· {common} · asked to every candidate, {order === "common_first" ? "before" : "after"} their own questions</span>
                  </span>
                  {showCommon ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                </button>
                {showCommon && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {common === 0 ? (
                      <p className="text-sm text-gray-500">
                        None — each candidate is asked only their own questions below.{" "}
                        <Link href={`/dashboard/jobs/${jobId}/questions`} className="font-semibold text-violet-700 hover:underline">Add common questions</Link>
                      </p>
                    ) : (
                      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">{plan.common.map((q) => <li key={q.id}>{q.text}</li>)}</ol>
                    )}
                  </div>
                )}
              </div>

              {common > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 px-4 py-3">
                  <span className="text-sm font-semibold text-gray-900">Ask first:</span>
                  <div className="inline-flex rounded-lg bg-gray-100 p-0.5" role="radiogroup" aria-label="Question order">
                    {([["own_first", "Candidate's own questions"], ["common_first", "Common questions"]] as const).map(([k, label]) => (
                      <button key={k} type="button" role="radio" aria-checked={order === k} disabled={sent} onClick={() => setOrder(k)}
                        className={`rounded-md px-3 py-1 text-xs font-semibold ${order === k ? "bg-white text-violet-700 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-gray-500">{rows.length > 1 ? "Applies to every candidate in this list." : ""}</span>
                </div>
              )}

              <p className="flex items-start gap-2 rounded-xl bg-gray-50 px-4 py-2.5 text-xs text-gray-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                {plan.allow_probes
                  ? <>Follow-ups are <b>on</b> for this job: Maya may ask up to 2 short follow-up questions after an answer to understand it better. Change this in the job&apos;s Settings.</>
                  : <>Follow-ups are <b>off</b> for this job: Maya asks each question once.</>}
              </p>

              {/* Candidates */}
              {rows.map((r) => {
                const own = r.questions.filter((q) => q.text.trim().length >= 5).length;
                const total = common + own;
                const mins = estimateInterviewMinutes(total);
                const issue = problems(r);
                const locked = !!r.session || r.decision !== "shortlisted" || sent;
                return (
                  <div key={r.screening_id} className={`rounded-xl border ${r.include && issue ? "border-amber-300" : "border-gray-200"}`}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      {rows.length > 1 && (
                        <input type="checkbox" checked={r.include} disabled={locked} onChange={(e) => update(r.screening_id, { include: e.target.checked })} aria-label={`Include ${r.name}`} />
                      )}
                      <button type="button" onClick={() => update(r.screening_id, { open: !r.open })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        {r.open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
                        <span className="truncate text-sm font-semibold text-gray-900">{r.name || "Unnamed candidate"}</span>
                        <span className="shrink-0 text-xs text-gray-500">
                          · {own} own{common > 0 ? ` + ${common} common` : ""} = {total} question{total === 1 ? "" : "s"}{total > 0 ? ` · about ${mins.low}–${mins.high} min` : ""}
                        </span>
                      </button>
                      {r.result ? (
                        <span className={`inline-flex items-center gap-1 text-xs font-semibold ${r.result.ok ? "text-emerald-700" : "text-red-600"}`}>
                          {r.result.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {r.result.message}
                        </span>
                      ) : issue && (r.include || rows.length === 1) ? (
                        <span className="text-xs font-semibold text-amber-700">{issue}</span>
                      ) : null}
                    </div>
                    {r.open && !locked && (
                      <div className="space-y-3 border-t border-gray-100 px-4 py-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="text-xs font-semibold text-gray-500">Name (Maya will say this)
                            <input value={r.name} onChange={(e) => update(r.screening_id, { name: e.target.value })} maxLength={160}
                              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-normal text-gray-900 focus:border-violet-400 focus:outline-none" />
                          </label>
                          <label className="text-xs font-semibold text-gray-500">Email
                            <input value={r.email} type="email" onChange={(e) => update(r.screening_id, { email: e.target.value })} maxLength={254}
                              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-normal text-gray-900 focus:border-violet-400 focus:outline-none" />
                          </label>
                        </div>
                        {(() => {
                          // Rendered in the exact order the interview will ask them.
                          const commonFirst = order === "common_first" && common > 0;
                          const ownBlock = (
                            <div key="own">
                              <p className="mb-1.5 text-xs font-semibold text-gray-500">
                                {commonFirst ? "Then questions for this candidate" : "Questions for this candidate (asked first)"} · use the arrows to reorder
                              </p>
                              <CandidateQuestionsEditor value={r.questions} suggestions={r.suggestions} onChange={(questions) => update(r.screening_id, { questions })} compact startAt={commonFirst ? common + 1 : 1} />
                            </div>
                          );
                          const commonBlock = common > 0 && plan ? (
                            <div key="common">
                              <p className="mb-1.5 text-xs font-semibold text-gray-500">
                                {commonFirst ? "The job's common questions (asked first, same for everyone)" : "Then the job's common questions (same for everyone)"}
                              </p>
                              <ol className="space-y-1">
                                {plan.common.map((q, i) => (
                                  <li key={q.id} className="flex items-start gap-2 text-sm text-gray-600">
                                    <span className="w-4 shrink-0 text-right text-xs font-semibold text-gray-400">{(commonFirst ? 0 : own) + i + 1}</span>
                                    <span className="flex-1">{q.text}</span>
                                    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-500">Common</span>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ) : null;
                          return commonFirst ? [commonBlock, ownBlock] : [ownBlock, commonBlock];
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-xs text-gray-500">
            {sent ? "Done. You can cancel an invite from the report or the Invites tab until the candidate starts."
              : blocked.length ? `${blocked.length} selected candidate(s) need attention before sending.`
              : `${selected.length} invite${selected.length === 1 ? "" : "s"} will be sent by email. The link is valid for 7 days.`}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="sc-btn-secondary !py-2">{sent ? "Close" : "Cancel"}</button>
            {!sent && (
              <button type="button" onClick={send} disabled={!canSend} className="sc-btn-primary !py-2">
                {sending && <Loader2 className="h-4 w-4 animate-spin" />} Send {selected.length > 1 ? `${selected.length} invites` : "invite"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
