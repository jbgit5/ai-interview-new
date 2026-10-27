// Checks that an excerpt the model quoted actually appears in the CV text it was given.
// An excerpt that can't be found is marked unverified, and the evidence it supports is
// downgraded by the scorer — this is the main defence against invented evidence.

export interface CitationCheck {
  verified: boolean;
  /** 1-based page, when the document has pages and the excerpt was located. */
  page: number | null;
  match: "exact" | "fuzzy" | "none";
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[•●▪◦·*]/g, " ")
    // keep letters (incl. accented Latin, Greek, Cyrillic), digits and symbols common in CVs
    .replace(/[^a-z0-9À-ɏͰ-ϿЀ-ӿ+#.\-'"%/@\[\]_ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

/** Share of the excerpt's consecutive word pairs that appear in the haystack. */
function bigramCoverage(excerptNorm: string, haystackNorm: string): number {
  const w = words(excerptNorm);
  if (w.length < 2) return haystackNorm.includes(excerptNorm) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i < w.length - 1; i++) if (haystackNorm.includes(`${w[i]} ${w[i + 1]}`)) hit++;
  return hit / (w.length - 1);
}

const FUZZY_THRESHOLD = 0.8;
const MIN_EXCERPT_CHARS = 3;

/**
 * @param pages the CV text split into pages (exactly the text the model saw)
 * @param paged false for formats without real pages (DOCX) — page is then always null
 */
export function verifyExcerpt(excerpt: string | null | undefined, pages: string[], paged: boolean): CitationCheck {
  const ex = normalizeForMatch(excerpt ?? "");
  if (ex.length < MIN_EXCERPT_CHARS) return { verified: false, page: null, match: "none" };
  const normPages = pages.map(normalizeForMatch);

  const exactIdx = normPages.findIndex((p) => p.includes(ex));
  if (exactIdx >= 0) return { verified: true, page: paged ? exactIdx + 1 : null, match: "exact" };
  const whole = normPages.join(" ");
  if (whole.includes(ex)) return { verified: true, page: paged ? firstPageWithStart(normPages, ex) : null, match: "exact" };

  let best = 0;
  let bestPage = -1;
  normPages.forEach((p, i) => {
    const c = bigramCoverage(ex, p);
    if (c > best) {
      best = c;
      bestPage = i;
    }
  });
  if (best >= FUZZY_THRESHOLD) return { verified: true, page: paged ? bestPage + 1 : null, match: "fuzzy" };
  if (bigramCoverage(ex, whole) >= FUZZY_THRESHOLD) return { verified: true, page: null, match: "fuzzy" };
  return { verified: false, page: null, match: "none" };
}

function firstPageWithStart(normPages: string[], ex: string): number {
  const head = words(ex).slice(0, 4).join(" ");
  const i = normPages.findIndex((p) => p.includes(head));
  return i >= 0 ? i + 1 : 1;
}

/** Split text into pages using recorded offsets. */
export function splitPages(text: string, pageOffsets: number[]): string[] {
  if (!pageOffsets.length) return [text];
  return pageOffsets.map((start, i) => text.slice(start, i + 1 < pageOffsets.length ? pageOffsets[i + 1] : undefined));
}
