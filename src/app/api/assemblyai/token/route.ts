import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// Issues a short-lived AssemblyAI streaming token.
// Accepts EITHER:
//   - x-session-token header → validates interview_sessions (candidate / check page flow)
//   - better-auth session cookie → dashboard / voice-lab flow
// Returns { token, keywords } — keywords extracted from job description when available.
export async function POST(req: Request) {
  const sessionToken = req.headers.get("x-session-token");
  let keywords: string[] = [];

  if (sessionToken) {
    // ── Interview candidate flow — validate against interview_sessions ─────
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT s.id, s.status, s.expires_at,
                j.title AS job_title, j.description AS job_description
           FROM interview_sessions s
           JOIN jobs j ON j.id = s.job_id
          WHERE s.token = $1`,
        [sessionToken]
      );
      if (result.rows.length === 0) {
        return Response.json({ error: "Invalid session token" }, { status: 401 });
      }
      const session = result.rows[0];
      if (new Date(session.expires_at) < new Date()) {
        return Response.json({ error: "Session expired" }, { status: 401 });
      }
      if (session.status === "completed") {
        return Response.json({ error: "Session already completed" }, { status: 403 });
      }
      keywords = extractKeywords(session.job_title ?? "", session.job_description ?? "");
    } finally {
      client.release();
    }
  } else {
    // ── Dashboard / voice-lab flow — require recruiter session ────────────
    const dashSession = await auth.api.getSession({ headers: headers() });
    if (!dashSession) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ASSEMBLYAI_API_KEY not configured — get a free key at assemblyai.com" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    expires_in_seconds: "300",
    max_session_duration_seconds: "3600",
  });
  const res = await fetch(`https://streaming.assemblyai.com/v3/token?${params}`, {
    method: "GET",
    headers: { Authorization: apiKey },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return Response.json(
      { error: `AssemblyAI API error ${res.status}: ${text}` },
      { status: 502 }
    );
  }

  const data = await res.json();
  return Response.json({ token: data.token, keywords });
}

// Extract domain-specific terms from job title + description to pass as
// AssemblyAI keyterms_prompt — improves recognition of technical vocabulary.
function extractKeywords(title: string, description: string): string[] {
  const STOP_WORDS = new Set([
    "the", "and", "for", "with", "this", "that", "will", "have", "from",
    "about", "their", "there", "which", "would", "should", "using", "ability",
    "strong", "skills", "experience", "required", "responsibilities", "position",
    "candidates", "including", "working", "multiple", "between", "through",
  ]);

  const combined = `${title} ${description}`;
  const words = combined.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of words) {
    const word = raw.trim();
    if (!word || seen.has(word.toLowerCase())) continue;

    const isProperNoun = /^[A-Z][a-z]/.test(word) && word.length > 2;
    const isCamelCase = /^[A-Z][a-z]+[A-Z]/.test(word);
    const isAllCaps = /^[A-Z]{2,}$/.test(word) && word.length <= 10;
    const isLongTechnical = word.length > 6 && !STOP_WORDS.has(word.toLowerCase());

    if (isProperNoun || isCamelCase || isAllCaps || isLongTechnical) {
      seen.add(word.toLowerCase());
      result.push(word);
      if (result.length >= 20) break;
    }
  }

  return result;
}

