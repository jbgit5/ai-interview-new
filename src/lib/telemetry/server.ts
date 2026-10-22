import type { Pool, PoolClient } from "pg";
import type { TelemetryInsertRow } from "./types";

const MAX_ATTRS_SIZE = 12_000;

function sanitizeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(attrs);
  if (s.length <= MAX_ATTRS_SIZE) return attrs;
  return {
    _truncated: true,
    message: "attrs exceeded max size — not stored",
  };
}

/**
 * Insert telemetry rows. Caller supplies validated session_id (UUID).
 */
export async function insertTelemetryRows(
  db: Pool | PoolClient,
  rows: TelemetryInsertRow[]
): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 0;
  for (const r of rows) {
    const base = i * 8;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`
    );
    values.push(
      r.session_id,
      r.occurred_at ?? new Date(),
      r.event_name,
      r.event_version,
      r.source,
      r.trace_id,
      r.turn_index,
      JSON.stringify(sanitizeAttrs(r.attrs))
    );
    i++;
  }

  await db.query(
    `INSERT INTO session_telemetry_events
       (session_id, occurred_at, event_name, event_version, source, trace_id, turn_index, attrs)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

/** Fire-and-forget; never throws to caller */
export function insertTelemetryFireAndForget(
  pool: Pool,
  rows: TelemetryInsertRow[]
): void {
  if (rows.length === 0) return;
  void insertTelemetryRows(pool, rows).catch((err: unknown) => {
    console.error("[telemetry] insert failed:", err);
  });
}
