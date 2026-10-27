// Candidate-name handling. The name is read aloud by the AI interviewer and shown everywhere,
// so it must match how the CV writes it. Letter-spaced headers ("M E E N A G") and all-caps
// headers ("MEENA G") are common, and an LLM can merge them into "MEENAG".

/** Letters only, lowercased. Used to compare a name with a CV line regardless of spacing. */
const LETTERS = (s: string) => s.toLowerCase().replace(/[^a-zÀ-ɏ]/g, "");

/** True for "M E E N A G": three or more single-letter tokens. */
function isLetterSpaced(line: string): boolean {
  const tokens = line.split(" ");
  return tokens.length >= 3 && tokens.every((t) => t.length === 1);
}

/**
 * Title-case an all-caps or all-lowercase name ("MEENA G" → "Meena G", "john o'neil" → "John O'Neil").
 * Mixed-case names are left exactly as written.
 */
export function formatPersonName(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  const letters = s.replace(/[^A-Za-zÀ-ɏ]/g, "");
  if (!letters) return s;
  const allUpper = letters === letters.toUpperCase();
  const allLower = letters === letters.toLowerCase();
  if (!allUpper && !allLower) return s;
  return s
    .split(" ")
    .map((word) =>
      word
        .split(/([-'])/)
        .map((part) => (part === "-" || part === "'" ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
        .join("")
    )
    .join(" ");
}

/**
 * Prefer the CV's own spelling of the name. If the extracted name matches a line in the CV's
 * first lines when spacing is ignored, use that line (so "MEENAG" becomes the header "MEENA G"),
 * then format it. Otherwise format the extracted value as is.
 */
export function resolveCandidateName(extracted: string | null | undefined, pages: string[]): string | null {
  const raw = (extracted ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const target = LETTERS(raw);
  if (target.length >= 2) {
    const head = pages
      .join("\n")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);
    const hit = head.find((line) => LETTERS(line) === target);
    // A letter-spaced header ("M E E N A G") is a layout choice, not a spelling: use the
    // extracted word split ("MEENA G") rather than copying the spacing.
    if (hit && !isLetterSpaced(hit)) return formatPersonName(hit);
  }
  return formatPersonName(raw);
}
