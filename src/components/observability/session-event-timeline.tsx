"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { TelemetryEventRow } from "@/lib/observability/types";
import { sortEventsAsc } from "@/lib/observability/live-derive";

const colorFor = (name: string) => {
  if (name.startsWith("stt.")) return "bg-cyan-500";
  if (name.startsWith("ai.") || name.startsWith("tts.")) return "bg-violet-500";
  if (name.startsWith("livekit.")) return "bg-amber-500";
  if (name.startsWith("interview.")) return "bg-emerald-500";
  return "bg-slate-500";
};

/** Horizontal event timeline — chronological markers with staggered animation */
export function SessionEventTimeline({ events }: { events: TelemetryEventRow[] }) {
  const asc = sortEventsAsc(events);
  const take = asc.slice(-48);

  return (
    <div className="relative overflow-x-auto pb-2">
      <div className="flex min-w-max items-center gap-0 pt-2">
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-slate-800" />
        {take.map((e, i) => (
          <motion.div
            key={`${e.id}-${i}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.015 }}
            className="relative z-10 flex flex-col items-center px-1"
            title={`${e.event_name} @ ${new Date(e.occurred_at).toLocaleTimeString()}`}
          >
            <span
              className={cn(
                "h-3 w-3 rounded-full ring-2 ring-slate-950 shadow-lg shadow-black/40",
                colorFor(e.event_name)
              )}
            />
            {i % 6 === 0 && (
              <span className="mt-2 max-w-[72px] truncate font-mono text-[9px] text-slate-500">
                {new Date(e.occurred_at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}
