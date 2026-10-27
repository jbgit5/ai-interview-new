// Run the Diagnostics rules on an exported session (same input the dashboard builds), from the terminal.
//   node --no-warnings --import ./tests/ts-resolve.mjs --experimental-strip-types tests/diagnose-export.mjs <file.json>
// Export a session with the SQL in docs/PIPELINE-ENGINE.md ("Diagnose one interview from the terminal").
import { readFileSync } from "node:fs";
import { diagnoseSession } from "../src/lib/diagnostics/diagnoseSession.ts";

const raw = readFileSync(process.argv[2], "utf8").replace(/^﻿/, "");
const d = diagnoseSession(JSON.parse(raw));
console.log(`engine: ${d.engine} | verdict: ${d.verdict.title}`);
for (const i of d.issues) console.log(`[${i.severity}] ${i.title} — ${i.detail.slice(0, 160)}`);
console.log("--- timeline ---");
for (const t of d.timeline) {
  if (t.kind === "candidate" || t.kind === "maya") continue;
  console.log(`${(t.atMs / 1000).toFixed(1).padStart(6)}s  ${t.label}${t.text ? ` “${t.text.slice(0, 60)}”` : ""}`);
}
