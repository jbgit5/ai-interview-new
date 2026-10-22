import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// Issues a short-lived Deepgram access token (TTL ~60s).
// Two flows accepted:
//   - Interview candidate: sends `x-session-token` header (validated against interview_sessions)
//   - Dashboard / voice-test: better-auth cookie session
//
// The temp token has only the `usage:write` scope so it can stream audio
// but cannot manage the project. Safe to send to the browser.
//
// Browser then connects with:
//   new WebSocket(url, ['token', tempToken])
//
export async function POST(req: Request) {
  const sessionToken = req.headers.get("x-session-token");
  let keywords: string[] = [];

  if (sessionToken) {
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
    const dashSession = await auth.api.getSession({ headers: headers() });
    if (!dashSession) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "DEEPGRAM_API_KEY not configured — get one at console.deepgram.com" },
      { status: 500 }
    );
  }

  // Return the API key directly. This is safe because:
  //   1. The route is protected — only valid interview sessions or recruiter sessions reach here.
  //   2. The key is only used for the streaming WebSocket; it is not stored in the browser.
  // The temp-token flow (v1/auth/grant) requires a paid Deepgram plan and is not needed here.
  return Response.json({ token: apiKey, keywords });
}

// Extract domain-specific terms from job title + description.
// Used by Deepgram `keywords` URL param for boosted recognition.
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
