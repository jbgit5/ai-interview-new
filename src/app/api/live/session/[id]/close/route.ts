import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { closeLiveSession } from "@/lib/live/guardrails";

// POST /api/live/session/[id]/close
// Body: { token: string, usage_seconds?: number, reason?: string }
// Settles the spend ledger. Safe to call more than once (first close wins).
// Also used via navigator.sendBeacon on tab close, so it must stay cheap.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  let body: { token?: unknown; usage_seconds?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const found = await pool.query(`SELECT id FROM interview_sessions WHERE token = $1`, [token]);
  const row = found.rows[0];
  if (!row) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const usage = typeof body.usage_seconds === "number" && Number.isFinite(body.usage_seconds)
    ? body.usage_seconds
    : 0;
  const reason = typeof body.reason === "string" ? body.reason : "client_close";

  const ok = await closeLiveSession(pool, {
    liveSessionId: params.id,
    interviewSessionId: row.id,
    usageSeconds: usage,
    reason,
  });
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
