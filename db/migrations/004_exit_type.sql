-- Add exit_type column to track normal vs early-exit completions
ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS exit_type TEXT NOT NULL DEFAULT 'normal'
    CHECK (exit_type IN ('normal', 'early_exit'));
