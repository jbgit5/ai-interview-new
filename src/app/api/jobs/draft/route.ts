import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { openAiJsonCall } from "@/lib/llm/openai";
import { LlmCallError } from "@/lib/llm/types";
import { getScreeningConfig } from "@/lib/screening/config";
import { DEFAULT_CRITERIA } from "@/lib/screening/criteria";
import { CV_ERROR_MESSAGES, cleanText, detectCvFile, extractCvText } from "@/lib/screening/parse";
import { draftJobFromJd, suggestionToCriteria } from "@/lib/screening/pipeline";
import { recordUsage, spentTodayUsd } from "@/lib/screening/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_JD_BYTES = 5 * 1024 * 1024;
const MAX_JD_CHARS = 12_000;

// POST (multipart "file" = PDF/DOCX JD, or JSON { text }) → a DRAFT job for the recruiter to
// review: title, department, JD text and suggested requirements. Nothing is saved here and no
// requirement is marked "Must have" automatically.
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rec = await pool.query(`SELECT id FROM recruiters WHERE better_auth_user_id = $1`, [session.user.id]);
  if (!rec.rows[0]) return NextResponse.json({ error: "Recruiter not found" }, { status: 404 });

  let text = "";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    if (parseInt(request.headers.get("content-length") ?? "0", 10) > MAX_JD_BYTES + 256 * 1024) {
      return NextResponse.json({ error: "The JD file is larger than 5 MB." }, { status: 413 });
    }
    const fd = await request.formData().catch(() => null);
    const f = fd?.get("file");
    if (!f || typeof f !== "object" || !("arrayBuffer" in f)) return NextResponse.json({ error: "Attach a PDF or DOCX file." }, { status: 400 });
    const buf = new Uint8Array(await (f as File).arrayBuffer());
    const check = detectCvFile(buf, MAX_JD_BYTES);
    if (!check.ok) {
      const msg = check.code === "too_large" ? "The JD file is larger than 5 MB." : CV_ERROR_MESSAGES[check.code];
      return NextResponse.json({ error: msg }, { status: 415 });
    }
    const parsed = await extractCvText(buf, check.mime);
    if (!parsed.ok) {
      const msg = parsed.code === "needs_ocr" ? "This looks like a scanned PDF, so its text can't be read. Paste the JD text instead." : CV_ERROR_MESSAGES[parsed.code];
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    text = parsed.value.text;
  } else {
    const body = await request.json().catch(() => null);
    text = cleanText(String(body?.text ?? ""));
  }
  text = text.slice(0, MAX_JD_CHARS);
  if (text.replace(/\s+/g, "").length < 50) return NextResponse.json({ error: "The job description is too short to read requirements from." }, { status: 400 });

  const cfg = getScreeningConfig();
  const spent = await spentTodayUsd(pool).catch(() => Number.POSITIVE_INFINITY);
  if (spent >= cfg.dailyBudgetUsd) return NextResponse.json({ error: CV_ERROR_MESSAGES.daily_budget, description: text }, { status: 429 });

  try {
    const { draft, usage } = await draftJobFromJd({ llm: openAiJsonCall, model: cfg.criteriaModel, timeoutMs: 45_000, jobDescription: text });
    await recordUsage(pool, { jobId: null, documentId: null, kind: "criteria_suggestion", usage, ok: true });
    return NextResponse.json({
      title: draft.title.trim().slice(0, 160),
      department: draft.department?.trim().slice(0, 120) || null,
      description: text,
      criteria: suggestionToCriteria(draft.requirements, DEFAULT_CRITERIA),
      sources: draft.requirements,
    });
  } catch (err) {
    const code = err instanceof LlmCallError ? err.code : "internal_error";
    if (err instanceof LlmCallError && err.usage) {
      await recordUsage(pool, { jobId: null, documentId: null, kind: "criteria_suggestion", usage: err.usage, ok: false, errorCode: code });
    }
    console.error("[jobs] JD draft failed", { code });
    // Still return the text so the recruiter can continue manually.
    return NextResponse.json({ error: "Couldn't read requirements automatically — you can fill them in yourself.", description: text }, { status: 502 });
  }
}
