"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import {
  LayoutDashboard,
  Briefcase,
  Users,
  LogOut,
  Mic,
  Bot,
  Zap,
  Building2,
  Activity,
  Stethoscope,
  Settings,
} from "lucide-react";

const navItems = [
  { href: "/dashboard",            label: "Dashboard",  icon: LayoutDashboard },
  { href: "/dashboard/jobs",       label: "Jobs",       icon: Briefcase },
  { href: "/dashboard/candidates", label: "Candidates", icon: Users },
  { href: "/dashboard/company-intro", label: "Company Intro", icon: Building2 },
  { href: "/dashboard/voice-test", label: "Voice Lab",  icon: Mic },
  { href: "/dashboard/avatar",     label: "Avatars",    icon: Bot },
  { href: "/dashboard/diagnostics", label: "Diagnostics", icon: Stethoscope },
  { href: "/dashboard/observability", label: "Observability", icon: Activity },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/sign-in");
  };

  return (
    <aside
      className="w-[230px] flex-shrink-0 flex flex-col h-full"
      style={{ background: "#060810", borderRight: "1px solid #1c2030" }}
    >
      {/* ── Logo ── */}
      <div className="flex items-center gap-3 px-5 py-5" style={{ borderBottom: "1px solid #1c2030" }}>
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl sc-logo-pulse flex-shrink-0"
          style={{ background: "linear-gradient(135deg, #4f7ef7 0%, #6366f1 100%)" }}
        >
          <Zap className="h-4.5 w-4.5 text-white" />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-tight text-white leading-none">Screeno</p>
          <p className="text-[10px] text-[#6070a0] mt-0.5 tracking-wider uppercase">Recruiter</p>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-3 pb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a5a7a]">
          Navigation
        </p>
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive =
            href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "sc-nav-active"
                  : "text-[#8892ab] hover:bg-white/[0.06] hover:text-[#b0bcd4]"
              }`}
            >
              <Icon
                className={`h-4 w-4 flex-shrink-0 transition-colors ${
                  isActive ? "text-[#a78bfa]" : "text-[#4a5a7a] group-hover:text-[#6b7fa0]"
                }`}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* ── Sign out ── */}
      <div className="px-3 pb-5 pt-2" style={{ borderTop: "1px solid #1c2030" }}>
        <button
          onClick={handleSignOut}
          className="group flex items-center gap-3 px-3 py-2.5 w-full rounded-xl text-sm font-medium text-[#45506e] hover:bg-red-500/10 hover:text-red-400 transition-all"
        >
          <LogOut className="h-4 w-4 flex-shrink-0 text-[#2e3a54] group-hover:text-red-400 transition-colors" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
