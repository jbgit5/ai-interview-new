# CV Screening (Phase 2)

Recruiters upload CVs against a job. Screeno extracts cited evidence from each CV and checks it against the job's **versioned** criteria. The recruiter reviews the report next to the original CV, corrects extraction errors, and records the shortlist decision. Shortlisted candidates can then be invited to the existing AI interview.

**The AI never rejects or invites anyone.** Every category is advisory, and every decision is made by a named recruiter with a recorded reason.

## 1. Workflow

Creating a job and creating interview questions are separate steps. A job is its JD plus its requirements.

1. **Jobs → Create job** (`/dashboard/jobs/new`).
   - Upload the JD (PDF/DOCX) or paste it. `POST /api/jobs/draft` (gpt-4o-mini) prefills the title, department and requirements.
   - The recruiter reviews them on the same screen and clicks **Create job**. This saves requirements version 1.
   - No questions are generated at this point.
2. **Candidates tab** (`/dashboard/jobs/[id]/screening`, the job's landing tab).
   - Upload CVs. Each one is parsed, contacts are masked, then extraction (LLM), criterion assessment (LLM), and deterministic timeline and scoring run.
3. **Requirements tab** (`/dashboard/jobs/[id]/requirements`).
   - A simple editor with three levels:
     - **Must have** = hard; decides eligibility.
     - **Important** = required; counts ×2 in the score.
     - **Nice to have** = preferred; counts ×1.
   - Every save is a new version.
   - "Re-screen them" re-queues older results. Only the assessment call is paid again.
4. **Report.** A summary card with must-have chips, then a **"Needs your attention"** strip, then tabs: Requirements, Experience, Checks, Interview questions. The CV opens in a side drawer.
   - The attention strip lists must-haves that are unmet or unclear, employment gaps, missing dates, date conflicts, short jobs, AI quotes that couldn't be found in the CV, a missing email, and contradictions. Each chip opens the right tab. These are facts to check and are never scored.
   - **Correct** dates, employers, titles, the candidate's name or a requirement's classification. The report is re-scored with no AI call.
5. **Decide** with the decision bar: **Ready for interview** / On hold / Needs review / **Not suitable**. The DB value for "Ready for interview" is `shortlisted`.
   - The saved decision is shown active and can't be clicked again.
   - A reason is required for Ready for interview and Not suitable.
   - This decides only whether the candidate goes to interview. It is not a final hiring decision.
6. **Interview questions.** Every interview is made of two parts:
   - **Common questions** (Interview questions tab): optional, asked to everyone for this job.
   - **This candidate's own questions** (report → Interview questions tab): pre-filled from the screening's suggested questions. HR keeps, edits or removes them and adds their own. Saved on `cv_documents.interview_questions` (migration 020).
   - The candidate's own questions are asked first, then the common ones.
   - **Rule on every invite path:** common + own ≥ 1. An interview is never created without questions.
7. **Invite** from the report (one candidate) or from Candidates → "Ready for interview" → select → **Invite selected** (bulk).
   - Both open **Confirm interview plan**. It shows the common questions, each candidate's own questions (editable), the follow-up setting, the question count, an estimated duration, and editable name and email.
   - Nothing is sent until HR confirms. Candidates with problems (no questions, invalid email, not ready, already invited) are blocked individually.
   - All invite paths use `createScreeningInvite()` in `src/lib/screening/interviewPlan.ts`. It is idempotent per CV, formats the name, and stores the confirmed questions on the interview session.
   - **Cancel invite** works until the candidate starts (`POST /api/jobs/[id]/invites/[sessionId]/cancel`, status → `expired`). A cancelled candidate can be invited again.
   - The manual Invites tab follows the same rule. HR can add questions for that one candidate there, and the invite is refused if the total would be 0.
   - Deleting the job's last common question is blocked while an invited candidate depends on it.

## 2. Code map

| Area | Files |
|---|---|
| Migration | `db/migrations/019_cv_screening.sql` |
| Criteria schema + defaults | `src/lib/screening/criteria.ts` (UI levels ↔ schema: `src/components/screening/RequirementsEditor.tsx`) |
| Create job from JD | `src/app/dashboard/jobs/new/page.tsx`, `src/app/api/jobs/draft/route.ts`, `POST /api/jobs` (`criteria`, `generate_questions`) |
| File detection / text extraction | `src/lib/screening/parse.ts` (pdf-parse v2, mammoth) |
| Contact regex + masking | `src/lib/screening/contact.ts` |
| LLM schemas (strict) | `src/lib/screening/schemas.ts` |
| Prompts (versioned) | `src/lib/prompts.ts` → `SCREENING_PROMPT_VERSION`, `buildCvExtractionPrompt`, `buildCriteriaAssessmentPrompt`, `buildCriteriaSuggestionPrompt` |
| LLM calls (injectable) | `src/lib/screening/pipeline.ts`, `src/lib/llm/{openai,types,pricing}.ts` |
| Citation verification | `src/lib/screening/citations.ts` |
| Timeline arithmetic | `src/lib/screening/timeline.ts` |
| Scoring rubric | `src/lib/screening/scoring.ts` (`RUBRIC_VERSION` in `criteria.ts`) |
| Evaluation + checklist | `src/lib/screening/evaluate.ts` |
| HR corrections | `src/lib/screening/corrections.ts` |
| Queue worker | `src/lib/screening/worker.ts` |
| DB helpers | `src/lib/screening/service.ts` |
| Auth helper | `src/lib/screening/access.ts` → `requireRecruiterJob()` |
| File storage | `src/lib/screening/storage.ts` |
| API | `src/app/api/jobs/[id]/screening/**` (15 routes, incl. `rescreen-all`) |
| UI | `src/app/dashboard/jobs/[jobId]/screening/**`, `src/components/screening/*` |
| Shared invite email | `src/lib/invites/sendInviteEmail.ts` (also used by `api/jobs/[id]/invites`) |
| HR 13-point checklist | `src/lib/screening/hrChecklist.ts` (built on report view; no AI) |
| Free checks | `contactChecks.ts` (email domain DNS + DoH fallback, disposable list, libphonenumber), `similarity.ts` (MinHash near-duplicate CVs), `seniority.ts` (growth from titles), `timeline.ts` `lastUsed()` (skill recency); cached on `cv_documents.contact_checks` / `text_signature` (migration 022) |
| Interview plan / invites | `src/lib/screening/interviewPlan.ts` (`createScreeningInvite`); question order per interview (`interview_sessions.question_order`, migration 021) |

## 3. Data model (migration 019)

| Table | Purpose |
|---|---|
| `screening_configs` | Immutable criteria versions per job. `UNIQUE(job_id, version)`. |
| `screening_batches` | One upload session, tied to a config version. |
| `cv_documents` | File metadata, `sha256`, private storage path, cached text and page offsets, and the cached job-independent extraction. `UNIQUE(job_id, sha256)` means the same file uploaded twice is reused, not re-charged. |
| `cv_screenings` | One CV against one config version. It is also the queue (status, attempts, `lease_until`). Holds timeline, assessment, result, corrections and scores. `UNIQUE(cv_document_id, config_id)` makes retries and re-screens idempotent. |
| `screening_decisions` | Append-only HR decisions. A DB `CHECK` requires a rationale for shortlist and reject. |
| `screening_audit_log` | Upload, view_report, view_cv, download_cv, correct, decide, retry, rescreen, invite, export, delete, config_saved. Stores ids and metadata only, never CV content. |
| `screening_llm_usage` | Every paid call (tokens, cost, latency, ok or error). Source of truth for the daily budget. |
| `interview_sessions.cv_document_id` | Link created by shortlist → invite. `ON DELETE SET NULL`. |

Candidates are not duplicated. The existing "candidate" is still the `interview_sessions` row, created only when a recruiter invites someone.

## 4. Scoring rubric (`RUBRIC_VERSION = rubric-2026-10-27.1`)

The LLM classifies evidence per criterion. **All numbers are computed in code.**

| Classification | Meaning | Points |
|---|---|---|
| strong | Concrete evidence of use or satisfaction | 1 |
| partial | Limited, indirect, or an accepted equivalent | 0.5 |
| listed_only | (skills) Named in a list, never tied to work | 0.25 |
| not_found | The CV doesn't mention it. **Not proof of absence.** | 0 |
| does_not_meet | The CV explicitly contradicts the criterion | 0 |
| unable_to_assess | Unclear or contradictory, or cited evidence couldn't be found in the CV | excluded |

**Score calculation**
- **Effective weight** = recruiter weight (1–5) × 2 for *required*, × 1 for *preferred*.
- **Job-fit** = round(100 × Σ(weight × points) ÷ Σ(weight of assessable criteria)).
- **Evidence completeness** = assessable weight ÷ total weight. It measures how much the CV lets us assess, **not** candidate quality.

**Mandatory (hard) status per criterion**
- *met*: strong evidence (and minimum years met).
- *unmet*: only when the CV explicitly contradicts the criterion, or the calculated timeline is below the minimum.
- *undetermined*: everything else, including "not found".

**Eligibility**
- Any hard criterion unmet gives `unmet`.
- All hard criteria met gives `meets`.
- Otherwise `undetermined`.

**Advisory category**
- `unmet` gives *Potential mismatch*.
- No score, or completeness below 50 %, gives *Insufficient information*.
- Fit ≥ 70 with `meets` gives *Strong evidence of fit*.
- Fit < 40 gives *Potential mismatch*.
- Anything else gives *Potential fit; review required*.

**Experience criteria**
- *Total experience* is calculated from the timeline (internships excluded) and never asked of the AI.
- *Skill minimum years* counts only the merged months of roles where the skill is evidenced as used. A skills-list mention adds nothing. Years below the minimum cap the points at 0.5.
- *Qualification equivalence*: if equivalents are allowed and total experience meets the configured years, the classification becomes *partial*, and HR must confirm the experience is relevant.

**Never scored:** gaps, short tenures, overlaps, contract work, career changes, CV style or length, and location (unless a location requirement is configured).

**Not calibrated:** scores have no statistical calibration. A 70 means "70 % of the weighted, assessable criteria are supported by CV text under this rubric", not a 70 % probability of anything.

## 5. Timeline arithmetic (`timeline.ts`)

**Conventions**
- Months are inclusive: Jan–Dec 2020 is 12 months.
- A year without a month becomes a Jan..Dec range, so durations become `{min, max}` ranges instead of invented exact numbers.
- A missing start or end date leaves the upper bound open (`max = null`).
- Overlapping periods are merged and counted once.
- "Present" is measured to the screening's stored `as_of_date`, so results are reproducible.

**Neutral observations reported**
- Gaps between roles.
- The gap from education to the first role.
- Time since the last role (when no role is current).
- Overlaps.
- Short tenures (contract, freelance and internship roles are excluded from the "frequent changes" count).
- Chronology conflicts (end before start, future dates, implausible years).

Each result lists its assumptions.

## 6. Safety, fairness and privacy

**Prompt injection**
- CV text is fenced in `<cv_document>`, and tag look-alikes are neutralised.
- The system prompt says the content is untrusted.
- Outputs use strict `json_schema` and are re-validated with zod `strictObject`, so extra fields are rejected.
- There is no field where a score could be written.
- Every cited excerpt is checked against the CV text. Unverifiable evidence is ignored and flagged.

**Sensitive attributes**
- The extraction schema has no fields for age, date of birth, gender, nationality, ethnicity, religion, marital status, health or disability, photos or personality.
- The prompts forbid recording them.
- Only text is sent; images are never sent.

**Data minimisation**
- Emails and phone numbers are found with regex and replaced with `[EMAIL_n]` / `[PHONE_n]` before any OpenAI call.
- The assessment call receives the structured facts without the candidate's name.
- Contact checks say "format valid, not verified". Nothing is ever claimed as verified.

**No inference**
- Relocation willingness and work preference come only from explicit statements.
- Location only matters when the recruiter configures a location requirement.

**Human in the loop**
- Decisions are append-only, attributed and require a rationale.
- Invites require an explicit click and a recorded shortlist decision.

**Access control**
- Every route calls `requireRecruiterJob()`, which checks the session and job ownership.
- Child queries always include `AND job_id = $job`. A source-guard test enforces this for every route file.

**Storage**
- Files are saved to `CV_STORAGE_DIR/<jobId>/<docId>.<ext>` with mode 0600, never under `public/`.
- They are served only through the authorised route with `Cache-Control: private, no-store` and `nosniff`. Every view and download is audited.

**Logging**
- Logs contain ids, error codes, token counts and timings only. CV text and prompts are never logged.

**Retention**
- **Manual only.** Recruiters delete a CV from the results table.
- Deleting removes the file, the extracted text and data, the screenings and the decisions.
- Interview sessions created from the CV are kept (`cv_document_id → NULL`).
- Audit and spend rows are kept, with ids only.
- Nothing expires automatically. Define the retention period in your privacy policy.

**OpenAI data handling**
- Screening uses the existing `OPENAI_API_KEY`.
- By default, API data isn't used for training but may be retained by OpenAI for up to 30 days for abuse monitoring.
- If your policy requires it, ask OpenAI for Zero Data Retention on the project. This is an account-level decision.

**Known limits on fairness**
- Omitting protected characteristics from prompts does **not** make the system unbiased.
- Measure outcomes with the evaluation harness (§8) on governed, labelled data before relying on it.
- Writing style, CV format and language can still influence extraction quality.

## 7. Operations

**Queue**
- `kickWorker()` runs up to `CV_SCREENING_CONCURRENCY` (default 2) drain loops inside the Next.js process.
- Upload routes, the results list and the batch-status poll (every 3 s while work is pending) restart it, so processing resumes after a PM2 reload.
- Rows are claimed with `FOR UPDATE SKIP LOCKED`. A lease (180 s) protects in-flight work; an expired lease is reclaimed.

**Retries**
- Provider and validation errors back off 30 s × attempt, up to 3 attempts, then become `failed`.
- File problems (password-protected, damaged, empty, scanned) fail permanently with a clear message.
- **Retry** in the UI re-queues; cached text and extraction are reused.

**Budget**
- `CV_SCREENING_DAILY_BUDGET_USD` (default $10) is summed from `screening_llm_usage`.
- When it's reached, items stay queued (the attempt isn't consumed) and the UI shows a banner. It fails closed.

