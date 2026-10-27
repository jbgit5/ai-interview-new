// The HR team's 13-point CV checklist, answered from the screening data. Pure and deterministic.
// Every item shows a status and the facts behind it. Statuses are guidance for HR, not scores:
//   ok          ✓  checked, nothing to follow up
//   check       ⚠  something HR should look at or ask about
//   unclear     ?  not enough information in the CV to say
//   info        ℹ  facts shown, no requirement set for this job
//   unverified  ◌  candidate's claim; not checked against an outside source

import type { ContactChecks } from "./contactChecks";
import { analyzePhone } from "./contactChecks";
import type { ScreeningEvaluation } from "./evaluate";
import type { Extraction } from "./schemas";
import { careerProgression, titleLevel } from "./seniority";
import { formatRange, idx, type TimelineResult } from "./timeline";

export type HrStatus = "ok" | "check" | "unclear" | "info" | "unverified";
export type ReportTab = "requirements" | "experience" | "checks" | "questions";

export interface HrItem {
  key: string;
  n: number;
  title: string;
  status: HrStatus;
  summary: string;
  details: string[];
  tab: ReportTab | null;
}

export interface CrossChecks {
  /** Other CVs in this job with the same email or phone number. */
  same_contact: { name: string; screening_id: string | null; via: "email" | "phone" }[];
  /** Other CVs in this job whose text is largely identical (estimated share of identical text). */
  similar_text: { name: string; screening_id: string | null; similarity: number }[];
}

