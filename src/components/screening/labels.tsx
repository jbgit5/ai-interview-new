// Shared labels and pill styles for the CV screening UI. Categories are ADVISORY — wording is
// deliberately non-final ("potential", "review required").

export const CATEGORY_META: Record<string, { label: string; cls: string; help: string }> = {
  strong_fit: { label: "Strong evidence of fit", cls: "bg-emerald-100 text-emerald-700", help: "High job-fit score and all mandatory requirements supported by the CV." },
  potential_fit: { label: "Potential fit — review", cls: "bg-sky-100 text-sky-700", help: "Some requirements are supported; review the evidence and uncertainties." },
  insufficient_info: { label: "Insufficient information", cls: "bg-amber-100 text-amber-700", help: "Too little of the relevant information is in the CV to judge. This is not a negative signal." },
  potential_mismatch: { label: "Potential mismatch", cls: "bg-rose-100 text-rose-700", help: "A mandatory requirement appears unmet, or few requirements are supported by the CV." },
};

export const ELIGIBILITY_META: Record<string, { label: string; cls: string }> = {
  meets: { label: "Meets mandatory", cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  unmet: { label: "Mandatory unmet", cls: "bg-rose-50 text-rose-700 ring-1 ring-rose-200" },
  undetermined: { label: "Mandatory unclear", cls: "bg-amber-50 text-amber-700 ring-1 ring-amber-200" },
};

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-gray-100 text-gray-600" },
  processing: { label: "Processing", cls: "bg-violet-100 text-violet-700" },
  completed: { label: "Completed", cls: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", cls: "bg-red-100 text-red-700" },
};

// Screening decisions are about the CV only. "shortlisted" (DB value) means ready for the
// interview, not a final selection.
export const DECISION_META: Record<string, { label: string; cls: string }> = {
  shortlisted: { label: "Ready for interview", cls: "bg-emerald-600 text-white" },
  rejected: { label: "Not suitable", cls: "bg-gray-700 text-white" },
  hold: { label: "On hold", cls: "bg-amber-500 text-white" },
  needs_review: { label: "Needs review", cls: "bg-violet-600 text-white" },
};

export const SESSION_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "Interview invited", cls: "text-sky-700" },
  in_progress: { label: "Interviewing", cls: "text-violet-700" },
  completed: { label: "Interview done", cls: "text-emerald-700" },
  shortlisted: { label: "Interview done", cls: "text-emerald-700" },
  rejected: { label: "Interview done", cls: "text-emerald-700" },
};

export const CLASSIFICATION_META: Record<string, { label: string; cls: string }> = {
  strong: { label: "Strongly supported", cls: "bg-emerald-100 text-emerald-700" },
  partial: { label: "Partially supported", cls: "bg-sky-100 text-sky-700" },
  listed_only: { label: "Listed, not demonstrated", cls: "bg-amber-100 text-amber-700" },
  not_found: { label: "Not found in CV", cls: "bg-gray-100 text-gray-600" },
  does_not_meet: { label: "CV contradicts", cls: "bg-rose-100 text-rose-700" },
  unable_to_assess: { label: "Unable to assess", cls: "bg-orange-100 text-orange-700" },
};

export const SOURCE_META: Record<string, { label: string; cls: string; help: string }> = {
  ai: { label: "AI interpretation", cls: "bg-violet-50 text-violet-700 ring-1 ring-violet-200", help: "Classified by the AI from cited CV text. Check the evidence." },
  calculated: { label: "Calculated", cls: "bg-slate-50 text-slate-700 ring-1 ring-slate-200", help: "Computed deterministically from the dates in the CV." },
  hr_override: { label: "HR correction", cls: "bg-amber-50 text-amber-800 ring-1 ring-amber-200", help: "Set by a recruiter." },
};

export function Pill({ meta, className = "" }: { meta?: { label: string; cls: string; help?: string }; className?: string }) {
  if (!meta) return null;
  return (
    <span title={meta.help} className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.cls} ${className}`}>
      {meta.label}
    </span>
  );
}

export function fitColor(score: number | null | undefined): string {
  if (score == null) return "text-gray-400";
  if (score >= 70) return "text-emerald-600";
  if (score >= 40) return "text-amber-600";
  return "text-rose-600";
}

export function formatMonths(r: { min: number; max: number | null } | null | undefined): string {
  if (!r) return "Unknown";
  const f = (m: number) => {
    const y = Math.floor(m / 12);
    const mo = m % 12;
    if (!y) return `${mo} mo`;
    return mo ? `${y} yr ${mo} mo` : `${y} yr`;
  };
  if (r.max == null) return `at least ${f(r.min)}`;
  if (r.max === r.min) return f(r.min);
  return `${f(r.min)} – ${f(r.max)}`;
}
