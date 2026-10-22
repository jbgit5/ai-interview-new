import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { fetchTrends } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(req: Request) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const days = Math.min(365, Math.max(14, Number(new URL(req.url).searchParams.get("days")) || 30));
  const trends = await fetchTrends(pool, recruiterId, days);
  return NextResponse.json(trends);
}
