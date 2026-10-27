import { z } from "zod";

// Structured-output schemas for the two screening LLM calls. Used twice:
//  1. sent to OpenAI as a strict json_schema (every field required; "missing" = null), and
//  2. re-validated with zod before anything is stored (strictObject → extra fields are rejected).
//
// By design there are NO fields for age, date of birth, gender, nationality, ethnicity, religion,
// marital status, health/disability, photos or personality — the model has nowhere to put them.

const excerpt = z.string().describe("Short VERBATIM quote copied from the CV (max ~200 chars). Never paraphrase.");

const YearMonth = z.strictObject({
  year: z.number().int().nullable().describe("4-digit year exactly as written, or null if not stated"),
  month: z.number().int().nullable().describe("1-12 if a month is written, else null. Never guess a month."),
  raw: z.string().describe("The date text exactly as written in the CV, e.g. 'Mar 2019', '2019', 'Present'"),
});

const TechMention = z.strictObject({
  name: z.string(),
  excerpt,
});

const employmentBase = {
  ref: z.string().describe("Sequential id: E1, E2, ... in CV order"),
  company: z.string().nullable().describe("Employer name exactly as written, or null if missing"),
  title: z.string().nullable().describe("Job title exactly as written, or null if missing"),
  start: YearMonth.nullable(),
  end: YearMonth.nullable().describe("null if no end date is written"),
  is_current: z.boolean().describe("true only if the CV explicitly says present/current/now"),
  employment_type: z.enum(["full_time", "part_time", "contract", "freelance", "internship", "unknown"])
    .describe("Only if the CV states or clearly labels it; otherwise unknown"),
  responsibilities: z.array(z.string()).describe("Up to 8 responsibilities/achievements, VERBATIM from the CV"),
  technologies: z.array(TechMention).describe("Technologies the CV says were USED IN THIS ROLE, each with a verbatim excerpt"),
  header_excerpt: excerpt.describe("The verbatim line(s) naming this role, e.g. 'Senior Engineer, Acme Ltd, Jan 2020 - Present'"),
};

// Added in SCREENING_PROMPT_VERSION cv-screen-2026-10-27.2. Required from the model, optional when
// reading extractions stored by older prompt versions (see upgradeExtraction).
const employmentV2 = {
  industry: z.string().nullable().describe("The employer's industry/domain (e.g. 'Banking', 'Healthcare') only if the CV states it; else null"),
  team_size: z.number().int().nullable().describe("Number of people the candidate managed or led in this role, only if the CV states a number; else null"),
  title_fit: z.enum(["consistent", "partly", "inconsistent", "unclear"])
    .describe("Do the listed duties match the job title? 'unclear' if there is too little detail to tell"),
  title_fit_note: z.string().nullable().describe("If partly/inconsistent: one neutral sentence on why. Else null"),
};

export const EmploymentEntry = z.strictObject({ ...employmentBase, ...employmentV2 });

export const EducationEntry = z.strictObject({
  ref: z.string().describe("ED1, ED2, ..."),
  qualification: z.string().nullable(),
  field_of_study: z.string().nullable(),
  institution: z.string().nullable(),
  start: YearMonth.nullable(),
  end: YearMonth.nullable().describe("Completion / graduation date if written"),
  excerpt,
});

export const CertificationEntry = z.strictObject({
  ref: z.string().describe("C1, C2, ..."),
  name: z.string(),
  issuer: z.string().nullable(),
  year: z.number().int().nullable(),
  excerpt,
});

export const ProjectEntry = z.strictObject({
  ref: z.string().describe("P1, P2, ..."),
  name: z.string().nullable(),
  employment_ref: z.string().nullable().describe("The E-ref this project belongs to, only if the CV makes it clear"),
  technologies: z.array(TechMention).describe("Only technologies the CV says were used in this project"),
  excerpt,
});

export const StatedItem = z.strictObject({ value: z.string(), excerpt });

const candidateBase = {
  name: z.string().nullable(),
  location: StatedItem.nullable().describe("Current location only if explicitly stated"),
  relocation: StatedItem.nullable().describe("Only an explicit statement about relocation willingness"),
  work_preference: z.strictObject({
    value: z.enum(["remote", "hybrid", "onsite", "flexible"]),
    excerpt,
  }).nullable().describe("Only an explicit statement of remote/hybrid/onsite preference"),
};
const candidateV2 = {
  notice_period: StatedItem.nullable().describe("Notice period / availability only if explicitly stated (e.g. '30 days', 'immediate')"),
};

/** A period the CV itself explains (career break, study…). Personal reasons are recorded only as "personal". */
export const GapExplanation = z.strictObject({
  reason: z.enum(["study", "personal", "job_search", "freelance_or_projects", "relocation", "other"])
    .describe("'personal' covers health, family, caregiving, parental leave etc. — never record the details"),
  start: YearMonth.nullable(),
  end: YearMonth.nullable(),
  excerpt: z.string().nullable().describe("Verbatim text for non-personal reasons; MUST be null for 'personal'"),
});

const extractionBase = {
  education: z.array(EducationEntry),
  certifications: z.array(CertificationEntry),
  skills_section: z.array(TechMention).describe("Items listed in a skills/technologies section (listing ≠ demonstrated use)"),
  projects: z.array(ProjectEntry),
  observations: z.array(z.strictObject({
    type: z.enum(["contradiction", "vague_claim", "repeated_passage", "missing_dates", "unclear_title", "ambiguous_employer", "unclear_structure", "other"]),
    description: z.string().describe("Factual, neutral, one sentence. No speculation about reasons."),
    excerpt: z.string().nullable(),
  })),
};