**Cost**
- About 2 gpt-4o calls per CV, roughly $0.02–0.05.
- Re-screening against a new criteria version costs only the assessment call.

**Re-screen**
- Changing criteria never rewrites old results.
- A report screened with an older version offers "Re-screen with criteria vN".

**Configuration**
- New env vars are optional (see `docs/ARCHITECTURE.md` §5). `OPENAI_API_KEY` is reused.

## 8. Testing and evaluation

```bash
npm run test:screening      # 126 pure checks: timeline, rubric, citations, parsing, schema/injection, source guards (no cost)
npm run test:screening:db   # local Docker Postgres only: scratch DB, migrations, isolation, worker, retries, budget, deletion (no cost)
npm test                    # all regression suites (includes test:screening)
npm run eval:screening -- --dir /secure/eval-set          # dry run: prints case count + cost estimate
npm run eval:screening -- --dir /secure/eval-set --yes    # real OpenAI calls (needs OPENAI_API_KEY; tip: node --env-file)
```

**Dataset for the harness** (`scripts/cv-eval/run.mjs`)
- Use authorised CVs plus HR gold labels, stored **outside the repo**. The script refuses an in-repo path.
- See the header comment in the script for the file layout.

**What it reports**
- Role recall and start/end date accuracy.
- Whether the gold experience falls within the computed range.
- Citation verification rate.
- Criterion exact agreement and 3-way Cohen's κ (supported / not supported / abstain).
- Hard-requirement false positives and false negatives.
- Abstention rate, cost and latency.
- Optional per-group breakdowns, for lawful, governed outcome comparison only.

