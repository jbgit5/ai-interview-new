"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Sparkles, ListChecks, Shuffle, FileSearch } from "lucide-react";

const MODES = [
  {
    value: "ai_only",
    icon: Sparkles,
    label: "AI Generated",
    tag: "Recommended",
    description: "AI creates 7 tailored questions from your job description.",
    color: "#7c3aed",
    bgIdle: "#f5f3ff",
    bgActive: "#ede9fe",
    borderActive: "#7c3aed",
    iconBg: "#ddd6fe",
  },
  {
    value: "custom_only",
    icon: ListChecks,
    label: "Custom Bank",
    tag: null,
    description: "Write all questions manually — full control.",
    color: "#2563eb",
    bgIdle: "#eff6ff",
    bgActive: "#dbeafe",
    borderActive: "#2563eb",
    iconBg: "#bfdbfe",
  },
  {
    value: "mixed",
    icon: Shuffle,
    label: "Mixed",
    tag: null,
    description: "AI generates a starter set, then you customise.",
    color: "#d97706",
    bgIdle: "#fffbeb",
    bgActive: "#fef3c7",
    borderActive: "#d97706",
    iconBg: "#fde68a",
  },
  {
    value: "resume" as const,
    icon: FileSearch,
    label: "Resume-Based",
    tag: null,
    description: "AI generates personal questions from each candidate's CV.",
    color: "#059669",
    bgIdle: "#f0fdf4",
    bgActive: "#dcfce7",
    borderActive: "#059669",
    iconBg: "#bbf7d0",
  },
] as const;

export default function NewJobPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionMode, setQuestionMode] = useState<"ai_only" | "custom_only" | "mixed" | "resume">("ai_only");
  const [allowProbes, setAllowProbes] = useState<boolean>(true);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const formData = new FormData(e.currentTarget);
    const payload = {
      title: formData.get("title") as string,
      department: formData.get("department") as string,
      description: formData.get("description") as string,
      status: formData.get("status") as string,
      question_mode: questionMode,
      allow_probes: allowProbes,
    };
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Something went wrong");
        return;
      }
      const job = await res.json();
      router.push(`/dashboard/jobs/${job.id}/questions`);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      {/* Breadcrumb */}
      <div className="mb-5 flex items-center gap-2 text-sm">
        <Link href="/dashboard/jobs" className="flex items-center gap-1.5 font-medium text-gray-500 hover:text-violet-600 transition-colors">
          <ArrowLeft className="h-4 w-4" />
          Jobs
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-500">New Job</span>
      </div>

      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-violet-500 mb-1">New Opening</p>
        <h1 className="text-2xl font-bold text-gray-900">Create Job</h1>
        <p className="mt-1 text-sm text-gray-500">Fill in the details and choose your interview question mode.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Title + Department row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="sc-label">Job Title <span className="text-red-500">*</span></label>
            <input name="title" type="text" required placeholder="e.g. Senior Frontend Engineer" className="sc-input" />
          </div>
          <div>
            <label className="sc-label">Department</label>
            <input name="department" type="text" placeholder="e.g. Engineering" className="sc-input" />
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="sc-label">Job Description</label>
          <textarea name="description" rows={5} placeholder="Describe the role, responsibilities, and requirements..." className="sc-input resize-none" />
          <p className="mt-1.5 text-xs text-gray-400">Used by AI to generate relevant interview questions.</p>
        </div>

        {/* Question Mode */}
        <div>
          <label className="sc-label">Interview Question Mode <span className="text-red-500">*</span></label>
          <div className="grid grid-cols-2 gap-3">
            {MODES.map(({ value, icon: Icon, label, tag, description, color, bgIdle, bgActive, borderActive, iconBg }) => {
              const isActive = questionMode === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuestionMode(value)}
                  className="relative rounded-xl p-4 text-left transition-all duration-150 border-2"
                  style={{
                    background: isActive ? bgActive : bgIdle,
                    borderColor: isActive ? borderActive : "transparent",
                    boxShadow: isActive ? `0 0 0 0px ${borderActive}` : "none",
                  }}
                >
                  {/* Icon badge */}
                  <span
                    className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg"
                    style={{ background: iconBg }}
                  >
                    <Icon className="h-4.5 w-4.5" style={{ color }} />
                  </span>

                  {/* Label + tag */}
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-bold text-gray-900">{label}</p>
                    {tag && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                        style={{ background: color, color: "#fff" }}
                      >
                        {tag}
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-gray-500">{description}</p>

                  {/* Selected checkmark */}
                  {isActive && (
                    <span
                      className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full"
                      style={{ background: borderActive }}
                    >
                      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 12 12">
                        <path d="M2.5 6l2.5 2.5L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {questionMode !== "custom_only" && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-violet-600">
              <Sparkles className="h-3.5 w-3.5" />
              AI will generate questions on submit — takes ~5 seconds.
            </p>
          )}
        </div>

        {/* Allow follow-up probes */}
        <div>
          <label className="sc-label">Interview Behavior</label>
          <button
            type="button"
            onClick={() => setAllowProbes((v) => !v)}
            className="flex w-full items-start justify-between gap-4 rounded-xl border-2 border-gray-200 bg-white p-4 text-left transition-colors hover:border-gray-300"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-gray-900">Allow follow-up probes</p>
                <span
                  className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                  style={{ background: allowProbes ? "#7c3aed" : "#9ca3af", color: "#fff" }}
                >
                  {allowProbes ? "On" : "Off"}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                {allowProbes
                  ? "Maya may ask short follow-up questions to dig deeper into shallow or unclear answers (up to 2 per question)."
                  : "Strict bank-only mode. Maya asks each bank question exactly once, then closes — no follow-ups, even for weak or off-topic answers."}
              </p>
            </div>
            <span
              role="switch"
              aria-checked={allowProbes}
              className="relative mt-1 inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 transition-colors"
              style={{
                background: allowProbes ? "#7c3aed" : "#e5e7eb",
                borderColor: allowProbes ? "#7c3aed" : "#d1d5db",
              }}
            >
              <span
                className="inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform"
                style={{ transform: allowProbes ? "translateX(20px)" : "translateX(2px)", marginTop: "2px" }}
              />
            </span>
          </button>
        </div>

        {/* Status */}
        <div>
          <label className="sc-label">Job Status</label>
          <select name="status" defaultValue="draft" className="sc-input">
            <option value="draft">Draft — hidden from invite links</option>
            <option value="active">Active — candidates can start interviews</option>
            <option value="closed">Closed</option>
          </select>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Link href="/dashboard/jobs" className="sc-btn-secondary px-5 py-2.5">
            Cancel
          </Link>
          <button type="submit" disabled={loading} className="sc-btn-primary px-6 py-2.5">
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {questionMode !== "custom_only" ? "Generating…" : "Creating…"}
              </span>
            ) : (
              "Create & Add Questions"
            )}
          </button>
        </div>

      </form>
    </div>
  );
}
