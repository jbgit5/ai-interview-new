-- Default AI interviewer avatar for all sessions owned by this recruiter (candidate-facing).
ALTER TABLE recruiters
  ADD COLUMN IF NOT EXISTS interviewer_avatar_id VARCHAR(24) NOT NULL DEFAULT 'maya';
