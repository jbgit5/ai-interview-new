-- ============================================================
-- MIGRATION 022: cached per-CV checks (no AI cost)
--  contact_checks  — email domain check results (DNS: does the domain exist / accept mail;
--                    throw-away provider). No email is ever sent. Cached so the DNS lookup
--                    runs once per CV.
--  text_signature  — MinHash fingerprint of the CV text (64 ints), used to spot CVs in the
--                    same job whose text is largely identical. Not a plagiarism verdict.
-- Additive, idempotent.
-- ============================================================
ALTER TABLE cv_documents
  ADD COLUMN IF NOT EXISTS contact_checks JSONB,
  ADD COLUMN IF NOT EXISTS text_signature INT[];
