"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Monitor, Eye, EyeOff, ArrowRight, Sparkles, Shield, Zap } from "lucide-react";

const FEATURES = [
  { icon: Sparkles, text: "AI-powered interview analysis" },
  { icon: Zap,      text: "Real-time speech transcription" },
  { icon: Shield,   text: "Built-in proctoring & integrity scoring" },
];

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const { error: signInError } = await authClient.signIn.email({ email, password, callbackURL: "/dashboard" });
    if (signInError) {
      setError(signInError.message ?? "Sign in failed. Please try again.");
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* ── Left dark panel ── */}
      <div className="hidden lg:flex lg:w-[42%] xl:w-[45%] flex-col sc-auth-panel relative overflow-hidden">
        <div className="absolute -top-24 -left-24 h-72 w-72 rounded-full bg-[#4f7ef7]/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-80 w-80 rounded-full bg-indigo-600/15 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-[#4f7ef7]/5 blur-3xl" />
        <div className="relative z-10 flex flex-col h-full p-10">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl sc-logo-pulse"
              style={{ background: "linear-gradient(135deg,#7c3aed 0%,#a855f7 100%)" }}
            >
              <Monitor className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">Screeno</span>
          </div>
          {/* Headline */}
          <div className="flex-1 flex flex-col justify-center">
            <p className="text-violet-600 text-sm font-bold uppercase tracking-widest mb-4">AI Interview Platform</p>
            <h2 className="text-4xl xl:text-5xl font-bold text-white leading-tight mb-6">
              Screen smarter.<br />
              <span style={{ background: "linear-gradient(90deg,#7097ff,#93c5fd)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Hire better.
              </span>
            </h2>
            <p className="text-gray-500 text-base leading-relaxed max-w-sm mb-10">
              Conduct consistent AI-powered interviews at scale.
            </p>
            <div className="space-y-3">
              {FEATURES.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <div
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                    style={{ background: "rgba(124,58,237,0.08)" }}
                  >
                    <Icon className="h-3.5 w-3.5 text-violet-500" />
                  </div>
                  <p className="text-sm text-gray-600">{text}</p>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-400">&copy; 2025 Screeno. All rights reserved.</p>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12" style={{ background: "#f4f5f9" }}>
        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-3 mb-8">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: "linear-gradient(135deg,#4f7ef7,#6366f1)" }}
          >
            <Monitor className="h-5 w-5 text-white" />
          </div>
          <span className="text-lg font-bold text-gray-900 tracking-tight">Screeno</span>
        </div>

        <div className="w-full max-w-[400px]">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Welcome back</h1>
            <p className="mt-1.5 text-sm text-gray-500">Sign in to your recruiter account</p>
          </div>

          <div
            className="rounded-2xl p-6"
            style={{ background: "#ffffff", border: "1px solid #e2e4ec", boxShadow: "0 24px 48px rgba(0,0,0,0.4)" }}
          >
            <form className="space-y-5" onSubmit={handleSubmit}>
              {error && (
                <div
                  className="rounded-xl px-4 py-3 text-sm text-red-600"
                  style={{ background: "#fef2f2", border: "1px solid #fecaca" }}
                >
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="email" className="sc-label">Email address</label>
                <input id="email" name="email" type="email" autoComplete="email" required
                  className="sc-input" placeholder="you@company.com" />
              </div>
              <div>
                <label htmlFor="password" className="sc-label">Password</label>
                <div className="relative">
                  <input id="password" name="password" type={showPass ? "text" : "password"}
                    autoComplete="current-password" required className="sc-input pr-10" placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPass(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600 transition-colors">
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={loading} className="sc-btn-primary w-full justify-center py-3">
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Signing in&hellip;
                  </span>
                ) : (
                  <span className="flex items-center gap-2">Sign in <ArrowRight className="h-4 w-4" /></span>
                )}
              </button>
            </form>
            <p className="mt-5 text-center text-sm text-gray-500">
              Don&apos;t have an account?{" "}
              <Link href="/sign-up" className="font-semibold text-violet-600 hover:text-violet-500 transition-colors">Create one</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
