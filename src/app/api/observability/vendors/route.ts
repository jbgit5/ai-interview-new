import { NextResponse } from "next/server";
import { getRecruiterIdForUser } from "@/lib/observability/recruiter";
import { fetchVendorStats } from "@/lib/observability/queries";
import { pool } from "@/lib/db";

export async function GET(req: Request) {
  const recruiterId = await getRecruiterIdForUser();
  if (!recruiterId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const since = Math.min(365, Math.max(7, Number(new URL(req.url).searchParams.get("sinceDays")) || 30));
  const vendors = await fetchVendorStats(pool, recruiterId, since);
  return NextResponse.json({ vendors });
}
