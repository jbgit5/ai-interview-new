"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, Download, FileText, Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { CATEGORY_META, CLASSIFICATION_META, DECISION_META, Pill, SESSION_META, SOURCE_META, fitColor, formatMonths } from "./labels";
import { estimateInterviewMinutes } from "@/lib/interviewDuration";
import CandidateQuestionsEditor, { type PlanQuestion } from "./CandidateQuestionsEditor";
import InvitePlanModal from "./InvitePlanModal";

// Compact candidate report: summary card → must-haves → tabs (Requirements | Experience |
// Checks | Questions) → decision bar. The original CV opens in a side drawer.

type Range = { min: number; max: number | null };
interface Evidence { source_ref: string | null; excerpt: string; verified: boolean; page: number | null; employer: string | null; title: string | null }
interface CriterionResult {
  id: string; kind: string; label: string; importance: "required" | "preferred"; hard: boolean;
  classification: string; source: "ai" | "calculated" | "hr_override"; evidence: Evidence[];
  experience: { required_years: number; months: Range | null; label: string; comparison: string } | null;
  points: number | null; hard_status: string | null; inferred: boolean; rationale: string; notes: string[];
  last_used?: { current: boolean; label: string; months_ago: number | null } | null;
}
type HrStatus = "ok" | "check" | "unclear" | "info" | "unverified";
interface HrItem { key: string; n: number; title: string; status: HrStatus; summary: string; details: string[]; tab: Tab | null }
interface CrossChecks { same_contact: { name: string; screening_id: string | null; via: string }[]; similar_text: { name: string; screening_id: string | null; similarity: number }[] }
interface ChecklistItem { kind: string; severity: "info" | "review"; message: string }
interface TimelineEntry { ref: string; start_label: string; end_label: string; months: Range | null }
interface Timeline {
  as_of: string; entries: TimelineEntry[];
  totals: { all_roles: Range; professional: Range };
  career_span: { first_label: string; last_label: string } | null;
  gaps: { kind: string; from_label: string; to_label: string; months: Range; exact: boolean }[];
  overlaps: { refs: [string, string]; months: number }[];
  short_tenures: { ref: string; months: Range; employment_type: string }[];
  assumptions: string[];
  undated_refs: string[];
  imprecise_refs: string[];
  conflicts: { ref: string; issue: string }[];
  frequent_changes: { short_tenure_count: number } | null;
}
interface Evaluation {
  criteria: CriterionResult[];
  summary: { job_fit_score: number | null; evidence_completeness: number | null; eligibility_status: string; fit_category: string };
  checklist: ChecklistItem[];
  candidate: { name: string | null; location: string | null; relocation: string | null; work_preference: string | null; emails: { value: string; format_valid: boolean }[]; phones: { value: string; format_valid: boolean }[] };
  education: { ref: string; qualification: string | null; field_of_study: string | null; institution: string | null; end: { year: number | null; month: number | null } | null }[];
  certifications: { ref: string; name: string; issuer: string | null; year: number | null }[];
  strengths: string[]; uncertainties: string[]; follow_up_questions: string[];
  corrected_refs: string[]; citation_stats: { total: number; verified: number };
}
interface ExtractedJob { ref: string; company: string | null; title: string | null; start: { year: number | null; month: number | null } | null; end: { year: number | null; month: number | null } | null; is_current: boolean; employment_type: string }
interface Report {
  id: string; status: string; error_message: string | null;
  timeline: Timeline | null; result: Evaluation | null;
  model: string | null; prompt_version: string | null; rubric_version: string | null;
  config_version: number; current_config_version: number | null;
  document_id: string; original_filename: string; mime: string; text_truncated: boolean;
  extraction: { employment: ExtractedJob[]; candidate: { name: string | null } } | null;
  docx_text: string | null;
  job: { id: string; title: string };
  decisions: { id: string; decision: string; rationale: string | null; created_at: string; recruiter_name: string | null }[];
  audit: { action: string; created_at: string; recruiter_name: string | null }[];
  session: { id: string; status: string; started_at: string | null } | null;
  other_screenings: { id: string; config_version: number }[];
  hr_checklist: HrItem[] | null;
  cross_checks: CrossChecks | null;
}

type Tab = "checklist" | "requirements" | "experience" | "checks" | "questions";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "freelance", "internship", "unknown"];
const typeLabel = (t: string) => t.replace("_", "-").replace(/^\w/, (c) => c.toUpperCase());

const levelOf = (c: CriterionResult) => (c.hard ? "Must have" : c.importance === "required" ? "Important" : "Nice to have");
const ICON: Record<string, { sym: string; cls: string }> = {
  strong: { sym: "✓", cls: "bg-emerald-100 text-emerald-700" },
  partial: { sym: "~", cls: "bg-sky-100 text-sky-700" },
  listed_only: { sym: "•", cls: "bg-amber-100 text-amber-700" },
  not_found: { sym: "–", cls: "bg-gray-100 text-gray-500" },
  does_not_meet: { sym: "✗", cls: "bg-rose-100 text-rose-700" },
  unable_to_assess: { sym: "?", cls: "bg-orange-100 text-orange-700" },
};
const HARD_CHIP: Record<string, string> = {
  met: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  unmet: "bg-rose-50 text-rose-800 ring-rose-200",
  undetermined: "bg-amber-50 text-amber-800 ring-amber-200",
};

