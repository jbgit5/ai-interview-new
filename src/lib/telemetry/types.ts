/**
 * Telemetry contracts — see docs/OBSERVABILITY.md
 */

export type TelemetrySource = "client" | "server";

/** Inbound from browser batch API */
export interface TelemetryBatchEventIn {
  event_name: string;
  event_version?: number;
  occurred_at?: string;
  trace_id?: string | null;
  turn_index?: number | null;
  interview_state?: string;
  attrs?: Record<string, unknown>;
}

export interface TelemetryInsertRow {
  session_id: string;
  occurred_at?: Date;
  event_name: string;
  event_version: number;
  source: TelemetrySource;
  trace_id: string | null;
  turn_index: number | null;
  attrs: Record<string, unknown>;
}

export interface SessionTelemetryApi {
  enqueue: (event: {
    event_name: string;
    attrs?: Record<string, unknown>;
    trace_id?: string | null;
    turn_index?: number | null;
    interview_state?: string;
  }) => void;
  flush: () => Promise<void>;
}
