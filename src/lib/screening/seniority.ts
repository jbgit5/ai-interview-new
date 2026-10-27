// Career growth read from JOB TITLES only (no AI, no cost). Descriptive, never scored:
// lateral moves, career changes and flat titles are normal and are not negatives.
// Titles differ a lot between companies, so this is a hint for HR, not a measurement.

// Checked top to bottom; more specific titles first ("assistant vice president" before "vice president").
const LADDER: [RegExp, number, string][] = [
  [/\b(ceo|cto|cfo|coo|cio|chief|founder|co-founder)\b/, 8, "executive"],
  [/\b(avp|assistant vice president|associate director|senior manager|sr\.? manager)\b/, 6, "senior manager / AVP"],
  [/\b(vice president|vp|svp|evp|director|head)\b/, 7, "director / head"],
  [/\b(manager|mgr)\b/, 5, "manager"],
  [/\b(lead|principal|staff|architect)\b/, 4, "lead / principal"],
  [/\b(senior|sr\.?)\b/, 3, "senior"],
  [/\b(junior|jr\.?|associate|assistant|trainee|graduate|fresher)\b/, 1, "junior / associate"],
  [/\b(intern|internship|apprentice)\b/, 0, "intern"],
];

export function titleLevel(title: string | null | undefined): { rank: number; band: string } | null {
  if (!title?.trim()) return null;
  const t = title.toLowerCase();
  for (const [re, rank, band] of LADDER) if (re.test(t)) return { rank, band };
  return { rank: 2, band: "professional" };
}

export interface Progression {
  /** "up" = later titles are more senior · "same" = no clear change · "unclear" = not enough titles */
  trend: "up" | "same" | "unclear";
  path: string[];
  /** Promotion inside the same company (same employer, more senior title later). */
  internal_promotions: number;
}

export function careerProgression(
  roles: { title: string | null; company: string | null; startIdx: number | null }[]
): Progression {
  const dated = roles
    .filter((r) => r.title && r.startIdx != null)
    .sort((a, b) => (a.startIdx as number) - (b.startIdx as number));
  if (dated.length < 2) return { trend: "unclear", path: dated.map((r) => r.title as string), internal_promotions: 0 };

  const levels = dated.map((r) => titleLevel(r.title)!.rank);
  const first = levels.slice(0, Math.ceil(levels.length / 2));
  const last = levels.slice(Math.floor(levels.length / 2));
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  let promotions = 0;
  for (let i = 1; i < dated.length; i++) {
    const prev = dated[i - 1];
    const cur = dated[i];
    if (prev.company && cur.company && prev.company.trim().toLowerCase() === cur.company.trim().toLowerCase() && levels[i] > levels[i - 1]) promotions++;
  }

  const trend = avg(last) - avg(first) >= 0.75 || promotions > 0 ? "up" : "same";
  // Show at most 4 steps: first, a couple in the middle, current.
  const titles = dated.map((r) => r.title as string);
  const path = titles.length <= 4 ? titles : [titles[0], titles[Math.floor(titles.length / 3)], titles[Math.floor((2 * titles.length) / 3)], titles[titles.length - 1]];
  return { trend, path, internal_promotions: promotions };
}
