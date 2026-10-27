// The two LLM steps of a screening, behind an injectable LlmJsonCall so tests can feed
// malformed / hostile model output through exactly the same validation as production.

import { LlmCallError, type LlmJsonCall, type LlmUsage } from "../llm/types";
import {
  buildCriteriaAssessmentPrompt,
  buildCriteriaSuggestionPrompt,
  buildCvExtractionPrompt,
  buildJobDraftPrompt,
} from "../prompts";
import { flattenCriteria, type Criteria } from "./criteria";
import {
  AssessmentSchema,
  CriteriaSuggestionSchema,
  ExtractionSchema,
  JobDraftSchema,
  clampExtraction,
  type Assessment,
  type CriteriaSuggestion,
  type Extraction,
  type JobDraft,
} from "./schemas";

export interface LlmOptions {
  llm: LlmJsonCall;
  model: string;
  timeoutMs: number;
}

/** Make refs unique and well-formed even if the model repeats or mangles them. */
function normalizeRefs(e: Extraction): Extraction {
  const fix = <T extends { ref: string }>(items: T[], prefix: string): T[] =>
    items.map((x, i) => ({ ...x, ref: `${prefix}${i + 1}` }));
  const oldToNew = new Map(e.employment.map((x, i) => [x.ref, `E${i + 1}`]));
  return {
    ...e,
    employment: fix(e.employment, "E"),
    education: fix(e.education, "ED"),
    certifications: fix(e.certifications, "C"),
    projects: fix(e.projects, "P").map((p) => ({ ...p, employment_ref: p.employment_ref ? oldToNew.get(p.employment_ref) ?? null : null })),
  };
}

export async function extractCv(opts: LlmOptions & { maskedText: string }): Promise<{ extraction: Extraction; usage: LlmUsage }> {
  const { system, user } = buildCvExtractionPrompt(opts.maskedText);
  const { data, usage } = await opts.llm({
    model: opts.model, system, user, schema: ExtractionSchema, schemaName: "cv_extraction",
    maxTokens: 6_000, timeoutMs: opts.timeoutMs, temperature: 0,
  });
  const parsed = ExtractionSchema.safeParse(data);
  if (!parsed.success) throw new LlmCallError("invalid_output", "Extraction failed schema validation", usage);
  return { extraction: normalizeRefs(clampExtraction(parsed.data)), usage };
}

/** Extraction stripped of identity/contact data for the assessment call (data minimisation). */
export function factsForAssessment(e: Extraction): string {
  return JSON.stringify({
    candidate: { location: e.candidate.location, relocation: e.candidate.relocation, work_preference: e.candidate.work_preference },
    employment: e.employment,
    education: e.education,
    certifications: e.certifications,
    skills_section: e.skills_section,
    projects: e.projects,
  });
}

export const EMPTY_ASSESSMENT: Assessment = { criteria: [], strengths: [], uncertainties: [], follow_up_questions: [] };

export async function assessCv(
  opts: LlmOptions & { extraction: Extraction; criteria: Criteria; jobTitle: string }
): Promise<{ assessment: Assessment; usage: LlmUsage | null }> {
  // total_experience is calculated deterministically — never sent to the model.
  const defs = flattenCriteria(opts.criteria).filter((d) => d.kind !== "total_experience");
  if (!defs.length) return { assessment: EMPTY_ASSESSMENT, usage: null };

  const { system, user } = buildCriteriaAssessmentPrompt({
    jobTitle: opts.jobTitle,
    criteria: defs.map((d) => ({ id: d.id, kind: d.kind, label: d.label, importance: d.importance, detail: d.detail })),
    cvFactsJson: factsForAssessment(opts.extraction),
  });
  const { data, usage } = await opts.llm({
    model: opts.model, system, user, schema: AssessmentSchema, schemaName: "cv_criteria_assessment",
    maxTokens: 4_000, timeoutMs: opts.timeoutMs, temperature: 0,
  });
  const parsed = AssessmentSchema.safeParse(data);
  if (!parsed.success) throw new LlmCallError("invalid_output", "Assessment failed schema validation", usage);

  // Keep only known criterion ids, first answer wins. Missing ones become unable_to_assess later.
  const known = new Set(defs.map((d) => d.id));
  const seen = new Set<string>();
  const criteria = parsed.data.criteria.filter((c) => {
    if (!known.has(c.criterion_id) || seen.has(c.criterion_id)) return false;
    seen.add(c.criterion_id);
    return true;
  });
  return { assessment: { ...parsed.data, criteria }, usage };
}

