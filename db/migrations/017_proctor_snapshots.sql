-- ============================================================
-- MIGRATION 017: proctoring evidence snapshots
-- Camera-based violations (no face, multiple people, looking away, phone) now carry a small JPEG
-- captured at the moment of detection, stored on disk next to the recordings
-- (recordings/<sessionId>/proctor/<file>.jpg). This column holds that relative path.
-- ============================================================
ALTER TABLE proctoring_events
  ADD COLUMN IF NOT EXISTS snapshot_path TEXT;
