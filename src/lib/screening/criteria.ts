import { z } from "zod";

// Recruiter-configured screening criteria for one job. Saved as an immutable, versioned row in
// screening_configs; every screening records the exact version it was scored against.
//
// Kinds of rule (see docs/CV-SCREENING.md):
//  - hard      → eligibility requirement (must be explicitly set by the recruiter, never inferred)
//  - required  → counts double in the job-fit score
//  - preferred → counts once
// Observation thresholds (gaps, short tenure) are informational only and never affect scores.

export const RUBRIC_VERSION = "rubric-2026-10-27.1";

const id = z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/, "lowercase letters, digits and _ only");
const importance = z.enum(["required", "preferred"]);
const weight = z.number().int().min(1).max(5);
const years = z.number().min(0).max(40).nullable();

export const SkillCriterionSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  synonyms: z.array(z.string().trim().min(1).max(80)).max(10),
  importance,
  weight,
  /** Minimum years of hands-on use, measured from the employment timeline (not from a skills list). */
  min_years: years,
  hard: z.boolean(),
});

export const QualificationCriterionSchema = z.object({
  id,
  description: z.string().trim().min(1).max(200),
  /** Equivalent qualifications or relevant experience may satisfy this requirement. */
  equivalents_allowed: z.boolean(),
  equivalent_experience_years: years,
  importance,
  weight,
  hard: z.boolean(),
  /** Why this qualification is needed for the role (required when hard). */
  justification: z.string().trim().max(300),
});

export const CertificationCriterionSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  importance,
  weight,
  hard: z.boolean(),
});

export const CriteriaSchema = z
  .object({
    skills: z.array(SkillCriterionSchema).max(30),
    total_experience: z.object({
      min_years: years,
      weight,
      hard: z.boolean(),
    }),
    qualifications: z.array(QualificationCriterionSchema).max(10),
    certifications: z.array(CertificationCriterionSchema).max(10),
    location: z.object({
      /** Free-text location requirement, e.g. "Bengaluru, India". Null = no location requirement. */
      required_location: z.string().trim().max(120).nullable(),
      arrangement: z.enum(["onsite", "hybrid", "remote", "any"]),
      relocation_required: z.boolean(),
      weight,
      hard: z.boolean(),
    }),
    observations: z.object({
      gap_threshold_months: z.number().int().min(1).max(36),
      short_tenure_months: z.number().int().min(1).max(36),
    }),
  })
  .superRefine((c, ctx) => {
    const ids = [...c.skills.map((s) => s.id), ...c.qualifications.map((q) => q.id), ...c.certifications.map((x) => x.id)];
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `Duplicate criterion id "${dup}"` });
    c.qualifications.forEach((q, i) => {
      if (q.hard && !q.justification) {
        ctx.addIssue({ code: "custom", path: ["qualifications", i, "justification"], message: "A hard qualification requirement needs a job-related justification" });
      }
    });
  });

export type Criteria = z.infer<typeof CriteriaSchema>;
export type SkillCriterion = z.infer<typeof SkillCriterionSchema>;

export const DEFAULT_CRITERIA: Criteria = {
  skills: [],
  total_experience: { min_years: null, weight: 3, hard: false },
  qualifications: [],
  certifications: [],
  location: { required_location: null, arrangement: "any", relocation_required: false, weight: 2, hard: false },
  observations: { gap_threshold_months: 6, short_tenure_months: 12 },
};

/** Hard rules only make sense on required criteria; normalise so the stored config is unambiguous. */
export function normalizeCriteria(c: Criteria): Criteria {
  return {
    ...c,
    skills: c.skills.map((s) => ({ ...s, hard: s.importance === "required" && s.hard })),
    qualifications: c.qualifications.map((q) => ({ ...q, hard: q.importance === "required" && q.hard })),
    certifications: c.certifications.map((x) => ({ ...x, hard: x.importance === "required" && x.hard })),
    total_experience: { ...c.total_experience, hard: c.total_experience.min_years != null && c.total_experience.hard },
    location: { ...c.location, hard: hasLocationRequirement(c) && c.location.hard },
  };
}

export function hasLocationRequirement(c: Criteria): boolean {
  return !!c.location.required_location || c.location.arrangement !== "any" || c.location.relocation_required;
}

/** One flat list of scorable criteria (used by the assessment prompt and the scorer). */
export interface CriterionDef {
  id: string;
  kind: "skill" | "total_experience" | "qualification" | "certification" | "location";
  label: string;
  importance: "required" | "preferred";
  weight: number;
  hard: boolean;
  min_years: number | null;
  /** Extra context for the assessor (synonyms, equivalents, arrangement). */
  detail: string;
}

export function flattenCriteria(c: Criteria): CriterionDef[] {
  const out: CriterionDef[] = [];
  for (const s of c.skills) {
    out.push({
      id: s.id, kind: "skill", label: s.name, importance: s.importance, weight: s.weight, hard: s.hard,
      min_years: s.min_years,
      detail: s.synonyms.length ? `Also accept: ${s.synonyms.join(", ")}` : "",
    });
  }
  if (c.total_experience.min_years != null) {
    out.push({
      id: "total_experience", kind: "total_experience",
      label: `At least ${c.total_experience.min_years} years of professional experience`,
      importance: "required", weight: c.total_experience.weight, hard: c.total_experience.hard,
      min_years: c.total_experience.min_years, detail: "Calculated from the employment timeline (internships excluded).",
    });
  }
  for (const q of c.qualifications) {
    out.push({
      id: q.id, kind: "qualification", label: q.description, importance: q.importance, weight: q.weight, hard: q.hard,
      min_years: null,
      detail: q.equivalents_allowed
        ? `Equivalent qualifications are accepted${q.equivalent_experience_years != null ? `, as are ${q.equivalent_experience_years}+ years of directly relevant experience` : ""}.`
        : "Equivalent qualifications are not accepted.",
    });
  }
  for (const x of c.certifications) {
    out.push({ id: x.id, kind: "certification", label: x.name, importance: x.importance, weight: x.weight, hard: x.hard, min_years: null, detail: "" });
  }
  if (hasLocationRequirement(c)) {
    const parts = [
      c.location.required_location ? `Location: ${c.location.required_location}` : null,
      c.location.arrangement !== "any" ? `Work arrangement: ${c.location.arrangement}` : null,
      c.location.relocation_required ? "Relocation required" : null,
    ].filter(Boolean);
    out.push({
      id: "location", kind: "location", label: parts.join("; "), importance: "required",
      weight: c.location.weight, hard: c.location.hard, min_years: null,
      detail: "Only explicit statements count. Never infer willingness to relocate or work preference from where someone lives.",
    });
  }
  return out;
}