export interface HrChecklistInput {
  ev: Omit<ScreeningEvaluation, "timeline">;
  timeline: TimelineResult;
  extraction: Extraction | null;
  contactChecks: ContactChecks | null;
  cross: CrossChecks;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} +${xs.length - max} more`);

export function buildHrChecklist({ ev, timeline: tl, extraction, contactChecks, cross }: HrChecklistInput): HrItem[] {
  const items: HrItem[] = [];
  const add = (it: Omit<HrItem, "n">) => items.push({ ...it, n: items.length + 1 });
  const crit = (kind: string) => ev.criteria.filter((c) => c.kind === kind);
  const statusFromCriteria = (cs: typeof ev.criteria): HrStatus => {
    if (!cs.length) return "info";
    if (cs.some((c) => c.classification === "does_not_meet" || c.hard_status === "unmet" || c.experience?.comparison === "unmet")) return "check";
    if (cs.every((c) => c.classification === "strong" && (!c.experience || c.experience.comparison === "met"))) return "ok";
    return "unclear";
  };

  // 1 · Contact details correct and real
  {
    const details: string[] = [];
    let status: HrStatus = "ok";
    const emails = ev.candidate.emails;
    if (!emails.length) { status = "check"; details.push("No email address found in the CV."); }
    for (const e of emails) {
      const dns = contactChecks?.emails.find((x) => x.email.toLowerCase() === e.value.toLowerCase());
      if (!e.format_valid) { status = "check"; details.push(`${e.value}: not a valid email format.`); continue; }
      if (dns?.disposable) { status = "check"; details.push(`${e.value}: a throw-away email service.`); }
      if (dns?.accepts_mail === false) {
        status = "check";
        details.push(`${e.value}: ${dns.detail === "domain_not_found" ? "the email domain doesn't exist" : "the domain has no mail server"}.`);
      } else if (dns?.accepts_mail === true && !dns.disposable) {
        details.push(`${e.value}: valid format, domain accepts email.`);
      } else if (!dns || dns.accepts_mail === null) {
        if (status === "ok") status = "unclear";
        details.push(`${e.value}: valid format; domain check not available.`);
      }
    }
    const phones = ev.candidate.phones.map((p) => analyzePhone(p.value));
    if (!phones.length) { if (status === "ok") status = "unclear"; details.push("No phone number found in the CV."); }
    for (const p of phones) {
      if (!p.valid) { status = "check"; details.push(`${p.value}: not a valid phone number${p.assumed_country ? ` for ${p.country ?? "the assumed country"}` : ""}.`); continue; }
      const kind = p.type === "MOBILE" ? "mobile" : p.type === "FIXED_LINE" ? "landline" : p.type === "FIXED_LINE_OR_MOBILE" ? "mobile/landline" : "number";
      details.push(`${p.international ?? p.value}: valid ${p.country ?? ""} ${kind}${p.assumed_country ? " (no country code in CV — country assumed)" : ""}.`);
    }
    for (const d of cross.same_contact) { status = "check"; details.push(`Same ${d.via} as another CV in this job: ${d.name}.`); }
    details.push("Not verified with the candidate (no email or SMS is sent).");
    add({ key: "contact", title: "Name, phone and email look correct", status, summary: status === "ok" ? "Email and phone look valid" : status === "check" ? "Something to check" : "Partly checked", details, tab: "checks" });
  }

  // 2 · Location, relocation, remote
  {
    const loc = crit("location");
    const facts = [
      `Lives in: ${ev.candidate.location ?? "not stated"}`,
      `Relocation: ${ev.candidate.relocation ?? "not stated"}`,
      `Remote / hybrid / onsite: ${ev.candidate.work_preference ?? "not stated"}`,
    ];
    const status: HrStatus = loc.length ? statusFromCriteria(loc) : "info";
    add({
      key: "location", title: "Current location; can relocate or work remotely", status,
      summary: loc.length ? `${loc[0].label}: ${status === "ok" ? "fits" : status === "check" ? "doesn't fit" : "unclear"}` : ev.candidate.location ? `Lives in ${ev.candidate.location}` : "Not stated",
      details: [...facts, "Only what the candidate states is used — never guessed from an address.", ...(loc.length ? [] : ["No location requirement set for this job."])],
      tab: loc.length ? "requirements" : null,
    });
  }

  // 3 · Degree fits the job
  {
    const q = crit("qualification");
    const degrees = ev.education.map((e) => [e.qualification, e.field_of_study].filter(Boolean).join(", ") || "qualification").filter(Boolean);
    const status: HrStatus = q.length ? statusFromCriteria(q) : degrees.length ? "info" : "unclear";
    add({
      key: "degree", title: "Degree fits the job", status,
      summary: degrees.length ? list(degrees, 2) : "No degree found in the CV",
      details: [
        ...(degrees.length ? degrees.map((d) => `Found: ${d}`) : []),
        ...q.map((c) => `${c.label}: ${c.classification.replace(/_/g, " ")}${c.notes.length ? ` — ${c.notes[0]}` : ""}`),
        ...(q.length ? [] : ["No degree requirement set for this job — add one on the Requirements tab (accepted fields can be listed, equivalents allowed)."]),
      ],
      tab: q.length ? "requirements" : "experience",
    });
  }

  // 4 · Gap after studies / gaps between jobs
  {
    const gaps = tl.gaps;
    add({
      key: "gaps", title: "Gap after studies, or gaps between jobs", status: gaps.length ? "check" : tl.entries.length ? "ok" : "unclear",
      summary: gaps.length ? `${gaps.length} gap${gaps.length === 1 ? "" : "s"} found` : tl.entries.length ? "No gaps found" : "No job dates to check",
      details: gaps.length
        ? [...gaps.map((g) => `${g.kind === "education_to_first_role" ? "After education" : g.kind === "since_last_role" ? "Since last job" : "Between jobs"}: ${g.from_label} → ${g.to_label} (${formatRange(g.months)}${g.exact ? "" : ", approx."})`), "A gap is a fact to ask about, not a negative. It never lowers the score."]
        : [],
      tab: "experience",
    });
  }

  // 5 · Total years of work
  {
    const t = crit("total_experience")[0];
    const total = formatRange(tl.totals.professional);
    add({
      key: "total_years", title: "Total years of work meets the minimum",
      status: t ? (t.experience?.comparison === "met" ? "ok" : t.experience?.comparison === "unmet" ? "check" : "unclear") : "info",
      summary: t ? `${total} (needs ${t.experience?.required_years} yr)` : `${total} (no minimum set)`,
      details: ["Calculated from job dates. Overlapping jobs counted once; internships not counted.", ...tl.assumptions.slice(5)],
      tab: "experience",
    });
  }

  // 6 · Years in the required technology
  {
    const withYears = crit("skill").filter((c) => c.experience);
    add({
      key: "tech_years", title: "Years in the required technology (not general IT)",
      status: withYears.length ? statusFromCriteria(withYears) : "info",
      summary: withYears.length ? list(withYears.map((c) => `${c.label} ${c.experience!.label}`), 3) : "No minimum years set for any skill",
      details: withYears.length
        ? withYears.map((c) => `${c.label}: ${c.experience!.label} of hands-on use (needs ${c.experience!.required_years} yr) — ${c.experience!.comparison}${c.last_used ? `, ${c.last_used.label}` : ""}`)
        : ["Set minimum years per skill on the Requirements tab to check this."],
      tab: "requirements",
    });
  }

  // 7 · Month and year for each job
  {
    const missing = tl.undated_refs;
    const yearOnly = tl.imprecise_refs.filter((r) => !missing.includes(r));
    const name = (ref: string) => { const e = tl.entries.find((x) => x.ref === ref); return e ? `${e.title ?? "role"} at ${e.company ?? "unknown"}` : ref; };
    add({
      key: "dates", title: "Month and year for each job's start and end",
      status: missing.length ? "check" : yearOnly.length ? "check" : tl.entries.length ? "ok" : "unclear",
      summary: missing.length ? `${missing.length} job(s) missing dates` : yearOnly.length ? `${yearOnly.length} job(s) give only the year` : tl.entries.length ? "All jobs have month and year" : "No jobs found",
      details: [...missing.map((r) => `Missing start or end: ${name(r)}`), ...yearOnly.map((r) => `Year only (no month): ${name(r)}`)],
      tab: "experience",
    });
  }

  // 8 · Unexplained breaks; overlapping jobs
  {
    const between = tl.gaps.filter((g) => g.kind === "between_roles");
    const overlaps = tl.overlaps;
    const ref = (r: string) => tl.entries.find((x) => x.ref === r)?.company ?? r;
    add({
      key: "breaks_overlaps", title: "No unexplained breaks; no overlapping jobs",
      status: between.length || overlaps.length ? "check" : tl.entries.length ? "ok" : "unclear",
      summary: [between.length && `${between.length} break(s)`, overlaps.length && `${overlaps.length} overlap(s)`].filter(Boolean).join(" · ") || (tl.entries.length ? "None found" : "No jobs found"),
      details: [
        ...between.map((g) => `Break: ${g.from_label} → ${g.to_label} (${formatRange(g.months)})`),
        ...overlaps.map((o) => `Jobs at the same time: ${ref(o.refs[0])} and ${ref(o.refs[1])} (${o.months} months) — may be normal (e.g. part-time or freelance).`),
        ...(between.length ? ["Whether the CV explains a break isn't read yet — ask the candidate."] : []),
      ],
      tab: "experience",
    });
  }

  // 9 · Short jobs / frequent changes
  {
    const short = tl.short_tenures;
    const ref = (r: string) => { const e = tl.entries.find((x) => x.ref === r); return e ? `${e.title ?? "role"} at ${e.company ?? "unknown"}` : r; };
    add({
      key: "short_jobs", title: "Jobs under a year, or frequent job changes",
      status: tl.frequent_changes || short.length ? "check" : tl.entries.length ? "ok" : "unclear",
      summary: tl.frequent_changes ? `Several short jobs (${tl.frequent_changes.short_tenure_count})` : short.length ? `${short.length} short job(s)` : tl.entries.length ? "None" : "No jobs found",
      details: [
        ...short.map((s) => `${ref(s.ref)}: ${formatRange(s.months)}${s.employment_type !== "unknown" ? ` (${s.employment_type.replace("_", "-")})` : ""}`),
        ...(short.length ? ["Contract, freelance and internship roles are often short by design. Never scored."] : []),
      ],
      tab: "experience",
    });
  }

  // 10 · Companies real; titles match the work
  {
    const noCompany = (extraction?.employment ?? []).filter((e) => !e.company);
    const noTitle = (extraction?.employment ?? []).filter((e) => !e.title);
    const notes = (extraction?.observations ?? []).filter((o) => o.type === "ambiguous_employer" || o.type === "unclear_title");
    const issues = [...noCompany.map((e) => `${e.title ?? "A role"}: employer name missing`), ...noTitle.map((e) => `${e.company ?? "A role"}: job title missing`), ...notes.map((o) => o.description)];
    const companies = Array.from(new Set((extraction?.employment ?? []).map((e) => e.company).filter((c): c is string => !!c)));
    add({
      key: "companies", title: "Companies are real; job titles match the work",
      status: issues.length ? "check" : "unverified",
      summary: issues.length ? `${issues.length} item(s) to check` : `${companies.length} employer(s) named — not verified online`,
      details: [...issues, ...(companies.length ? [`Employers: ${list(companies, 6)}`] : []), "Company existence is not checked against an outside source yet. Titles are as written by the candidate."],
      tab: "checks",
    });
  }

  // 11 · Growth over time (from job titles)
  {
    const roles = (extraction?.employment ?? []).map((e) => ({
      title: e.title,
      company: e.company,
      startIdx: e.start?.year ? idx(e.start.year, e.start.month ?? 1) : null,
    }));
    const prog = careerProgression(roles);
    const bands = roles.filter((r) => r.title).map((r) => titleLevel(r.title)?.band).filter(Boolean) as string[];
    add({
      key: "growth", title: "Grown over time (bigger roles, more responsibility)",
      status: prog.trend === "up" ? "ok" : prog.trend === "same" ? "info" : "unclear",
      summary: prog.trend === "up" ? `Titles show progression${prog.internal_promotions ? ` (${prog.internal_promotions} internal promotion${prog.internal_promotions > 1 ? "s" : ""})` : ""}` : prog.trend === "same" ? "Similar level across roles" : "Not enough dated roles to tell",
      details: [
        ...(prog.path.length ? [`Path: ${prog.path.join(" → ")}`] : []),
        ...(bands.length ? [`Levels read from titles: ${Array.from(new Set(bands)).join(", ")}`] : []),
        "Read from job titles only — titles differ between companies. Lateral moves and career changes are normal and never scored.",
      ],
      tab: "experience",
    });
  }

  // 12 · Skills listed match actual work
  {
    const skills = crit("skill");
    const listedOnly = skills.filter((c) => c.classification === "listed_only").map((c) => c.label);
    const shown = skills.filter((c) => c.classification === "strong" || c.classification === "partial").map((c) => c.label);
    const used = new Set((extraction?.employment ?? []).flatMap((e) => e.technologies.map((t) => t.name.toLowerCase()))
      .concat((extraction?.projects ?? []).flatMap((p) => p.technologies.map((t) => t.name.toLowerCase()))));
    const sectionOnly = (extraction?.skills_section ?? []).map((s) => s.name).filter((n) => !used.has(n.toLowerCase()));
    add({
      key: "skills_match", title: "Skills listed match the work actually done",
      status: listedOnly.length ? "check" : skills.length ? "ok" : sectionOnly.length ? "info" : "unclear",
      summary: listedOnly.length ? `${listedOnly.length} required skill(s) only listed, not shown in work` : skills.length ? `${shown.length} of ${skills.length} job skills shown in real work` : "No skills set for this job",
      details: [
        ...(shown.length ? [`Shown in work: ${list(shown, 6)}`] : []),
        ...(listedOnly.length ? [`Only listed in a skills section: ${list(listedOnly, 6)}`] : []),
        ...(sectionOnly.length ? [`Other skills listed but not linked to any job or project: ${list(sectionOnly, 8)}`] : []),
        "A skill missing from the CV doesn't mean the candidate lacks it.",
      ],
      tab: "requirements",
    });
  }

  // 13 · CV clear and consistent; copied text; buzzwords
  {
    const obs = (extraction?.observations ?? []).filter((o) => ["contradiction", "vague_claim", "repeated_passage", "unclear_structure"].includes(o.type));
    const unverified = ev.citation_stats.total - ev.citation_stats.verified;
    const label: Record<string, string> = { contradiction: "Contradiction", vague_claim: "Vague claim, no example", repeated_passage: "Repeated text", unclear_structure: "Unclear structure" };
    const status: HrStatus = obs.some((o) => o.type === "contradiction") || cross.similar_text.length ? "check" : obs.length ? "check" : "ok";
    add({
      key: "cv_quality", title: "CV clear and consistent; no copied text or empty buzzwords",
      status,
      summary: [cross.similar_text.length && "Text similar to another CV", obs.length && `${obs.length} note(s)`].filter(Boolean).join(" · ") || "No issues noted",
      details: [
        ...cross.similar_text.map((s) => `About ${pct(s.similarity)} of the text is identical to ${s.name}'s CV — compare them. This alone doesn't prove copying.`),
        ...obs.map((o) => `${label[o.type] ?? o.type}: ${o.description}`),
        ...(unverified > 0 ? [`${unverified} AI quote(s) couldn't be found in the CV and were ignored.`] : []),
        "Writing style and length are never scored.",
      ],
      tab: "checks",
    });
  }

  return items;
}

export function hrChecklistCounts(items: HrItem[]): Record<HrStatus, number> {
  const c: Record<HrStatus, number> = { ok: 0, check: 0, unclear: 0, info: 0, unverified: 0 };
  for (const it of items) c[it.status]++;
  return c;
}