export async function suggestCriteria(
  opts: LlmOptions & { jobTitle: string; jobDescription: string }
): Promise<{ suggestion: CriteriaSuggestion; usage: LlmUsage }> {
  const { system, user } = buildCriteriaSuggestionPrompt({ jobTitle: opts.jobTitle, jobDescription: opts.jobDescription.slice(0, 12_000) });
  const { data, usage } = await opts.llm({
    model: opts.model, system, user, schema: CriteriaSuggestionSchema, schemaName: "criteria_suggestion",
    maxTokens: 2_000, timeoutMs: opts.timeoutMs, temperature: 0,
  });
  const parsed = CriteriaSuggestionSchema.safeParse(data);
  if (!parsed.success) throw new LlmCallError("invalid_output", "Suggestion failed schema validation", usage);
  return { suggestion: parsed.data, usage };
}

export async function draftJobFromJd(
  opts: LlmOptions & { jobDescription: string }
): Promise<{ draft: JobDraft; usage: LlmUsage }> {
  const { system, user } = buildJobDraftPrompt(opts.jobDescription.slice(0, 12_000));
  const { data, usage } = await opts.llm({
    model: opts.model, system, user, schema: JobDraftSchema, schemaName: "job_draft",
    maxTokens: 2_500, timeoutMs: opts.timeoutMs, temperature: 0,
  });
  const parsed = JobDraftSchema.safeParse(data);
  if (!parsed.success) throw new LlmCallError("invalid_output", "Job draft failed schema validation", usage);
  return { draft: parsed.data, usage };
}

/** Turn a model suggestion into an editable draft. Nothing is ever marked hard automatically. */
export function suggestionToCriteria(s: CriteriaSuggestion, base: Criteria): Criteria {
  const slug = (t: string, used: Set<string>) => {
    const b = t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "item";
    let id = b;
    for (let i = 2; used.has(id); i++) id = `${b}_${i}`.slice(0, 40);
    used.add(id);
    return id;
  };
  const used = new Set<string>();
  const yrs = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.min(40, Math.max(0, n)));
  return {
    ...base,
    skills: s.skills.slice(0, 30).map((k) => ({
      id: slug(`skill_${k.name}`, used), name: k.name.slice(0, 80),
      synonyms: k.synonyms.filter(Boolean).slice(0, 10).map((x) => x.slice(0, 80)),
      importance: k.importance, weight: k.importance === "required" ? 3 : 2, min_years: yrs(k.min_years), hard: false,
    })),
    total_experience: { ...base.total_experience, min_years: yrs(s.total_experience_years), hard: false },
    qualifications: s.qualifications.slice(0, 10).map((q) => ({
      id: slug(`qual_${q.description}`, used), description: q.description.slice(0, 200), equivalents_allowed: true,
      equivalent_experience_years: null, importance: q.importance, weight: 2, hard: false, justification: "",
    })),
    certifications: s.certifications.slice(0, 10).map((c) => ({
      id: slug(`cert_${c.name}`, used), name: c.name.slice(0, 120), importance: c.importance, weight: 2, hard: false,
    })),
    location: { ...base.location, required_location: s.location?.slice(0, 120) || null, arrangement: s.arrangement, hard: false },
  };
}