/** Sent to the model (strict: every field required). */
export const ExtractionSchema = z.strictObject({
  candidate: z.strictObject({ ...candidateBase, ...candidateV2 }),
  employment: z.array(EmploymentEntry),
  ...extractionBase,
  gap_explanations: z.array(GapExplanation).describe("Only periods the CV explicitly explains; [] if none"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedEmployment = z.infer<typeof EmploymentEntry>;

/** Reads extractions stored by ANY prompt version (fields added later are optional here). */
const StoredExtractionSchema = z.strictObject({
  candidate: z.strictObject({ ...candidateBase, notice_period: candidateV2.notice_period.optional() }),
  employment: z.array(z.strictObject({
    ...employmentBase,
    industry: employmentV2.industry.optional(),
    team_size: employmentV2.team_size.optional(),
    title_fit: employmentV2.title_fit.optional(),
    title_fit_note: employmentV2.title_fit_note.optional(),
  })),
  ...extractionBase,
  gap_explanations: z.array(GapExplanation).optional(),
});

/**
 * Parse a stored extraction (old or new prompt version) into the current shape. Fields an older
 * prompt never asked for come back as "not read" (null / "unclear" / []), never as invented values.
 * `upgraded` = false when the extraction predates these fields.
 */
export function parseStoredExtraction(raw: unknown): { ok: true; extraction: Extraction; upgraded: boolean } | { ok: false } {
  const p = StoredExtractionSchema.safeParse(raw);
  if (!p.success) return { ok: false };
  const d = p.data;
  const upgraded = d.gap_explanations !== undefined;
  return {
    ok: true,
    upgraded,
    extraction: {
      ...d,
      candidate: { ...d.candidate, notice_period: d.candidate.notice_period ?? null },
      employment: d.employment.map((e) => ({
        ...e,
        industry: e.industry ?? null,
        team_size: e.team_size ?? null,
        title_fit: e.title_fit ?? "unclear",
        title_fit_note: e.title_fit_note ?? null,
      })),
      gap_explanations: d.gap_explanations ?? [],
    },
  };
}

export const CLASSIFICATIONS = ["strong", "partial", "listed_only", "not_found", "does_not_meet", "unable_to_assess"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const AssessmentSchema = z.strictObject({
  criteria: z.array(z.strictObject({
    criterion_id: z.string(),
    classification: z.enum(CLASSIFICATIONS),
    evidence: z.array(z.strictObject({
      source_ref: z.string().nullable().describe("E1/ED1/C1/P1, 'SKILLS' for the skills section, 'CANDIDATE' for stated location/preferences"),
      excerpt,
    })),
    employment_refs: z.array(z.string()).describe("E-refs of roles where this skill was demonstrably USED (skills only; else [])"),
    inferred: z.boolean().describe("true if the conclusion relies on inference rather than an explicit statement"),
    rationale: z.string().describe("One or two neutral sentences explaining the classification"),
  })),
  strengths: z.array(z.string()).describe("Up to 5 job-relevant strengths, each grounded in the evidence"),
  uncertainties: z.array(z.string()).describe("Up to 5 missing, unclear or contradictory points"),
  follow_up_questions: z.array(z.string()).describe("Up to 5 neutral, job-related questions HR could ask"),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const CriteriaSuggestionSchema = z.strictObject({
  skills: z.array(z.strictObject({
    name: z.string(),
    synonyms: z.array(z.string()),
    importance: z.enum(["required", "preferred"]),
    min_years: z.number().nullable(),
    jd_excerpt: z.string().describe("Verbatim JD text this came from"),
  })),
  total_experience_years: z.number().nullable(),
  total_experience_excerpt: z.string().nullable(),
  qualifications: z.array(z.strictObject({
    description: z.string(),
    importance: z.enum(["required", "preferred"]),
    jd_excerpt: z.string(),
  })),
  certifications: z.array(z.strictObject({
    name: z.string(),
    importance: z.enum(["required", "preferred"]),
    jd_excerpt: z.string(),
  })),
  location: z.string().nullable(),
  arrangement: z.enum(["onsite", "hybrid", "remote", "any"]),
});
export type CriteriaSuggestion = z.infer<typeof CriteriaSuggestionSchema>;

// Caps applied after validation (kept out of the provider schema to stay within strict-mode limits).
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function clampExtraction(e: Extraction): Extraction {
  return {
    ...e,
    employment: e.employment.slice(0, 40).map((x) => ({
      ...x,
      responsibilities: x.responsibilities.slice(0, 8).map((r) => clip(r, 400)),
      technologies: x.technologies.slice(0, 40),
      industry: x.industry ? clip(x.industry, 80) : null,
      team_size: x.team_size != null && x.team_size > 0 && x.team_size < 100_000 ? x.team_size : null,
      title_fit_note: x.title_fit_note ? clip(x.title_fit_note, 300) : null,
    })),
    education: e.education.slice(0, 15),
    certifications: e.certifications.slice(0, 30),
    skills_section: e.skills_section.slice(0, 80),
    projects: e.projects.slice(0, 30),
    observations: e.observations.slice(0, 20),
    // Privacy guard in code, not only in the prompt: personal reasons never keep their text.
    gap_explanations: e.gap_explanations.slice(0, 10).map((g) => ({ ...g, excerpt: g.reason === "personal" || !g.excerpt ? null : clip(g.excerpt, 300) })),
  };
}

/** "Create job from JD": job basics + draft requirements in one call. */
export const JobDraftSchema = z.strictObject({
  title: z.string().describe("Job title as written in the JD"),
  department: z.string().nullable().describe("Department/team if stated, else null"),
  requirements: CriteriaSuggestionSchema,
});
export type JobDraft = z.infer<typeof JobDraftSchema>;
