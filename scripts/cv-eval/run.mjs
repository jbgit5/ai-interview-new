// CV-screening evaluation harness — compares the real pipeline (real OpenAI calls) with
// HR-reviewed gold labels. Run by hand, on an AUTHORISED dataset stored OUTSIDE the repo.
//
//   npm run eval:screening -- --dir /secure/cv-eval-set            # prints plan + cost estimate, no calls
//   npm run eval:screening -- --dir /secure/cv-eval-set --yes      # runs it
//
// Dataset layout (see docs/CV-SCREENING.md §Evaluation):
//   <dir>/criteria.json                 screening criteria (same shape as the criteria editor saves)
//   <dir>/cases/<name>.pdf|.docx        CV
//   <dir>/cases/<name>.gold.json        HR labels:
//     { "as_of": "2026-10",
//       "employment": [{ "company": "...", "title": "...", "start": {"year":2020,"month":1}, "end": null, "is_current": true }],
//       "total_professional_months": 80,                         // or null if HR can't tell
//       "criteria": { "<criterion_id>": { "classification": "strong", "hard_status": "met" } },
//       "group": "optional group label for governed outcome comparison" }
//
// Writes <dir>/eval-report-<timestamp>.json (contains no CV text). Prints a summary.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCvText, detectCvFile } from "../../src/lib/screening/parse.ts";
import { CriteriaSchema, flattenCriteria } from "../../src/lib/screening/criteria.ts";
import { buildDocContext } from "../../src/lib/screening/service.ts";
import { extractCv, assessCv } from "../../src/lib/screening/pipeline.ts";
import { evaluateScreening } from "../../src/lib/screening/evaluate.ts";
import { openAiJsonCall } from "../../src/lib/llm/openai.ts";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = arg("dir");
const model = arg("model") ?? process.env.CV_SCREENING_MODEL ?? "gpt-4o";
const go = args.includes("--yes");
if (!dir || !existsSync(dir)) {
  console.error("Usage: npm run eval:screening -- --dir <dataset dir> [--model gpt-4o] [--yes]");
  process.exit(2);
}
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
if (path.resolve(dir).toLowerCase().startsWith(repoRoot.toLowerCase())) {
  console.error("Refusing to run: keep CV evaluation data outside the repository.");
  process.exit(2);
}

const criteria = CriteriaSchema.parse(JSON.parse(readFileSync(path.join(dir, "criteria.json"), "utf8")));
const defs = flattenCriteria(criteria);
const caseDir = path.join(dir, "cases");
const cases = readdirSync(caseDir)
  .filter((f) => /\.(pdf|docx)$/i.test(f))
  .map((f) => ({ file: f, name: f.replace(/\.(pdf|docx)$/i, ""), gold: path.join(caseDir, f.replace(/\.(pdf|docx)$/i, ".gold.json")) }))
  .filter((c) => existsSync(c.gold));

const EST_PER_CV = model.includes("mini") ? 0.004 : 0.05;
console.log(`Cases with gold labels: ${cases.length}`);
console.log(`Model: ${model} · 2 calls per CV · estimated cost ≈ $${(cases.length * EST_PER_CV).toFixed(2)}`);
if (!go) {
  console.log("Dry run only. Re-run with --yes to make the API calls.");
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set (tip: node --env-file=.env.local ...).");
  process.exit(2);
}

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SUPPORTED = new Set(["strong", "partial"]);
const collapse = (c) => (c === "unable_to_assess" ? "abstain" : SUPPORTED.has(c) ? "supported" : "not_supported");

const out = { model, generated_at: new Date().toISOString(), cases: [], metrics: {} };
let cost = 0;
let latency = 0;