## 9. Deployment checklist

1. **New dependency `mammoth`.** The first deploy must use `npm run deploy:prod -- --deps`. `deploy.ps1` refuses package.json changes.
2. **Migration 019.** It only adds tables and columns. Back up first (`pg_dump`), then apply with `psql -f db/migrations/019_cv_screening.sql`. Get explicit approval before running it on prod.
3. **Storage.** On the server, `mkdir -p cv-uploads && chmod 700 cv-uploads` in the app directory (or set `CV_STORAGE_DIR`). The rsync deploy excludes `cv-uploads`. The zip deploy only replaces `.next`, `public` and `next.config.mjs`. Include the folder in server backups.
4. **Reverse proxy body size.** Uploads are up to `CV_MAX_FILE_MB` (10 MB) per request. If the proxy is nginx, its default `client_max_body_size` is 1 MB, which would reject larger CVs with 413. Check the current value before release; changing the proxy needs separate approval.
5. Optionally set the `CV_*` env vars in `.env.production`. Defaults are safe.

## 10. Known limitations

- **No OCR.** Scanned or image-only PDFs are flagged `needs_ocr` for manual review. HR can still view the file and record a decision.
- **No DOCX preview.** DOCX files show the extracted text, with a download link for the original.
- **Excerpt matching is approximate.** Citation matching is normalised and fuzzy (≥ 80 % word-pair coverage). Page numbers come from PDF text pages.
- **External verification isn't implemented.** Employers, titles and qualifications are always labelled as the candidate's own claims.
- **No resume-mode questions on screening invites.** Invites from screening use the job's existing question bank. Resume-mode personalised questions are generated only by the manual invite route.
