"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileText, Loader2, Sparkles, UploadCloud, X } from "lucide-react";
import RequirementsEditor, { cleanCriteria } from "@/components/screening/RequirementsEditor";
import { DEFAULT_CRITERIA, type Criteria } from "@/lib/screening/criteria";

// Create a job from its JD: upload or paste the JD → AI drafts the title and requirements →
// recruiter reviews/edits on one screen → create. Interview questions are made later.

type Step = "source" | "review";

export default function NewJobPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("source");
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"draft" | "active">("active");
  const [criteria, setCriteria] = useState<Criteria>(DEFAULT_CRITERIA);
  const [aiFilled, setAiFilled] = useState(false);
  const [showJd, setShowJd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  async function readJd() {
    setError(null);
    setNotice(null);
    setReading(true);
    try {
      let res: Response;
      if (mode === "upload") {
        if (!file) throw new Error("Choose a PDF or DOCX file first.");
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/jobs/draft", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/jobs/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: pasted }) });
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The text may still be usable even if the AI step failed.
        if (d.description) {
          setDescription(d.description);
          setNotice(d.error ?? "Couldn't read requirements automatically.");
          setStep("review");
          return;
        }
        throw new Error(d.error ?? "Couldn't read the job description.");
      }
      setTitle(d.title ?? "");
      setDepartment(d.department ?? "");
      setDescription(d.description ?? "");
      setCriteria(d.criteria ?? DEFAULT_CRITERIA);
      setAiFilled(true);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function create() {
    setError(null);
    setIssues([]);
    if (!title.trim()) return setError("Add a job title.");
    setCreating(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, department, description, status,
          question_mode: "mixed",
          allow_probes: true,
          generate_questions: false,
          criteria: cleanCriteria(criteria),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIssues((d.issues ?? []).map((i: { path: string; message: string }) => i.message));
        throw new Error(d.error ?? "Something went wrong");
      }
      router.push(`/dashboard/jobs/${d.id}/screening`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-5 flex items-center gap-2 text-sm">
        <Link href="/dashboard/jobs" className="flex items-center gap-1.5 font-medium text-gray-500 transition-colors hover:text-violet-600">
          <ArrowLeft className="h-4 w-4" /> Jobs
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-500">New job</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Create job</h1>
        <p className="mt-1 text-sm text-gray-500">
          {step === "source"
            ? "Start from your job description — we'll fill in the title and requirements for you to check."
            : "Check the details and requirements, then create the job. You can change anything later."}
        </p>
      </div>

      {error && <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {issues.length > 0 && (
        <ul className="mb-4 list-disc rounded-xl bg-red-50 px-8 py-2 text-sm text-red-700">{issues.map((m, i) => <li key={i}>{m}</li>)}</ul>
      )}

      {step === "source" && (
        <div className="sc-card p-6">
          <div className="mb-5 inline-flex rounded-xl bg-gray-100 p-1">
            {(["upload", "paste"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
                {m === "upload" ? "Upload JD file" : "Paste JD text"}
              </button>
            ))}
          </div>

          {mode === "upload" ? (
            <div
              role="button" tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              className="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-gray-200 px-6 py-12 text-center transition hover:border-violet-300 hover:bg-violet-50/30"
            >
              {file ? (
                <div className="flex items-center gap-3 rounded-xl bg-violet-50 px-4 py-3">
                  <FileText className="h-5 w-5 text-violet-600" />
                  <span className="text-sm font-semibold text-gray-900">{file.name}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setFile(null); }} aria-label="Remove file" className="rounded p-1 text-gray-400 hover:text-gray-700">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <UploadCloud className="h-9 w-9 text-violet-600" />
                  <p className="mt-3 text-sm font-semibold text-gray-900">Drop the job description here, or click to choose</p>
                  <p className="mt-1 text-xs text-gray-500">PDF or DOCX, up to 5 MB</p>
                </>
              )}
              <input ref={fileInput} type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          ) : (
            <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={12} className="sc-input resize-y"
              placeholder="Paste the full job description — responsibilities, required skills, experience, location…" aria-label="Job description text" />
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => setStep("review")} className="text-sm font-medium text-gray-500 hover:text-gray-800">
              Skip — fill in manually
            </button>
            <button type="button" onClick={readJd} disabled={reading || (mode === "upload" ? !file : pasted.trim().length < 50)} className="sc-btn-primary">
              {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {reading ? "Reading job description…" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-5">
          {notice && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">{notice}</p>}

          <div className="sc-card space-y-4 p-6">
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr_auto]">
              <div>
                <label className="sc-label">Job title *</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} className="sc-input" placeholder="e.g. Senior Backend Engineer" />
              </div>
              <div>
                <label className="sc-label">Department</label>
                <input value={department} onChange={(e) => setDepartment(e.target.value)} maxLength={120} className="sc-input" placeholder="e.g. Engineering" />
              </div>
              <div>
                <label className="sc-label">Status</label>
                <div className="inline-flex rounded-xl bg-gray-100 p-1">
                  {(["active", "draft"] as const).map((s) => (
                    <button key={s} type="button" onClick={() => setStatus(s)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-semibold capitalize ${status === s ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <button type="button" onClick={() => setShowJd(!showJd)} className="text-xs font-semibold text-violet-700 hover:underline">
                {showJd ? "Hide job description" : description ? "View / edit job description" : "Add job description"}
              </button>
              {showJd && (
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={10} className="sc-input mt-2 resize-y" aria-label="Job description" />
              )}
            </div>
          </div>

          <div className="sc-card p-6">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-gray-900">Requirements</h2>
              <p className="mt-0.5 text-sm text-gray-500">
                {aiFilled
                  ? "Filled in from your job description. Mark real deal-breakers as Must have — everything else stays Important or Nice to have."
                  : "Used to screen CVs for this job. Mark real deal-breakers as Must have."}
              </p>
            </div>
            <RequirementsEditor value={criteria} onChange={setCriteria} />
          </div>

          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setStep("source")} className="sc-btn-secondary">Back</button>
            <button type="button" onClick={create} disabled={creating} className="sc-btn-primary">
              {creating && <Loader2 className="h-4 w-4 animate-spin" />} Create job
            </button>
          </div>
          <p className="text-right text-xs text-gray-400">Next: upload CVs to screen. Interview questions can be added any time from the job.</p>
        </div>
      )}
    </div>
  );
}