for (const c of cases) {
  const gold = JSON.parse(readFileSync(c.gold, "utf8"));
  const buf = readFileSync(path.join(caseDir, c.file));
  const check = detectCvFile(buf, 25 * 1024 * 1024);
  const rec = { case: c.name, group: gold.group ?? null };
  if (!check.ok) {
    out.cases.push({ ...rec, error: check.code });
    continue;
  }
  const parsed = await extractCvText(buf, check.mime);
  if (!parsed.ok) {
    out.cases.push({ ...rec, error: parsed.code });
    continue;
  }
  const ctx = buildDocContext({ mime: check.mime, extracted_text: parsed.value.text, page_offsets: parsed.value.pageOffsets });
  const t0 = Date.now();
  try {
    const ex = await extractCv({ llm: openAiJsonCall, model, timeoutMs: 90_000, maskedText: ctx.maskedText });
    const as = await assessCv({ llm: openAiJsonCall, model, timeoutMs: 90_000, extraction: ex.extraction, criteria, jobTitle: "Evaluation" });
    cost += ex.usage.cost_usd + (as.usage?.cost_usd ?? 0);
    latency += Date.now() - t0;
    const [y, m] = String(gold.as_of ?? new Date().toISOString().slice(0, 7)).split("-").map(Number);
    const ev = evaluateScreening({
      extraction: ex.extraction, assessment: as.assessment, criteria, pages: ctx.pages, paged: ctx.paged,
      contacts: ctx.contacts, asOf: { year: y, month: m || 1 }, corrections: {}, textTruncated: parsed.value.truncated,
    });

    // Employment extraction: match gold roles to extracted roles by company + title.
    const roles = (gold.employment ?? []).map((g) => {
      const hit = ex.extraction.employment.find((e) => norm(e.company) === norm(g.company) && norm(e.title) === norm(g.title))
        ?? ex.extraction.employment.find((e) => norm(e.company) === norm(g.company));
      const same = (a, b) => (a?.year ?? null) === (b?.year ?? null) && (a?.month ?? null) === (b?.month ?? null);
      return {
        found: !!hit,
        start_ok: !!hit && same(hit.start, g.start),
        end_ok: !!hit && (g.is_current ? hit.is_current : same(hit.end, g.end)),
      };
    });
    const tp = ev.timeline.totals.professional;
    const goldMonths = gold.total_professional_months;
    rec.extraction = {
      gold_roles: roles.length,
      roles_found: roles.filter((r) => r.found).length,
      start_dates_correct: roles.filter((r) => r.start_ok).length,
      end_dates_correct: roles.filter((r) => r.end_ok).length,
      extra_roles: Math.max(0, ex.extraction.employment.length - roles.filter((r) => r.found).length),
    };
    rec.experience = goldMonths == null ? null : {
      gold_months: goldMonths, min: tp.min, max: tp.max,
      within_range: goldMonths >= tp.min && (tp.max == null || goldMonths <= tp.max),
      abs_error_midpoint: tp.max == null ? null : Math.abs((tp.min + tp.max) / 2 - goldMonths),
    };
    rec.citations = ev.citation_stats;
    rec.criteria = defs.map((d) => {
      const pred = ev.criteria.find((x) => x.id === d.id);
      const g = gold.criteria?.[d.id];
      return { id: d.id, hard: d.hard, gold: g?.classification ?? null, pred: pred?.classification ?? null, gold_hard: g?.hard_status ?? null, pred_hard: pred?.hard_status ?? null };
    });
    rec.summary = ev.summary;
  } catch (err) {
    rec.error = err.code ?? "error";
  }
  out.cases.push(rec);
  process.stdout.write(".");
}
console.log();

// ── Metrics ──
const ok = out.cases.filter((c) => !c.error);
const sum = (f) => ok.reduce((s, c) => s + (f(c) ?? 0), 0);
const pairs = ok.flatMap((c) => c.criteria.filter((x) => x.gold && x.pred).map((x) => ({ ...x, group: c.group })));
const agreeExact = pairs.filter((p) => p.gold === p.pred).length;
const cats = ["supported", "not_supported", "abstain"];
function kappa(ps) {
  if (!ps.length) return null;
  const n = ps.length;
  const po = ps.filter((p) => collapse(p.gold) === collapse(p.pred)).length / n;
  const pe = cats.reduce((s, k) => s + (ps.filter((p) => collapse(p.gold) === k).length / n) * (ps.filter((p) => collapse(p.pred) === k).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
const hardPairs = pairs.filter((p) => p.hard && p.gold_hard && p.pred_hard);
out.metrics = {
  cases: out.cases.length,
  failed_cases: out.cases.length - ok.length,
  role_recall: sum((c) => c.extraction.roles_found) / Math.max(1, sum((c) => c.extraction.gold_roles)),
  start_date_accuracy: sum((c) => c.extraction.start_dates_correct) / Math.max(1, sum((c) => c.extraction.gold_roles)),
  end_date_accuracy: sum((c) => c.extraction.end_dates_correct) / Math.max(1, sum((c) => c.extraction.gold_roles)),
  extra_roles: sum((c) => c.extraction.extra_roles),
  experience_within_range: ok.filter((c) => c.experience).filter((c) => c.experience.within_range).length / Math.max(1, ok.filter((c) => c.experience).length),
  citation_verified_rate: sum((c) => c.citations.verified) / Math.max(1, sum((c) => c.citations.total)),
  criterion_exact_agreement: pairs.length ? agreeExact / pairs.length : null,
  criterion_kappa_3way: kappa(pairs),
  abstention_rate: pairs.length ? pairs.filter((p) => p.pred === "unable_to_assess").length / pairs.length : null,
  hard_false_positive: hardPairs.filter((p) => p.pred_hard === "met" && p.gold_hard === "unmet").length,
  hard_false_negative: hardPairs.filter((p) => p.pred_hard === "unmet" && p.gold_hard === "met").length,
  hard_undetermined: hardPairs.filter((p) => p.pred_hard === "undetermined").length,
  hard_pairs: hardPairs.length,
  total_cost_usd: Math.round(cost * 10000) / 10000,
  avg_latency_ms: ok.length ? Math.round(latency / ok.length) : null,
};
const groups = [...new Set(ok.map((c) => c.group).filter(Boolean))];
if (groups.length) {
  out.metrics.by_group = Object.fromEntries(groups.map((g) => {
    const gc = ok.filter((c) => c.group === g);
    const gp = pairs.filter((p) => p.group === g);
    const catCounts = {};
    for (const c of gc) catCounts[c.summary.fit_category] = (catCounts[c.summary.fit_category] ?? 0) + 1;
    return [g, { n: gc.length, kappa_3way: kappa(gp), exact_agreement: gp.length ? gp.filter((p) => p.gold === p.pred).length / gp.length : null, fit_categories: catCounts }];
  }));
}

const file = path.join(dir, `eval-report-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.table(Object.fromEntries(Object.entries(out.metrics).filter(([k]) => k !== "by_group")));
if (out.metrics.by_group) console.log("By group:", JSON.stringify(out.metrics.by_group, null, 2));
console.log(`Report written to ${file}`);
