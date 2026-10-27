// CV file → plain text. Server-side only. File type is decided from the bytes (magic numbers),
// never from the browser-supplied MIME type or extension alone.

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type CvMime = typeof PDF_MIME | typeof DOCX_MIME;

/** Hard cap on text kept per CV (≈10k tokens). Longer CVs are truncated and flagged. */
export const MAX_TEXT_CHARS = 40_000;
/** Below this many non-space characters per page, a PDF is treated as scanned/image-only. */
const MIN_CHARS_PER_PAGE = 40;
const PARSE_TIMEOUT_MS = 30_000;

export type FileCheck =
  | { ok: true; mime: CvMime; ext: "pdf" | "docx" }
  | { ok: false; code: "unsupported_type" | "legacy_doc" | "empty_file" | "too_large" };

export function detectCvFile(buf: Uint8Array, maxBytes: number): FileCheck {
  if (buf.length === 0) return { ok: false, code: "empty_file" };
  if (buf.length > maxBytes) return { ok: false, code: "too_large" };
  const head = (n: number) => Buffer.from(buf.subarray(0, n));
  if (head(5).toString("latin1") === "%PDF-") return { ok: true, mime: PDF_MIME, ext: "pdf" };
  // Old binary Word (.doc) is an OLE container — explicitly unsupported (mammoth reads .docx only).
  if (head(8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { ok: false, code: "legacy_doc" };
  // DOCX is a ZIP whose entry names (stored as plain text) include word/document.xml.
  if (head(4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && Buffer.from(buf).includes("word/document.xml", 0, "latin1")) {
    return { ok: true, mime: DOCX_MIME, ext: "docx" };
  }
  return { ok: false, code: "unsupported_type" };
}

export interface ExtractedText {
  text: string;
  /** Start offset of each page inside `text` (DOCX has no pages → [0]). */
  pageOffsets: number[];
  pageCount: number | null;
  truncated: boolean;
}

export type ExtractResult =
  | { ok: true; value: ExtractedText }
  | { ok: false; code: "password_protected" | "malformed" | "empty" | "needs_ocr" | "parse_timeout" };

/** Strip control characters and collapse runs of blank lines; keeps line structure. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Join page texts, recording offsets and applying the length cap. Pure (exported for tests). */
export function assemblePages(pages: string[]): ExtractedText {
  let text = "";
  const pageOffsets: number[] = [];
  let truncated = false;
  for (const p of pages) {
    const clean = cleanText(p);
    if (text.length >= MAX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    pageOffsets.push(text.length);
    text += (text ? "\n\n" : "") + clean;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
  }
  if (pageOffsets.length === 0) pageOffsets.push(0);
  return { text, pageOffsets, pageCount: pages.length, truncated };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("parse_timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function extractPdf(buf: Uint8Array): Promise<ExtractResult> {
  // pdf-parse (pdfjs) is listed in serverComponentsExternalPackages so webpack doesn't bundle it.
  const { PDFParse, PasswordException } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await withTimeout(parser.getText(), PARSE_TIMEOUT_MS);
    const pages = res.pages.length ? res.pages.map((p) => p.text) : [res.text];
    const assembled = assemblePages(pages);
    const visible = assembled.text.replace(/\s+/g, "").length;
    if (visible === 0) return { ok: false, code: assembled.pageCount ? "needs_ocr" : "empty" };
    if (visible / Math.max(1, assembled.pageCount ?? 1) < MIN_CHARS_PER_PAGE) return { ok: false, code: "needs_ocr" };
    return { ok: true, value: assembled };
  } catch (err) {
    if (err instanceof PasswordException) return { ok: false, code: "password_protected" };
    if ((err as Error)?.message === "parse_timeout") return { ok: false, code: "parse_timeout" };
    return { ok: false, code: "malformed" };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buf: Uint8Array): Promise<ExtractResult> {
  const mod = await import("mammoth");
  const mammoth = ((mod as unknown as { default?: typeof import("mammoth") }).default ?? mod) as typeof import("mammoth");
  try {
    const res = await withTimeout(mammoth.extractRawText({ buffer: Buffer.from(buf) }), PARSE_TIMEOUT_MS);
    const assembled = assemblePages([res.value]);
    assembled.pageCount = null;
    if (!assembled.text.replace(/\s+/g, "")) return { ok: false, code: "empty" };
    return { ok: true, value: assembled };
  } catch (err) {
    if ((err as Error)?.message === "parse_timeout") return { ok: false, code: "parse_timeout" };
    return { ok: false, code: "malformed" };
  }
}

export async function extractCvText(buf: Uint8Array, mime: CvMime): Promise<ExtractResult> {
  return mime === PDF_MIME ? extractPdf(buf) : extractDocx(buf);
}

/** 1-based page number for a character offset. */
export function pageForOffset(pageOffsets: number[], offset: number): number {
  let page = 1;
  for (let i = 0; i < pageOffsets.length; i++) if (offset >= pageOffsets[i]) page = i + 1;
  return page;
}

/** Human-readable messages for every error code a recruiter can see. Never includes CV content. */
export const CV_ERROR_MESSAGES: Record<string, string> = {
  unsupported_type: "Unsupported file type. Upload a PDF or DOCX file.",
  legacy_doc: "Old .doc files aren't supported. Save it as .docx or PDF and upload again.",
  empty_file: "The file is empty.",
  too_large: "The file is larger than the upload limit.",
  password_protected: "The PDF is password-protected. Ask for an unlocked copy.",
  malformed: "The file appears to be damaged and couldn't be read.",
  empty: "No text could be found in the document.",
  needs_ocr: "This looks like a scanned or image-only PDF. Text recognition (OCR) isn't supported yet — review it manually.",
  parse_timeout: "Reading the file took too long.",
  provider_error: "The AI provider failed. Retry later.",
  provider_rate_limited: "The AI provider is rate-limiting requests. It will be retried.",
  model_refused: "The AI model declined to process this document.",
  output_truncated: "The AI response was too long to complete.",
  empty_output: "The AI returned no result.",
  malformed_output: "The AI returned a malformed result.",
  invalid_output: "The AI result failed validation.",
  daily_budget: "The daily AI budget for CV screening has been reached. Processing resumes tomorrow.",
  config_missing: "The screening criteria for this job could not be loaded.",
  file_missing: "The stored file could not be found.",
  internal_error: "Unexpected error while processing this CV.",
};
