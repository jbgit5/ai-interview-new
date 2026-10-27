-- ============================================================
-- MIGRATION 019: AI CV screening (Phase 2)
-- Recruiters upload CVs against a job, Screeno extracts cited evidence and scores it
-- against a VERSIONED criteria config, and HR records the shortlist decision.
-- Additive only and idempotent (safe to re-run). See docs/CV-SCREENING.md.
--
-- Privacy: CV files live on local disk (CV_STORAGE_DIR), never under public/.
-- Deleting a CV (cv_documents row) cascades to its screenings/decisions but only
-- SET NULLs interview_sessions.cv_document_id — interview history is never deleted.
-- ============================================================

-- Immutable, versioned screening criteria per job. Editing criteria inserts a new
-- version; every screening points at the exact version it was scored against.
CREATE TABLE IF NOT EXISTS screening_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version         INT  NOT NULL CHECK (version >= 1),
  criteria        JSONB NOT NULL,
  rubric_version  TEXT NOT NULL,
  created_by      UUID REFERENCES recruiters(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

-- One upload session (a group of files submitted together).
CREATE TABLE IF NOT EXISTS screening_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  config_id   UUID NOT NULL REFERENCES screening_configs(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES recruiters(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_screening_batches_job ON screening_batches (job_id, created_at DESC);

-- An uploaded CV file. The job-independent parse + LLM extraction are cached here so
-- retries and re-screens against a new config version never pay for them twice.
CREATE TABLE IF NOT EXISTS cv_documents (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_id                   UUID REFERENCES screening_batches(id) ON DELETE SET NULL,
  uploaded_by                UUID REFERENCES recruiters(id) ON DELETE SET NULL,
  original_filename          TEXT NOT NULL,
  mime                       TEXT NOT NULL CHECK (mime IN (
                               'application/pdf',
                               'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes                 INT  NOT NULL CHECK (size_bytes > 0),
  sha256                     TEXT NOT NULL,
  storage_path               TEXT NOT NULL,           -- relative to CV_STORAGE_DIR
  page_count                 INT,
  extracted_text             TEXT,
  page_offsets               JSONB,                   -- [start char offset of page 1, page 2, ...]
  text_truncated             BOOLEAN NOT NULL DEFAULT FALSE,
  extraction_status          TEXT NOT NULL DEFAULT 'pending'
                               CHECK (extraction_status IN ('pending', 'extracted', 'failed', 'needs_ocr')),
  error_code                 TEXT,
  extraction                 JSONB,                   -- validated LLM extraction (job-independent)
  extraction_prompt_version  TEXT,
  extraction_model           TEXT,
  extraction_usage           JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_cv_documents_job ON cv_documents (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cv_documents_batch ON cv_documents (batch_id);

-- One CV assessed against one config version. Doubles as the processing queue
-- (status + lease_until, claimed with FOR UPDATE SKIP LOCKED).
CREATE TABLE IF NOT EXISTS cv_screenings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cv_document_id         UUID NOT NULL REFERENCES cv_documents(id) ON DELETE CASCADE,
  config_id              UUID NOT NULL REFERENCES screening_configs(id) ON DELETE CASCADE,
  batch_id               UUID REFERENCES screening_batches(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts               INT  NOT NULL DEFAULT 0,
  lease_until            TIMESTAMPTZ,
  error_code             TEXT,
  as_of_date             DATE,
  timeline               JSONB,                       -- deterministic calculations
  assessment             JSONB,                       -- per-criterion AI classification + evidence refs
  result                 JSONB,                       -- deterministic per-criterion scoring detail
  corrections            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- HR edits to the extraction
  job_fit_score          INT CHECK (job_fit_score BETWEEN 0 AND 100),
  evidence_completeness  NUMERIC(4,3) CHECK (evidence_completeness BETWEEN 0 AND 1),
  eligibility_status     TEXT CHECK (eligibility_status IN ('meets', 'unmet', 'undetermined')),
  fit_category           TEXT CHECK (fit_category IN ('strong_fit', 'potential_fit', 'insufficient_info', 'potential_mismatch')),
  model                  TEXT,
  prompt_version         TEXT,
  rubric_version         TEXT,
  usage                  JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  UNIQUE (cv_document_id, config_id)
);
CREATE INDEX IF NOT EXISTS idx_cv_screenings_job ON cv_screenings (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cv_screenings_queue ON cv_screenings (status, lease_until);
CREATE INDEX IF NOT EXISTS idx_cv_screenings_batch ON cv_screenings (batch_id);

-- Append-only HR decisions. The latest row is the current decision; the AI never writes here.
CREATE TABLE IF NOT EXISTS screening_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screening_id    UUID NOT NULL REFERENCES cv_screenings(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  recruiter_id    UUID REFERENCES recruiters(id) ON DELETE SET NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('shortlisted', 'rejected', 'hold', 'needs_review')),
  rationale       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (decision IN ('hold', 'needs_review') OR length(trim(coalesce(rationale, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS idx_screening_decisions_screening ON screening_decisions (screening_id, created_at DESC);

-- Access + decision audit trail. Ids and action metadata only — never CV content.
-- No FK on entity_id on purpose: the trail must survive deletion of the CV.
CREATE TABLE IF NOT EXISTS screening_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  recruiter_id  UUID REFERENCES recruiters(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     UUID,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_screening_audit_job ON screening_audit_log (job_id, created_at DESC);

-- Every paid LLM call (cost + latency telemetry, and the source of truth for the daily budget
-- CV_SCREENING_DAILY_BUDGET_USD). No FK on cv_document_id so spend history survives CV deletion.
CREATE TABLE IF NOT EXISTS screening_llm_usage (
  id                 BIGSERIAL PRIMARY KEY,
  job_id             UUID REFERENCES jobs(id) ON DELETE SET NULL,
  cv_document_id     UUID,
  kind               TEXT NOT NULL CHECK (kind IN ('extraction', 'assessment', 'criteria_suggestion')),
  model              TEXT NOT NULL,
  prompt_tokens      INT NOT NULL DEFAULT 0,
  completion_tokens  INT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(10,5) NOT NULL DEFAULT 0,
  latency_ms         INT,
  ok                 BOOLEAN NOT NULL DEFAULT TRUE,
  error_code         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_screening_llm_usage_created ON screening_llm_usage (created_at);

-- Link an interview invite back to the CV it came from (shortlist → invite).
ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS cv_document_id UUID REFERENCES cv_documents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_interview_sessions_cv_document ON interview_sessions (cv_document_id);
