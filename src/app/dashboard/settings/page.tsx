"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle } from "lucide-react";

export default function SettingsPage() {
  const [debugMode, setDebugMode] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/recruiter/settings")
      .then((r) => r.json())
      .then((d: { debug_mode?: boolean }) => setDebugMode(d.debug_mode === true))
      .catch(() => setError("Failed to load settings"));
  }, []);

  async function toggleDebug() {
    if (debugMode === null) return;
    const next = !debugMode;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/recruiter/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debug_mode: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError((d as { error?: string }).error ?? "Failed to save");
        return;
      }
      setDebugMode(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <p className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-violet-600">Settings</p>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Application settings</h1>

      <label className="sc-label">Interview room</label>
      {debugMode === null && !error ? (
        <div className="flex h-24 items-center justify-center rounded-xl border-2 border-gray-200 bg-white">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      ) : (
        <button
          type="button"
          onClick={toggleDebug}
          disabled={saving || debugMode === null}
          className="flex w-full items-start justify-between gap-4 rounded-xl border-2 border-gray-200 bg-white p-4 text-left transition-colors hover:border-gray-300 disabled:opacity-60"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-gray-900">Debug mode</p>
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                style={{ background: debugMode ? "#7c3aed" : "#9ca3af", color: "#fff" }}
              >
                {debugMode ? "On" : "Off"}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              {debugMode
                ? "Interview rooms for your jobs show developer panels: debug logs, which voice engine is running and why, the live transcript and the integrity score. Turn this off before real candidates interview."
                : "Candidates see a clean, Meet-style interview room — no logs, engine info or integrity score. Turn on to troubleshoot interviews for your jobs."}
            </p>
          </div>
          <span
            role="switch"
            aria-checked={!!debugMode}
            className="relative mt-1 inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 transition-colors"
            style={{ background: debugMode ? "#7c3aed" : "#e5e7eb", borderColor: debugMode ? "#7c3aed" : "#d1d5db" }}
          >
            <span
              className="inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform"
              style={{ transform: debugMode ? "translateX(20px)" : "translateX(2px)", marginTop: "2px" }}
            />
          </span>
        </button>
      )}

      {saved && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-600">
          <CheckCircle className="h-4 w-4" /> Saved — applies to interview rooms opened from now on.
        </p>
      )}
      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}
    </div>
  );
}
