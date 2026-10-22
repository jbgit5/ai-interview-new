"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, LayoutGrid, Radio, TrendingUp, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/dashboard/observability", label: "Overview", icon: LayoutGrid, end: true },
  { href: "/dashboard/observability/live", label: "Live sessions", icon: Radio },
  { href: "/dashboard/observability/vendors", label: "Vendors", icon: Building2 },
  { href: "/dashboard/observability/trends", label: "Improvement", icon: TrendingUp },
];

/** Sticky sub-nav for the observability hub (App Router segments). */
export function ObservabilityNav() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-700 shadow-lg shadow-violet-900/40">
          <Activity className="h-6 w-6 text-white" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-50">Observability</h1>
          <p className="text-sm text-slate-500">Realtime interview analytics & telemetry</p>
        </div>
      </div>
      <nav className="flex flex-wrap gap-1.5">
        {links.map(({ href, label, icon: Icon, end }) => {
          const active = end
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-all",
                active
                  ? "bg-violet-600/25 text-violet-100 ring-1 ring-violet-500/40"
                  : "text-slate-400 hover:bg-slate-800/80 hover:text-slate-200"
              )}
            >
              <Icon className="h-4 w-4 opacity-80" />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