export default function ScreeningReport({ jobId, screeningId }: { jobId: string; screeningId: string }) {
  const base = `/api/jobs/${jobId}/screening`;
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("checklist");
  const [cvOpen, setCvOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${base}/results/${screeningId}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load report");
      setReport(d);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, screeningId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!report || (report.status !== "queued" && report.status !== "processing")) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [report, load]);

  const openCv = (p?: number) => { if (p) setPage(p); setCvOpen(true); };

  async function patch(corrections: unknown) {
    setBusy("correct");
    const r = await fetch(`${base}/results/${screeningId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ corrections }) });
    if (!r.ok) alert((await r.json().catch(() => ({}))).error ?? "Correction failed");
    await load();
    setBusy("");
  }

  async function post(path: string) {
    setBusy(path);
    const r = await fetch(`${base}/results/${screeningId}/${path}`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy("");
    if (!r.ok) alert(d.error ?? "Action failed");
    return r.ok ? d : null;
  }

  if (error) return <p className="m-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!report) return <div className="flex items-center gap-2 p-10 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  const ev = report.result;
  const name = ev?.candidate.name || report.extraction?.candidate.name || report.original_filename;
  const hard = ev?.criteria.filter((c) => c.hard) ?? [];
  const reviewChecks = ev?.checklist.filter((c) => c.severity === "review") ?? [];
  const newer = report.other_screenings.find((s) => s.config_version > report.config_version);
  const outdated = report.current_config_version != null && report.config_version < report.current_config_version;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6 pb-10">
      <div className="flex items-center justify-between gap-3">
        <Link href={`/dashboard/jobs/${jobId}/screening`} className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-violet-600">
          <ArrowLeft className="h-4 w-4" /> Candidates
        </Link>
        {newer ? (
          <Link href={`/dashboard/jobs/${jobId}/screening/${newer.id}`} className="text-xs font-semibold text-amber-700 hover:underline">View result for the latest requirements →</Link>
        ) : outdated ? (
          <button type="button" disabled={!!busy} onClick={async () => { const d = await post("rescreen"); if (d) window.location.href = `/dashboard/jobs/${jobId}/screening/${d.screening_id}`; }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:underline">
            <RefreshCw className="h-3.5 w-3.5" /> Screened with older requirements — re-screen
          </button>
        ) : null}
      </div>

      {/* Summary */}
      <div className="sc-card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <NameHeader name={name} onSave={(n) => patch({ candidate: { name: n } })} />
            <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-gray-500">
              {ev?.candidate.emails[0] && <span>{ev.candidate.emails[0].value}</span>}
              {ev?.candidate.phones[0] && <span>{ev.candidate.phones[0].value}</span>}
              {ev?.candidate.location && <span>{ev.candidate.location}</span>}
              {tlTotal(report.timeline) && <span>{tlTotal(report.timeline)} experience</span>}
            </p>
          </div>
          {ev && (
            <div className="flex items-center gap-4">
              <div className="text-right" title="How strongly the CV supports the requirements (fixed rubric).">
                <p className={`text-3xl font-bold leading-none ${fitColor(ev.summary.job_fit_score)}`}>{ev.summary.job_fit_score ?? "—"}<span className="text-sm font-medium text-gray-400">/100</span></p>
                <p className="mt-1 text-[11px] text-gray-400">
                  fit · evidence for {ev.summary.evidence_completeness != null ? Math.round(ev.summary.evidence_completeness * 100) : "—"}%
                </p>
              </div>
            </div>
          )}
          <button type="button" onClick={() => openCv()} className="sc-btn-secondary !py-2"><FileText className="h-4 w-4" /> View CV</button>
        </div>

        {ev && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
            <Pill meta={CATEGORY_META[ev.summary.fit_category]} />
            {hard.length > 0 ? (
              <>
                <span className="ml-1 text-xs font-semibold text-gray-400">Must-haves</span>
                {hard.map((c) => (
                  <span key={c.id} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${HARD_CHIP[c.hard_status ?? "undetermined"]}`}>
                    {c.hard_status === "met" ? "✓" : c.hard_status === "unmet" ? "✗" : "?"} {c.label}
                    {c.experience?.months && <span className="font-normal opacity-70">· {formatMonths(c.experience.months)}</span>}
                  </span>
                ))}
              </>
            ) : (
              <span className="text-xs text-gray-400">No must-haves set for this job</span>
            )}
          </div>
        )}
      </div>

      {report.status !== "completed" && (
        <div className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm ring-1 ${report.status === "failed" ? "bg-red-50 text-red-800 ring-red-200" : "bg-violet-50 text-violet-800 ring-violet-200"}`}>
          {report.status === "failed" ? <AlertTriangle className="mt-0.5 h-4 w-4" /> : <Loader2 className="mt-0.5 h-4 w-4 animate-spin" />}
          <p className="flex-1">
            {report.status === "failed" ? <>{report.error_message} You can still open the CV and record a decision below.</> : "Screening this CV… the report appears automatically."}
          </p>
          {report.status === "failed" && <button type="button" onClick={async () => { await post("retry"); load(); }} className="font-semibold hover:underline">Retry</button>}
        </div>
      )}

      {ev && report.timeline && report.status === "completed" && (
        <AttentionStrip ev={ev} tl={report.timeline} cross={report.cross_checks} hr={report.hr_checklist} onJump={(t) => { setTab(t); document.getElementById("report-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />
      )}

      {ev && report.timeline && (
        <div id="report-tabs" className="sc-card overflow-hidden">
          <nav className="flex gap-1 border-b border-gray-100 px-3" role="tablist">
            {([
              ["checklist", report.hr_checklist ? `HR checklist (${report.hr_checklist.filter((i) => i.status === "check").length} to check)` : "HR checklist"],
              ["requirements", `Requirements (${ev.criteria.length})`],
              ["experience", "Experience"],
              ["checks", reviewChecks.length ? `Checks (${reviewChecks.length})` : "Checks"],
              ["questions", "Interview questions"],
            ] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`border-b-2 px-3 py-3 text-sm font-semibold transition ${tab === k ? "border-violet-600 text-violet-700" : "border-transparent text-gray-500 hover:text-gray-900"}`}>
                {label}
              </button>
            ))}
          </nav>
          <div className="p-5">
            {tab === "checklist" && (report.hr_checklist
              ? <HrChecklistTab items={report.hr_checklist} onJump={(t) => setTab(t)} />
              : <p className="text-sm text-gray-500">The checklist appears once screening is complete.</p>)}
            {tab === "requirements" && <RequirementsTab criteria={ev.criteria} onPage={openCv} onOverride={(id, cls, note) => patch({ criteria: { [id]: { classification: cls, note } } })} busy={busy === "correct"} />}
            {tab === "experience" && report.extraction && (
              <ExperienceTab tl={report.timeline} jobs={report.extraction.employment} ev={ev} onCorrect={(ref, fix) => patch({ employment: { [ref]: fix } })} busy={busy === "correct"} />
            )}
            {tab === "checks" && <ChecksTab ev={ev} report={report} />}
            {tab === "questions" && <PrepTab ev={ev} base={`${base}/results/${screeningId}`} />}
          </div>
        </div>
      )}

      <DecisionBar report={report} jobId={jobId} screeningId={screeningId} onChanged={load} />

      {/* CV drawer */}
      {cvOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setCvOpen(false)}>
          <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Original CV">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <p className="truncate text-sm font-semibold text-gray-900">{report.original_filename}</p>
              <div className="flex items-center gap-1">
                <a href={`${base}/documents/${report.document_id}/file?download=1`} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" title="Download" aria-label="Download CV"><Download className="h-4 w-4" /></a>
                <button type="button" onClick={() => setCvOpen(false)} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Close"><X className="h-4 w-4" /></button>
              </div>
            </div>
            {report.mime === "application/pdf" ? (
              <iframe key={page} title="Original CV" src={`${base}/documents/${report.document_id}/file#page=${page}`} className="flex-1 bg-gray-50" />
            ) : (
              <div className="flex-1 overflow-y-auto whitespace-pre-wrap p-5 text-sm leading-relaxed text-gray-700">
                <p className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">Word files can&apos;t be previewed — this is the extracted text. Download for the original layout.</p>
                {report.docx_text ?? "Text not extracted yet."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── HR checklist tab: the HR team's 13 points ──
const HR_ICON: Record<HrStatus, { sym: string; cls: string; label: string }> = {
  ok: { sym: "✓", cls: "bg-emerald-100 text-emerald-700", label: "Looks fine" },
  check: { sym: "!", cls: "bg-amber-100 text-amber-800", label: "Check this" },
  unclear: { sym: "?", cls: "bg-orange-100 text-orange-700", label: "Not enough information" },
  info: { sym: "i", cls: "bg-sky-100 text-sky-700", label: "Facts only (no requirement set)" },
  unverified: { sym: "◌", cls: "bg-gray-100 text-gray-600", label: "Candidate's claim, not verified" },
};

function HrChecklistTab({ items, onJump }: { items: HrItem[]; onJump: (t: Tab) => void }) {
  const [open, setOpen] = useState<string | null>(items.find((i) => i.status === "check")?.key ?? null);
  const counts = items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.status]: (m[i.status] ?? 0) + 1 }), {});
  const tabName: Record<string, string> = { requirements: "Requirements", experience: "Experience", checks: "Checks", questions: "Interview questions" };
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {(Object.keys(HR_ICON) as HrStatus[]).filter((k) => counts[k]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 font-medium text-gray-700 ring-1 ring-gray-200">
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${HR_ICON[k].cls}`}>{HR_ICON[k].sym}</span>
            {counts[k]} {HR_ICON[k].label.toLowerCase()}
          </span>
        ))}
      </div>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
        {items.map((it) => {
          const ic = HR_ICON[it.status];
          const isOpen = open === it.key;
          return (
            <li key={it.key}>
              <button type="button" onClick={() => setOpen(isOpen ? null : it.key)} aria-expanded={isOpen} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50">
                <span className="w-5 shrink-0 text-right text-xs font-semibold text-gray-400">{it.n}</span>
                <span title={ic.label} className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ic.cls}`}>{ic.sym}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900">{it.title}</span>
                  <span className={`block truncate text-xs ${it.status === "check" ? "text-amber-800" : "text-gray-500"}`}>{it.summary}</span>
                </span>
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
              </button>
              {isOpen && (
                <div className="space-y-1.5 bg-gray-50/60 px-3 pb-3 pl-[4.25rem]">
                  {it.details.length ? (
                    <ul className="space-y-1 text-sm text-gray-700">
                      {it.details.map((d, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-400" />{d}</li>)}
                    </ul>
                  ) : <p className="text-sm text-gray-500">Nothing found.</p>}
                  {it.tab && (
                    <button type="button" onClick={() => onJump(it.tab!)} className="text-xs font-semibold text-violet-700 hover:underline">Open {tabName[it.tab]} →</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-gray-400">
        Your team&apos;s CV checklist, filled in automatically from the CV. Only the Requirements count toward the score — everything else is for you to review or ask about.
      </p>
    </div>
  );
}

/** Candidate name in the report header. HR can correct it; the change flows to invites and interviews. */
function NameHeader({ name, onSave }: { name: string; onSave: (n: string | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing) {
    return (
      <h1 className="group flex min-w-0 items-center gap-2 text-xl font-bold text-gray-900">
        <span className="truncate">{name}</span>
        <button type="button" onClick={() => { setValue(name); setEditing(true); }} className="shrink-0 rounded p-1 text-gray-300 opacity-0 hover:text-violet-700 focus:opacity-100 group-hover:opacity-100" aria-label="Correct candidate name" title="Correct the name. The interview will use it.">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </h1>
    );
  }
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await onSave(value.trim() || null); setEditing(false); }} className="flex flex-wrap items-center gap-2">
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={160} aria-label="Candidate name"
        className="min-w-[220px] rounded-lg border border-gray-200 px-2 py-1 text-xl font-bold focus:border-violet-400 focus:outline-none" />
      <button type="submit" className="sc-btn-primary !px-3 !py-1.5 !text-xs">Save name</button>
      <button type="button" onClick={() => setEditing(false)} className="text-xs font-medium text-gray-500 hover:text-gray-800">Cancel</button>
    </form>
  );
}

function tlTotal(tl: Timeline | null): string | null {
  if (!tl || (tl.totals.professional.min === 0 && tl.totals.professional.max === 0)) return null;
  return formatMonths(tl.totals.professional);
}

// ── Requirements tab ──
function RequirementsTab({ criteria, onPage, onOverride, busy }: { criteria: CriterionResult[]; onPage: (p: number) => void; onOverride: (id: string, cls: string, note: string) => void; busy: boolean }) {
  if (!criteria.length) return <p className="text-sm text-gray-500">No requirements were set when this CV was screened.</p>;
  const rank = (c: CriterionResult) => (c.hard ? 0 : c.importance === "required" ? 1 : 2);
  const sorted = [...criteria].sort((a, b) => rank(a) - rank(b));
  return (
    <div>
      <ul className="divide-y divide-gray-100">
        {sorted.map((c) => <CriterionRow key={c.id} c={c} onPage={onPage} onOverride={onOverride} busy={busy} />)}
      </ul>
      <p className="mt-3 text-xs text-gray-400">✓ shown in work history · ~ partly · • only listed · – not in CV (not proof they lack it) · ✗ CV says otherwise · ? needs a look</p>
    </div>
  );
}

function CriterionRow({ c, onPage, onOverride, busy }: { c: CriterionResult; onPage: (p: number) => void; onOverride: (id: string, cls: string, note: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cls, setCls] = useState(c.classification);
  const [note, setNote] = useState("");
  const icon = ICON[c.classification] ?? ICON.unable_to_assess;
  return (
    <li className="py-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 text-left" aria-expanded={open}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${icon.cls}`}>{icon.sym}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-gray-900">{c.label}</span>
          <span className="block text-xs text-gray-500">
            {CLASSIFICATION_META[c.classification]?.label}
            {c.experience && ` · ${c.experience.label} (needs ${c.experience.required_years} yr)`}
            {c.last_used && ` · ${c.last_used.label}`}
            {c.source === "hr_override" && " · corrected by HR"}
          </span>
        </span>
        <span className={`hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase sm:inline ${c.hard ? "bg-rose-50 text-rose-700" : c.importance === "required" ? "bg-violet-50 text-violet-700" : "bg-gray-50 text-gray-500"}`}>
          {levelOf(c)}
        </span>
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
      </button>
      {open && (
        <div className="ml-9 mt-2 space-y-2 text-sm">
          {c.rationale && <p className="text-gray-700">{c.rationale}</p>}
          {c.evidence.map((e, i) => (
            <div key={i} className={`rounded-lg border-l-2 px-3 py-1.5 text-xs ${e.verified ? "border-emerald-300 bg-gray-50" : "border-red-300 bg-red-50/60"}`}>
              <span className="italic text-gray-700">&ldquo;{e.excerpt}&rdquo;</span>
              {(e.title || e.employer) && <span className="text-gray-500"> — {[e.title, e.employer].filter(Boolean).join(", ")}</span>}
              {e.verified ? e.page ? <button type="button" onClick={() => onPage(e.page!)} className="ml-2 font-semibold text-violet-700 hover:underline">p. {e.page}</button> : null
                : <span className="ml-2 font-semibold text-red-600">not found in CV — ignored</span>}
            </div>
          ))}
          {c.notes.map((n, i) => <p key={i} className="text-xs text-amber-700">{n}</p>)}
          <p className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
            <Pill meta={SOURCE_META[c.source]} className="!px-2 !text-[10px]" />
            {c.inferred && "relies on inference"}
          </p>
          {!editing ? (
            <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:underline"><Pencil className="h-3 w-3" /> Correct this</button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2">
              <select value={cls} onChange={(e) => setCls(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs" aria-label="Corrected assessment">
                {Object.entries(CLASSIFICATION_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why? (e.g. confirmed on a call)" className="min-w-[180px] flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs" />
              <button type="button" disabled={busy || !note.trim()} onClick={() => { onOverride(c.id, cls, note.trim()); setEditing(false); }} className="sc-btn-primary !px-3 !py-1.5 !text-xs">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="rounded p-1 text-gray-400 hover:text-gray-700" aria-label="Cancel"><X className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Experience tab ──
function ExperienceTab({ tl, jobs, ev, onCorrect, busy }: { tl: Timeline; jobs: ExtractedJob[]; ev: Evaluation; onCorrect: (ref: string, fix: Record<string, unknown>) => void; busy: boolean }) {
  const [editRef, setEditRef] = useState<string | null>(null);
  const byRef = new Map(tl.entries.map((e) => [e.ref, e]));
  const gapLabel: Record<string, string> = { between_roles: "Gap between roles", education_to_first_role: "Education → first job", since_last_role: "Since last listed role" };
  const observations = [
    ...tl.gaps.map((g) => `${gapLabel[g.kind] ?? "Gap"}: ${g.from_label} → ${g.to_label} (${formatMonths(g.months)}${g.exact ? "" : ", approx."})`),
    ...tl.overlaps.map((o) => `${o.refs.join(" & ")} overlap by ${o.months} months`),
    ...tl.short_tenures.map((s) => `Short role ${s.ref}: ${formatMonths(s.months)} (${typeLabel(s.employment_type)})`),
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-6 text-sm">
        <Stat label="Professional experience" value={formatMonths(tl.totals.professional)} />
        <Stat label="Including internships" value={formatMonths(tl.totals.all_roles)} />
        {tl.career_span && <Stat label="Career" value={`${tl.career_span.first_label} – ${tl.career_span.last_label}`} />}
      </div>

      <ol className="relative space-y-3 border-l border-gray-200 pl-5">
        {jobs.map((j) => {
          const e = byRef.get(j.ref);
          return (
            <li key={j.ref} className="relative">
              <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-violet-500" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{j.title ?? <span className="italic text-amber-700">Title missing</span>}</p>
                  <p className="text-sm text-gray-600">{j.company ?? <span className="italic text-amber-700">Employer missing</span>}</p>
                  <p className="text-xs text-gray-500">
                    {e ? `${e.start_label} – ${e.end_label}` : "Dates missing"}
                    {e?.months ? ` · ${formatMonths(e.months)}` : " · can't measure"}
                    {j.employment_type !== "unknown" && ` · ${typeLabel(j.employment_type)}`}
                    {ev.corrected_refs.includes(j.ref) && <span className="text-amber-700"> · corrected by HR</span>}
                  </p>
                </div>
                <button type="button" onClick={() => setEditRef(editRef === j.ref ? null : j.ref)} className="rounded p-1.5 text-gray-300 hover:bg-gray-100 hover:text-violet-700" aria-label={`Correct ${j.title ?? j.ref}`} title="Correct">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
              {editRef === j.ref && <JobEditor job={j} busy={busy} onCancel={() => setEditRef(null)} onSave={(fix) => { onCorrect(j.ref, fix); setEditRef(null); }} />}
            </li>
          );
        })}
        {jobs.length === 0 && <li className="text-sm text-gray-500">No employment history found in the CV.</li>}
      </ol>

      {observations.length > 0 && (
        <div className="rounded-xl bg-gray-50 p-3">
          <p className="mb-1 text-xs font-semibold text-gray-500">Timeline notes — facts only, never scored</p>
          <ul className="space-y-0.5 text-sm text-gray-700">{observations.map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
      )}

      {(ev.education.length > 0 || ev.certifications.length > 0) && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Education & certificates</p>
          <ul className="space-y-0.5 text-sm text-gray-700">
            {ev.education.map((e) => (
              <li key={e.ref}>{[e.qualification, e.field_of_study].filter(Boolean).join(", ") || "Qualification"}{e.institution && <span className="text-gray-500"> · {e.institution}</span>}{e.end?.year && <span className="text-gray-500"> · {e.end.month ? `${MONTHS[e.end.month - 1]} ` : ""}{e.end.year}</span>}</li>
            ))}
            {ev.certifications.map((c) => <li key={c.ref}>{c.name}{c.issuer && <span className="text-gray-500"> · {c.issuer}</span>}{c.year && <span className="text-gray-500"> · {c.year}</span>}</li>)}
          </ul>
        </div>
      )}

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer">How durations are calculated</summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-5">{tl.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
      </details>
    </div>
  );
}

function JobEditor({ job, onSave, onCancel, busy }: { job: ExtractedJob; onSave: (fix: Record<string, unknown>) => void; onCancel: () => void; busy: boolean }) {
  const [company, setCompany] = useState(job.company ?? "");
  const [title, setTitle] = useState(job.title ?? "");
  const [sy, setSy] = useState(job.start?.year?.toString() ?? "");
  const [sm, setSm] = useState(job.start?.month?.toString() ?? "");
  const [ey, setEy] = useState(job.end?.year?.toString() ?? "");
  const [em, setEm] = useState(job.end?.month?.toString() ?? "");
  const [current, setCurrent] = useState(job.is_current);
  const [type, setType] = useState(job.employment_type);
  const ym = (y: string, m: string) => (y ? { year: Number(y), month: m ? Number(m) : null } : null);
  const input = "rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none";
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-violet-50/50 p-3 ring-1 ring-violet-100">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" aria-label="Job title" />
        <input className={input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Employer" aria-label="Employer" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <MonthSelect value={sm} onChange={setSm} label="Start month" />
        <input className={`${input} w-20`} type="number" value={sy} onChange={(e) => setSy(e.target.value)} placeholder="Year" aria-label="Start year" />
        <span>to</span>
        {current ? <span className="font-medium">Present</span> : (
          <>
            <MonthSelect value={em} onChange={setEm} label="End month" />
            <input className={`${input} w-20`} type="number" value={ey} onChange={(e) => setEy(e.target.value)} placeholder="Year" aria-label="End year" />
          </>
        )}
        <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={current} onChange={(e) => setCurrent(e.target.checked)} /> current</label>
        <select className={input} value={type} onChange={(e) => setType(e.target.value)} aria-label="Employment type">
          {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onSave({ company: company || null, title: title || null, start: ym(sy, sm), end: current ? null : ym(ey, em), is_current: current, employment_type: type })} className="sc-btn-primary !px-3 !py-1.5 !text-xs">
          Save — recalculates the report
        </button>
        <button type="button" onClick={onCancel} className="sc-btn-secondary !px-3 !py-1.5 !text-xs">Cancel</button>
      </div>
    </div>
  );
}

function MonthSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Month</option>
      {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
    </select>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="font-semibold text-gray-900">{value}</p>
    </div>
  );
}

// ── Checks tab ──
function ChecksTab({ ev, report }: { ev: Evaluation; report: Report }) {
  const [showAll, setShowAll] = useState(false);
  const review = ev.checklist.filter((c) => c.severity === "review");
  const info = ev.checklist.filter((c) => c.severity === "info");
  return (
    <div className="space-y-4">
      {review.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700"><Check className="h-4 w-4" /> Nothing needs checking.</p>
      ) : (
        <ul className="space-y-2">
          {review.map((c, i) => <li key={i} className="flex gap-2 text-sm text-gray-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />{c.message}</li>)}
        </ul>
      )}
      {info.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAll(!showAll)} className="text-xs font-semibold text-gray-500 hover:text-gray-800">{showAll ? "Hide" : `Show ${info.length} more`} notes</button>
          {showAll && <ul className="mt-2 space-y-1">{info.map((c, i) => <li key={i} className="flex gap-2 text-sm text-gray-500"><Check className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />{c.message}</li>)}</ul>}
        </div>
      )}
      <details className="border-t border-gray-100 pt-3 text-xs text-gray-500">
        <summary className="cursor-pointer">About this result</summary>
        <p className="mt-2">
          Requirements v{report.config_version} · rubric {report.rubric_version ?? "—"} · prompt {report.prompt_version ?? "—"} · model {report.model ?? "—"} ·
          {" "}{ev.citation_stats.verified}/{ev.citation_stats.total} AI quotes found in the CV{report.text_truncated ? " · long CV, only the first part analysed" : ""}.
        </p>
        <ul className="mt-2 space-y-0.5">{report.audit.slice(0, 15).map((a, i) => <li key={i}>{new Date(a.created_at).toLocaleString()} · {a.recruiter_name ?? "Recruiter"} · {a.action.replace(/_/g, " ")}</li>)}</ul>
      </details>
    </div>
  );
}

// ── Interview questions tab ──
function PrepTab({ ev, base }: { ev: Evaluation; base: string }) {
  const [plan, setPlan] = useState<{ questions: PlanQuestion[]; suggestions: string[]; common: { id: string; text: string }[]; session: { id: string } | null; prepared: boolean } | null>(null);
  const [questions, setQuestions] = useState<PlanQuestion[]>([]);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`${base}/questions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPlan(d);
        setQuestions(d.questions);
        setSaved(JSON.stringify(d.questions));
      })
      .catch(() => {});
  }, [base]);

  async function save() {
    setSaving(true);
    setMsg("");
    const clean = questions.filter((q) => q.text.trim().length >= 5);
    const r = await fetch(`${base}/questions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: clean }) });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) return setMsg(d.error ?? "Couldn't save");
    setQuestions(d.questions);
    setSaved(JSON.stringify(d.questions));
    setMsg("Saved. These will be in the interview plan when you invite this candidate.");
  }

  const dirty = JSON.stringify(questions) !== saved;
  const own = questions.filter((q) => q.text.trim().length >= 5).length;
  const total = own + (plan?.common.length ?? 0);
  const mins = estimateInterviewMinutes(total);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Bullets title="Strengths" items={ev.strengths} dot="bg-emerald-500" />
        <Bullets title="To clarify in the interview" items={ev.uncertainties} dot="bg-amber-500" />
      </div>

      {!plan ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading questions…</div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-gray-900">This candidate&apos;s interview</p>
              <p className="text-xs text-gray-500">
                {total === 0 ? "No questions yet — add at least one before inviting." : `${total} question${total === 1 ? "" : "s"} · about ${mins.low}–${mins.high} minutes`}
              </p>
            </div>
            {!plan.session && (
              <button type="button" onClick={save} disabled={saving || !dirty} className="sc-btn-primary !py-1.5 !text-xs">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {dirty ? "Save questions" : "Saved"}
              </button>
            )}
          </div>
          {msg && <p className="text-xs text-emerald-700">{msg}</p>}

          <div className="rounded-xl border border-gray-200 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">1 · Questions for this candidate (asked first)</p>
            {plan.session ? (
              <p className="text-sm text-gray-500">This candidate has already been invited — their questions are fixed. See them on the Invites tab.</p>
            ) : (
              <CandidateQuestionsEditor value={questions} suggestions={plan.suggestions} onChange={setQuestions} />
            )}
            {!plan.prepared && !plan.session && questions.length > 0 && (
              <p className="mt-2 text-[11px] text-gray-400">Pre-filled from the CV screening. Edit, remove or add your own, then save.</p>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">2 · Common questions for this job (asked to everyone)</p>
            {plan.common.length === 0 ? (
              <p className="text-sm text-gray-500">None yet. That&apos;s fine if this candidate has their own questions.</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">{plan.common.map((q) => <li key={q.id}>{q.text}</li>)}</ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Bullets({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</p>
      {items.length ? (
        <ul className="space-y-1.5">{items.map((s, i) => <li key={i} className="flex gap-2 text-sm text-gray-700"><span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />{s}</li>)}</ul>
      ) : <p className="text-sm text-gray-400">None noted.</p>}
    </div>
  );
}

// ── Attention strip: facts HR should not miss (never part of the score) ──
function AttentionStrip({ ev, tl, cross, hr, onJump }: { ev: Evaluation; tl: Timeline; cross: CrossChecks | null; hr: HrItem[] | null; onJump: (t: Tab) => void }) {
  const items: { label: string; tab: Tab; tone: "rose" | "amber" }[] = [];
  const contactItem = hr?.find((i) => i.key === "contact");
  const mustUnmet = ev.criteria.filter((c) => c.hard && c.hard_status === "unmet");
  const mustUnclear = ev.criteria.filter((c) => c.hard && c.hard_status === "undetermined");
  if (mustUnmet.length) items.push({ label: `Must-have not met: ${mustUnmet.map((c) => c.label).join(", ")}`, tab: "requirements", tone: "rose" });
  if (mustUnclear.length) items.push({ label: `Must-have unclear: ${mustUnclear.map((c) => c.label).join(", ")}`, tab: "requirements", tone: "amber" });
  for (const g of tl.gaps) {
    const what = g.kind === "education_to_first_role" ? "Gap after education" : g.kind === "since_last_role" ? "No current role" : "Employment gap";
    items.push({ label: `${what}: ${formatMonths(g.months)} (${g.from_label} – ${g.to_label})`, tab: "experience", tone: "amber" });
  }
  if (tl.undated_refs.length) items.push({ label: `${tl.undated_refs.length} job(s) with missing dates`, tab: "experience", tone: "amber" });
  if (tl.conflicts.length) items.push({ label: `${tl.conflicts.length} date conflict(s)`, tab: "checks", tone: "amber" });
  if (tl.short_tenures.length) items.push({ label: `${tl.short_tenures.length} job(s) shorter than the set minimum`, tab: "experience", tone: "amber" });
  if (tl.frequent_changes) items.push({ label: `Several short jobs (${tl.frequent_changes.short_tenure_count})`, tab: "experience", tone: "amber" });
  if (tl.overlaps.length) items.push({ label: `${tl.overlaps.length} overlapping job(s)`, tab: "experience", tone: "amber" });
  for (const d of cross?.same_contact ?? []) items.push({ label: `Same ${d.via} as ${d.name}`, tab: "checklist", tone: "rose" });
  for (const d of cross?.similar_text ?? []) items.push({ label: `CV text ~${Math.round(d.similarity * 100)}% identical to ${d.name}`, tab: "checklist", tone: "rose" });
  if (contactItem?.status === "check" && !(cross?.same_contact.length)) items.push({ label: "Email or phone to check", tab: "checklist", tone: "amber" });
  const unverified = ev.citation_stats.total - ev.citation_stats.verified;
  if (unverified > 0) items.push({ label: `${unverified} AI quote(s) not found in CV`, tab: "checks", tone: "amber" });
  if (!ev.candidate.emails.some((e) => e.format_valid) && contactItem?.status !== "check") items.push({ label: "No valid email in CV", tab: "checks", tone: "rose" });
  if (ev.checklist.some((c) => c.kind === "cv_observation" && c.severity === "review")) items.push({ label: "Contradictions in CV", tab: "checks", tone: "amber" });

  if (!items.length) {
    return <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 ring-1 ring-emerald-200"><Check className="h-4 w-4" /> No gaps, date problems or open must-haves found.</p>;
  }
  return (
    <div className="rounded-xl bg-amber-50/70 px-4 py-3 ring-1 ring-amber-200">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-800"><AlertTriangle className="h-3.5 w-3.5" /> Needs your attention ({items.length})</p>
      <div className="flex flex-wrap gap-2">
        {items.map((it, i) => (
          <button key={i} type="button" onClick={() => onJump(it.tab)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition hover:shadow-sm ${it.tone === "rose" ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-white text-amber-900 ring-amber-200"}`}>
            {it.label} →
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-amber-800/70">Facts to check or ask about — gaps and short jobs are never used in the score.</p>
    </div>
  );
}

// ── Decision bar ──
const DECISIONS = [
  { key: "shortlisted", label: "Ready for interview", active: "bg-emerald-600 text-white ring-emerald-600" },
  { key: "hold", label: "On hold", active: "bg-amber-500 text-white ring-amber-500" },
  { key: "needs_review", label: "Needs review", active: "bg-violet-600 text-white ring-violet-600" },
  { key: "rejected", label: "Not suitable", active: "bg-gray-800 text-white ring-gray-800" },
] as const;

function DecisionBar({ report, jobId, screeningId, onChanged }: { report: Report; jobId: string; screeningId: string; onChanged: () => void }) {
  const base = `/api/jobs/${jobId}/screening/results/${screeningId}`;
  const current = report.decisions[0] ?? null;
  const [choice, setChoice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const needsReason = choice === "shortlisted" || choice === "rejected";

  async function save() {
    setSaving(true);
    setErr("");
    const r = await fetch(`${base}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: choice, rationale: reason }) });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) return setErr(d.error ?? "Couldn't save");
    setChoice(null);
    setReason("");
    onChanged();
  }

  async function cancelInvite() {
    if (!report.session) return;
    if (!confirm("Cancel this interview invite? The candidate's link will stop working. You can invite them again later.")) return;
    setSaving(true);
    const r = await fetch(`/api/jobs/${jobId}/invites/${report.session.id}/cancel`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) return setErr(d.error ?? "Couldn't cancel");
    onChanged();
  }

  const session = report.session;
  const canCancel = session?.status === "pending" && !session.started_at;

  return (
    <div className="sc-card sticky bottom-4 z-10 p-4 shadow-lg">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Screening decision</p>
          {current ? (
            <p className="truncate text-xs text-gray-500">
              {DECISION_META[current.decision]?.label} · {current.recruiter_name ?? "a recruiter"}, {new Date(current.created_at).toLocaleDateString()}
              {current.rationale && <> — &ldquo;{current.rationale}&rdquo;</>}
            </p>
          ) : (
            <p className="text-xs text-gray-500">Not decided yet. This decides only whether the candidate goes to interview.</p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5" role="radiogroup" aria-label="Screening decision">
          {DECISIONS.map((d) => {
            const isSaved = current?.decision === d.key;
            const isPicked = choice === d.key;
            return (
              <button
                key={d.key}
                type="button"
                role="radio"
                aria-checked={isSaved || isPicked}
                disabled={isSaved || saving}
                onClick={() => setChoice(isPicked ? null : d.key)}
                title={isSaved ? "Current decision" : undefined}
                className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                  isSaved ? `${d.active} cursor-default` : isPicked ? `${d.active} opacity-80` : "bg-white text-gray-700 ring-gray-200 hover:bg-gray-50"
                }`}
              >
                {isSaved && <Check className="h-3.5 w-3.5" />} {d.label}
              </button>
            );
          })}
        </div>
      </div>

      {choice && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus
            placeholder={needsReason ? "Reason (required) — based on job-related evidence" : "Note (optional)"}
            className="min-w-[240px] flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none" aria-label="Decision reason" />
          <button type="button" onClick={save} disabled={saving || (needsReason && reason.trim().length < 3)} className="sc-btn-primary !py-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save decision
          </button>
          <button type="button" onClick={() => { setChoice(null); setReason(""); }} className="text-xs font-medium text-gray-500 hover:text-gray-800">Cancel</button>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

      {!choice && (current?.decision === "shortlisted" || session) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
          {session ? (
            <>
              <span className={`text-sm font-semibold ${SESSION_META[session.status]?.cls ?? "text-gray-700"}`}>{SESSION_META[session.status]?.label ?? session.status}</span>
              {session.status === "completed" && <Link href={`/dashboard/reports/${session.id}`} className="text-sm font-semibold text-violet-700 hover:underline">Open interview report</Link>}
              {canCancel && <button type="button" onClick={cancelInvite} disabled={saving} className="text-xs font-semibold text-red-600 hover:underline">Cancel invite</button>}
            </>
          ) : (
            <>
              <span className="text-sm text-gray-600">Ready for interview — review the questions and send the invite.</span>
              <button type="button" onClick={() => setPlanOpen(true)} className="sc-btn-primary ml-auto !py-1.5">Invite to interview</button>
            </>
          )}
        </div>
      )}

      {planOpen && <InvitePlanModal jobId={jobId} screeningIds={[screeningId]} onClose={() => setPlanOpen(false)} onDone={onChanged} />}
    </div>
  );
}
