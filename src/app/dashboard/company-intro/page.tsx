"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Save, CheckCircle, ArrowLeft } from "lucide-react";

const DEFAULT_INTRO =
  "AppHelix is a Bangalore-based consultative engineering company delivering GenAI solutions, product engineering, and cloud & data services—helping enterprises modernize systems and ship secure, scalable outcomes.";

export default function CompanyIntroPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyIntro, setCompanyIntro] = useState("");

  const isEmpty = useMemo(() => companyIntro.trim().length === 0, [companyIntro]);

  useEffect(() => {
    let active = true;
    fetch("/api/company-intro")
      .then(async (r) => {
        const raw = await r.text();
        const data = raw ? JSON.parse(raw) : {};
        if (!r.ok) {
          const errBody = data as { error?: string };
          throw new Error(errBody?.error ?? "Failed to load");
        }
        return data as { company_intro?: string };
      })
      .then((data: { company_intro?: string }) => {
        if (!active) return;
        setCompanyIntro((data.company_intro ?? "").trim());
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Failed to load company intro");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/company-intro", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_intro: companyIntro }),
      });
      const raw = await res.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!res.ok) {
        const errBody = data as { error?: string };
        setError(errBody?.error ?? "Failed to save");
        return;
      }
      const body = data as { company_intro?: string };
      setCompanyIntro((body.company_intro ?? "").trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="mb-5 flex items-center gap-2 text-sm">
        <Link
          href="/dashboard"
          className="flex items-center gap-1.5 font-medium text-gray-500 hover:text-violet-600 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-500">Company Intro</span>
      </div>

      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-violet-500 mb-1">
          Template
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Company Introduction</h1>
        <p className="mt-1 text-sm text-gray-500">
          Maya will use this as the opening company context for every interview (about 10–15 seconds).
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        <div>
          <label className="sc-label">
            Intro text{" "}
            <span className="ml-1.5 font-normal text-gray-400">
              (max 300 characters)
            </span>
          </label>

          <textarea
            rows={4}
            maxLength={300}
            value={companyIntro}
            onChange={(e) => setCompanyIntro(e.target.value)}
            placeholder={DEFAULT_INTRO}
            className="sc-input resize-none"
          />

          <div className="mt-1.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setCompanyIntro(DEFAULT_INTRO)}
              className="text-xs font-semibold text-violet-600 hover:text-violet-700"
            >
              Use AppHelix default
            </button>
            <span
              className={`text-xs tabular-nums ${
                companyIntro.length > 270
                  ? "text-red-500 font-semibold"
                  : companyIntro.length > 200
                    ? "text-amber-500"
                    : "text-gray-400"
              }`}
            >
              {companyIntro.length}/300
            </span>
          </div>
          {isEmpty && (
            <p className="mt-2 text-xs text-amber-700">
              Tip: set this once and you won’t need to repeat it for every job.
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end">
          <button type="submit" disabled={saving} className="sc-btn-primary px-6 py-2.5">
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving…" : saved ? "Saved!" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

