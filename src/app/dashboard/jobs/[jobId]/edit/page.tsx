"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Save, CheckCircle } from "lucide-react";

type JobStatus = "draft" | "active" | "closed";

interface JobData {
  id: string;
  title: string;
  department: string | null;
  description: string | null;
  status: JobStatus;
  question_mode: string;
  allow_probes: boolean;
}

const STATUS_OPTIONS: { value: JobStatus; label: string; color: string }[] = [
  { value: "draft",  label: "Draft",  color: "text-gray-600" },
  { value: "active", label: "Active", color: "text-green-700" },
  { value: "closed", label: "Closed", color: "text-red-600" },
];

export default function JobEditPage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();

  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<JobStatus>("draft");
  const [allowProbes, setAllowProbes] = useState<boolean>(true);

  useEffect(() => {
    fetch(`/api/jobs/${params.jobId}`)
      .then((r) => r.json())
      .then((data: JobData) => {
        setJob(data);
        setTitle(data.title ?? "");
        setDepartment(data.department ?? "");
        setDescription(data.description ?? "");
        setStatus(data.status ?? "draft");
        setAllowProbes(data.allow_probes !== false);
      })
      .catch(() => setError("Failed to load job"))
      .finally(() => setLoading(false));
  }, [params.jobId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);

    try {
      const res = await fetch(`/api/jobs/${params.jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          department: department.trim() || null,
          description: description.trim() || null,
          status,
          allow_probes: allowProbes,
        }),
      });

      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
        return;
      }

      const updated: JobData = await res.json();
      setJob(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);

      // Refresh the layout (title/status in header) by navigating in place
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (!job) {
    return <p className="p-6 text-sm text-red-600">{error ?? "Job not found"}</p>;
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="mb-6 text-xl font-bold text-gray-900">Edit Job</h2>

      <form onSubmit={handleSave} className="space-y-5">
        {/* Status */}
        <div>
          <label className="sc-label">Status</label>
          <div className="flex gap-2">
            {STATUS_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex flex-1 cursor-pointer items-center justify-center rounded-xl border-2 px-4 py-2.5 text-sm font-semibold transition-all ${
                  status === opt.value
                    ? opt.value === "active"
                      ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                      : opt.value === "closed"
                        ? "border-red-400 bg-red-50 text-red-600"
                        : "border-gray-300 bg-gray-50 text-gray-600"
                    : "border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:text-gray-600"
                }`}
              >
                <input type="radio" name="status" value={opt.value} checked={status === opt.value} onChange={() => setStatus(opt.value)} className="sr-only" />
                {opt.label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-gray-400">
            Set to <strong className="text-gray-600">Active</strong> to allow candidates to start interviews. <strong className="text-gray-600">Draft</strong> keeps it hidden from invite links.
          </p>
        </div>

        {/* Title */}
        <div>
          <label className="sc-label">Job Title <span className="text-red-500">*</span></label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Senior Software Engineer" className="sc-input" />
        </div>

        {/* Department */}
        <div>
          <label className="sc-label">Department</label>
          <input type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Engineering" className="sc-input" />
        </div>

        {/* Description */}
        <div>
          <label className="sc-label">Job Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={7} placeholder="Describe the role, responsibilities, and requirements…" className="sc-input resize-none" />
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

        <div>
          <label className="sc-label">Company Introduction</label>
          <p className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            The interview opening uses a single company-wide template. Update it in{" "}
            <a href="/dashboard/company-intro" className="font-semibold text-violet-600 hover:text-violet-700">
              Company Intro
            </a>
            .
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-gray-400">
            Question mode: <strong className="text-gray-600 capitalize">{job.question_mode?.replace("_", " ")}</strong>
            {" · "}To change mode, create a new job.
          </span>
          <button type="submit" disabled={saving} className="sc-btn-primary px-6 py-2.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving…" : saved ? "Saved!" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
