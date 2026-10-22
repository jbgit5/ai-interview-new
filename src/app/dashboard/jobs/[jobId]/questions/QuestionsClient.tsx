"use client";

import { useState } from "react";
import {
  PlusCircle, Trash2, ChevronDown, ChevronUp, Loader2,
  Sparkles, RefreshCw, Upload, FileText, ArrowRight,
  Zap, ListChecks, FileSearch, X
} from "lucide-react";
import type { Question, QuestionCategory, QuestionMode } from "@/types";

const CATEGORY_STYLES: Record<QuestionCategory, string> = {
  technical: "bg-blue-100 text-blue-700",
  behavioral: "bg-purple-100 text-purple-700",
  situational: "bg-amber-100 text-amber-700",
  culture: "bg-green-100 text-green-700",
};

const DIFFICULTY_STARS = (n: number) => "★".repeat(n) + "☆".repeat(3 - n);

const MODE_META: Record<QuestionMode, { label: string; color: string; icon: React.ElementType; desc: string }> = {
  ai_only:     { label: "AI Generated",  color: "bg-blue-50 border-blue-200 text-blue-700",      icon: Zap,        desc: "AI generates questions from your job description. Each interview follows the same question bank." },
  custom_only: { label: "Custom Bank",   color: "bg-purple-50 border-purple-200 text-purple-700", icon: ListChecks, desc: "You control every question. Upload via CSV or add manually. Same bank for all candidates." },
  mixed:       { label: "Mixed",         color: "bg-amber-50 border-amber-200 text-amber-700",    icon: Sparkles,   desc: "AI generates a base set, you can edit and add custom questions on top." },
  resume:      { label: "Resume-Based",  color: "bg-emerald-50 border-emerald-200 text-emerald-700", icon: FileSearch, desc: "When you invite a candidate, upload their CV. AI generates personalised questions from it. Each interview is unique." },
};

interface CsvRow { text: string; category: string; difficulty: number; expected_hint: string; }

interface Props {
  jobId: string;
  jobTitle: string;
  questionMode: QuestionMode;
  initialQuestions: Question[];
}

