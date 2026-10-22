"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Monitor, Eye, EyeOff, ArrowRight, CheckCircle2 } from "lucide-react";

const PERKS = [
  "AI-generated interview questions tailored per job",
  "Real-time transcription & scoring",
  "Proctoring with integrity analysis",
];

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass]       = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    const name     = formData.get("name")     as string;
    const email    = formData.get("email")    as string;
    const password = formData.get("password") as string;
    const confirm  = formData.get("confirm")  as string;

    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 8)  { setError("Password must be at least 8 characters."); return; }

    setLoading(true);
    const { error: signUpError } = await authClient.signUp.email({ name, email, password, callbackURL: "/dashboard" });
    if (signUpError) {
      setError(signUpError.message ?? "Sign up failed. Please try again.");
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* ── Left dark panel ── */}
      <div className="hidden lg:flex lg:w-[42%] xl:w-[45%] flex-col sc-auth-panel relative overflow-hidden">
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-80 w-80 rounded-full bg-[#4f7ef7]/15 blur-3xl" />
        <div className="relative z-10 flex flex-col h-full p-10">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl sc-logo-pulse"
              style={{ background: "linear-gradient(135deg,#7c3aed 0%,#a855f7 100%)" }}
            >
              <Monitor className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">Screeno</span>
          </div>
          <div className="flex-1 flex flex-col justify-center">
            <p className="text-violet-600 text-sm font-bold uppercase tracking-widest mb-4">Get started free</p>
            <h2 className="text-4xl xl:text-5xl font-bold text-white leading-tight mb-6">
              Build your<br />
              <span style={{ background: "linear-gradient(90deg,#7097ff,#93c5fd)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                dream team.
              </span>
            </h2>
            <p className="text-gray-500 text-base leading-relaxed max-w-sm mb-10">
              Let AI handle screening so you can focus on what matters.
            </p>
            <div className="space-y-3">
              {PERKS.map((text) => (
                <div key={text} className="flex items-start gap-3">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5 text-violet-600" />
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
            <h1 className="text-2xl font-bold text-gray-900">Create account</h1>
            <p className="mt-1.5 text-sm text-gray-500">Start screening candidates with AI</p>
          </div>

          <div
            className="rounded-2xl p-6"
            style={{ background: "#ffffff", border: "1px solid #e2e4ec", boxShadow: "0 24px 48px rgba(0,0,0,0.4)" }}
          >
            <form className="space-y-4" onSubmit={handleSubmit}>
              {error && (
                <div
                  className="rounded-xl px-4 py-3 text-sm text-red-600"
                  style={{ background: "#fef2f2", border: "1px solid #fecaca" }}
                >
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="name" className="sc-label">Full name</label>
                <input id="name" name="name" type="text" autoComplete="name" required
                  className="sc-input" placeholder="Jane Smith" />
              </div>
              <div>
                <label htmlFor="email" className="sc-label">Work email</label>
                <input id="email" name="email" type="email" autoComplete="email" required
                  className="sc-input" placeholder="you@company.com" />
              </div>
              <div>
                <label htmlFor="password" className="sc-label">Password</label>
                <div className="relative">
                  <input id="password" name="password" type={showPass ? "text" : "password"}
                    autoComplete="new-password" required minLength={8}
                    className="sc-input pr-10" placeholder="Min. 8 characters" />
                  <button type="button" onClick={() => setShowPass(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600 transition-colors">
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="confirm" className="sc-label">Confirm password</label>
                <div className="relative">
                  <input id="confirm" name="confirm" type={showConfirm ? "text" : "password"}
                    autoComplete="new-password" required
                    className="sc-input pr-10" placeholder="Repeat password" />
                  <button type="button" onClick={() => setShowConfirm(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600 transition-colors">
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={loading} className="sc-btn-primary w-full justify-center py-3 mt-1">
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Creating account&hellip;
                  </span>
                ) : (
                  <span className="flex items-center gap-2">Create account <ArrowRight className="h-4 w-4" /></span>
                )}
              </button>
            </form>
            <p className="mt-5 text-center text-sm text-gray-500">
              Already have an account?{" "}
              <Link href="/sign-in" className="font-semibold text-violet-600 hover:text-violet-500 transition-colors">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
