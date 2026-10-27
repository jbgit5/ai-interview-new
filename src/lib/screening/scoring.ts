// Deterministic, documented scoring rubric (RUBRIC_VERSION in criteria.ts). The LLM only
// classifies evidence per criterion; every number below is computed here.
//
// Rubric (see docs/CV-SCREENING.md §Scoring):
//   points: strong 1 · partial 0.5 · listed_only 0.25 · not_found 0 · does_not_meet 0
//           unable_to_assess → excluded from the score (lowers evidence completeness instead)
//   effective weight = recruiter weight (1-5) × 2 for required, × 1 for preferred
//   job-fit  = round(100 × Σ(weight × points) / Σ(weight of assessable criteria))
//   evidence completeness = Σ(weight of assessable criteria) / Σ(weight of all criteria)
//   eligibility: any hard criterion unmet → "unmet"; all hard met → "meets"; else "undetermined"
//   category: unmet → potential_mismatch; no score or completeness < 0.5 → insufficient_info;
//             fit ≥ 70 and meets → strong_fit; fit < 40 → potential_mismatch; else potential_fit
// Gaps, tenure, overlaps, CV style and (unless configured) location never enter the score.
// A missing statement is never treated as proof of absence for a hard requirement: not_found
// leaves eligibility "undetermined", only explicit contrary evidence or the calculated timeline
// can make it "unmet".

import type { CriterionDef } from "./criteria";
import type { Classification } from "./schemas";
import { compareToYears, formatRange, type MonthRange } from "./timeline";

export const POINTS: Record<Classification, number | null> = {
  strong: 1,
  partial: 0.5,
  listed_only: 0.25,
  not_found: 0,
  does_not_meet: 0,
  unable_to_assess: null,
};

export const STRONG_FIT_MIN = 70;
export const MISMATCH_BELOW = 40;
export const MIN_COMPLETENESS = 0.5;

export type HardStatus = "met" | "unmet" | "undetermined";
export type Eligibility = "meets" | "unmet" | "undetermined";
export type FitCategory = "strong_fit" | "potential_fit" | "insufficient_info" | "potential_mismatch";

export interface EvidenceRef {
  source_ref: string | null;
  excerpt: string;
  verified: boolean;
  page: number | null;
  employer: string | null;
  title: string | null;
}

export interface CriterionInput {
  def: CriterionDef;
  /** Classification the AI returned (already validated). */
  ai_classification: Classification;
  evidence: EvidenceRef[];
  inferred: boolean;
  rationale: string;
  /** Hands-on months for skills (from the timeline), or total professional months. */
  months: MonthRange | null;
  /** Set when the classification comes from deterministic calculation rather than the AI. */
  calculated?: { classification: Classification; note: string } | null;
  /** HR correction, applied last. */
  override?: { classification: Classification; note: string } | null;
}

export interface CriterionResult {
  id: string;
  kind: CriterionDef["kind"];
  label: string;
  importance: CriterionDef["importance"];
  weight: number;
  effective_weight: number;
  hard: boolean;
  classification: Classification;
  ai_classification: Classification;
  source: "ai" | "calculated" | "hr_override";
  evidence: EvidenceRef[];
  experience: { required_years: number; months: MonthRange | null; label: string; comparison: HardStatus } | null;
  points: number | null;
  hard_status: HardStatus | null;
  inferred: boolean;
  rationale: string;
  notes: string[];
  /** Skills only: when it was last used in a dated role. Informational, never scored. */
  last_used?: { current: boolean; label: string; months_ago: number | null } | null;
}

export interface ScoreSummary {
  job_fit_score: number | null;
  fit_band: "high" | "medium" | "low" | null;
  evidence_completeness: number | null;
  eligibility_status: Eligibility;
  fit_category: FitCategory;
  hard_criteria: { met: number; unmet: number; undetermined: number };
}

export function effectiveWeight(def: CriterionDef): number {
  return def.weight * (def.importance === "required" ? 2 : 1);
}

