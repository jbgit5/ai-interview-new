import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { fetchOverviewKpis } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(req: Request) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const days = Math.min(90, Math.max(7, Number(searchParams.get("trendDays")) || 14));
  const data = await fetchOverviewKpis(pool, recruiterId, days);
  return NextResponse.json(data);
}