export default function QuestionsClient({ jobId, jobTitle, questionMode, initialQuestions }: Props) {
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [activeTab, setActiveTab] = useState<"bank" | "preview">("bank");

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvPreview, setCsvPreview] = useState<CsvRow[]>([]);

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFormError(null); setSaving(true);
    const formData = new FormData(e.currentTarget);
    const payload = { text: formData.get("text") as string, category: formData.get("category") as string, difficulty: Number(formData.get("difficulty")), expected_hint: formData.get("expected_hint") as string };
    try {
      const res = await fetch(`/api/jobs/${jobId}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const d = await res.json(); setFormError(d.error ?? "Failed"); return; }
      const newQ: Question = await res.json();
      setQuestions((prev) => [...prev, newQ]);
      (e.target as HTMLFormElement).reset(); setShowForm(false);
    } catch { setFormError("Network error"); } finally { setSaving(false); }
  }

  async function handleDelete(qid: string) {
    setDeleting(qid);
    try { const res = await fetch(`/api/jobs/${jobId}/questions/${qid}`, { method: "DELETE" }); if (res.ok) setQuestions((prev) => prev.filter((q) => q.id !== qid)); }
    finally { setDeleting(null); }
  }

  async function handleRegenerate() {
    if (!confirm("Delete all AI-generated questions and regenerate? Custom questions are kept.")) return;
    setRegenerating(true); setRegenError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/questions/regenerate`, { method: "POST" });
      if (!res.ok) { const d = await res.json(); setRegenError(d.error ?? "Failed"); return; }
      setQuestions(await res.json());
    } catch { setRegenError("Network error"); } finally { setRegenerating(false); }
  }

  function parseCsv(raw: string): CsvRow[] {
    const validCats = ["technical", "behavioral", "situational", "culture"];
    return raw.trim().split("\n").filter(Boolean).map((line) => {
      const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, "").trim());
      const [text = "", category = "behavioral", diffStr = "1", expected_hint = ""] = cols;
      const cat = category.toLowerCase();
      return { text, category: validCats.includes(cat) ? cat : "behavioral", difficulty: [1,2,3].includes(Number(diffStr)) ? Number(diffStr) : 1, expected_hint };
    }).filter((r) => r.text.length > 0);
  }

  function handleCsvChange(raw: string) { setCsvText(raw); setCsvError(null); setCsvPreview(raw.trim() ? parseCsv(raw) : []); }

  async function handleCsvUpload() {
    setCsvError(null);
    const rows = parseCsv(csvText);
    if (rows.length === 0) { setCsvError("No valid rows found."); return; }
    setCsvUploading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/questions/bulk`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: rows }) });
      if (!res.ok) { const d = await res.json(); setCsvError(d.error ?? "Upload failed"); return; }
      const inserted: Question[] = await res.json();
      setQuestions((prev) => [...prev, ...inserted]);
      setShowCsvModal(false); setCsvText(""); setCsvPreview([]);
    } catch { setCsvError("Network error"); } finally { setCsvUploading(false); }
  }

  function downloadTemplate() {
    const csv = `"Question text","category","difficulty (1-3)","scoring hint"\n"How do you approach debugging a complex issue?","technical","2","Look for: systematic approach, tools"\n"Describe a conflict with a colleague","behavioral","2","Look for: communication, resolution"\n"How would you handle a critical production bug?","situational","3","Look for: calm process, communication"`;
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "questions-template.csv"; a.click();
  }

  const aiCount = questions.filter((q) => q.source === "ai_generated").length;
  const customCount = questions.filter((q) => q.source === "custom").length;
  const modeMeta = MODE_META[questionMode];
  const ModeIcon = modeMeta.icon;

  return (
    <div className="px-6 py-6">
      {/* Header + tabs */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{jobTitle}</h2>
          <div className={`mt-1 inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs font-semibold ${modeMeta.color}`}>
            <ModeIcon className="h-3.5 w-3.5" />{modeMeta.label} mode
          </div>
        </div>
        <div className="flex rounded-lg border border-[#e2e4ec] bg-gray-50 p-1">
          {(["bank", "preview"] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-all ${activeTab === t ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-600"}`}>
              {t === "bank" ? `Question Bank (${questions.length})` : "Interview Flow Preview"}
            </button>
          ))}
        </div>
      </div>

      {/* ── BANK TAB ─────────────────────────────────────────────────────── */}
      {activeTab === "bank" && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-500">
              {questions.length} question{questions.length !== 1 ? "s" : ""}
              {aiCount > 0 && <span className="ml-2 text-blue-600">· {aiCount} AI</span>}
              {customCount > 0 && <span className="ml-2 text-purple-600">· {customCount} custom</span>}
            </p>
            <div className="flex items-center gap-2">
              {questionMode !== "custom_only" && questionMode !== "resume" && (
                <button onClick={handleRegenerate} disabled={regenerating}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60">
                  {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Regenerate AI
                </button>
              )}
              {questionMode !== "resume" && (
                <>
                  <button onClick={() => setShowCsvModal(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-sm font-medium text-purple-700 hover:bg-purple-100">
                    <Upload className="h-3.5 w-3.5" />Upload CSV
                  </button>
                  <button onClick={() => setShowForm((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                    <PlusCircle className="h-3.5 w-3.5" />Add Question
                    {showForm ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                </>
              )}
            </div>
          </div>

          {regenError && <p className="mb-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-600">{regenError}</p>}

          {questionMode === "resume" && (
            <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <div className="flex items-start gap-3">
                <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">Resume-Based Mode — No shared question bank</p>
                  <p className="mt-1 text-sm text-emerald-700">Questions are generated individually for each candidate when you upload their CV on the invite page. Every interview is personalised.</p>
                  <p className="mt-2 text-xs text-emerald-600">Go to <strong>Invite</strong> tab → fill candidate details → upload CV → send invite.</p>
                </div>
              </div>
            </div>
          )}

          {showForm && (
            <form onSubmit={handleAdd} className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-5">
              <h3 className="mb-4 text-sm font-semibold text-gray-900">New Question</h3>
              <div className="space-y-4">
                <textarea name="text" rows={3} required placeholder="Question text..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <div className="grid grid-cols-2 gap-4">
                  <select name="category" required defaultValue=""
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="" disabled>Category</option>
                    {["technical","behavioral","situational","culture"].map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
                  </select>
                  <select name="difficulty" defaultValue="1"
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="1">★☆☆ Easy</option><option value="2">★★☆ Medium</option><option value="3">★★★ Hard</option>
                  </select>
                </div>
                <input name="expected_hint" type="text" placeholder="Scoring hint (optional)"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                {formError && <p className="text-sm text-red-600">{formError}</p>}
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}{saving ? "Saving…" : "Add"}
                  </button>
                </div>
              </div>
            </form>
          )}

          {questions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
              <p className="text-sm text-gray-500">{questionMode === "resume" ? "Questions are generated per-candidate when you send an invite with their CV." : `Click "Add Question" or "Upload CSV" to build your bank.`}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {questions.map((q, idx) => (
                <div key={q.id} className="flex gap-4 rounded-lg border border-[#e2e4ec] bg-white p-4">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-500">{idx + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900">{q.text}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${CATEGORY_STYLES[q.category]}`}>{q.category}</span>
                      <span className="text-xs text-amber-500">{DIFFICULTY_STARS(q.difficulty)}</span>
                      {q.source === "ai_generated" && <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600"><Sparkles className="h-3 w-3" />AI</span>}
                      {q.expected_hint && <span className="truncate text-xs text-gray-500">Hint: {q.expected_hint}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleDelete(q.id)} disabled={deleting === q.id} className="shrink-0 p-1 text-gray-500 hover:text-red-500 disabled:opacity-40">
                    {deleting === q.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── PREVIEW TAB ───────────────────────────────────────────────────── */}
      {activeTab === "preview" && (
        <div className="space-y-6">
          <div className={`rounded-xl border p-5 ${modeMeta.color}`}>
            <div className="flex items-start gap-3">
              <ModeIcon className="mt-0.5 h-5 w-5 shrink-0" />
              <div><p className="font-semibold">{modeMeta.label} — How it works</p><p className="mt-1 text-sm opacity-80">{modeMeta.desc}</p></div>
            </div>
          </div>

          <div className="rounded-xl border border-[#e2e4ec] bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-600">Live Interview Flow</h3>
            {questionMode === "resume" ? <ResumeFlowDiagram /> : <StandardFlowDiagram questions={questions} questionMode={questionMode} />}
          </div>

          <div className="rounded-xl border border-[#e2e4ec] bg-gray-50 p-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-600">AI Interview Rules (enforced at runtime)</h3>
            <ul className="space-y-2 text-sm text-gray-600">
              <li className="flex items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" /><span><strong>Max 2 probes per question</strong> — if AI probes twice and the answer is still weak, it moves to the next question automatically.</span></li>
              <li className="flex items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" /><span><strong>Category coverage</strong> — AI cannot close until at least one question from each available category has been asked.</span></li>
              <li className="flex items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" /><span><strong>Max 10 turns</strong> — interview automatically closes at turn 10.</span></li>
              <li className="flex items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" /><span><strong>Validated question IDs</strong> — question selection is validated server-side; GPT cannot hallucinate question references.</span></li>
            </ul>
          </div>
        </div>
      )}

      {/* ── CSV MODAL ─────────────────────────────────────────────────────── */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-[#e2e4ec] px-6 py-4">
              <div className="flex items-center gap-2"><FileText className="h-5 w-5 text-purple-600" /><h2 className="text-base font-semibold">Upload Questions via CSV</h2></div>
              <button onClick={() => { setShowCsvModal(false); setCsvText(""); setCsvPreview([]); setCsvError(null); }}><X className="h-5 w-5 text-gray-500 hover:text-gray-600" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">Format: <code className="rounded bg-gray-100 px-1 text-xs">question, category, difficulty, hint</code></p>
                <button onClick={downloadTemplate} className="text-xs text-blue-600 underline hover:text-blue-700">Download template</button>
              </div>
              <textarea value={csvText} onChange={(e) => handleCsvChange(e.target.value)} rows={8}
                placeholder={`"How do you debug a complex bug?","technical","2","Look for: systematic approach"\n"Tell me about a conflict","behavioral","2","Look for: communication"`}
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {csvPreview.length > 0 && (
                <div className="rounded-lg border border-[#e2e4ec] bg-gray-50 p-3">
                  <p className="mb-2 text-xs font-medium text-gray-600">{csvPreview.length} question{csvPreview.length !== 1 ? "s" : ""} detected</p>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {csvPreview.map((r, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-gray-600">
                        <span className="shrink-0 text-gray-500">{i+1}.</span>
                        <span className="flex-1">{r.text}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium capitalize ${CATEGORY_STYLES[r.category as QuestionCategory]}`}>{r.category}</span>
                        <span className="shrink-0 text-amber-500">{DIFFICULTY_STARS(r.difficulty)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {csvError && <p className="text-sm text-red-600">{csvError}</p>}
              <div className="flex justify-end gap-3">
                <button onClick={() => { setShowCsvModal(false); setCsvText(""); setCsvPreview([]); setCsvError(null); }}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
                <button onClick={handleCsvUpload} disabled={csvUploading || csvPreview.length === 0}
                  className="inline-flex items-center gap-2 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-60">
                  {csvUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {csvUploading ? "Uploading…" : `Import ${csvPreview.length} Question${csvPreview.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StandardFlowDiagram({ questions, questionMode }: { questions: Question[]; questionMode: QuestionMode }) {
  const byCategory = questions.reduce<Record<string, number>>((acc, q) => { acc[q.category] = (acc[q.category] ?? 0) + 1; return acc; }, {});
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { label: "AI Greeting", sub: "Maya introduces herself", color: "border-[#e2e4ec] bg-gray-50 text-gray-600" },
          null,
          { label: "Q1 Asked", sub: questions[0]?.text.slice(0, 35).concat("…") ?? "First question", color: "border-blue-200 bg-blue-50 text-blue-800" },
          null,
          { label: "Q2 Asked", sub: "next question", color: "border-blue-200 bg-blue-50 text-blue-800" },
          null,
          { label: "Probe (if shallow)", sub: "max 2x per question", color: "border-amber-200 bg-amber-50 text-amber-800" },
          null,
          { label: "Q3 → …", sub: "continues", color: "border-blue-200 bg-blue-50 text-blue-800" },
          null,
          { label: "Closing", sub: "all categories covered", color: "border-green-200 bg-green-50 text-green-800" },
        ].map((step, i) =>
          step === null ? (
            <ArrowRight key={i} className="h-4 w-4 text-gray-500" />
          ) : (
            <div key={i} className={`rounded-lg border px-3 py-2 text-center ${step.color}`}>
              <p className="text-xs font-semibold">{step.label}</p>
              {step.sub && <p className="mt-0.5 text-xs opacity-70">{step.sub}</p>}
            </div>
          )
        )}
      </div>
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">Questions by Category</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["technical","behavioral","situational","culture"] as QuestionCategory[]).map((cat) => (
            <div key={cat} className="rounded-lg border border-[#e2e4ec] bg-gray-50 p-3">
              <p className={`text-xs font-semibold capitalize ${CATEGORY_STYLES[cat].split(" ")[1]}`}>{cat}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{byCategory[cat] ?? 0}</p>
              {!byCategory[cat] && <p className="mt-1 text-xs text-amber-600">⚠ No questions</p>}
            </div>
          ))}
        </div>
      </div>
      {questionMode === "mixed" && (
        <p className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm text-amber-700">
          <strong>Mixed mode:</strong> AI-generated and custom questions are pooled together. AI picks the most relevant unasked question each turn.
        </p>
      )}
    </div>
  );
}

function ResumeFlowDiagram() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { label: "Recruiter uploads CV", sub: "on invite page", color: "border-emerald-200 bg-emerald-50 text-emerald-800" },
          null,
          { label: "AI reads CV", sub: "skills, gaps, experience", color: "border-blue-200 bg-blue-50 text-blue-800" },
          null,
          { label: "5 questions generated", sub: "unique to candidate", color: "border-purple-200 bg-purple-50 text-purple-800" },
          null,
          { label: "Interview runs", sub: "resume Qs first", color: "border-blue-200 bg-blue-50 text-blue-800" },
          null,
          { label: "Closing", sub: "", color: "border-green-200 bg-green-50 text-green-800" },
        ].map((step, i) =>
          step === null ? (
            <ArrowRight key={i} className="h-4 w-4 text-gray-500" />
          ) : (
            <div key={i} className={`rounded-lg border px-3 py-2 text-center ${step.color}`}>
              <p className="text-xs font-semibold">{step.label}</p>
              {step.sub && <p className="mt-0.5 text-xs opacity-70">{step.sub}</p>}
            </div>
          )
        )}
      </div>
      <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-800">
        <p className="font-semibold mb-2">Example — Candidate with 5yr PHP/Python background:</p>
        <ol className="space-y-1 text-xs list-decimal list-inside text-emerald-700">
          <li>You mentioned Django in your CV — what&apos;s the largest Django project you&apos;ve led?</li>
          <li>Your resume shows limited cloud experience. How have you handled infrastructure in past roles?</li>
          <li>You listed SQL optimisation — walk me through a specific query improvement you made.</li>
          <li>What was the biggest technical challenge at your last company and how did you resolve it?</li>
          <li>You have experience in both PHP and Python — how do you decide which stack to use?</li>
        </ol>
      </div>
    </div>
  );
}
