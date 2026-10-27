"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { Criteria } from "@/lib/screening/criteria";

// Simple 3-level requirements editor. Maps onto the versioned Criteria schema:
//   Must have    → required + hard (decides eligibility)
//   Important    → required (counts double in the job-fit score)
//   Nice to have → preferred (counts once)
// Weights, ids and synonyms are handled automatically; synonyms/thresholds live under "Advanced".

export type Level = "must" | "important" | "nice";

const LEVELS: { value: Level; label: string; cls: string }[] = [
  { value: "must", label: "Must have", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  { value: "important", label: "Important", cls: "bg-violet-50 text-violet-700 ring-violet-200" },
  { value: "nice", label: "Nice to have", cls: "bg-gray-50 text-gray-600 ring-gray-200" },
];

const WEIGHT: Record<Level, number> = { must: 4, important: 3, nice: 2 };

export function levelOf(x: { importance: "required" | "preferred"; hard: boolean }): Level {
  if (x.importance === "required") return x.hard ? "must" : "important";
  return "nice";
}

export function applyLevel<T extends { importance: "required" | "preferred"; hard: boolean; weight: number }>(x: T, level: Level): T {
  return { ...x, importance: level === "nice" ? "preferred" : "required", hard: level === "must", weight: WEIGHT[level] };
}

let seq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 40);

