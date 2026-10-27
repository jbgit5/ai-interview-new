// Deterministic employment-timeline arithmetic. No LLM involvement: the model only transcribes
// dates (year/month as written); every duration, gap and overlap is computed here.
//
// Conventions (also listed in `assumptions` on every result):
//  - Months are inclusive: Jan 2020 – Dec 2020 = 12 months; Mar 2020 – Mar 2020 = 1 month.
//  - A missing month makes the date a range (Jan..Dec of that year). Results become ranges
//    {min, max} instead of invented exact figures. max = null means "cannot be bounded".
//  - "Present" is measured to the screening's as-of month.
//  - Overlapping periods are merged, so concurrent roles are never double-counted.
//  - Part-time roles count as calendar time (not full-time equivalent).
//  - Internships are excluded from "professional" experience but shown separately.
//  - Gaps, short tenures and overlaps are neutral observations. They never affect scores.

export type EmploymentType = "full_time" | "part_time" | "contract" | "freelance" | "internship" | "unknown";

export interface YM {
  year: number | null;
  month: number | null;
}

export interface TimelineEmploymentInput {
  ref: string;
  company: string | null;
  title: string | null;
  start: YM | null;
  end: YM | null;
  is_current: boolean;
  employment_type: EmploymentType;
}

export interface TimelineEducationInput {
  ref: string;
  qualification: string | null;
  end: YM | null;
}

export interface MonthRange {
  min: number;
  /** null → can't be bounded (an entry has a missing start or open end). */
  max: number | null;
}

export type EntryFlag =
  | "missing_start"
  | "missing_end"
  | "start_month_missing"
  | "end_month_missing"
  | "end_before_start"
  | "future_start"
  | "future_end"
  | "implausible_year";

export interface TimelineEntry {
  ref: string;
  company: string | null;
  title: string | null;
  employment_type: EmploymentType;
  is_current: boolean;
  start_label: string;
  end_label: string;
  /** null when the entry couldn't be placed on the timeline (see flags). */
  months: MonthRange | null;
  flags: EntryFlag[];
}

export interface Gap {
  kind: "between_roles" | "education_to_first_role" | "since_last_role";
  after_ref: string | null;
  before_ref: string | null;
  from_label: string;
  to_label: string;
  months: MonthRange;
  exact: boolean;
}

export interface TimelineResult {
  as_of: string;
  entries: TimelineEntry[];
  totals: {
    all_roles: MonthRange;
    professional: MonthRange;
    by_type: Partial<Record<EmploymentType, MonthRange>>;
  };
  career_span: { first_label: string; last_label: string; months: MonthRange } | null;
  gaps: Gap[];
  overlaps: { refs: [string, string]; months: number }[];
  short_tenures: { ref: string; months: MonthRange; employment_type: EmploymentType }[];
  frequent_changes: { short_tenure_count: number } | null;
  conflicts: { ref: string; issue: EntryFlag }[];
  imprecise_refs: string[];
  undated_refs: string[];
  assumptions: string[];
}

