-- ============================================================
-- MIGRATION 003: Object storage bucket (optional)
-- Run after 002_rls_policies.sql when `storage.buckets` exists (some hosted stacks).
-- Local Docker setup skips this file — interview recordings use the local filesystem.
-- ============================================================

-- Requires storage.buckets (not present on plain Postgres — skip if missing)
INSERT INTO storage.buckets (id, name, public)
VALUES ('interview-recordings', 'interview-recordings', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: Only service role can write
-- Recruiters access via signed URLs generated server-side
-- No public access allowed
