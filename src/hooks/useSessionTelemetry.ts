"use client";

import { useRef, useCallback, useEffect } from "react";
import type { SessionTelemetryApi } from "@/lib/telemetry/types";

const FLUSH_MS = 2_000;
const FLUSH_COUNT = 25;
const APP_VERSION =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0" : "0.1.0";

/**
 * Batches client telemetry events to POST /api/sessions/[token]/telemetry.
 * Non-blocking — drops failures silently to avoid impacting interviews.
 */
export function useSessionTelemetry(sessionToken: string): SessionTelemetryApi {
  const queueRef = useRef<
    Array<{
      event_name: string;
      event_version?: number;
      occurred_at: string;
      trace_id?: string | null;
      turn_index?: number | null;
      interview_state?: string;
      attrs?: Record<string, unknown>;
    }>
  >([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef(sessionToken);
  tokenRef.current = sessionToken;

  const flushInternal = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const batch = queueRef.current;
    if (batch.length === 0) return;
    queueRef.current = [];
    try {
      await fetch(`/api/sessions/${tokenRef.current}/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: batch.map((e) => ({
            ...e,
            attrs: { app_version: APP_VERSION, ...e.attrs },
          })),
        }),
        keepalive: true,
      });
    } catch {
      /* non-fatal */
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushInternal();
    }, FLUSH_MS);
  }, [flushInternal]);

  const enqueue = useCallback(
    (event: {
      event_name: string;
      attrs?: Record<string, unknown>;
      trace_id?: string | null;
      turn_index?: number | null;
      interview_state?: string;
    }) => {
      queueRef.current.push({
        event_name: event.event_name,
        occurred_at: new Date().toISOString(),
        trace_id: event.trace_id,
        turn_index: event.turn_index ?? null,
        interview_state: event.interview_state,
        attrs: event.attrs,
      });
      if (queueRef.current.length >= FLUSH_COUNT) {
        void flushInternal();
      } else {
        scheduleFlush();
      }
    },
    [flushInternal, scheduleFlush]
  );

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void flushInternal();
    };
    document.addEventListener("visibilitychange", onVis);
    const onUnload = () => {
      void flushInternal();
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onUnload);
      void flushInternal();
    };
  }, [flushInternal]);

  return { enqueue, flush: flushInternal };
}
