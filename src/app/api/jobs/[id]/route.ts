import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isLiveMasterEnabled } from "@/lib/live/guardrails";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await pool.query(
    `SELECT j.*
     FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );

  if (!result.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...result.rows[0],
    // Lets the edit page show the GPT-Live toggle only when the server has it switched on.
    live_voice_available: isLiveMasterEnabled(),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership
  const ownerCheck = await pool.query(
    `SELECT j.id FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );
  if (!ownerCheck.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await request.json();
  const { title, department, description, status, allow_probes, live_voice_enabled } = body;

  const validStatuses = ["draft", "active", "closed"];
  if (status !== undefined && !validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (title !== undefined && !title?.trim()) {
    return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
  }
  if (allow_probes !== undefined && typeof allow_probes !== "boolean") {
    return NextResponse.json({ error: "allow_probes must be a boolean" }, { status: 400 });
  }
  if (live_voice_enabled !== undefined && typeof live_voice_enabled !== "boolean") {
    return NextResponse.json({ error: "live_voice_enabled must be a boolean" }, { status: 400 });
  }
  if (live_voice_enabled === true && !isLiveMasterEnabled()) {
    return NextResponse.json(
      { error: "GPT-Live voice is not enabled on this server" },
      { status: 400 }
    );
  }

  const result = await pool.query(
    `UPDATE jobs
     SET title        = COALESCE($1, title),
         department   = COALESCE($2, department),
         description  = COALESCE($3, description),
         status       = COALESCE($4, status),
         allow_probes = COALESCE($5, allow_probes),
         updated_at   = NOW()
     WHERE id = $6
     RETURNING *`,
    [
      title?.trim() ?? null,
      department !== undefined ? department : null,
      description !== undefined ? description : null,
      status ?? null,
      typeof allow_probes === "boolean" ? allow_probes : null,
      params.id,
    ]
  );

  // Separate statement: if migration 014 hasn't run, ordinary job edits above still work.
  let row = result.rows[0];
  if (typeof live_voice_enabled === "boolean") {
    try {
      const flagged = await pool.query(
        `UPDATE jobs SET live_voice_enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [live_voice_enabled, params.id]
      );
      row = flagged.rows[0];
    } catch (err) {
      console.error("[jobs] live_voice_enabled update failed (migration 014 applied?):", err);
      return NextResponse.json(
        { error: "Could not save the GPT-Live setting (database migration 014 missing?)" },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ...row, live_voice_available: isLiveMasterEnabled() });
}
