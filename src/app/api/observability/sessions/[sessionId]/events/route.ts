import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { fetchSessionEvents } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: { sessionId: string } }
) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const events = await fetchSessionEvents(pool, recruiterId, params.sessionId, 250);
  if (events === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ events });
}
