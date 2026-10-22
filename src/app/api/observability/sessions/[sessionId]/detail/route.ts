import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { getSessionDetailForAnalytics } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: { sessionId: string } }
) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const detail = await getSessionDetailForAnalytics(pool, recruiterId, params.sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(detail);
}
