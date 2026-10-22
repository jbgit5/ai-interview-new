import { NextRequest, NextResponse } from "next/server";

/**
 * Minimal Prometheus-style exposition for process health.
 * On serverless hosts, counters reset on cold start — prefer vendor metrics for SLOs in production.
 *
 * Set METRICS_SCRAPE_SECRET in .env; caller must pass ?token= (or omit in dev if unset).
 */
export async function GET(req: NextRequest) {
  const secret = process.env.METRICS_SCRAPE_SECRET;
  const token = req.nextUrl.searchParams.get("token");
  if (secret && token !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lines = [
    "# HELP process_uptime_seconds Process uptime (Node).",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime()}`,
    "# HELP telemetry_info Primary signals are in PostgreSQL session_telemetry_events (see docs/OBSERVABILITY.md).",
    "# TYPE telemetry_info gauge",
    "telemetry_info 1",
    "",
  ];

  return new NextResponse(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
