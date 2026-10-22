import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { runDailyTelemetryRollup } from "@/lib/telemetry/dailyRollup";

// GET /api/cron/telemetry-daily
// Secured with Authorization: Bearer <CRON_SECRET> or?secret= for manual runs.
// Aggregates yesterday (UTC) into telemetry_daily_rollup.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const q = req.nextUrl.searchParams.get("secret");

  if (!secret || (token !== secret && q !== secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  try {
    await runDailyTelemetryRollup(pool, yesterday);
    return NextResponse.json({
      ok: true,
      day: yesterday.toISOString().slice(0, 10),
    });
  } catch (err: unknown) {
    console.error("[cron/telemetry-daily]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
