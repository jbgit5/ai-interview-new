// Deterministic part of a screening: given the (validated) extraction and assessment, build the
// timeline, verify citations, score every criterion and produce the verification checklist.
// Pure — no I/O, no LLM. Re-run after HR corrections without any provider cost.

import { flattenCriteria, type Criteria, type CriterionDef } from "./criteria";
import { verifyExcerpt } from "./citations";
import type { ContactInfo } from "./contact";
import { applyCorrections, correctedEmploymentRefs, type Corrections } from "./corrections";
import type { Assessment, Classification, Extraction } from "./schemas";
import { scoreCriterion, summarize, type CriterionResult, type EvidenceRef, type ScoreSummary } from "./scoring";
import { buildTimeline, compareToYears, formatRange, lastUsed, skillMonths, type TimelineResult } from "./timeline";
import { formatPersonName, resolveCandidateName } from "./name";

export interface ChecklistItem {
  kind:
    | "contact_format"
    | "missing_dates"
    | "chronology_conflict"
    | "ambiguous_employer"
    | "unclear_title"
    | "unverified_citation"
    | "cv_observation"
    | "truncated_text"
    | "human_verification";
  severity: "info" | "review";
  message: string;
  refs: string[];
}

export interface ScreeningEvaluation {
  timeline: TimelineResult;
  criteria: CriterionResult[];
  summary: ScoreSummary;
  checklist: ChecklistItem[];
  candidate: {
    name: string | null;
    location: string | null;
    relocation: string | null;
    work_preference: string | null;
    emails: ContactInfo["emails"];
    phones: ContactInfo["phones"];
  };
  education: Extraction["education"];
  certifications: Extraction["certifications"];
  strengths: string[];
  uncertainties: string[];
  follow_up_questions: string[];
  corrected_refs: string[];
  citation_stats: { total: number; verified: number };
}

export interface EvaluateInput {
  extraction: Extraction;
  assessment: Assessment;
  criteria: Criteria;
  /** Page texts exactly as the model saw them (masked). */
  pages: string[];
  paged: boolean;
  contacts: ContactInfo;
  asOf: { year: number; month: number };
  corrections: Corrections;
  textTruncated: boolean;
}

