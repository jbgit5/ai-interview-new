"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type LivePulseProps = {
  label: string;
  active?: boolean;
  className?: string;
};

/** Animated status strip — “realtime” affordance */
export function LivePulse({ label, active = true, className }: LivePulseProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300",
        className
      )}
    >
      <span className="relative flex h-2 w-2">
        {active && (
          <motion.span
            className="absolute inline-flex h-full w-full rounded-full bg-emerald-400"
            animate={{ scale: [1, 1.4, 1], opacity: [0.7, 0.2, 0.7] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            active ? "bg-emerald-500" : "bg-slate-600"
          )}
        />
      </span>
      <span className="text-slate-400">Live</span>
      <span className="text-slate-200">{label}</span>
    </div>
  );
}