export interface TimelineOptions {
  asOf: { year: number; month: number };
  gapThresholdMonths: number;
  shortTenureMonths: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MIN_YEAR = 1950;

export const idx = (year: number, month: number) => year * 12 + (month - 1);
const labelIdx = (i: number) => `${MONTHS[((i % 12) + 12) % 12]} ${Math.floor(i / 12)}`;

export function labelYM(ym: YM | null, current = false): string {
  if (current) return "Present";
  if (!ym || ym.year == null) return "Not stated";
  return ym.month ? `${MONTHS[ym.month - 1]} ${ym.year}` : String(ym.year);
}

function validMonth(m: number | null): number | null {
  return m != null && Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

interface Bounds {
  ref: string;
  type: EmploymentType;
  startEarliest: number;
  startLatest: number;
  endEarliest: number;
  endLatest: number | null;
  /** Shortest interval consistent with the dates. */
  minIv: [number, number];
  /** Longest interval (null if the end is open). */
  maxIv: [number, number] | null;
}

function computeBounds(e: TimelineEmploymentInput, asOfIdx: number, asOfYear: number, flags: EntryFlag[]): Bounds | null {
  const sy = e.start?.year ?? null;
  if (sy == null) {
    flags.push("missing_start");
    return null;
  }
  if (sy < MIN_YEAR || sy > asOfYear + 1) {
    flags.push("implausible_year");
    return null;
  }
  const sm = validMonth(e.start?.month ?? null);
  if (!sm) flags.push("start_month_missing");
  const startEarliest = idx(sy, sm ?? 1);
  const startLatest = idx(sy, sm ?? 12);
  if (startEarliest > asOfIdx) {
    flags.push("future_start");
    return null;
  }

  let endEarliest: number;
  let endLatest: number | null;
  if (e.is_current) {
    endEarliest = endLatest = asOfIdx;
  } else if (e.end?.year != null) {
    const ey = e.end.year;
    if (ey < MIN_YEAR || ey > asOfYear + 5) {
      flags.push("implausible_year");
      return null;
    }
    const em = validMonth(e.end.month);
    if (!em) flags.push("end_month_missing");
    endEarliest = idx(ey, em ?? 1);
    endLatest = idx(ey, em ?? 12);
    if (endEarliest > asOfIdx) {
      // A future end date (e.g. a fixed-term contract) is only counted up to the as-of month.
      flags.push("future_end");
      endEarliest = Math.min(endEarliest, asOfIdx);
      endLatest = Math.min(endLatest, asOfIdx);
    }
  } else {
    flags.push("missing_end");
    endEarliest = startLatest;
    endLatest = null;
  }
  if (endLatest != null && endLatest < startEarliest) {
    flags.push("end_before_start");
    return null;
  }
  endLatest = endLatest == null ? null : Math.min(endLatest, asOfIdx);

  // Shortest consistent interval: start as late and end as early as the dates allow (≥ 1 month).
  let s = Math.min(startLatest, asOfIdx);
  let en = endEarliest;
  if (en < s) {
    s = Math.max(startEarliest, en);
    en = Math.max(en, s);
  }
  return {
    ref: e.ref,
    type: e.employment_type,
    startEarliest,
    startLatest,
    endEarliest,
    endLatest,
    minIv: [s, en],
    maxIv: endLatest == null ? null : [startEarliest, endLatest],
  };
}

/** Total months covered by inclusive [start, end] month intervals, overlaps counted once. */
export function mergedMonths(intervals: [number, number][]): number {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1] + 1) {
      if (cur) total += cur[1] - cur[0] + 1;
      cur = [a, b];
    } else {
      cur[1] = Math.max(cur[1], b);
    }
  }
  if (cur) total += cur[1] - cur[0] + 1;
  return total;
}

function rangeFor(bounds: Bounds[], unplaceable: number): MonthRange {
  const min = mergedMonths(bounds.map((b) => b.minIv));
  const unbounded = unplaceable > 0 || bounds.some((b) => !b.maxIv);
  return { min, max: unbounded ? null : mergedMonths(bounds.map((b) => b.maxIv as [number, number])) };
}

