"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { Criteria } from "@/lib/screening/criteria";
import RequirementsEditor, { cleanCriteria } from "./RequirementsEditor";

// Requirements tab: edit → save creates a new version (earlier results keep theirs) → optionally
// re-screen existing CVs against the new version.

const EST_PER_CV = 0.02; // assessment call only; extraction is cached

export default function RequirementsClient({ jobId }: { jobId: string }) {
  const base = `/api/jobs/${jobId}/screening`;
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [version, setVersion] = useState<number | null>(null);
  const [hasJd, setHasJd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState("");
  const [outdated, setOutdated] = useState(0);
  const [rescreening, setRescreening] = useState(false);
  const [message, setMessage] = useState("");

  const loadOutdated = useCallback(() => {
    fetch(`${base}/rescreen-all`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setOutdated(d.outdated)).catch(() => {});
  }, [base]);

  useEffect(() => {
    fetch(`${base}/config`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Failed to load requirements");
        const c = d.current?.criteria ?? d.defaults;
        setCriteria(c);
        setSaved(JSON.stringify(c));
        setVersion(d.current?.version ?? null);
        setHasJd(d.job.hasDescription);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    loadOutdated();
  }, [base, loadOutdated]);

  if (loading) return <div className="flex items-center gap-2 p-10 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  if (!criteria) return <p className="m-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error || "Failed to load requirements"}</p>;

  const dirty = JSON.stringify(criteria) !== saved;

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const r = await fetch(`${base}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criteria: cleanCriteria(criteria!) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.issues?.[0]?.message ?? d.error ?? "Save failed");
      setCriteria(d.criteria);
      setSaved(JSON.stringify(d.criteria));
      setVersion(d.version);
      setMessage("Saved. New CVs will be screened against these requirements.");
      loadOutdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function suggest() {
    if (!confirm("Replace the current requirements with a fresh draft from the job description? Nothing is saved until you click Save.")) return;
    setSuggesting(true);
    setError("");
    try {
      const r = await fetch(`${base}/config/suggest`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn't read the job description");
      setCriteria({ ...d.criteria, observations: criteria!.observations });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function rescreenAll() {
    if (!confirm(`Re-screen ${outdated} CV(s) against the current requirements?\n\nEstimated AI cost: about $${(outdated * EST_PER_CV).toFixed(2)}. Earlier results are kept.`)) return;
    setRescreening(true);
    const r = await fetch(`${base}/rescreen-all`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setRescreening(false);
    if (!r.ok) return setError(d.error ?? "Re-screen failed");
    setOutdated(0);
    setMessage(`${d.queued} CV(s) queued for re-screening. Progress shows on the Candidates tab.`);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Requirements</h2>
          <p className="mt-0.5 text-sm text-gray-500">What CVs are checked against. <b>Must have</b> items decide eligibility; <b>Important</b> items count double in the fit score.</p>
        </div>
        <div className="flex items-center gap-2">
          {hasJd && (
            <button type="button" onClick={suggest} disabled={suggesting} className="sc-btn-secondary !py-2">
              {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-violet-600" />} Re-read JD
            </button>
          )}
          <button type="button" onClick={save} disabled={saving || !dirty} className="sc-btn-primary !py-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {message && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
      {outdated > 0 && !dirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <span>{outdated} CV(s) were screened with earlier requirements.</span>
          <button type="button" onClick={rescreenAll} disabled={rescreening} className="inline-flex items-center gap-1.5 font-semibold hover:underline">
            {rescreening ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Re-screen them
          </button>
        </div>
      )}

      <div className="sc-card p-5">
        <RequirementsEditor value={criteria} onChange={setCriteria} />
      </div>

      <p className="text-xs text-gray-400">
        {version ? `Version ${version}. ` : ""}Every save is kept as a new version, so earlier screening results stay explainable.{" "}
        <Link href={`/dashboard/jobs/${jobId}/screening`} className="text-violet-700 hover:underline">Go to candidates →</Link>
      </p>
    </div>
  );
}
