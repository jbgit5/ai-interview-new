import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { fetchSessionsForRecruiter } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(req: Request) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limit = Math.min(100, Math.max(10, Number(new URL(req.url).searchParams.get("limit")) || 50));
  const sessions = await fetchSessionsForRecruiter(pool, recruiterId, limit);
  return NextResponse.json({ sessions });
}
