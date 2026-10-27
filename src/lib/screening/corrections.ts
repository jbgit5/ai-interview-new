import { z } from "zod";
import { CLASSIFICATIONS, type Extraction } from "./schemas";

// HR corrections to the AI extraction. Stored separately (cv_screenings.corrections) so the
// original extraction is never lost; the timeline and scores are recomputed deterministically
// from extraction ⊕ corrections without another LLM call.

const YM = z.object({
  year: z.number().int().min(1950).max(2100).nullable(),
  month: z.number().int().min(1).max(12).nullable(),
});

export const EmploymentCorrectionSchema = z.object({
  company: z.string().trim().max(160).nullable(),
  title: z.string().trim().max(160).nullable(),
  start: YM.nullable(),
  end: YM.nullable(),
  is_current: z.boolean(),
  employment_type: z.enum(["full_time", "part_time", "contract", "freelance", "internship", "unknown"]),
}).partial();

export const CorrectionsSchema = z.object({
  candidate: z.object({
    name: z.string().trim().max(160).nullable(),
    location: z.string().trim().max(160).nullable(),
  }).partial().optional(),
  employment: z.record(z.string().max(10), EmploymentCorrectionSchema).optional(),
  criteria: z.record(z.string().max(40), z.object({
    classification: z.enum(CLASSIFICATIONS),
    note: z.string().trim().max(500),
  })).optional(),
});
export type Corrections = z.infer<typeof CorrectionsSchema>;

/** Deep-merge a new correction patch into existing corrections. */
export function mergeCorrections(existing: Corrections, patch: Corrections): Corrections {
  const employment = { ...(existing.employment ?? {}) };
  for (const [ref, c] of Object.entries(patch.employment ?? {})) employment[ref] = { ...(employment[ref] ?? {}), ...c };
  return {
    candidate: { ...(existing.candidate ?? {}), ...(patch.candidate ?? {}) },
    employment,
    criteria: { ...(existing.criteria ?? {}), ...(patch.criteria ?? {}) },
  };
}

export function applyCorrections(e: Extraction, c: Corrections): Extraction {
  const name = c.candidate?.name;
  const loc = c.candidate?.location;
  return {
    ...e,
    candidate: {
      ...e.candidate,
      name: name !== undefined ? name : e.candidate.name,
      location: loc !== undefined ? (loc ? { value: loc, excerpt: e.candidate.location?.excerpt ?? "" } : null) : e.candidate.location,
    },
    employment: e.employment.map((job) => {
      const fix = c.employment?.[job.ref];
      if (!fix) return job;
      return {
        ...job,
        company: fix.company !== undefined ? fix.company : job.company,
        title: fix.title !== undefined ? fix.title : job.title,
        start: fix.start !== undefined ? (fix.start ? { ...fix.start, raw: "corrected by HR" } : null) : job.start,
        end: fix.end !== undefined ? (fix.end ? { ...fix.end, raw: "corrected by HR" } : null) : job.end,
        is_current: fix.is_current ?? job.is_current,
        employment_type: fix.employment_type ?? job.employment_type,
      };
    }),
  };
}

export function correctedEmploymentRefs(c: Corrections): string[] {
  return Object.keys(c.employment ?? {});
}