export function scoreCriterion(input: CriterionInput): CriterionResult {
  const { def } = input;
  const notes: string[] = [];
  let classification: Classification = input.ai_classification;
  let source: CriterionResult["source"] = "ai";

  // 1. Evidence the model cited but that can't be found in the CV doesn't count.
  const verified = input.evidence.filter((e) => e.verified);
  if (input.evidence.length && !verified.length && ["strong", "partial", "listed_only"].includes(classification)) {
    classification = "unable_to_assess";
    notes.push("The AI's supporting excerpts could not be located in the CV, so this criterion needs manual review.");
  } else if (verified.length < input.evidence.length) {
    notes.push(`${input.evidence.length - verified.length} cited excerpt(s) could not be located in the CV and were ignored.`);
  }
  if (["strong", "partial"].includes(classification) && input.evidence.length === 0 && !input.calculated) {
    classification = "unable_to_assess";
    notes.push("No supporting excerpt was provided, so this criterion needs manual review.");
  }

  // "Listed but not demonstrated" only applies to skills.
  if (def.kind !== "skill" && classification === "listed_only") classification = "partial";

  if (input.calculated) {
    classification = input.calculated.classification;
    source = "calculated";
    notes.push(input.calculated.note);
  }

  // 2. Minimum years (skills): measured from the timeline, never from a skills list.
  let experience: CriterionResult["experience"] = null;
  if (def.min_years != null && def.kind === "skill") {
    const usable = classification === "strong" || classification === "partial";
    const comparison: HardStatus = usable ? compareToYears(input.months, def.min_years) : "undetermined";
    experience = { required_years: def.min_years, months: usable ? input.months : null, label: usable ? formatRange(input.months) : "Not measurable", comparison };
    if (usable && comparison === "unmet") notes.push(`Hands-on use in dated roles (${formatRange(input.months)}) is below the required ${def.min_years} years.`);
    if (usable && comparison === "undetermined") notes.push(`Hands-on duration (${formatRange(input.months)}) can't be compared reliably with the required ${def.min_years} years.`);
  }
  if (def.kind === "total_experience" && def.min_years != null) {
    experience = { required_years: def.min_years, months: input.months, label: formatRange(input.months), comparison: compareToYears(input.months, def.min_years) };
  }

  if (input.override) {
    classification = input.override.classification;
    source = "hr_override";
    notes.push(`Corrected by HR: ${input.override.note || "no note"}`);
  }

  let points = POINTS[classification];
  if (points != null && experience?.comparison === "unmet" && def.kind === "skill" && source !== "hr_override") points = Math.min(points, 0.5);

  let hardStatus: HardStatus | null = null;
  if (def.hard) {
    if (classification === "does_not_meet") hardStatus = "unmet";
    else if (source !== "hr_override" && experience?.comparison === "unmet") hardStatus = "unmet";
    else if (classification === "strong" && (!experience || experience.comparison === "met" || source === "hr_override")) hardStatus = "met";
    else hardStatus = "undetermined";
  }

  return {
    id: def.id,
    kind: def.kind,
    label: def.label,
    importance: def.importance,
    weight: def.weight,
    effective_weight: effectiveWeight(def),
    hard: def.hard,
    classification,
    ai_classification: input.ai_classification,
    source,
    evidence: input.evidence,
    experience,
    points,
    hard_status: hardStatus,
    inferred: input.inferred,
    rationale: input.rationale,
    notes,
  };
}

export function summarize(results: CriterionResult[]): ScoreSummary {
  const total = results.reduce((s, r) => s + r.effective_weight, 0);
  const assessable = results.filter((r) => r.points != null);
  const assessableWeight = assessable.reduce((s, r) => s + r.effective_weight, 0);
  const earned = assessable.reduce((s, r) => s + r.effective_weight * (r.points as number), 0);

  const fit = assessableWeight > 0 ? Math.round((100 * earned) / assessableWeight) : null;
  const completeness = total > 0 ? Math.round((assessableWeight / total) * 1000) / 1000 : null;

  const hard = results.filter((r) => r.hard);
  const counts = {
    met: hard.filter((r) => r.hard_status === "met").length,
    unmet: hard.filter((r) => r.hard_status === "unmet").length,
    undetermined: hard.filter((r) => r.hard_status === "undetermined").length,
  };
  const eligibility: Eligibility = counts.unmet > 0 ? "unmet" : counts.undetermined > 0 ? "undetermined" : "meets";

  let category: FitCategory;
  if (eligibility === "unmet") category = "potential_mismatch";
  else if (fit == null || completeness == null || completeness < MIN_COMPLETENESS) category = "insufficient_info";
  else if (fit >= STRONG_FIT_MIN && eligibility === "meets") category = "strong_fit";
  else if (fit < MISMATCH_BELOW) category = "potential_mismatch";
  else category = "potential_fit";

  return {
    job_fit_score: fit,
    fit_band: fit == null ? null : fit >= STRONG_FIT_MIN ? "high" : fit >= MISMATCH_BELOW ? "medium" : "low",
    evidence_completeness: completeness,
    eligibility_status: eligibility,
    fit_category: category,
    hard_criteria: counts,
  };
}
