import { ObservabilityNav } from "@/components/observability/observability-nav";

/** Dark shell for analytics routes — scoped `dark` for Tailwind tokens */
export default function ObservabilityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark min-h-full min-w-0 bg-slate-950 text-slate-100 antialiased">
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-5">
          <ObservabilityNav />
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-8">{children}</div>
    </div>
  );
}