export function buildTimeline(
  employment: TimelineEmploymentInput[],
  education: TimelineEducationInput[],
  opts: TimelineOptions
): TimelineResult {
  const asOfIdx = idx(opts.asOf.year, opts.asOf.month);
  const entries: TimelineEntry[] = [];
  const bounds: Bounds[] = [];
  const unplaceableTypes: EmploymentType[] = [];
  const conflicts: TimelineResult["conflicts"] = [];

  for (const e of employment) {
    const flags: EntryFlag[] = [];
    const b = computeBounds(e, asOfIdx, opts.asOf.year, flags);
    if (b) bounds.push(b);
    else unplaceableTypes.push(e.employment_type);
    for (const f of flags) {
      if (f === "end_before_start" || f === "future_start" || f === "future_end" || f === "implausible_year") conflicts.push({ ref: e.ref, issue: f });
    }
    entries.push({
      ref: e.ref,
      company: e.company,
      title: e.title,
      employment_type: e.employment_type,
      is_current: e.is_current,
      start_label: labelYM(e.start),
      end_label: e.is_current ? "Present" : labelYM(e.end),
      months: b ? { min: b.minIv[1] - b.minIv[0] + 1, max: b.maxIv ? b.maxIv[1] - b.maxIv[0] + 1 : null } : null,
      flags,
    });
  }

  const professional = bounds.filter((b) => b.type !== "internship");
  const byType: TimelineResult["totals"]["by_type"] = {};
  const types = bounds.map((b) => b.type).concat(unplaceableTypes).filter((t, i, all) => all.indexOf(t) === i);
  for (const t of types) {
    byType[t] = rangeFor(bounds.filter((b) => b.type === t), unplaceableTypes.filter((x) => x === t).length);
  }

  // ── Gaps (sweep in start order, tracking the earliest/latest possible end of coverage) ──
  const sorted = [...bounds].sort((a, b) => a.startEarliest - b.startEarliest);
  const gaps: Gap[] = [];
  const reportable = (min: number, max: number) => min >= 1 && max >= opts.gapThresholdMonths;
  if (sorted.length) {
    let coverEndEarliest = sorted[0].endEarliest;
    let coverEndLatest = sorted[0].endLatest ?? Number.POSITIVE_INFINITY;
    let lastRef = sorted[0].ref;
    for (const b of sorted.slice(1)) {
      const gMin = b.startEarliest - coverEndLatest - 1;
      const gMax = b.startLatest - coverEndEarliest - 1;
      if (reportable(gMin, gMax)) {
        gaps.push({
          kind: "between_roles", after_ref: lastRef, before_ref: b.ref,
          from_label: labelIdx(coverEndEarliest), to_label: labelIdx(b.startLatest),
          months: { min: gMin, max: gMax }, exact: gMin === gMax,
        });
      }
      if (b.endEarliest >= coverEndEarliest) lastRef = b.ref;
      coverEndEarliest = Math.max(coverEndEarliest, b.endEarliest);
      coverEndLatest = Math.max(coverEndLatest, b.endLatest ?? Number.POSITIVE_INFINITY);
    }
    const hasCurrent = employment.some((e) => e.is_current);
    if (!hasCurrent && Number.isFinite(coverEndLatest)) {
      const gMin = asOfIdx - coverEndLatest;
      const gMax = asOfIdx - coverEndEarliest;
      if (reportable(gMin, gMax)) {
        gaps.push({
          kind: "since_last_role", after_ref: lastRef, before_ref: null,
          from_label: labelIdx(coverEndEarliest), to_label: `${labelIdx(asOfIdx)} (as of screening)`,
          months: { min: gMin, max: gMax }, exact: gMin === gMax,
        });
      }
    }

    // Education → first role: the latest qualification completed before the first role started.
    const first = sorted[0];
    const eduEnds = education
      .filter((ed) => ed.end?.year != null && ed.end.year >= MIN_YEAR)
      .map((ed) => {
        const m = validMonth(ed.end!.month);
        return { ref: ed.ref, earliest: idx(ed.end!.year!, m ?? 1), latest: idx(ed.end!.year!, m ?? 12) };
      })
      .filter((ed) => ed.earliest <= first.startLatest)
      .sort((a, b) => b.earliest - a.earliest);
    if (eduEnds.length) {
      const ed = eduEnds[0];
      const gMin = first.startEarliest - ed.latest - 1;
      const gMax = first.startLatest - ed.earliest - 1;
      if (reportable(gMin, gMax)) {
        gaps.push({
          kind: "education_to_first_role", after_ref: ed.ref, before_ref: first.ref,
          from_label: labelIdx(ed.earliest), to_label: labelIdx(first.startLatest),
          months: { min: gMin, max: gMax }, exact: gMin === gMax,
        });
      }
    }
  }

  // ── Definite overlaps (concurrent roles; neutral) ──
  const overlaps: TimelineResult["overlaps"] = [];
  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i].minIv;
      const b = bounds[j].minIv;
      const n = Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1;
      if (n > 0) overlaps.push({ refs: [bounds[i].ref, bounds[j].ref], months: n });
    }
  }

  // ── Short tenures: definitely shorter than the threshold and finished ──
  const shortTenures: TimelineResult["short_tenures"] = [];
  for (const b of bounds) {
    const e = employment.find((x) => x.ref === b.ref)!;
    if (e.is_current || !b.maxIv) continue;
    const max = b.maxIv[1] - b.maxIv[0] + 1;
    if (max < opts.shortTenureMonths) shortTenures.push({ ref: b.ref, months: { min: b.minIv[1] - b.minIv[0] + 1, max }, employment_type: b.type });
  }
  // Fixed-term work (contract/freelance/internship) is short by nature and not counted here.
  const permanentShort = shortTenures.filter((s) => s.employment_type === "full_time" || s.employment_type === "part_time" || s.employment_type === "unknown").length;

  let careerSpan: TimelineResult["career_span"] = null;
  if (sorted.length) {
    const firstStartE = Math.min(...sorted.map((b) => b.startEarliest));
    const firstStartL = Math.min(...sorted.map((b) => b.startLatest));
    const lastEndE = Math.max(...sorted.map((b) => b.endEarliest));
    const unbounded = sorted.some((b) => b.endLatest == null);
    const lastEndL = unbounded ? null : Math.max(...sorted.map((b) => b.endLatest as number));
    careerSpan = {
      first_label: labelIdx(firstStartL),
      last_label: employment.some((e) => e.is_current) ? "Present" : labelIdx(lastEndE),
      months: { min: Math.max(1, lastEndE - firstStartL + 1), max: lastEndL == null ? null : lastEndL - firstStartE + 1 },
    };
  }

  const imprecise = entries.filter((e) => e.flags.includes("start_month_missing") || e.flags.includes("end_month_missing")).map((e) => e.ref);
  const undated = entries.filter((e) => e.flags.includes("missing_start") || e.flags.includes("missing_end")).map((e) => e.ref);

  const assumptions = [
    "Durations count both the start and end month (Jan–Dec 2020 = 12 months).",
    `"Present" is measured to ${labelIdx(asOfIdx)}.`,
    "Overlapping roles are counted once.",
    "Part-time roles count as calendar time, not full-time equivalent.",
    "Internships are excluded from professional experience.",
  ];
  if (imprecise.length) assumptions.push(`Year-only dates (${imprecise.join(", ")}) are treated as anywhere from January to December, so totals are ranges.`);
  if (undated.length) assumptions.push(`Roles with a missing start or end date (${undated.join(", ")}) can't be fully measured; the upper bound is left open.`);
  if (conflicts.length) assumptions.push(`Roles with inconsistent dates (${conflicts.map((c) => c.ref).filter((r, i, all) => all.indexOf(r) === i).join(", ")}) are excluded from totals or clipped to the screening date.`);

  return {
    as_of: labelIdx(asOfIdx),
    entries,
    totals: {
      all_roles: rangeFor(bounds, unplaceableTypes.length),
      professional: rangeFor(professional, unplaceableTypes.filter((t) => t !== "internship").length),
      by_type: byType,
    },
    career_span: careerSpan,
    gaps,
    overlaps,
    short_tenures: shortTenures,
    frequent_changes: permanentShort >= 3 ? { short_tenure_count: permanentShort } : null,
    conflicts,
    imprecise_refs: imprecise,
    undated_refs: undated,
    assumptions,
  };
}

