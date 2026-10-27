"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";

// Editable list of ONE candidate's own interview questions: CV-based suggestions HR keeps or
// rewrites, plus HR's own questions. Removed suggestions can be added back.

export interface PlanQuestion {
  text: string;
  source: "cv" | "hr";
}

export const MAX_CANDIDATE_QUESTIONS = 8;

export default function CandidateQuestionsEditor({
  value,
  suggestions,
  onChange,
  compact = false,
  startAt = 1,
}: {
  value: PlanQuestion[];
  suggestions: string[];
  onChange: (q: PlanQuestion[]) => void;
  compact?: boolean;
  /** Number shown for the first question (when common questions are asked before these). */
  startAt?: number;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const [draft, setDraft] = useState("");
  const used = new Set(value.map((q) => q.text.trim().toLowerCase()));
  const unused = suggestions.filter((s) => !used.has(s.trim().toLowerCase()));
  const full = value.length >= MAX_CANDIDATE_QUESTIONS;

  function add(text: string, source: PlanQuestion["source"]) {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 5 || full || used.has(t.toLowerCase())) return;
    onChange([...value, { text: t.slice(0, 500), source }]);
  }

  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">No questions for this candidate yet.</p>}
      <ol className="space-y-1.5">
        {value.map((q, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-2 w-4 shrink-0 text-right text-xs font-semibold text-gray-400">{startAt + i}</span>
            <span className="flex shrink-0 flex-col">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`} title="Move up"
                className="rounded p-0.5 text-gray-300 hover:bg-gray-100 hover:text-violet-700 disabled:invisible">
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} aria-label={`Move question ${i + 1} down`} title="Move down"
                className="rounded p-0.5 text-gray-300 hover:bg-gray-100 hover:text-violet-700 disabled:invisible">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </span>
            <textarea
              value={q.text}
              rows={compact ? 1 : 2}
              maxLength={500}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              aria-label={`Question ${i + 1}`}
              className="min-w-0 flex-1 resize-y rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-900 focus:border-violet-400 focus:outline-none"
            />
            <span className={`mt-1.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${q.source === "cv" ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"}`}>
              {q.source === "cv" ? "From CV" : "Yours"}
            </span>
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove question ${i + 1}`} className="mt-1 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-600">
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft, "hr"); setDraft(""); } }}
          disabled={full}
          maxLength={500}
          placeholder={full ? `Maximum ${MAX_CANDIDATE_QUESTIONS} questions` : "Add your own question for this candidate"}
          aria-label="Add your own question"
          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-violet-400 focus:outline-none disabled:bg-gray-50"
        />
        <button type="button" disabled={full || draft.trim().length < 5} onClick={() => { add(draft, "hr"); setDraft(""); }}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-40">
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {unused.length > 0 && !full && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Suggested from CV screening</p>
          <div className="flex flex-col gap-1">
            {unused.map((s, i) => (
              <button key={i} type="button" onClick={() => add(s, "cv")}
                className="flex items-start gap-1.5 rounded-lg px-2 py-1 text-left text-xs text-gray-600 hover:bg-emerald-50 hover:text-emerald-800">
                <Plus className="mt-0.5 h-3 w-3 shrink-0" /> {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
