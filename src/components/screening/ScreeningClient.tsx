"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, RotateCcw, Search, Send, Trash2, UploadCloud, X, XCircle } from "lucide-react";
import { CATEGORY_META, DECISION_META, Pill, SESSION_META, fitColor } from "./labels";
import InvitePlanModal from "./InvitePlanModal";

// Candidates tab: upload CVs, watch progress, scan results, open a report.

interface ResultRow {
  document_id: string;
  original_filename: string;
  uploaded_at: string;
  candidate_name: string | null;
  screening_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  error_message: string | null;
  job_fit_score: number | null;
  evidence_completeness: number | null;
  eligibility_status: string | null;
  fit_category: string | null;
  config_version: number;
  outdated: boolean;
  decision: string | null;
  session_id: string | null;
  session_status: string | null;
  gap_count: number;
  review_count: number;
  must_open: number;
}

interface UploadItem {
  key: string;
  name: string;
  state: "pending" | "uploading" | "uploaded" | "duplicate" | "error";
  message?: string;
}

const MAX_MB = 10;
const ACCEPT = ".pdf,.docx";
const PARALLEL = 3;

const ELIGIBILITY_SHORT: Record<string, { icon: string; label: string; cls: string }> = {
  meets: { icon: "✓", label: "Met", cls: "text-emerald-700" },
  unmet: { icon: "✗", label: "Not met", cls: "text-rose-700" },
  undetermined: { icon: "?", label: "Unclear", cls: "text-amber-700" },
};

const VIEWS = [
  { key: "all", label: "All" },
  { key: "todo", label: "To review" },
  { key: "ready", label: "Ready for interview" },
  { key: "invited", label: "Interview" },
  { key: "hold", label: "On hold" },
  { key: "rejected", label: "Not suitable" },
] as const;

/** Ready for interview and not invited yet → can be selected for a (bulk) invite. */
const invitable = (r: { decision: string | null; session_id: string | null }) => r.decision === "shortlisted" && !r.session_id;