/**
 * Hands-on duration for one skill: merged months of only the roles where the skill is
 * evidenced as USED. Listing a skill in a skills section contributes nothing.
 */
export function skillMonths(
  employment: TimelineEmploymentInput[],
  refs: string[],
  asOf: { year: number; month: number }
): MonthRange | null {
  const wanted = new Set(refs);
  const picked = employment.filter((e) => wanted.has(e.ref));
  if (!picked.length) return null;
  const asOfIdx = idx(asOf.year, asOf.month);
  const bounds: Bounds[] = [];
  let unplaceable = 0;
  for (const e of picked) {
    const b = computeBounds(e, asOfIdx, asOf.year, []);
    if (b) bounds.push(b);
    else unplaceable++;
  }
  return rangeFor(bounds, unplaceable);
}

/** Compare a month range with a minimum-years requirement without inventing precision. */
export function compareToYears(range: MonthRange | null, minYears: number): "met" | "unmet" | "undetermined" {
  if (!range) return "undetermined";
  const req = Math.round(minYears * 12);
  if (range.min >= req) return "met";
  if (range.max != null && range.max < req) return "unmet";
  return "undetermined";
}

/** "3 yrs 4 mos" or "2–3 yrs" style label for a range. */
export function formatRange(r: MonthRange | null): string {
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

/**
 * When a skill was last used: the latest end date among the roles where it is evidenced as
 * USED ("current" if any of those roles is current). Shown to HR, never scored.
 */
export function lastUsed(
  employment: TimelineEmploymentInput[],
  refs: string[],
  asOf: { year: number; month: number }
): { current: boolean; label: string; months_ago: number | null } | null {
  const picked = employment.filter((e) => refs.includes(e.ref));
  if (!picked.length) return null;
  if (picked.some((e) => e.is_current)) return { current: true, label: "in current role", months_ago: 0 };
  let best: YM | null = null;
  let bestIdx = -1;
  for (const e of picked) {
    if (e.end?.year == null) continue;
    const i = idx(e.end.year, validMonth(e.end.month) ?? 12);
    if (i > bestIdx) {
      bestIdx = i;
      best = e.end;
    }
  }
  if (!best) return null;
  const ago = Math.max(0, idx(asOf.year, asOf.month) - bestIdx);
  return { current: false, label: `last used ${labelYM(best)}`, months_ago: ago };
}