export default function RequirementsEditor({ value, onChange }: { value: Criteria; onChange: (c: Criteria) => void }) {
  const [draft, setDraft] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const c = value;
  const set = (patch: Partial<Criteria>) => onChange({ ...c, ...patch });

  // Skills, qualifications and certifications are shown as ONE list of requirements.
  type Row =
    | { kind: "skill"; i: number; name: string; level: Level; years: number | null }
    | { kind: "qualification"; i: number; name: string; level: Level; years: null }
    | { kind: "certification"; i: number; name: string; level: Level; years: null };
  const rows: Row[] = [
    ...c.skills.map((s, i) => ({ kind: "skill" as const, i, name: s.name, level: levelOf(s), years: s.min_years })),
    ...c.qualifications.map((q, i) => ({ kind: "qualification" as const, i, name: q.description, level: levelOf(q), years: null })),
    ...c.certifications.map((x, i) => ({ kind: "certification" as const, i, name: x.name, level: levelOf(x), years: null })),
  ];
  const order: Record<Level, number> = { must: 0, important: 1, nice: 2 };
  rows.sort((a, b) => order[a.level] - order[b.level]);

  function updateRow(r: Row, patch: { name?: string; level?: Level; years?: number | null }) {
    if (r.kind === "skill") {
      set({
        skills: c.skills.map((s, j) => {
          if (j !== r.i) return s;
          let next = { ...s };
          if (patch.name !== undefined) next.name = patch.name;
          if (patch.years !== undefined) next.min_years = patch.years;
          if (patch.level) next = applyLevel(next, patch.level);
          return next;
        }),
      });
    } else if (r.kind === "qualification") {
      set({
        qualifications: c.qualifications.map((q, j) => {
          if (j !== r.i) return q;
          let next = { ...q };
          if (patch.name !== undefined) next.description = patch.name;
          if (patch.level) next = applyLevel(next, patch.level);
          return next;
        }),
      });
    } else {
      set({
        certifications: c.certifications.map((x, j) => {
          if (j !== r.i) return x;
          let next = { ...x };
          if (patch.name !== undefined) next.name = patch.name;
          if (patch.level) next = applyLevel(next, patch.level);
          return next;
        }),
      });
    }
  }

  function removeRow(r: Row) {
    if (r.kind === "skill") set({ skills: c.skills.filter((_, j) => j !== r.i) });
    else if (r.kind === "qualification") set({ qualifications: c.qualifications.filter((_, j) => j !== r.i) });
    else set({ certifications: c.certifications.filter((_, j) => j !== r.i) });
  }

  function addSkill(names: string) {
    const list = names.split(",").map((n) => n.trim()).filter(Boolean);
    if (!list.length) return;
    set({
      skills: [
        ...c.skills,
        ...list.map((name) => applyLevel({ id: newId("skill"), name: name.slice(0, 80), synonyms: [], importance: "required" as const, weight: 3, min_years: null, hard: false }, "important")),
      ].slice(0, 30),
    });
    setDraft("");
  }

  const mustQualMissingReason = c.qualifications.some((q) => q.hard && !q.justification.trim());
  const hasLocation = !!c.location.required_location || c.location.arrangement !== "any" || c.location.relocation_required;

  return (
    <div className="space-y-5">
      {/* Requirements list */}
      <div>
        <div className="mb-2 flex items-end justify-between">
          <p className="text-sm font-semibold text-gray-900">Skills and qualifications</p>
          <p className="text-xs text-gray-400">Min. years counts only roles where the CV shows the skill in use</p>
        </div>
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-gray-400">No requirements yet — add skills below.</p>}
          {rows.map((r) => (
            <div key={`${r.kind}-${r.i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <input
                value={r.name}
                onChange={(e) => updateRow(r, { name: e.target.value })}
                aria-label="Requirement"
                maxLength={r.kind === "qualification" ? 200 : 80}
                className="min-w-[180px] flex-1 rounded-lg border border-transparent px-2 py-1.5 text-sm text-gray-900 hover:border-gray-200 focus:border-violet-400 focus:outline-none"
              />
              {r.kind !== "skill" && <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{r.kind === "qualification" ? "Degree" : "Certificate"}</span>}
              <LevelPicker value={r.level} onChange={(level) => updateRow(r, { level })} />
              {r.kind === "skill" ? (
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  <input
                    type="number" min={0} max={40} step={0.5} value={r.years ?? ""} placeholder="–"
                    onChange={(e) => updateRow(r, { years: e.target.value === "" ? null : Math.min(40, Math.max(0, Number(e.target.value))) })}
                    className="w-14 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm focus:border-violet-400 focus:outline-none"
                    aria-label={`Minimum years of ${r.name}`}
                  />
                  yrs
                </label>
              ) : (
                <span className="w-[70px]" />
              )}
              <button type="button" onClick={() => removeRow(r)} aria-label={`Remove ${r.name}`} className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-600">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 bg-gray-50/60 px-3 py-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(draft); } }}
              placeholder="Add skills, e.g. React, Node.js, SQL"
              aria-label="Add skills"
              className="min-w-[200px] flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm focus:border-violet-400 focus:outline-none"
            />
            <button type="button" onClick={() => addSkill(draft)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-50">
              <Plus className="h-4 w-4" /> Add
            </button>
            <button type="button"
              onClick={() => set({ qualifications: [...c.qualifications, { id: newId("qual"), description: "Degree in a related field", equivalents_allowed: true, equivalent_experience_years: null, importance: "preferred" as const, weight: 2, hard: false, justification: "" }].slice(0, 10) })}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100"
            >
              + Degree
            </button>
            <button type="button"
              onClick={() => set({ certifications: [...c.certifications, { id: newId("cert"), name: "Certification", importance: "preferred" as const, weight: 2, hard: false }].slice(0, 10) })}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100"
            >
              + Certificate
            </button>
          </div>
        </div>
        {mustQualMissingReason && (
          <div className="mt-2 space-y-2 rounded-xl bg-rose-50/60 p-3">
            <p className="text-xs text-rose-800">A degree marked <b>Must have</b> rules out candidates who don&apos;t have it. Add the job-related reason:</p>
            {c.qualifications.map((q, i) => q.hard && (
              <input
                key={q.id}
                value={q.justification}
                maxLength={300}
                onChange={(e) => set({ qualifications: c.qualifications.map((x, j) => (j === i ? { ...x, justification: e.target.value } : x)) })}
                placeholder={`Why is "${q.description}" required? (e.g. licensing requirement)`}
                className="sc-input py-2 text-sm"
              />
            ))}
          </div>
        )}
      </div>

      {/* Experience + location */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">Total experience</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number" min={0} max={40} step={0.5} placeholder="Any"
              value={c.total_experience.min_years ?? ""}
              onChange={(e) => set({ total_experience: { ...c.total_experience, min_years: e.target.value === "" ? null : Math.min(40, Math.max(0, Number(e.target.value))) } })}
              className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm focus:border-violet-400 focus:outline-none"
              aria-label="Minimum years of experience"
            />
            <span className="text-sm text-gray-500">years or more</span>
            {c.total_experience.min_years != null && (
              <LevelPicker
                value={c.total_experience.hard ? "must" : "important"}
                options={["must", "important"]}
                onChange={(l) => set({ total_experience: { ...c.total_experience, hard: l === "must", weight: WEIGHT[l] } })}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-gray-400">Calculated from employment dates. Internships excluded.</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">Location</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={c.location.required_location ?? ""} maxLength={120} placeholder="Any location"
              onChange={(e) => set({ location: { ...c.location, required_location: e.target.value || null } })}
              className="min-w-[140px] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-violet-400 focus:outline-none"
              aria-label="Work location"
            />
            <select
              value={c.location.arrangement}
              onChange={(e) => set({ location: { ...c.location, arrangement: e.target.value as Criteria["location"]["arrangement"] } })}
              className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-violet-400 focus:outline-none"
              aria-label="Work arrangement"
            >
              <option value="any">Any arrangement</option>
              <option value="onsite">Onsite</option>
              <option value="hybrid">Hybrid</option>
              <option value="remote">Remote</option>
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={c.location.relocation_required} onChange={(e) => set({ location: { ...c.location, relocation_required: e.target.checked } })} />
              Relocation required
            </label>
            {hasLocation && (
              <LevelPicker
                value={c.location.hard ? "must" : "important"}
                options={["must", "important"]}
                onChange={(l) => set({ location: { ...c.location, hard: l === "must", weight: WEIGHT[l] } })}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-gray-400">Only what the candidate states is used — never guessed from their address.</p>
        </div>
      </div>

      {/* Advanced */}
      <div>
        <button type="button" onClick={() => setAdvanced(!advanced)} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-800">
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Advanced
        </button>
        {advanced && (
          <div className="mt-3 space-y-4 rounded-xl border border-gray-200 bg-white p-4">
            {c.skills.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-600">Alternative names to accept (comma-separated)</p>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {c.skills.map((s, i) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <span className="w-28 shrink-0 truncate text-gray-700">{s.name || "—"}</span>
                      <input
                        value={s.synonyms.join(", ")}
                        placeholder="e.g. JS, ECMAScript"
                        onChange={(e) => set({ skills: c.skills.map((x, j) => (j === i ? { ...x, synonyms: e.target.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10) } : x)) })}
                        className="flex-1 rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-violet-400 focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {c.qualifications.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-gray-600">Degree equivalents</p>
                {c.qualifications.map((q, i) => (
                  <label key={q.id} className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={q.equivalents_allowed} onChange={(e) => set({ qualifications: c.qualifications.map((x, j) => (j === i ? { ...x, equivalents_allowed: e.target.checked, equivalent_experience_years: e.target.checked ? x.equivalent_experience_years : null } : x)) })} />
                    Accept equivalent qualifications or experience for &ldquo;{q.description}&rdquo;
                    {q.equivalents_allowed && (
                      <>
                        — or
                        <input type="number" min={0} max={40} step={0.5} value={q.equivalent_experience_years ?? ""} placeholder="–"
                          onChange={(e) => set({ qualifications: c.qualifications.map((x, j) => (j === i ? { ...x, equivalent_experience_years: e.target.value === "" ? null : Number(e.target.value) } : x)) })}
                          className="w-14 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm" aria-label="Equivalent years" />
                        years&apos; experience
                      </>
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-6 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                Flag employment gaps of
                <input type="number" min={1} max={36} value={c.observations.gap_threshold_months}
                  onChange={(e) => set({ observations: { ...c.observations, gap_threshold_months: Math.max(1, Math.min(36, Number(e.target.value) || 6)) } })}
                  className="w-14 rounded-lg border border-gray-200 px-2 py-1 text-center" />
                months+
              </label>
              <label className="flex items-center gap-2">
                Note jobs shorter than
                <input type="number" min={1} max={36} value={c.observations.short_tenure_months}
                  onChange={(e) => set({ observations: { ...c.observations, short_tenure_months: Math.max(1, Math.min(36, Number(e.target.value) || 12)) } })}
                  className="w-14 rounded-lg border border-gray-200 px-2 py-1 text-center" />
                months
              </label>
            </div>
            <p className="text-xs text-gray-400">Gaps and short jobs are shown as facts only and never lower a score.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function LevelPicker({ value, onChange, options = ["must", "important", "nice"] }: { value: Level; onChange: (l: Level) => void; options?: Level[] }) {
  return (
    <div className="inline-flex rounded-lg bg-gray-100 p-0.5" role="radiogroup" aria-label="Importance">
      {LEVELS.filter((l) => options.includes(l.value)).map((l) => (
        <button
          type="button"
          key={l.value}
          role="radio"
          aria-checked={value === l.value}
          onClick={() => onChange(l.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${value === l.value ? `${l.cls} shadow-sm ring-1` : "text-gray-500 hover:text-gray-800"}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** Drop empty rows and give blank names a chance to fail validation clearly. */
export function cleanCriteria(c: Criteria): Criteria {
  return {
    ...c,
    skills: c.skills.filter((s) => s.name.trim()),
    qualifications: c.qualifications.filter((q) => q.description.trim()),
    certifications: c.certifications.filter((x) => x.name.trim()),
  };
}
