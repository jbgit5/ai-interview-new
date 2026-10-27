// Database integration tests for CV screening (opt-in; needs the local Docker Postgres).
// Run:  npm run db:local:up && npm run test:screening:db
//
// Safety: creates a throw-away database (ai_interview_cvtest_<pid>) on the LOCAL server, applies
// the migrations from setup-local-db.sh to it, runs the tests, then drops it. Refuses to run
// against any host other than localhost/127.0.0.1. Never touches the ai_interview database's data.
// The LLM is mocked — no OpenAI calls, no cost.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failures++;
};

// ── Connection (local only) ──
function localUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return "postgresql://postgres:postgres@127.0.0.1:54322/ai_interview";
}
const adminUrl = new URL(localUrl());
if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
  console.error(`Refusing to run: ${adminUrl.hostname} is not a local database.`);
  process.exit(2);
}
const dbName = `ai_interview_cvtest_${process.pid}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;

const admin = new pg.Client({ connectionString: adminUrl.toString() });
try {
  await admin.connect();
} catch (err) {
  console.error(`Local Postgres not reachable (${err.code ?? err.message}). Start it with: npm run db:local:up`);
  process.exit(2);
}
await admin.query(`CREATE DATABASE ${dbName}`);

const storageDir = mkdtempSync(path.join(tmpdir(), "cv-uploads-test-"));
process.env.DATABASE_URL = testUrl.toString();
process.env.CV_STORAGE_DIR = storageDir;
process.env.CV_SCREENING_DAILY_BUDGET_USD = "5";

const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 5 });

try {
  // ── Migrations (same list and order as setup-local-db.sh) ──
  const setup = readFileSync(new URL("../setup-local-db.sh", import.meta.url), "utf8");
  const files = [...setup.matchAll(/"(db\/migrations\/[^"]+\.sql)"/g)].map((m) => m[1]);
  for (const f of files) await pool.query(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
  check(`applied ${files.length} migrations to a scratch DB`, files.includes("db/migrations/019_cv_screening.sql"));
  let rerunOk = true;
  try {
    await pool.query(readFileSync(new URL("../db/migrations/019_cv_screening.sql", import.meta.url), "utf8"));
  } catch (err) {
    rerunOk = false;
    console.error(err.message);
  }
  check("migration 019 can be re-applied safely (idempotent)", rerunOk);

  const { findRecruiterJob, createConfigVersion, listResults, reevaluateScreening, spentTodayUsd, latestDecision } = await import("../src/lib/screening/service.ts");
  const { claim, processOne } = await import("../src/lib/screening/worker.ts");
  const { createScreeningInvite, loadCandidatePlans, saveCandidateQuestions } = await import("../src/lib/screening/interviewPlan.ts");
  const { saveCvFile, storagePathFor, readCvFile } = await import("../src/lib/screening/storage.ts");
  const { DEFAULT_CRITERIA } = await import("../src/lib/screening/criteria.ts");

  // ── Two recruiters, one job each ──
  const mk = async (n) => {
    await pool.query(`INSERT INTO "user" (id, email, name) VALUES ($1, $2, $3)`, [`u${n}`, `r${n}@test.local`, `Recruiter ${n}`]);
    const r = await pool.query(`INSERT INTO recruiters (better_auth_user_id, email, name) VALUES ($1, $2, $3) RETURNING id`, [`u${n}`, `r${n}@test.local`, `Recruiter ${n}`]);
    const j = await pool.query(`INSERT INTO jobs (recruiter_id, title, description, status) VALUES ($1, $2, 'JD', 'active') RETURNING id`, [r.rows[0].id, `Job ${n}`]);
    return { userId: `u${n}`, recruiterId: r.rows[0].id, jobId: j.rows[0].id };
  };
  const A = await mk("A");
  const B = await mk("B");

  check("owner can access their job", (await findRecruiterJob(pool, A.userId, A.jobId))?.job.id === A.jobId);
  check("another recruiter cannot access the job", (await findRecruiterJob(pool, B.userId, A.jobId)) === null);
  check("malformed job id is rejected without a query error", (await findRecruiterJob(pool, A.userId, "1 OR 1=1")) === null);

  // ── Versioned config ──
  const criteria = {
    ...DEFAULT_CRITERIA,
    skills: [{ id: "python", name: "Python", synonyms: [], importance: "required", weight: 3, min_years: 2, hard: true }],
    total_experience: { min_years: 3, weight: 3, hard: false },
  };
  const v1 = await createConfigVersion(pool, A.jobId, A.recruiterId, criteria);
  const v2 = await createConfigVersion(pool, A.jobId, A.recruiterId, { ...criteria, total_experience: { min_years: 5, weight: 3, hard: false } });
  check("config versions increment per job (1, 2)", v1.version === 1 && v2.version === 2);
  const vb = await createConfigVersion(pool, B.jobId, B.recruiterId, DEFAULT_CRITERIA);
  check("versions are independent per job", vb.version === 1);
  const both = await Promise.all([1, 2, 3].map(() => createConfigVersion(pool, B.jobId, B.recruiterId, DEFAULT_CRITERIA)));
  check("concurrent saves never collide on a version number", new Set(both.map((x) => x.version)).size === 3);

  // ── Upload-equivalent: document + screening ──
  const pdf = makePdf([
    "Jane Doe jane.doe@example.com +44 7700 900123 Senior Engineer, Acme Ltd, Jan 2020 - Present. Built payment APIs in Python and Django.",
    "Engineer, Beta Corp, Jun 2017 - Dec 2019. Maintained Java services.",
  ]);
  const batch = await pool.query(`INSERT INTO screening_batches (job_id, config_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [A.jobId, v2.id, A.recruiterId]);
  const insertDoc = async (jobId, sha, batchId = null) => {
    const id = crypto.randomUUID();
    const rel = storagePathFor(jobId, id, "pdf");
    await pool.query(
      `INSERT INTO cv_documents (id, job_id, batch_id, original_filename, mime, size_bytes, sha256, storage_path)
       VALUES ($1, $2, $3, 'jane.pdf', 'application/pdf', $4, $5, $6)`,
      [id, jobId, batchId, pdf.length, sha, rel]
    );
    await saveCvFile(rel, pdf);
    return { id, rel };
  };
  const doc = await insertDoc(A.jobId, "sha-1", batch.rows[0].id);
  check("stored file is readable back", (await readCvFile(doc.rel)).length === pdf.length);
  let dupBlocked = false;
  try {
    await pool.query(`INSERT INTO cv_documents (job_id, original_filename, mime, size_bytes, sha256, storage_path) VALUES ($1, 'x.pdf', 'application/pdf', 1, 'sha-1', 'x')`, [A.jobId]);
  } catch (err) {
    dupBlocked = err.code === "23505";
  }
  check("duplicate upload (same job + sha256) is blocked by the DB", dupBlocked);
  const otherJobSameFile = await insertDoc(B.jobId, "sha-1");
  check("the same file may be uploaded to a different job", !!otherJobSameFile.id);

  const scr = await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id, batch_id) VALUES ($1, $2, $3, $4) RETURNING id`, [A.jobId, doc.id, v2.id, batch.rows[0].id]);
  const sid = scr.rows[0].id;
  const again = await pool.query(
    `INSERT INTO cv_screenings (job_id, cv_document_id, config_id) VALUES ($1, $2, $3) ON CONFLICT (cv_document_id, config_id) DO NOTHING RETURNING id`,
    [A.jobId, doc.id, v2.id]
  );
  check("re-queuing the same CV + config version is a no-op (idempotent)", again.rowCount === 0);

  // ── Worker with a mocked LLM ──
  let calls = 0;
  const usage = (n) => ({ model: "gpt-4o", prompt_tokens: 1000 * n, completion_tokens: 100 * n, cost_usd: 0.01 * n, latency_ms: 5 });
  const goodLlm = async (req) => {
    calls++;
    if (req.schemaName === "cv_extraction") {
      check("only masked text reaches the extraction call", !req.user.includes("@") && req.user.includes("<cv_document>"));
      return { data: extraction(), usage: usage(1) };
    }
    return { data: assessment(), usage: usage(1) };
  };

  const row1 = await claim(pool);
  check("worker claims the queued screening", row1?.id === sid && row1.attempts === 1);
  check("a claimed row is not handed out twice", (await claim(pool)) === null);
  await processOne(pool, goodLlm, row1);
  const done = (await pool.query(`SELECT * FROM cv_screenings WHERE id = $1`, [sid])).rows[0];
  check("screening completes with deterministic scores", done.status === "completed" && done.job_fit_score != null && done.eligibility_status === "meets", `${done.status} ${done.error_code ?? ""} fit=${done.job_fit_score}`);
  check("two paid calls recorded in the usage ledger", (await pool.query(`SELECT COUNT(*)::int n FROM screening_llm_usage`)).rows[0].n === 2 && calls === 2);
  check("daily spend is summed from the ledger", Math.abs((await spentTodayUsd(pool)) - 0.02) < 1e-9);
  const docRow = (await pool.query(`SELECT extraction_status, extraction IS NOT NULL AS has_ex, page_count FROM cv_documents WHERE id = $1`, [doc.id])).rows[0];
  check("parsed text + extraction are cached on the document", docRow.extraction_status === "extracted" && docRow.has_ex && docRow.page_count === 2);
  check("completed screenings are never re-claimed", (await claim(pool)) === null);

  // Re-screen against config v1 → reuses the cached extraction (only the assessment is paid).
  const scr2 = await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id) VALUES ($1, $2, $3) RETURNING id`, [A.jobId, doc.id, v1.id]);
  calls = 0;
  await processOne(pool, goodLlm, await claim(pool));
  check("re-screen reuses the cached extraction (1 call, not 2)", calls === 1);
  const rows = await listResults(pool, A.jobId);
  check("results list shows one row per CV (newest config version)", rows.length === 1 && rows[0].config_version === 2, JSON.stringify(rows.map((r) => r.config_version)));
  check("results never include another recruiter's CVs", (await listResults(pool, B.jobId)).every((r) => r.document_id !== doc.id));

  // HR correction → deterministic re-evaluation, and no cross-job access.
  await pool.query(`UPDATE cv_screenings SET corrections = $2 WHERE id = $1`, [sid, JSON.stringify({ employment: { E1: { start: { year: 2026, month: 1 } } } })]);
  calls = 0;
  const re = await reevaluateScreening(pool, A.jobId, sid);
  check("correction re-scores without any LLM call", calls === 0 && re?.summary.eligibility_status === "unmet");
  check("re-evaluation via another job's id is refused", (await reevaluateScreening(pool, B.jobId, sid)) === null);

  // ── Failure handling ──
  const doc2 = await insertDoc(A.jobId, "sha-2");
  const s2 = (await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id) VALUES ($1, $2, $3) RETURNING id`, [A.jobId, doc2.id, v2.id])).rows[0].id;
  const badLlm = async () => ({ data: { not: "the schema" }, usage: usage(1) });
  await processOne(pool, badLlm, await claim(pool));
  let st = (await pool.query(`SELECT status, error_code, attempts, lease_until > now() AS backing_off FROM cv_screenings WHERE id = $1`, [s2])).rows[0];
  check("malformed model output → re-queued with back-off, nothing stored", st.status === "queued" && st.error_code === "invalid_output" && st.backing_off);
  const failedUsage = (await pool.query(`SELECT COUNT(*)::int n FROM screening_llm_usage WHERE ok = false`)).rows[0].n;
  check("billed-but-invalid calls still count toward spend", failedUsage === 1);
  await pool.query(`UPDATE cv_screenings SET lease_until = now() - interval '1 second', attempts = 2 WHERE id = $1`, [s2]);
  await processOne(pool, badLlm, await claim(pool));
  st = (await pool.query(`SELECT status, error_code FROM cv_screenings WHERE id = $1`, [s2])).rows[0];
  check("after the maximum attempts the screening is marked failed", st.status === "failed" && st.error_code === "invalid_output");

  // Crash recovery: an expired lease is reclaimed.
  await pool.query(`UPDATE cv_screenings SET status = 'processing', lease_until = now() - interval '1 minute', attempts = 1, error_code = NULL WHERE id = $1`, [s2]);
  const reclaimed = await claim(pool);
  check("a row whose lease expired (crashed worker) is reclaimed", reclaimed?.id === s2 && reclaimed.attempts === 2);
  await pool.query(`UPDATE cv_screenings SET status = 'failed', lease_until = NULL WHERE id = $1`, [s2]);

  // Unreadable file → permanent failure, no LLM call.
  const docBad = crypto.randomUUID();
  const relBad = storagePathFor(A.jobId, docBad, "pdf");
  await pool.query(`INSERT INTO cv_documents (id, job_id, original_filename, mime, size_bytes, sha256, storage_path) VALUES ($1, $2, 'bad.pdf', 'application/pdf', 20, 'sha-bad', $3)`, [docBad, A.jobId, relBad]);
  await saveCvFile(relBad, Buffer.from("%PDF-1.4 garbage!!!"));
  const sBad = (await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id) VALUES ($1, $2, $3) RETURNING id`, [A.jobId, docBad, v2.id])).rows[0].id;
  calls = 0;
  await processOne(pool, goodLlm, await claim(pool));
  st = (await pool.query(`SELECT status, error_code FROM cv_screenings WHERE id = $1`, [sBad])).rows[0];
  check("damaged PDF fails permanently without calling the AI", st.status === "failed" && st.error_code === "malformed" && calls === 0, `${st.status} ${st.error_code}`);

  // Budget: fail closed, item stays queued, attempt not consumed.
  process.env.CV_SCREENING_DAILY_BUDGET_USD = "0";
  const doc3 = await insertDoc(A.jobId, "sha-3");
  const s3 = (await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id) VALUES ($1, $2, $3) RETURNING id`, [A.jobId, doc3.id, v2.id])).rows[0].id;
  calls = 0;
  const stop = await processOne(pool, goodLlm, await claim(pool));
  st = (await pool.query(`SELECT status, attempts, error_code FROM cv_screenings WHERE id = $1`, [s3])).rows[0];
  check("daily budget reached → no AI call, item stays queued, attempt refunded", stop === true && calls === 0 && st.status === "queued" && st.attempts === 0 && st.error_code === "daily_budget");
  process.env.CV_SCREENING_DAILY_BUDGET_USD = "5";

  // ── Decisions ──
  let noRationale = false;
  try {
    await pool.query(`INSERT INTO screening_decisions (screening_id, job_id, recruiter_id, decision) VALUES ($1, $2, $3, 'shortlisted')`, [sid, A.jobId, A.recruiterId]);
  } catch (err) {
    noRationale = err.code === "23514";
  }
  check("shortlist without a rationale is rejected by the DB", noRationale);
  await pool.query(`INSERT INTO screening_decisions (screening_id, job_id, recruiter_id, decision, rationale) VALUES ($1, $2, $3, 'shortlisted', 'Strong Python evidence')`, [scr2.rows[0].id, A.jobId, A.recruiterId]);
  check("latest decision is found across the CV's screenings", (await latestDecision(pool, A.jobId, doc.id))?.decision === "shortlisted");
  check("decisions are not visible through another job", (await latestDecision(pool, B.jobId, doc.id)) === null);

  // ── Interview plan + invite rules (email sending is faked) ──
  {
    const emails = [];
    const fakeSend = async (o) => { emails.push(o); return { interviewUrl: `http://test/interview/${o.token}`, emailSent: true }; };
    const docP = await insertDoc(A.jobId, "sha-plan");
    const sP = (await pool.query(
      `INSERT INTO cv_screenings (job_id, cv_document_id, config_id, status, result) VALUES ($1, $2, $3, 'completed', $4) RETURNING id`,
      [A.jobId, docP.id, v2.id, JSON.stringify({ candidate: { name: "MEENA G", emails: [{ value: "meena@example.com", format_valid: true }] }, follow_up_questions: ["How did you use Collibra at Citi?", "What did BCBS 239 work involve?"] })]
    )).rows[0].id;
    const job = { id: A.jobId, title: "Job A", companyName: null };
    const args = (o = {}) => ({ job, recruiterId: A.recruiterId, screeningId: sP, candidateName: "MEENA G", candidateEmail: "meena@example.com", questions: [], ...o });

    const [plan0] = await loadCandidatePlans(pool, A.jobId, [sP]);
    check("plan starts from the screening's suggested questions, name formatted", plan0.questions.length === 2 && plan0.questions[0].source === "cv" && plan0.name === "Meena G" && plan0.email === "meena@example.com" && !plan0.prepared);

    let r = await createScreeningInvite(pool, args({ questions: plan0.questions }), fakeSend);
    check("invite refused until the candidate is marked Ready for interview", !r.ok && r.code === "not_ready");
    await pool.query(`INSERT INTO screening_decisions (screening_id, job_id, recruiter_id, decision, rationale) VALUES ($1, $2, $3, 'shortlisted', 'Good fit')`, [sP, A.jobId, A.recruiterId]);

    r = await createScreeningInvite(pool, args({ questions: [] }), fakeSend);
    const sessionsNow = (await pool.query(`SELECT COUNT(*)::int n FROM interview_sessions WHERE cv_document_id = $1`, [docP.id])).rows[0].n;
    check("job with NO common questions + no candidate questions → refused, nothing created, no email", !r.ok && r.code === "no_questions" && sessionsNow === 0 && emails.length === 0);

    r = await createScreeningInvite(pool, args({ candidateEmail: "not-an-email" , questions: plan0.questions }), fakeSend);
    check("invalid email is refused", !r.ok && r.code === "email_invalid");

    r = await createScreeningInvite(pool, { ...args(), screeningId: sP, job: { id: B.jobId, title: "Job B", companyName: null }, questions: plan0.questions }, fakeSend);
    check("another job can't invite this candidate", !r.ok && r.code === "not_found");

    const confirmed = [{ text: "How did you use Collibra at Citi?", source: "cv" }, { text: "Walk me through your BCBS 239 programme.", source: "hr" }];
    r = await createScreeningInvite(pool, args({ questions: confirmed }), fakeSend);
    const own = (await pool.query(`SELECT text, source FROM questions WHERE session_id = $1 ORDER BY order_index`, [r.session_id])).rows;
    const sessRow = (await pool.query(`SELECT candidate_name FROM interview_sessions WHERE id = $1`, [r.session_id])).rows[0];
    check("invite stores exactly the confirmed questions (CV → resume, HR → custom)", r.ok && own.length === 2 && own[0].source === "resume" && own[1].source === "custom");
    check("interview name is formatted (MEENA G → Meena G)", sessRow.candidate_name === "Meena G" && emails[0]?.candidateName === "Meena G");
    const [plan1] = await loadCandidatePlans(pool, A.jobId, [sP]);
    check("confirmed questions are saved as the candidate's plan; invite shows on the plan", plan1.prepared && plan1.questions.length === 2 && plan1.session?.id === r.session_id);

    const again = await createScreeningInvite(pool, args({ questions: confirmed }), fakeSend);
    check("inviting twice returns the same interview (no duplicate, no second email)", again.ok && again.existing && again.session_id === r.session_id && emails.length === 1);

    await pool.query(`UPDATE interview_sessions SET status = 'expired', expires_at = now() WHERE id = $1`, [r.session_id]);
    const re = await createScreeningInvite(pool, args({ questions: confirmed }), fakeSend);
    check("after cancelling, the candidate can be invited again", re.ok && !re.existing && re.session_id !== r.session_id);

    // Question order: the interview brain's ORDER BY (copied from sessions/[token]/turn) must follow HR's choice.
    await pool.query(`INSERT INTO questions (job_id, text, category, difficulty, order_index, source) VALUES ($1, 'Common question for all candidates', 'technical', 1, 0, 'custom')`, [A.jobId]);
    const orderSql = `SELECT session_id IS NOT NULL AS own FROM questions
       WHERE (job_id = $1 AND session_id IS NULL) OR session_id = $2
       ORDER BY CASE WHEN (session_id IS NOT NULL) = ($3 = 'own_first') THEN 0 ELSE 1 END, order_index`;
    const turnSrc = readFileSync(new URL("../src/app/api/sessions/[token]/turn/route.ts", import.meta.url), "utf8");
    check("test uses the same ORDER BY as the interview brain", turnSrc.includes("ORDER BY CASE WHEN (session_id IS NOT NULL) = ($3 = 'own_first') THEN 0 ELSE 1 END, order_index"));
    const ownFirst = (await pool.query(orderSql, [A.jobId, re.session_id, "own_first"])).rows.map((x) => x.own);
    const commonFirst = (await pool.query(orderSql, [A.jobId, re.session_id, "common_first"])).rows.map((x) => x.own);
    check("own_first: candidate questions, then common", JSON.stringify(ownFirst) === JSON.stringify([true, true, false]));
    check("common_first: common question, then candidate questions", JSON.stringify(commonFirst) === JSON.stringify([false, true, true]));
    await pool.query(`UPDATE interview_sessions SET status = 'expired' WHERE id = $1`, [re.session_id]);
    const cf = await createScreeningInvite(pool, args({ questions: confirmed, questionOrder: "common_first" }), fakeSend);
    const stored = (await pool.query(`SELECT question_order FROM interview_sessions WHERE id = $1`, [cf.session_id])).rows[0];
    check("HR's question order is saved on the interview", cf.ok && stored.question_order === "common_first");
    const dflt = (await pool.query(`SELECT question_order FROM interview_sessions WHERE id = $1`, [r.session_id])).rows[0];
    check("default order stays 'own first'", dflt.question_order === "own_first");

    await saveCandidateQuestions(pool, A.jobId, docP.id, [{ text: "Only this one question", source: "hr" }]);
    const [plan2] = await loadCandidatePlans(pool, A.jobId, [sP]);
    check("saved draft questions replace the suggestions", plan2.questions.length === 1 && plan2.questions[0].text === "Only this one question");
    check("another job can't read this candidate's plan", (await loadCandidatePlans(pool, B.jobId, [sP])).length === 0);
  }

  // ── Free checks: email domain (cached) and duplicate CVs within a job ──
  {
    const { ensureDocChecks, loadCrossChecks } = await import("../src/lib/screening/service.ts");
    const body = "Defined and enforced thirty data quality rules across critical data elements in a global bank. Partnered with risk technology and operations teams to design remediation strategies for compliance gaps and tracked progress in governance forums. Conducted lineage reviews from source to endpoint during onboarding of a metadata management tool and resolved data flow gaps.";
    const mk = async (sha, name, email, text) => {
      const d = await insertDoc(A.jobId, sha);
      await pool.query(`UPDATE cv_documents SET extracted_text = $2, extraction_status = 'extracted' WHERE id = $1`, [d.id, `${name}\n${email}\n${text}`]);
      const s = (await pool.query(`INSERT INTO cv_screenings (job_id, cv_document_id, config_id, status, result) VALUES ($1, $2, $3, 'completed', $4) RETURNING id`,
        [A.jobId, d.id, v2.id, JSON.stringify({ candidate: { name, emails: [{ value: email, format_valid: true }], phones: [] } })])).rows[0].id;
      return { doc: d.id, sid: s };
    };
    const one = await mk("sha-x1", "Asha Rao", "asha@example.com", body);
    const two = await mk("sha-x2", "Ravi Kumar", "ravi@example.com", body);
    const three = await mk("sha-x3", "Asha R", "ASHA@example.com", "Frontend engineer building React interfaces for retail checkout flows with TypeScript and accessible responsive layouts for millions of users across devices and browsers worldwide.");

    let lookups = 0;
    const fakeDns = { resolveMx: async () => { lookups++; return [{ exchange: "mx.example.com", priority: 1 }]; }, resolve4: async () => [] };
    await ensureDocChecks(pool, A.jobId, one.doc, fakeDns);
    await ensureDocChecks(pool, A.jobId, one.doc, fakeDns);
    const cached = (await pool.query(`SELECT contact_checks, array_length(text_signature, 1) AS sig FROM cv_documents WHERE id = $1`, [one.doc])).rows[0];
    check("email domain check runs once and is cached", lookups === 1 && cached.contact_checks.emails[0].accepts_mail === true);
    check("text fingerprint is stored (64 values)", cached.sig === 64);
    check("checks for another job's CV do nothing", await ensureDocChecks(pool, B.jobId, one.doc, fakeDns).then(() => lookups === 1));

    const cross = await loadCrossChecks(pool, A.jobId, one.doc);
    check("same email (any case) as another CV in the job is found", cross.same_contact.some((c) => c.name === "Asha R" && c.via === "email"));
    check("largely identical CV text is found", cross.similar_text.some((c) => c.name === "Ravi Kumar" && c.similarity >= 0.5));
    check("unrelated CV is not reported as similar", !cross.similar_text.some((c) => c.name === "Asha R"));
    check("other jobs' CVs are never compared", (await loadCrossChecks(pool, B.jobId, one.doc)).same_contact.length === 0);
    void two; void three;
  }

  // ── Deleting a CV keeps interview history ──
  const sess = await pool.query(`INSERT INTO interview_sessions (job_id, candidate_name, candidate_email, cv_document_id) VALUES ($1, 'Jane', 'jane@example.com', $2) RETURNING id, token`, [A.jobId, doc.id]);
  await pool.query(`INSERT INTO screening_audit_log (job_id, recruiter_id, action, entity_type, entity_id) VALUES ($1, $2, 'view_cv', 'cv_document', $3)`, [A.jobId, A.recruiterId, doc.id]);
  await pool.query(`DELETE FROM cv_documents WHERE id = $1 AND job_id = $2`, [doc.id, A.jobId]);
  const after = (await pool.query(`SELECT cv_document_id, token FROM interview_sessions WHERE id = $1`, [sess.rows[0].id])).rows[0];
  check("deleting a CV keeps the interview session (link set to NULL, token unchanged)", after && after.cv_document_id === null && after.token === sess.rows[0].token);
  check("deleting a CV removes its screenings and decisions", (await pool.query(`SELECT COUNT(*)::int n FROM cv_screenings WHERE cv_document_id = $1`, [doc.id])).rows[0].n === 0);
  check("the audit trail survives deletion", (await pool.query(`SELECT COUNT(*)::int n FROM screening_audit_log WHERE entity_id = $1`, [doc.id])).rows[0].n === 1);
  check("spend history survives deletion", (await pool.query(`SELECT COUNT(*)::int n FROM screening_llm_usage WHERE cv_document_id = $1`, [doc.id])).rows[0].n >= 3);
} catch (err) {
  failures++;
  console.error("FAIL  unexpected error:", err);
} finally {
  await pool.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error("cleanup:", e.message));
  await admin.end().catch(() => {});
  rmSync(storageDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nAll CV screening DB checks passed");
process.exit(failures ? 1 : 0);

// ── fixtures ──
function extraction() {
  return {
    candidate: { name: "Jane Doe", location: null, relocation: null, work_preference: null },
    employment: [
      { ref: "E1", company: "Acme Ltd", title: "Senior Engineer", start: { year: 2020, month: 1, raw: "Jan 2020" }, end: null, is_current: true, employment_type: "full_time",
        responsibilities: ["Built payment APIs in Python and Django."], technologies: [{ name: "Python", excerpt: "Built payment APIs in Python" }], header_excerpt: "Senior Engineer, Acme Ltd" },
      { ref: "E2", company: "Beta Corp", title: "Engineer", start: { year: 2017, month: 6, raw: "Jun 2017" }, end: { year: 2019, month: 12, raw: "Dec 2019" }, is_current: false, employment_type: "unknown",
        responsibilities: ["Maintained Java services."], technologies: [{ name: "Java", excerpt: "Maintained Java services" }], header_excerpt: "Engineer, Beta Corp" },
    ],
    education: [], certifications: [], skills_section: [], projects: [], observations: [],
  };
}
function assessment() {
  return {
    criteria: [{ criterion_id: "python", classification: "strong", evidence: [{ source_ref: "E1", excerpt: "Built payment APIs in Python and Django" }], employment_refs: ["E1"], inferred: false, rationale: "Used at Acme." }],
    strengths: ["Python APIs"], uncertainties: [], follow_up_questions: [],
  };
}
function makePdf(pageTexts) {
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((t, i) => {
    const content = `BT /F1 9 Tf 30 760 Td (${t.replace(/[()\\]/g, "")}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