export function evaluateScreening(input: EvaluateInput): ScreeningEvaluation {
  const extraction = applyCorrections(input.extraction, input.corrections);
  const defs = flattenCriteria(input.criteria);
  const employmentByRef = new Map(extraction.employment.map((e) => [e.ref, e]));

  const timeline = buildTimeline(
    extraction.employment.map((e) => ({
      ref: e.ref, company: e.company, title: e.title, start: e.start, end: e.end,
      is_current: e.is_current, employment_type: e.employment_type,
    })),
    extraction.education.map((ed) => ({ ref: ed.ref, qualification: ed.qualification, end: ed.end })),
    { asOf: input.asOf, gapThresholdMonths: input.criteria.observations.gap_threshold_months, shortTenureMonths: input.criteria.observations.short_tenure_months }
  );

  let citeTotal = 0;
  let citeOk = 0;
  const cite = (source_ref: string | null, excerpt: string): EvidenceRef => {
    const check = verifyExcerpt(excerpt, input.pages, input.paged);
    citeTotal++;
    if (check.verified) citeOk++;
    const job = source_ref ? employmentByRef.get(source_ref) : undefined;
    return { source_ref, excerpt, verified: check.verified, page: check.page, employer: job?.company ?? null, title: job?.title ?? null };
  };

  const assessed = new Map(input.assessment.criteria.map((a) => [a.criterion_id, a]));
  const timelineEmployment = extraction.employment.map((e) => ({
    ref: e.ref, company: e.company, title: e.title, start: e.start, end: e.end, is_current: e.is_current, employment_type: e.employment_type,
  }));

  const criteria: CriterionResult[] = defs.map((def: CriterionDef) => {
    const a = assessed.get(def.id);
    const override = input.corrections.criteria?.[def.id] ?? null;
    if (def.kind === "total_experience") {
      const months = timeline.totals.professional;
      const cmp = compareToYears(months, def.min_years ?? 0);
      const noRoles = extraction.employment.length === 0;
      const cls: Classification = noRoles ? "unable_to_assess" : cmp === "met" ? "strong" : cmp === "unmet" ? "does_not_meet" : "unable_to_assess";
      return scoreCriterion({
        def, ai_classification: cls, evidence: [], inferred: false,
        rationale: noRoles
          ? "No employment history could be extracted from the CV."
          : `Calculated professional experience: ${formatRange(months)} (required: ${def.min_years} years).`,
        months,
        calculated: { classification: cls, note: "Calculated from the employment timeline, not by the AI." },
        override,
      });
    }

    const ai: Classification = a?.classification ?? "unable_to_assess";
    const evidence = (a?.evidence ?? []).slice(0, 6).map((ev) => cite(ev.source_ref, ev.excerpt));
    const refs = def.kind === "skill" && (ai === "strong" || ai === "partial")
      ? (a?.employment_refs ?? []).filter((r) => employmentByRef.has(r))
      : [];
    const months = refs.length ? skillMonths(timelineEmployment, refs, input.asOf) : null;

    let calculated: { classification: Classification; note: string } | null = null;
    if (def.kind === "qualification" && ai !== "strong") {
      const q = input.criteria.qualifications.find((x) => x.id === def.id);
      if (q?.equivalents_allowed && q.equivalent_experience_years != null && compareToYears(timeline.totals.professional, q.equivalent_experience_years) === "met") {
        calculated = {
          classification: "partial",
          note: `Professional experience (${formatRange(timeline.totals.professional)}) meets the ${q.equivalent_experience_years}-year equivalence threshold; HR should confirm it is directly relevant.`,
        };
      }
    }

    const scored = scoreCriterion({
      def,
      ai_classification: ai,
      evidence,
      inferred: a?.inferred ?? false,
      rationale: a ? a.rationale : "The AI did not return an assessment for this criterion.",
      months,
      calculated,
      override,
    });
    return def.kind === "skill" ? { ...scored, last_used: refs.length ? lastUsed(timelineEmployment, refs, input.asOf) : null } : scored;
  });

  const summary = summarize(criteria);

  // ── Verification checklist (deterministic) ──
  const checklist: ChecklistItem[] = [];
  const push = (kind: ChecklistItem["kind"], severity: ChecklistItem["severity"], message: string, refs: string[] = []) =>
    checklist.push({ kind, severity, message, refs });

  if (!input.contacts.emails.length) push("contact_format", "review", "No email address found in the CV.");
  for (const e of input.contacts.emails) {
    push("contact_format", e.format_valid ? "info" : "review",
      e.format_valid ? `Email ${e.value} has a valid format (not verified — no message was sent).` : `Email ${e.value} does not look like a valid address.`);
  }
  if (!input.contacts.phones.length) push("contact_format", "info", "No phone number found in the CV.");
  for (const p of input.contacts.phones) {
    const cc = p.has_country_code ? "includes a country code" : "has no country code";
    push("contact_format", p.format_valid ? "info" : "review",
      `Phone ${p.value} ${p.format_valid ? "has a plausible format" : "has an unusual length"} and ${cc} (not verified).`);
  }
  if (timeline.undated_refs.length) push("missing_dates", "review", `Missing start or end dates: ${timeline.undated_refs.join(", ")}.`, timeline.undated_refs);
  if (timeline.imprecise_refs.length) push("missing_dates", "info", `Year-only dates (no month): ${timeline.imprecise_refs.join(", ")}. Durations are shown as ranges.`, timeline.imprecise_refs);
  for (const c of timeline.conflicts) {
    const msg: Record<string, string> = {
      end_before_start: "end date is before the start date",
      future_start: "start date is after the screening date",
      future_end: "end date is in the future (counted only up to today)",
      implausible_year: "contains an implausible year",
    };
    push("chronology_conflict", "review", `${c.ref}: ${msg[c.issue] ?? c.issue}.`, [c.ref]);
  }
  for (const job of extraction.employment) {
    if (!job.company) push("ambiguous_employer", "review", `${job.ref} (${job.title ?? "untitled role"}): employer name is missing.`, [job.ref]);
    if (!job.title) push("unclear_title", "review", `${job.ref} (${job.company ?? "unknown employer"}): job title is missing.`, [job.ref]);
  }
  for (const o of extraction.observations) {
    const kind: ChecklistItem["kind"] =
      o.type === "ambiguous_employer" ? "ambiguous_employer" : o.type === "unclear_title" ? "unclear_title" : o.type === "missing_dates" ? "missing_dates" : "cv_observation";
    push(kind, o.type === "contradiction" ? "review" : "info", o.description);
  }
  if (citeTotal > citeOk) push("unverified_citation", "review", `${citeTotal - citeOk} of ${citeTotal} AI-cited excerpts could not be found in the CV and were not counted as evidence.`);
  if (input.textTruncated) push("truncated_text", "review", "The CV is very long; only the first part was analysed.");
  push("human_verification", "info", "Employers, job titles, qualifications and certifications are the candidate's own claims and have not been verified externally.");

  return {
    timeline,
    criteria,
    summary,
    checklist,
    candidate: {
      // HR's correction is authoritative; otherwise use the CV's own spelling of the name.
      name: input.corrections.candidate?.name
        ? formatPersonName(input.corrections.candidate.name)
        : resolveCandidateName(input.extraction.candidate.name, input.pages),
      location: extraction.candidate.location?.value ?? null,
      relocation: extraction.candidate.relocation?.value ?? null,
      work_preference: extraction.candidate.work_preference?.value ?? null,
      emails: input.contacts.emails,
      phones: input.contacts.phones,
    },
    education: extraction.education,
    certifications: extraction.certifications,
    strengths: input.assessment.strengths.slice(0, 5),
    uncertainties: input.assessment.uncertainties.slice(0, 5),
    follow_up_questions: input.assessment.follow_up_questions.slice(0, 5),
    corrected_refs: correctedEmploymentRefs(input.corrections),
    citation_stats: { total: citeTotal, verified: citeOk },
  };
}