export default function ScreeningClient({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [budgetPaused, setBudgetPaused] = useState(false);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("all");
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [planIds, setPlanIds] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/screening/results`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to load candidates");
      setRows(data.results);
      setBudgetPaused(data.budget_paused);
      setHasConfig(data.current_config_version != null);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const active = rows.some((r) => r.status === "queued" || r.status === "processing");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [active, load]);

  async function handleFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (!files.length) return;
    setUploadError("");
    const items: UploadItem[] = files.map((f, i) => {
      const n = f.name.toLowerCase();
      const key = `${Date.now()}-${i}`;
      if (!n.endsWith(".pdf") && !n.endsWith(".docx")) return { key, name: f.name, state: "error", message: "Only PDF or DOCX" };
      if (f.size > MAX_MB * 1024 * 1024) return { key, name: f.name, state: "error", message: `Over ${MAX_MB} MB` };
      return { key, name: f.name, state: "pending" };
    });
    setUploads(items);
    const todo = items.map((it, i) => ({ it, file: files[i] })).filter((x) => x.it.state === "pending");
    if (!todo.length) return;

    setUploading(true);
    try {
      const b = await fetch(`/api/jobs/${jobId}/screening/batches`, { method: "POST" });
      const bd = await b.json();
      if (!b.ok) throw new Error(bd.error ?? "Could not start the upload");
      const update = (key: string, patch: Partial<UploadItem>) => setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...patch } : u)));
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const { it, file } = todo[next++];
          update(it.key, { state: "uploading" });
          try {
            const fd = new FormData();
            fd.append("file", file);
            const r = await fetch(`/api/jobs/${jobId}/screening/batches/${bd.batch_id}/files`, { method: "POST", body: fd });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) update(it.key, { state: "error", message: d.error ?? `Failed (${r.status})` });
            else update(it.key, { state: d.duplicate ? "duplicate" : "uploaded", message: d.duplicate ? "Already uploaded" : undefined });
          } catch {
            update(it.key, { state: "error", message: "Network error" });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
      await load();
    } catch (e) {
      setUploadError((e as Error).message);
      setUploads((prev) => prev.map((u) => (u.state === "pending" ? { ...u, state: "error", message: "Not uploaded" } : u)));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function retry(e: React.MouseEvent, row: ResultRow) {
    e.stopPropagation();
    setBusyRow(row.screening_id);
    const r = await fetch(`/api/jobs/${jobId}/screening/results/${row.screening_id}/retry`, { method: "POST" });
    if (!r.ok) alert((await r.json().catch(() => ({}))).error ?? "Retry failed");
    await load();
    setBusyRow(null);
  }

  async function remove(e: React.MouseEvent, row: ResultRow) {
    e.stopPropagation();
    if (!confirm(`Delete the CV and results for "${row.candidate_name || row.original_filename}"?\n\nAny interview already created for this candidate is kept.`)) return;
    setBusyRow(row.screening_id);
    const r = await fetch(`/api/jobs/${jobId}/screening/documents/${row.document_id}`, { method: "DELETE" });
    if (!r.ok) alert((await r.json().catch(() => ({}))).error ?? "Delete failed");
    await load();
    setBusyRow(null);
  }

  const counts = useMemo(() => ({
    total: rows.length,
    working: rows.filter((r) => r.status === "queued" || r.status === "processing").length,
    failed: rows.filter((r) => r.status === "failed").length,
    todo: rows.filter((r) => !r.decision || r.decision === "needs_review").length,
    ready: rows.filter(invitable).length,
  }), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !q || (r.candidate_name ?? "").toLowerCase().includes(q) || r.original_filename.toLowerCase().includes(q))
      .filter((r) => {
        if (view === "all") return true;
        if (view === "todo") return !r.decision || r.decision === "needs_review";
        if (view === "ready") return invitable(r);
        if (view === "invited") return !!r.session_id;
        return r.decision === view;
      })
      .sort((a, b) => (b.job_fit_score ?? -1) - (a.job_fit_score ?? -1));
  }, [rows, search, view]);

  const pending = uploads.some((u) => u.state === "pending" || u.state === "uploading");
  const selectable = visible.filter(invitable).map((r) => r.screening_id);
  const selectedNow = selected.filter((id) => rows.some((r) => r.screening_id === id && invitable(r)));
  const allSelected = selectable.length > 0 && selectable.every((id) => selectedNow.includes(id));
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (hasConfig === false && rows.length === 0) {
    return (
      <div className="p-6">
        <div className="sc-card flex flex-col items-center p-14 text-center">
          <h3 className="text-base font-semibold text-gray-900">Add requirements first</h3>
          <p className="mt-1 max-w-md text-sm text-gray-500">Tell Screeno what this job needs — CVs are checked against it. It takes a minute, and can be read from your job description.</p>
          <Link href={`/dashboard/jobs/${jobId}/requirements`} className="sc-btn-primary mt-5">Set requirements</Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="space-y-4 p-6"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) handleFiles(e.dataTransfer.files); }}
    >
      <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && handleFiles(e.target.files)} />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Candidates</h2>
          <p className="text-sm text-gray-500">
            {counts.total === 0 ? "Upload CVs to screen them against this job's requirements." : (
              <>
                {counts.total} CV{counts.total === 1 ? "" : "s"} · {counts.todo} to review
                {counts.ready > 0 && <span className="text-emerald-700"> · {counts.ready} ready for interview</span>}
                {counts.working > 0 && <span className="text-violet-700"> · {counts.working} screening…</span>}
                {counts.failed > 0 && <span className="text-red-600"> · {counts.failed} failed</span>}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {counts.total > 0 && (
            <a href={`/api/jobs/${jobId}/screening/export`} className="sc-btn-secondary !px-3 !py-2" title="Export CSV" aria-label="Export CSV">
              <Download className="h-4 w-4" />
            </a>
          )}
          <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} className="sc-btn-primary !py-2">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Upload CVs
          </button>
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400 bg-violet-50 py-8 text-sm font-semibold text-violet-700">
          Drop CVs to upload
        </div>
      )}

      {/* Upload progress */}
      {(uploads.length > 0 || uploadError) && (
        <div className="sc-card px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">
              {pending ? "Uploading…" : `Uploaded ${uploads.filter((u) => u.state === "uploaded").length} of ${uploads.length}`}
            </p>
            {!pending && (
              <button type="button" onClick={() => { setUploads([]); setUploadError(""); }} className="rounded p-1 text-gray-400 hover:text-gray-700" aria-label="Dismiss">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {uploadError && <p className="mt-1 text-sm text-red-600">{uploadError}</p>}
          <ul className="mt-2 flex flex-wrap gap-2" aria-live="polite">
            {uploads.map((u) => (
              <li key={u.key} title={u.message} className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 text-xs text-gray-700 ring-1 ring-gray-200">
                {u.state === "uploading" || u.state === "pending" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-gray-400" />
                  : u.state === "error" ? <XCircle className="h-3 w-3 shrink-0 text-red-500" />
                  : u.state === "duplicate" ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                  : <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />}
                <span className="truncate">{u.name}</span>
                {u.message && <span className="shrink-0 text-gray-400">· {u.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {budgetPaused && (
        <p className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
          <AlertTriangle className="h-4 w-4" /> Today&apos;s AI budget for screening is used up. Queued CVs continue tomorrow.
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : loadError ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
      ) : rows.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="flex w-full flex-col items-center rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-16 text-center transition hover:border-violet-300 hover:bg-violet-50/30"
        >
          <UploadCloud className="h-9 w-9 text-violet-600" />
          <p className="mt-3 text-sm font-semibold text-gray-900">Drop CVs here, or click to choose</p>
          <p className="mt-1 text-xs text-gray-500">PDF or DOCX · up to {MAX_MB} MB each · as many as you like</p>
        </button>
      ) : (
        <div className="sc-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
            <div className="inline-flex flex-wrap rounded-lg bg-gray-100 p-0.5">
              {VIEWS.map((v) => (
                <button key={v.key} type="button" onClick={() => setView(v.key)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold ${view === v.key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
                  {v.label}
                </button>
              ))}
            </div>
            {selectedNow.length > 0 ? (
              <button type="button" onClick={() => setPlanIds(selectedNow)} className="sc-btn-primary !py-1.5 !text-xs">
                <Send className="h-3.5 w-3.5" /> Invite selected ({selectedNow.length})
              </button>
            ) : view === "ready" && selectable.length > 0 ? (
              <span className="text-xs text-gray-500">Select candidates to invite them together.</span>
            ) : null}
            <div className="relative ml-auto w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search candidates"
                className="w-full rounded-lg border border-gray-200 py-1.5 pl-9 pr-3 text-sm focus:border-violet-400 focus:outline-none" />
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              <tr className="border-b border-gray-100">
                <th className="w-8 py-2 pl-4">
                  {selectable.length > 0 && (
                    <input type="checkbox" checked={allSelected} aria-label="Select all ready candidates"
                      onChange={() => setSelected(allSelected ? selectedNow.filter((id) => !selectable.includes(id)) : Array.from(new Set([...selectedNow, ...selectable])))} />
                  )}
                </th>
                <th className="px-4 py-2">Candidate</th>
                <th className="px-4 py-2">Fit</th>
                <th className="px-4 py-2">Must-haves</th>
                <th className="px-4 py-2" title="Gaps, missing dates, open must-haves and other items to check">Check</th>
                <th className="hidden px-4 py-2 md:table-cell">Assessment</th>
                <th className="px-4 py-2">Decision</th>
                <th className="w-20 px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visible.map((r) => {
                const el = r.eligibility_status ? ELIGIBILITY_SHORT[r.eligibility_status] : null;
                return (
                  <tr key={r.document_id} onClick={() => router.push(`/dashboard/jobs/${jobId}/screening/${r.screening_id}`)} className="group cursor-pointer hover:bg-violet-50/40">
                    <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                      {invitable(r) && (
                        <input type="checkbox" checked={selectedNow.includes(r.screening_id)} onChange={() => toggle(r.screening_id)} aria-label={`Select ${r.candidate_name ?? r.original_filename}`} />
                      )}
                    </td>
                    <td className="max-w-[260px] px-4 py-3">
                      <Link href={`/dashboard/jobs/${jobId}/screening/${r.screening_id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-gray-900 group-hover:text-violet-700">
                        {r.candidate_name || <span className="font-normal italic text-gray-500">{r.original_filename}</span>}
                      </Link>
                      {r.candidate_name && <p className="truncate text-xs text-gray-400">{r.original_filename}</p>}
                      {r.outdated && <p className="text-[11px] text-amber-600">Screened with older requirements</p>}
                    </td>
                    <td className="px-4 py-3">
                      {r.status === "completed" ? (
                        <div className="flex items-center gap-2" title={r.evidence_completeness != null ? `Evidence available for ${Math.round(r.evidence_completeness * 100)}% of requirements` : undefined}>
                          <span className={`w-8 text-base font-bold ${fitColor(r.job_fit_score)}`}>{r.job_fit_score ?? "—"}</span>
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-gray-100 sm:block">
                            <span className={`block h-full rounded-full ${(r.job_fit_score ?? 0) >= 70 ? "bg-emerald-500" : (r.job_fit_score ?? 0) >= 40 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${r.job_fit_score ?? 0}%` }} />
                          </span>
                        </div>
                      ) : r.status === "failed" ? (
                        <span className="text-xs font-medium text-red-600" title={r.error_message ?? undefined}>Couldn&apos;t read</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-violet-700"><Loader2 className="h-3 w-3 animate-spin" /> {r.status === "queued" ? "Queued" : "Screening"}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {el ? <span className={`text-xs font-semibold ${el.cls}`}>{el.icon} {el.label}</span> : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.status === "completed" && r.gap_count + r.review_count + r.must_open > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200"
                          title={[r.must_open && `${r.must_open} must-have(s) not met or unclear`, r.gap_count && `${r.gap_count} employment gap(s)`, r.review_count && `${r.review_count} item(s) to check`].filter(Boolean).join(" · ")}
                        >
                          <AlertTriangle className="h-3 w-3" /> {r.gap_count + r.review_count + r.must_open}
                        </span>
                      ) : r.status === "completed" ? <span className="text-xs text-emerald-700">✓</span> : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">{r.fit_category ? <Pill meta={CATEGORY_META[r.fit_category]} /> : <span className="text-xs text-gray-300">—</span>}</td>
                    <td className="px-4 py-3">
                      {r.decision ? <Pill meta={DECISION_META[r.decision]} /> : <span className="text-xs text-gray-400">—</span>}
                      {r.session_status && <p className={`mt-0.5 text-[11px] font-semibold ${SESSION_META[r.session_status]?.cls ?? "text-gray-600"}`}>{SESSION_META[r.session_status]?.label ?? r.session_status}</p>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                        {r.status === "failed" && (
                          <button type="button" onClick={(e) => retry(e, r)} disabled={busyRow === r.screening_id} className="rounded p-1.5 text-gray-500 hover:bg-white hover:text-gray-900" title="Retry" aria-label={`Retry ${r.original_filename}`}>
                            <RotateCcw className="h-4 w-4" />
                          </button>
                        )}
                        <button type="button" onClick={(e) => remove(e, r)} disabled={busyRow === r.screening_id} className="rounded p-1.5 text-gray-400 hover:bg-white hover:text-red-600" title="Delete" aria-label={`Delete ${r.original_filename}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-sm text-gray-500"><FileText className="mx-auto mb-2 h-6 w-6 text-gray-300" />No candidates here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {planIds && (
        <InvitePlanModal jobId={jobId} screeningIds={planIds} onClose={() => setPlanIds(null)} onDone={() => { setSelected([]); load(); }} />
      )}
      {rows.length > 0 && (
        <p className="text-xs text-gray-400">Fit shows how well the CV supports the requirements — advisory only. A skill missing from a CV doesn&apos;t mean the candidate lacks it.</p>
      )}
    </div>
  );
}
