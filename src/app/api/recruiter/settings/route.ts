import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

// GET / PATCH /api/recruiter/settings — the signed-in recruiter's own app settings.
// debug_mode: show developer panels (logs, engine, transcript, integrity) in interview rooms for
// this recruiter's jobs. Read via to_jsonb so a DB without migration 016 answers "off" instead of 500.

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const r = await pool.query(
    `SELECT COALESCE((to_jsonb(r)->>'debug_mode')::boolean, false) AS debug_mode
       FROM recruiters r WHERE r.better_auth_user_id = $1`,
    [session.user.id]
  );
  return NextResponse.json({ debug_mode: r.rows[0]?.debug_mode === true });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { debug_mode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.debug_mode !== "boolean") {
    return NextResponse.json({ error: "debug_mode must be a boolean" }, { status: 400 });
  }

  try {
    await pool.query(
      `UPDATE recruiters SET debug_mode = $1, updated_at = now() WHERE better_auth_user_id = $2`,
      [body.debug_mode, session.user.id]
    );
  } catch (err) {
    console.error("[settings] debug_mode update failed (migration 016 applied?):", err);
    return NextResponse.json(
      { error: "Could not save the setting (database migration 016 missing?)" },
      { status: 500 }
    );
  }
  return NextResponse.json({ debug_mode: body.debug_mode });
}
