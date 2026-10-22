import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { normalizeInterviewerAvatarId } from "@/lib/interviewerAvatar";

// PATCH — signed-in recruiter only: persists default interviewer avatar for candidate sessions.

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw =
    typeof body === "object" &&
    body !== null &&
    "avatar_id" in body &&
    typeof (body as { avatar_id: unknown }).avatar_id === "string"
      ? (body as { avatar_id: string }).avatar_id
      : null;

  if (!raw) {
    return NextResponse.json({ error: "avatar_id required" }, { status: 400 });
  }

  const avatarId = normalizeInterviewerAvatarId(raw);

  await pool.query(
    `UPDATE recruiters
        SET interviewer_avatar_id = $1, updated_at = now()
      WHERE better_auth_user_id = $2`,
    [avatarId, session.user.id]
  );

  return NextResponse.json({ ok: true, avatar_id: avatarId });
}
